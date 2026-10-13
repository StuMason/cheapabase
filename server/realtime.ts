// Realtime over a single websocket at /realtime/v1.
//
// Two features, both small:
//   1. Database changes: tables opt in with `select realtime.enable('public.todos')`.
//      A trigger sends the row's primary key over LISTEN/NOTIFY. For every subscriber we
//      re-read that row *as the subscriber* (same role + JWT claims as PostgREST), so RLS
//      decides who receives what. Deletes only carry the primary key.
//   2. Channels: broadcast messages and presence between clients. Joining is gated by
//      the SQL function realtime.can_join(channel), which also runs as the user.
//      Fan-out uses Bun's native pub/sub (one serialization per message, not per peer).
//      Presence goes out as diffs (the joiner gets the full roster, everyone else one entry),
//      and `state` messages keep only each client's latest value and flush once per tick,
//      so fast-changing data like cursors costs one frame per tick, not one per move.
//
// The wire protocol is plain JSON, documented in docs/realtime.md.
import type { Server, ServerWebSocket } from "bun";
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
  /** Token bucket for the inbound rate limit. */
  budget: number;
  refilled: number;
  warned: boolean;
};
type WS = ServerWebSocket<SocketData>;

const sockets = new Set<WS>();
const channels = new Map<string, Set<WS>>();
// channel -> socket key -> latest state payload not yet flushed
const dirty = new Map<string, Map<string, unknown>>();
let server: Server<SocketData> | null = null;

export const limits = {
  /** Inbound messages per second per socket (burst = 2x). Extra messages are dropped. */
  msgsPerSec: Number(process.env.REALTIME_MAX_MSGS_PER_SEC ?? 60),
  /** Largest inbound message in bytes; bigger ones close the socket. */
  maxPayload: Number(process.env.REALTIME_MAX_PAYLOAD ?? 64 * 1024),
  /** Most sockets one channel can hold. */
  channelMembers: Number(process.env.REALTIME_MAX_CHANNEL_MEMBERS ?? 2000),
  /** How often coalesced `state` messages are flushed, in ms. */
  tickMs: Number(process.env.REALTIME_TICK_MS ?? 100),
};

const counters = { msgsIn: 0, msgsOut: 0, bytesOut: 0, dropped: 0, started: Date.now() };

function send(ws: WS, msg: unknown) {
  const out = JSON.stringify(msg);
  counters.msgsOut++;
  counters.bytesOut += out.length;
  ws.send(out);
}

const topic = (channel: string) => `ch:${channel}`;

/** Send to every member of a channel, optionally skipping one socket. Serializes once. */
function publish(channel: string, msg: unknown, except?: WS) {
  const out = JSON.stringify(msg);
  const n = (channels.get(channel)?.size ?? 0) - (except ? 1 : 0);
  if (n <= 0) return;
  counters.msgsOut += n;
  counters.bytesOut += out.length * n;
  if (except) except.publish(topic(channel), out);
  else server!.publish(topic(channel), out);
}

/** Short socket keys keep presence and state frames small. Unique per process. */
const boot = Math.random().toString(36).slice(2, 5);
let nextKey = 0;
export function newKey() {
  return `${boot}${(nextKey++).toString(36)}`;
}

/** Token bucket: refill msgsPerSec per second up to 2x burst. */
export function allow(d: Pick<SocketData, "budget" | "refilled">, now = Date.now(), rate = limits.msgsPerSec) {
  d.budget = Math.min(rate * 2, d.budget + ((now - d.refilled) / 1000) * rate);
  d.refilled = now;
  if (d.budget < 1) return false;
  d.budget -= 1;
  return true;
}

function claimsKey(c: Claims) {
  return `${c.role ?? "anon"}:${c.sub ?? ""}`;
}

function presenceEntry(ws: WS, channel: string) {
  return {
    key: ws.data.key,
    user_id: ws.data.claims.sub ?? null,
    email: ws.data.claims.email ?? null,
    ...ws.data.channels.get(channel),
  };
}

function presenceList(channel: string) {
  return [...(channels.get(channel) ?? [])].map((ws) => presenceEntry(ws, channel));
}

function leave(ws: WS, channel: string) {
  if (!ws.data.channels.delete(channel)) return;
  ws.unsubscribe(topic(channel));
  dirty.get(channel)?.delete(ws.data.key);
  const set = channels.get(channel);
  set?.delete(ws);
  if (set?.size === 0) {
    channels.delete(channel);
    dirty.delete(channel);
  } else publish(channel, { type: "presence_diff", channel, joins: [], leaves: [ws.data.key] });
}

/** Flush coalesced state: one frame per channel per tick, holding only what changed. */
export function flushStates() {
  for (const [channel, states] of dirty) {
    if (!states.size) continue;
    publish(channel, { type: "states", channel, states: [...states] });
    states.clear();
  }
}

export async function upgradeData(req: Request): Promise<SocketData | null> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? url.searchParams.get("apikey");
  const claims = token ? await verify(token, config.jwtSecret) : null;
  if (!claims) return null;
  return { claims, subs: new Map(), channels: new Map(), key: newKey(), budget: limits.msgsPerSec * 2, refilled: Date.now(), warned: false };
}

export const websocket = {
  maxPayloadLength: limits.maxPayload,
  // Trades CPU for bandwidth; worth it when frames are big and repetitive (cursors).
  perMessageDeflate: process.env.REALTIME_COMPRESS === "true",

  open(ws: WS) {
    sockets.add(ws);
    send(ws, { type: "ready", key: ws.data.key, user: { id: ws.data.claims.sub ?? null, role: ws.data.claims.role } });
  },

  async message(ws: WS, raw: string | Buffer) {
    counters.msgsIn++;
    if (!allow(ws.data)) {
      counters.dropped++;
      if (!ws.data.warned) {
        ws.data.warned = true;
        send(ws, { type: "error", message: `rate limited: over ${limits.msgsPerSec} messages per second, extra messages are dropped` });
      }
      return;
    }
    ws.data.warned = false;
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
        if (!channels.has(channel)) channels.set(channel, new Set());
        const set = channels.get(channel)!;
        if (!set.has(ws) && set.size >= limits.channelMembers) {
          return send(ws, { type: "error", ref, channel, message: "channel is full" });
        }
        ws.data.channels.set(channel, msg.presence && typeof msg.presence === "object" ? msg.presence : {});
        set.add(ws);
        ws.subscribe(topic(channel));
        send(ws, { type: "joined", ref, channel });
        // Full roster to the joiner, one entry to everyone else.
        send(ws, { type: "presence", channel, users: presenceList(channel) });
        return publish(channel, { type: "presence_diff", channel, joins: [presenceEntry(ws, channel)], leaves: [] }, ws);
      }

      case "track": {
        if (!ws.data.channels.has(msg.channel)) return send(ws, { type: "error", ref, message: "join first" });
        ws.data.channels.set(msg.channel, msg.presence && typeof msg.presence === "object" ? msg.presence : {});
        return publish(msg.channel, { type: "presence_diff", channel: msg.channel, joins: [presenceEntry(ws, msg.channel)], leaves: [] });
      }

      case "state": {
        // Latest value wins; flushed to the whole channel (sender included) every tick.
        if (!ws.data.channels.has(msg.channel)) return send(ws, { type: "error", ref, message: "join first" });
        if (!dirty.has(msg.channel)) dirty.set(msg.channel, new Map());
        dirty.get(msg.channel)!.set(ws.data.key, msg.payload ?? null);
        return;
      }

      case "leave":
        leave(ws, msg.channel);
        return send(ws, { type: "ok", ref });

      case "broadcast": {
        if (!channels.get(msg.channel)?.has(ws)) return send(ws, { type: "error", ref, message: "join first" });
        const out = {
          type: "broadcast",
          channel: msg.channel,
          event: msg.event,
          payload: msg.payload,
          from: { key: ws.data.key, user_id: ws.data.claims.sub ?? null, email: ws.data.claims.email ?? null },
        };
        return publish(msg.channel, out, msg.self ? undefined : ws);
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

/** Hand realtime the running server so it can publish to channel topics. */
export function attach(srv: Server<SocketData>) {
  server = srv;
  setInterval(flushStates, limits.tickMs);
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
  return {
    connections: sockets.size,
    channels: channels.size,
    msgs_in: counters.msgsIn,
    msgs_out: counters.msgsOut,
    bytes_out: counters.bytesOut,
    dropped: counters.dropped,
    since: new Date(counters.started).toISOString(),
  };
}

export function channelSize(channel: string) {
  return channels.get(channel)?.size ?? 0;
}
