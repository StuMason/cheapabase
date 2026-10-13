// Realtime over a single websocket at /realtime/v1.
//
// Two features, both small:
//   1. Database changes: tables opt in with `select realtime.enable('public.todos')`.
//      A trigger sends the row's primary key over LISTEN/NOTIFY. For every subscriber we
//      re-read that row *as the subscriber* (same role + JWT claims as PostgREST), so RLS
//      decides who receives what. Deletes only carry the primary key.
//   2. Channels: broadcast messages and presence between clients. Joining is gated by
//      the SQL function realtime.can_join(channel), which also runs as the user.
//
// The wire protocol is plain JSON, documented in docs/realtime.md.
import type { ServerWebSocket } from "bun";
import { asUser, sql } from "./db";
import { config } from "./config";
import { verify, type Claims } from "./jwt";
import { parseFilter, type Filter } from "./filter";

type Sub = { schema: string; table: string; event: string; filter?: Filter };
export type SocketData = {
  claims: Claims;
  subs: Map<string, Sub>;
  channels: Map<string, Record<string, unknown>>;
  key: string;
};
type WS = ServerWebSocket<SocketData>;

const sockets = new Set<WS>();
const channels = new Map<string, Set<WS>>();

function send(ws: WS, msg: unknown) {
  ws.send(JSON.stringify(msg));
}

function claimsKey(c: Claims) {
  return `${c.role ?? "anon"}:${c.sub ?? ""}`;
}

function presenceList(channel: string) {
  return [...(channels.get(channel) ?? [])].map((ws) => ({
    key: ws.data.key,
    user_id: ws.data.claims.sub ?? null,
    email: ws.data.claims.email ?? null,
    ...ws.data.channels.get(channel),
  }));
}

function publishPresence(channel: string) {
  const users = presenceList(channel);
  for (const ws of channels.get(channel) ?? []) send(ws, { type: "presence", channel, users });
}

function leave(ws: WS, channel: string) {
  if (!ws.data.channels.delete(channel)) return;
  const set = channels.get(channel);
  set?.delete(ws);
  if (set?.size === 0) channels.delete(channel);
  else publishPresence(channel);
}

export async function upgradeData(req: Request): Promise<SocketData | null> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? url.searchParams.get("apikey");
  const claims = token ? await verify(token, config.jwtSecret) : null;
  if (!claims) return null;
  return { claims, subs: new Map(), channels: new Map(), key: crypto.randomUUID() };
}

export const websocket = {
  open(ws: WS) {
    sockets.add(ws);
    send(ws, { type: "ready", key: ws.data.key, user: { id: ws.data.claims.sub ?? null, role: ws.data.claims.role } });
  },

  async message(ws: WS, raw: string | Buffer) {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: "error", message: "invalid json" });
    }
    const ref = msg.ref;
    switch (msg.type) {
      case "ping":
        return send(ws, { type: "pong", ref });

      case "auth": {
        // Clients call this when their session refreshes.
        const claims = typeof msg.token === "string" ? await verify(msg.token, config.jwtSecret) : null;
        if (!claims) return send(ws, { type: "error", ref, message: "invalid token" });
        ws.data.claims = claims;
        return send(ws, { type: "ok", ref });
      }

      case "subscribe": {
        const filter = parseFilter(msg.filter);
        if (typeof msg.table !== "string" || filter === null || typeof ref !== "string") {
          return send(ws, { type: "error", ref, message: "subscribe needs ref, table and an optional col=eq.value filter" });
        }
        ws.data.subs.set(ref, {
          schema: typeof msg.schema === "string" ? msg.schema : "public",
          table: msg.table,
          event: typeof msg.event === "string" ? msg.event.toUpperCase() : "*",
          filter,
        });
        return send(ws, { type: "subscribed", ref });
      }

      case "unsubscribe":
        ws.data.subs.delete(ref);
        return send(ws, { type: "ok", ref });

      case "join": {
        const channel = msg.channel;
        if (typeof channel !== "string" || channel.length > 200) {
          return send(ws, { type: "error", ref, message: "join needs a channel" });
        }
        let allowed = false;
        try {
          const [row] = await asUser(ws.data.claims, (tx) => tx`select realtime.can_join(${channel}) as ok`);
          allowed = row?.ok === true;
        } catch (e) {
          console.error("[realtime] can_join failed", e);
        }
        if (!allowed) return send(ws, { type: "error", ref, channel, message: "not allowed to join channel" });
        ws.data.channels.set(channel, msg.presence && typeof msg.presence === "object" ? msg.presence : {});
        if (!channels.has(channel)) channels.set(channel, new Set());
        channels.get(channel)!.add(ws);
        send(ws, { type: "joined", ref, channel });
        return publishPresence(channel);
      }

      case "track": {
        if (!ws.data.channels.has(msg.channel)) return send(ws, { type: "error", ref, message: "join first" });
        ws.data.channels.set(msg.channel, msg.presence ?? {});
        return publishPresence(msg.channel);
      }

      case "leave":
        leave(ws, msg.channel);
        return send(ws, { type: "ok", ref });

      case "broadcast": {
        const set = channels.get(msg.channel);
        if (!set?.has(ws)) return send(ws, { type: "error", ref, message: "join first" });
        const out = JSON.stringify({
          type: "broadcast",
          channel: msg.channel,
          event: msg.event,
          payload: msg.payload,
          from: { key: ws.data.key, user_id: ws.data.claims.sub ?? null, email: ws.data.claims.email ?? null },
        });
        for (const peer of set) if (peer !== ws || msg.self) peer.send(out);
        return;
      }

      default:
        return send(ws, { type: "error", ref, message: `unknown message type ${msg.type}` });
    }
  },

  close(ws: WS) {
    sockets.delete(ws);
    for (const channel of [...ws.data.channels.keys()]) leave(ws, channel);
  },
};

type Change = { schema: string; table: string; type: "INSERT" | "UPDATE" | "DELETE"; pk: string; id: unknown };

async function fanOut(change: Change) {
  const targets: [WS, string, Sub][] = [];
  for (const ws of sockets) {
    for (const [ref, sub] of ws.data.subs) {
      if (sub.schema !== change.schema || sub.table !== change.table) continue;
      if (sub.event !== "*" && sub.event !== change.type) continue;
      targets.push([ws, ref, sub]);
    }
  }
  if (!targets.length) return;

  if (change.type === "DELETE") {
    // The row is gone so RLS can't be checked: only the primary key is sent.
    const old = { [change.pk]: change.id };
    for (const [ws, ref, sub] of targets) {
      if (sub.filter && sub.filter.column === change.pk && String(change.id) !== sub.filter.value) continue;
      send(ws, { type: "change", ref, event: "DELETE", schema: change.schema, table: change.table, old });
    }
    return;
  }

  // One RLS-checked read per distinct user, not per subscription.
  const rows = new Map<string, Promise<Record<string, unknown> | null>>();
  const now = Date.now() / 1000;
  for (const [ws, ref, sub] of targets) {
    const c = ws.data.claims;
    if (c.exp && c.exp < now) {
      send(ws, { type: "error", ref, message: "token expired, send {type:'auth'} with a fresh one" });
      continue;
    }
    const key = claimsKey(c);
    if (!rows.has(key)) {
      rows.set(
        key,
        asUser(c, async (tx) => {
          const [r] = await tx`
            select to_jsonb(t) as row from ${tx(change.schema)}.${tx(change.table)} t
            where t.${tx(change.pk)} = ${String(change.id)}`;
          return (r?.row as Record<string, unknown>) ?? null;
        }).catch((e) => {
          console.error("[realtime] read failed", e.message);
          return null;
        }),
      );
    }
    const row = await rows.get(key)!;
    if (!row) continue; // not visible to this user
    if (sub.filter && String(row[sub.filter.column]) !== sub.filter.value) continue;
    send(ws, { type: "change", ref, event: change.type, schema: change.schema, table: change.table, new: row });
  }
}

export async function startRealtime() {
  await sql.listen("cheapabase_realtime", (payload) => {
    try {
      fanOut(JSON.parse(payload)).catch((e) => console.error("[realtime]", e));
    } catch (e) {
      console.error("[realtime] bad payload", e);
    }
  });
}

export function stats() {
  return { connections: sockets.size, channels: channels.size };
}
