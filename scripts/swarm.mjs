// Bot swarm for the cursors room: N real websocket clients drawing Lissajous curves.
//   node scripts/swarm.mjs <url> [bots=100] [seconds=60] [rampSeconds=20]
// Every bot is labelled bot:true in presence, so the page shows it as a bot.
// Prints a JSON summary: how many connected, frames each bot received, bytes in, lag.
// Uses the `ws` package (npm i --no-save ws): Node's built-in WebSocket can't inflate Bun's
// compressed published frames and hands back empty strings when REALTIME_COMPRESS=true.
import WebSocket from "ws";
const [url = "http://localhost:8000", nArg = "100", secArg = "60", rampArg = "20"] = process.argv.slice(2);
const N = Number(nArg);
const SECONDS = Number(secArg);
const RAMP = Number(rampArg);

const { anonKey } = await (await fetch(`${url}/config.json`)).json();
const wsUrl = `${url.replace(/^http/, "ws")}/realtime/v1?apikey=${anonKey}`;
const t0 = Date.now();
const stats = { connected: 0, joined: 0, errors: 0, closed: 0, frames: 0, bytes_in: 0, rate_limited: 0, max_gap_ms: 0 };
const bots = [];

function bot(i) {
  const ws = new WebSocket(wsUrl);
  const b = { ws, i, last: 0, clicks: 0, a: 1 + (i % 5), bb: 2 + (i % 7), phase: i * 0.37 };
  ws.onopen = () => {
    stats.connected++;
    ws.send(JSON.stringify({ type: "join", ref: "j", channel: "cursors", presence: { n: `Bot ${String(i).padStart(4, "0")}`, bot: true } }));
  };
  ws.onmessage = (e) => {
    const data = String(e.data);
    stats.bytes_in += data.length;
    if (data.startsWith('{"type":"states"')) {
      stats.frames++;
      const now = Date.now();
      if (b.last && now - t0 > (RAMP + 5) * 1000) stats.max_gap_ms = Math.max(stats.max_gap_ms, now - b.last);
      b.last = now;
      return;
    }
    const m = JSON.parse(data);
    if (m.type === "joined") stats.joined++;
    if (m.type === "error") (m.message.startsWith("rate limited") ? stats.rate_limited++ : stats.errors++);
  };
  ws.onerror = () => stats.errors++;
  ws.onclose = () => stats.closed++;
  bots.push(b);
}

for (let i = 0; i < N; i++) setTimeout(() => bot(i), (i / N) * RAMP * 1000);

const move = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    const x = Math.round(5000 + 4200 * Math.sin(b.a * t * 0.6 + b.phase));
    const y = Math.round(5000 + 4200 * Math.sin(b.bb * t * 0.6));
    if (Math.random() < 0.01) b.clicks++;
    b.ws.send(JSON.stringify({ type: "state", channel: "cursors", payload: [x, y, b.clicks, 0] }));
  }
}, 100);

const report = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`[swarm] t=${s}s connected=${stats.connected} joined=${stats.joined} closed=${stats.closed} frames=${stats.frames} in=${(stats.bytes_in / 1048576).toFixed(1)}MB errors=${stats.errors}`);
}, 5000);

setTimeout(() => {
  clearInterval(move);
  clearInterval(report);
  for (const b of bots) b.ws.close();
  const secs = (Date.now() - t0) / 1000;
  console.log(JSON.stringify({ bots: N, seconds: SECONDS, ...stats, mb_in: +(stats.bytes_in / 1048576).toFixed(1), mb_per_s: +(stats.bytes_in / 1048576 / secs).toFixed(2), frames_per_bot_per_s: +(stats.frames / Math.max(1, stats.joined) / secs).toFixed(2) }));
  setTimeout(() => process.exit(0), 1000);
}, SECONDS * 1000);
