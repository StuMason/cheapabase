// Tiny client for cheapabase realtime. Works in the browser and in Bun/Node 22+.
//
//   const rt = new RealtimeClient("https://your-app.up.railway.app", () => session?.access_token ?? anonKey)
//   const stop = await rt.on("todos", { event: "*", filter: "list_id=eq.42" }, (change) => ...)
//   const room = rt.channel("room:1", { presence: { name: "Ada" } })
//   room.on("cursor", (payload, from) => ...); room.onPresence((users) => ...)
//   await room.join(); room.send("cursor", { x: 1, y: 2 })
//   room.setState({ x: 1, y: 2 }); room.onStates((states) => ...)  // latest-value, batched per server tick

export class RealtimeClient {
  constructor(url, getToken) {
    this.url = url.replace(/^http/, "ws").replace(/\/$/, "") + "/realtime/v1";
    this.getToken = getToken;
    this.subs = new Map(); // ref -> { opts, cb }
    this.channels = new Map(); // name -> Channel
    this.pending = new Map(); // ref -> { resolve, reject }
    this.queue = [];
    this.closed = false;
    this.reconnectTimer = null;
    this.retry = 0;
    this.n = 0;
    this.connect();
  }

  connect() {
    const token = this.getToken();
    const ws = (this.ws = new WebSocket(`${this.url}?token=${encodeURIComponent(token)}`));
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.retry = 0;
      // Subscriptions and joins are (re)sent from state on every open, never queued,
      // so a reconnect restores them and nothing is sent twice.
      for (const [ref, s] of this.subs) this.raw({ type: "subscribe", ref, ...s.opts });
      for (const ch of this.channels.values()) if (ch.joined || ch.joinRef) ch.rejoin();
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => ws === this.ws && this.handle(JSON.parse(e.data));
    // Some runtimes fire close more than once; only the current socket may schedule
    // one reconnect, otherwise we'd open a second, orphaned connection.
    ws.onclose = () => {
      if (this.closed || ws !== this.ws || this.reconnectTimer) return;
      const delay = Math.min(10000, 250 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closed) this.connect();
      }, delay);
    };
    clearInterval(this.ping);
    this.ping = setInterval(() => this.raw({ type: "ping" }), 25000);
  }

  raw(msg, { queue = true } = {}) {
    const s = JSON.stringify(msg);
    if (this.ws.readyState === 1) this.ws.send(s);
    else if (queue) this.queue.push(s);
  }

  request(msg, opts) {
    const ref = msg.ref ?? `r${++this.n}`;
    return new Promise((resolve, reject) => {
      this.pending.set(ref, { resolve, reject });
      this.raw({ ...msg, ref }, opts);
    });
  }

  handle(msg) {
    const p = msg.ref && this.pending.get(msg.ref);
    if (p && msg.type !== "change") {
      this.pending.delete(msg.ref);
      msg.type === "error" ? p.reject(new Error(msg.message)) : p.resolve(msg);
    }
    if (msg.type === "change") this.subs.get(msg.ref)?.cb(msg);
    else if (msg.type === "broadcast") this.channels.get(msg.channel)?.emit(msg.event, msg.payload, msg.from);
    else if (msg.type === "presence") this.channels.get(msg.channel)?.presence(msg.users);
    else if (msg.type === "presence_diff") this.channels.get(msg.channel)?.presenceDiff(msg.joins, msg.leaves);
    else if (msg.type === "states") this.channels.get(msg.channel)?.states(msg.states);
    else if (msg.type === "error" && !p) console.warn("[realtime]", msg.message);
  }

  /** Subscribe to row changes. Resolves to an unsubscribe function. */
  async on(table, { schema = "public", event = "*", filter } = {}, cb) {
    const ref = `s${++this.n}`;
    const opts = { table, schema, event, filter };
    this.subs.set(ref, { opts, cb });
    await this.request({ type: "subscribe", ref, ...opts }, { queue: false });
    return () => {
      this.subs.delete(ref);
      this.raw({ type: "unsubscribe", ref });
    };
  }

  channel(name, { presence } = {}) {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = new Channel(this, name, presence);
      this.channels.set(name, ch);
    } else if (presence) {
      ch.meta = presence;
    }
    return ch;
  }

  /** Call when the user's session refreshes or they sign in/out. */
  setAuth(token) {
    return this.request({ type: "auth", token });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.ping);
    this.ws.close();
  }
}

class Channel {
  constructor(client, name, presence) {
    this.client = client;
    this.name = name;
    this.meta = presence ?? {};
    this.handlers = new Map();
    this.presenceHandlers = new Set();
    this.stateHandlers = new Set();
    this.users = [];
    this.joined = false;
  }
  async join() {
    this.client.channels.set(this.name, this);
    this.joinRef = `j${++this.client.n}`;
    try {
      await this.client.request({ type: "join", ref: this.joinRef, channel: this.name, presence: this.meta }, { queue: false });
    } catch (e) {
      this.client.channels.delete(this.name);
      throw e;
    } finally {
      this.joinRef = null;
    }
    this.joined = true;
    return this;
  }
  rejoin() {
    // Reuse a pending join's ref so its promise still resolves.
    this.client.raw({ type: "join", ref: this.joinRef ?? undefined, channel: this.name, presence: this.meta });
  }
  leave() {
    this.joined = false;
    this.client.channels.delete(this.name);
    this.client.raw({ type: "leave", channel: this.name });
  }
  track(meta) {
    this.meta = meta;
    this.client.raw({ type: "track", channel: this.name, presence: meta });
  }
  /** Latest-value state (e.g. a cursor). The server keeps only the newest and flushes once per tick. */
  setState(payload) {
    this.client.raw({ type: "state", channel: this.name, payload }, { queue: false });
  }
  /** cb(states): array of [key, payload] that changed this tick. key matches presence entries. */
  onStates(cb) {
    this.stateHandlers.add(cb);
    return this;
  }
  send(event, payload, { self = false } = {}) {
    this.client.raw({ type: "broadcast", channel: this.name, event, payload, self });
  }
  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(cb);
    return this;
  }
  onPresence(cb) {
    this.presenceHandlers.add(cb);
    return this;
  }
  emit(event, payload, from) {
    for (const cb of this.handlers.get(event) ?? []) cb(payload, from);
    for (const cb of this.handlers.get("*") ?? []) cb(payload, from, event);
  }
  presence(users) {
    this.users = users;
    for (const cb of this.presenceHandlers) cb(users);
  }
  presenceDiff(joins = [], leaves = []) {
    const gone = new Set([...leaves, ...joins.map((u) => u.key)]);
    this.presence([...this.users.filter((u) => !gone.has(u.key)), ...joins]);
  }
  states(states) {
    for (const cb of this.stateHandlers) cb(states);
  }
}
