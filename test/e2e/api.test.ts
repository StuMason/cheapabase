// End-to-end test against a running cheapabase (docker compose up, then `bun test`).
// Uses the real supabase-js client to prove compatibility.
import { describe, expect, test, beforeAll } from "bun:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RealtimeClient } from "../../public/realtime.js";

const URL = process.env.CHEAPABASE_URL ?? "http://localhost:8000";
let anonKey = "";

async function newUser() {
  const sb = createClient(URL, anonKey, { auth: { persistSession: false } });
  const email = `u${crypto.randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await sb.auth.signUp({ email, password: "password123" });
  if (error) throw error;
  return { sb, email, id: data.user!.id, token: data.session!.access_token };
}

function realtimeFor(token: string) {
  return new RealtimeClient(URL, () => token);
}

function waitFor<T>(arr: T[], n = 1, ms = 3000) {
  return new Promise<T[]>((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (arr.length >= n) { clearInterval(t); resolve(arr); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error(`timed out, got ${arr.length}`)); }
    }, 20);
  });
}

let alice: Awaited<ReturnType<typeof newUser>>;
let bob: Awaited<ReturnType<typeof newUser>>;

beforeAll(async () => {
  anonKey = (await (await fetch(`${URL}/config.json`)).json()).anonKey;
  alice = await newUser();
  bob = await newUser();
});

describe("rest + rls", () => {
  test("users only see their own docs", async () => {
    const { data: doc, error } = await alice.sb.from("docs").insert({ title: "secret" }).select().single();
    expect(error).toBeNull();
    expect(doc.owner_id).toBe(alice.id);
    const { data: bobs } = await bob.sb.from("docs").select().eq("id", doc.id);
    expect(bobs).toEqual([]);
    const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
    const { data: anonDocs, error: anonErr } = await anon.from("docs").select();
    expect(anonDocs ?? []).toEqual([]);
    expect(anonErr === null || anonErr.code === "42501").toBe(true);
  });
});

describe("functions", () => {
  test("hello knows who you are", async () => {
    const { data } = await alice.sb.functions.invoke("hello");
    expect(data.message).toBe(`hello ${alice.email}`);
  });

  test("only the owner can share", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "shared" }).select().single();
    const denied = await bob.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    expect(denied.error).not.toBeNull();
    const ok = await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    expect(ok.data.user_id).toBe(bob.id);
    const { data: seen } = await bob.sb.from("docs").select().eq("id", doc.id);
    expect(seen?.length).toBe(1);
  });
});

describe("realtime", () => {
  test("changes respect rls and filters", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "live" }).select().single();
    const a = realtimeFor(alice.token);
    const b = realtimeFor(bob.token);
    const aEvents: any[] = [], bEvents: any[] = [];
    await a.on("docs", { filter: `id=eq.${doc.id}` }, (e) => aEvents.push(e));
    await b.on("docs", {}, (e) => bEvents.push(e));

    await alice.sb.from("docs").update({ content: "hello world" }).eq("id", doc.id);
    await waitFor(aEvents);
    expect(aEvents[0].event).toBe("UPDATE");
    expect(aEvents[0].new.content).toBe("hello world");
    await Bun.sleep(200);
    expect(bEvents).toEqual([]); // bob can't see alice's doc

    await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    await alice.sb.from("docs").update({ content: "now bob sees it" }).eq("id", doc.id);
    await waitFor(bEvents);
    expect(bEvents[0].new.content).toBe("now bob sees it");

    await alice.sb.from("docs").delete().eq("id", doc.id);
    await waitFor(aEvents, 3);
    expect(aEvents.at(-1).event).toBe("DELETE");
    expect(aEvents.at(-1).old.id).toBe(doc.id);
    a.close(); b.close();
  });

  test("channels: presence, broadcast and can_join", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "chan" }).select().single();
    const a = realtimeFor(alice.token);
    const b = realtimeFor(bob.token);
    const ca = a.channel(`doc:${doc.id}`, { presence: { name: "alice" } });
    const presence: any[] = [];
    ca.onPresence((users) => presence.push(users));
    await ca.join();
    await expect(b.channel(`doc:${doc.id}`).join()).rejects.toThrow(/not allowed/);

    await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    const cb = b.channel(`doc:${doc.id}`, { presence: { name: "bob" } });
    const got: any[] = [];
    cb.on("cursor", (payload) => got.push(payload));
    await cb.join();
    await waitFor(presence, 2);
    expect(presence.at(-1).map((u: any) => u.name).sort()).toEqual(["alice", "bob"]);
    ca.send("cursor", { pos: 5 });
    await waitFor(got);
    expect(got[0]).toEqual({ pos: 5 });
    a.close(); b.close();
  });
});
