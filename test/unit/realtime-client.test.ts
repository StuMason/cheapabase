// Tests client/realtime.js against a fake server speaking the same protocol.
import { afterEach, expect, test } from "bun:test";
import { RealtimeClient } from "../../client/realtime.js";

type Msg = Record<string, any>;
let server: ReturnType<typeof Bun.serve> | undefined;

function fakeServer(onMessage: (ws: any, msg: Msg) => void) {
  const received: Msg[] = [];
  const tokens: string[] = [];
  server = Bun.serve<undefined>({
    port: 0,
    fetch(req, srv) {
      tokens.push(new URL(req.url).searchParams.get("token") ?? "");
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        onMessage(ws, msg);
      },
    },
  });
  return { url: `http://localhost:${server.port}`, received, tokens };
}

async function until(fn: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

afterEach(() => server?.stop(true));

test("subscribe resolves, change events reach the callback", async () => {
  const s = fakeServer((ws, m) => {
    if (m.type === "subscribe") {
      ws.send(JSON.stringify({ type: "subscribed", ref: m.ref }));
      ws.send(JSON.stringify({ type: "change", ref: m.ref, event: "INSERT", new: { id: 1 } }));
    }
  });
  const rt = new RealtimeClient(s.url, () => "tok");
  const events: any[] = [];
  await rt.on("todos", { filter: "id=eq.1" }, (e: any) => events.push(e));
  await until(() => events.length === 1);
  expect(events[0].new).toEqual({ id: 1 });
  expect(s.received[0]).toMatchObject({ type: "subscribe", table: "todos", schema: "public", event: "*", filter: "id=eq.1" });
  expect(s.tokens[0]).toBe("tok");
  rt.close();
});

test("errors reject the pending request", async () => {
  const s = fakeServer((ws, m) => ws.send(JSON.stringify({ type: "error", ref: m.ref, message: "not allowed to join channel" })));
  const rt = new RealtimeClient(s.url, () => "tok");
  await expect(rt.channel("secret").join()).rejects.toThrow(/not allowed/);
  expect(rt.channels.size).toBe(0);
  rt.close();
});

test("reconnects with a fresh token and restores subscriptions and channels", async () => {
  let token = "first";
  let sockets: any[] = [];
  const s = fakeServer((ws, m) => {
    sockets.push(ws);
    if (m.type === "subscribe") ws.send(JSON.stringify({ type: "subscribed", ref: m.ref }));
    if (m.type === "join") ws.send(JSON.stringify({ type: "joined", ref: m.ref, channel: m.channel }));
  });
  const rt = new RealtimeClient(s.url, () => token);
  await rt.on("docs", {}, () => {});
  await rt.channel("room:1", { presence: { name: "ada" } }).join();

  token = "second";
  sockets[0].close();
  await until(() => s.tokens.length === 2 && s.received.filter((m) => m.type === "join").length === 2);
  expect(s.tokens[1]).toBe("second");
  expect(s.received.filter((m) => m.type === "subscribe").length).toBe(2);
  expect(s.received.filter((m) => m.type === "join").at(-1)).toMatchObject({ channel: "room:1", presence: { name: "ada" } });
  rt.close();
});

test("broadcast and presence are routed to the channel", async () => {
  const s = fakeServer((ws, m) => {
    if (m.type === "join") {
      ws.send(JSON.stringify({ type: "joined", ref: m.ref, channel: m.channel }));
      ws.send(JSON.stringify({ type: "presence", channel: m.channel, users: [{ name: "ada" }] }));
      ws.send(JSON.stringify({ type: "broadcast", channel: m.channel, event: "cursor", payload: { x: 1 }, from: { key: "k" } }));
    }
  });
  const rt = new RealtimeClient(s.url, () => "tok");
  const got: any[] = [];
  const users: any[] = [];
  const room = rt.channel("room:2").on("cursor", (p: any, from: any) => got.push([p, from])).onPresence((u: any) => users.push(u));
  await room.join();
  await until(() => got.length === 1 && users.length === 1);
  expect(got[0]).toEqual([{ x: 1 }, { key: "k" }]);
  expect(users[0]).toEqual([{ name: "ada" }]);
  room.send("cursor", { x: 2 });
  await until(() => s.received.some((m) => m.type === "broadcast"));
  expect(s.received.find((m) => m.type === "broadcast")).toMatchObject({ channel: "room:2", event: "cursor", payload: { x: 2 } });
  rt.close();
});
