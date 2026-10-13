// CURSORS // Global Operations Centre.
// Everyone on the page shares one realtime channel, "cursors". Each client sends its latest
// cursor as channel *state* ([x, y, clicks, ping], x/y in 0..10000 of the viewport); the server
// keeps only the newest per client and flushes one frame per tick. Presence carries who you are.
import { RealtimeClient } from "/realtime.js";

const $ = (id) => document.getElementById(id);
const SCALE = 10000;
const PX_TO_KM = 0.0254 / 96 / 1000; // CSS px at 96dpi, in km

const me = { name: null, country: null, city: null, x: -1, y: -1, clicks: 0, ping: 0, lastSent: 0, dirty: false };
const cursors = new Map(); // key -> { meta, x, y, tx, ty, c, ping, seen, moved, dist, speeds: [] , ripples: [] }
let myKey = null;
let room = null;
let rt = null;

const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🏴‍☠️");
const fmt = (n) => (n == null || Number.isNaN(n) ? "-" : Math.round(n).toLocaleString("en-GB"));
const hue = (key) => [...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

function browserInfo() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Mystery browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  let referrer = null;
  try {
    referrer = document.referrer ? new URL(document.referrer).host : null;
  } catch {}
  return { browser, os, referrer };
}

async function fn(name, body) {
  const res = await fetch(`/functions/v1/${name}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ---------- boot ----------
const { anonKey } = await (await fetch("/config.json")).json();
const visit = await fn("cursors-visit", browserInfo()).catch(() => ({}));
Object.assign(me, { name: visit.name ?? "Anonymous Ghost", country: visit.country, city: visit.city });
$("you-name").textContent = `${flag(me.country)} ${me.name}`;
$("you-where").textContent = [me.city, me.country, visit.timezone].filter(Boolean).join(" · ") || "location classified";
$("you-n").textContent = visit.visit_number ? `page load #${fmt(visit.visit_number)}` : "";

rt = new RealtimeClient(location.origin, () => anonKey);
room = rt.channel("cursors", { presence: { n: me.name, cc: me.country, city: me.city } });
room.onPresence(onRoster).onStates(onStates);
// The server names each socket in its "ready" message; that's how we skip drawing ourselves,
// and it changes on every reconnect.
const handle = rt.handle.bind(rt);
rt.handle = (m) => {
  if (m.type === "ready") myKey = m.key;
  handle(m);
};
await room.join();

// ---------- presence + state ----------
function onRoster(users) {
  const keys = new Set(users.map((u) => u.key));
  for (const k of cursors.keys()) if (!keys.has(k)) cursors.delete(k);
  for (const u of users) {
    const c = cursors.get(u.key);
    if (c) c.meta = u;
    else cursors.set(u.key, { meta: u, x: -1, y: -1, tx: -1, ty: -1, c: 0, ping: 0, seen: performance.now(), moved: performance.now(), dist: 0, speeds: [], ripples: [], joined: performance.now() });
  }
  const bots = users.filter((u) => u.bot).length;
  $("swarm").classList.toggle("hidden", bots === 0);
  $("swarm-n").textContent = fmt(bots);
  $("t-live").textContent = fmt(users.length);
  threat(users.length);
}

function onStates(states) {
  const now = performance.now();
  const w = innerWidth;
  const h = innerHeight;
  for (const [key, p] of states) {
    const c = cursors.get(key);
    if (!c || !Array.isArray(p)) continue;
    const [x, y, clicks = 0, ping = 0] = p;
    const nx = (x / SCALE) * w;
    const ny = (y / SCALE) * h;
    if (c.tx >= 0) {
      const d = Math.hypot(nx - c.tx, ny - c.ty);
      if (d > 0) {
        c.dist += d;
        c.speeds.push([now, d / Math.max(0.016, (now - c.seen) / 1000)]);
        c.moved = now;
      }
    } else {
      c.x = nx;
      c.y = ny;
    }
    if (clicks > c.c && c.tx >= 0) c.ripples.push({ x: nx, y: ny, t: now });
    Object.assign(c, { tx: nx, ty: ny, c: clicks, ping, seen: now });
  }
}

// ---------- my cursor ----------
function move(clientX, clientY) {
  const x = Math.round((clientX / innerWidth) * SCALE);
  const y = Math.round((clientY / innerHeight) * SCALE);
  if (me.x >= 0) myDistance += Math.hypot(clientX - (me.x / SCALE) * innerWidth, clientY - (me.y / SCALE) * innerHeight);
  me.x = x;
  me.y = y;
  me.dirty = true;
}
let myDistance = 0;
let myClicks = 0;
let myRage = 0;
let clickTimes = [];
addEventListener("pointermove", (e) => move(e.clientX, e.clientY), { passive: true });
addEventListener("pointerdown", (e) => {
  move(e.clientX, e.clientY);
  me.clicks++;
  myClicks++;
  const t = performance.now();
  clickTimes = clickTimes.filter((c) => t - c < 1000).concat(t);
  if (clickTimes.length >= 4) {
    myRage++;
    clickTimes = [];
  }
});

// Send at most every 50ms while moving; the server flushes per tick anyway. Heartbeat every 5s
// so ping updates and idle cursors don't vanish from leaderboards.
setInterval(() => {
  const now = performance.now();
  if (me.x < 0) return;
  if (me.dirty || now - me.lastSent > 5000) {
    room.setState([me.x, me.y, me.clicks, me.ping]);
    me.dirty = false;
    me.lastSent = now;
  }
}, 50);

async function measurePing() {
  const t = performance.now();
  try {
    await rt.request({ type: "ping" });
    me.ping = Math.round(performance.now() - t);
    $("t-ping").textContent = `${me.ping}ms`;
  } catch {}
}
setInterval(measurePing, 5000);
measurePing();

setInterval(() => {
  if (!myDistance && !myClicks) return;
  fn("cursors-tally", { distance_px: myDistance, clicks: myClicks, rage_clicks: myRage }).catch(() => {});
  myDistance = myClicks = myRage = 0;
}, 5000);

// ---------- drawing ----------
const arena = $("arena");
const ctx = arena.getContext("2d");
function resize() {
  arena.width = innerWidth * devicePixelRatio;
  arena.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
addEventListener("resize", resize);
resize();

function drawArrow(x, y, color, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.5, 13);
  ctx.lineTo(8, 20);
  ctx.lineTo(10.5, 19);
  ctx.lineTo(7, 12);
  ctx.lineTo(12.5, 12);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

function frame() {
  const now = performance.now();
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // grid
  ctx.strokeStyle = "rgba(0,255,170,.05)";
  ctx.lineWidth = 1;
  for (let gx = 0; gx < innerWidth; gx += 48) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, innerHeight);
    ctx.stroke();
  }
  for (let gy = 0; gy < innerHeight; gy += 48) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(innerWidth, gy);
    ctx.stroke();
  }

  const crowd = cursors.size;
  const labels = crowd <= 150;
  ctx.font = "11px ui-monospace, Menlo, monospace";
  for (const [key, c] of cursors) {
    if (key === myKey || c.tx < 0) continue;
    c.x += (c.tx - c.x) * 0.35;
    c.y += (c.ty - c.y) * 0.35;
    const bot = c.meta.bot;
    const color = bot ? "rgba(150,150,150,.55)" : `hsl(${hue(key)} 95% 60%)`;
    for (const r of c.ripples) {
      const age = (now - r.t) / 600;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 6 + age * 40, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue(key)} 95% 60% / ${1 - age})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    c.ripples = c.ripples.filter((r) => now - r.t < 600);
    drawArrow(c.x, c.y, color, bot ? 0.7 : 1);
    if (labels || !bot) {
      const text = bot ? `🤖 ${c.meta.n ?? "bot"}` : `${flag(c.meta.cc)} ${c.meta.n ?? "?"}${c.meta.city ? " · " + c.meta.city : ""}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = bot ? "rgba(40,40,40,.7)" : `hsl(${hue(key)} 80% 25% / .85)`;
      ctx.fillRect(c.x + 12, c.y + 16, tw + 8, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, c.x + 16, c.y + 28);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- leaderboards (computed locally from the shared state stream) ----------
function board(id, rows) {
  $(id).replaceChildren(
    ...rows.slice(0, 5).map(([c, v]) => {
      const li = document.createElement("li");
      li.textContent = `${c.meta.bot ? "🤖" : flag(c.meta.cc)} ${c.meta.n ?? "?"}  ${v}`;
      return li;
    }),
  );
}
setInterval(() => {
  const now = performance.now();
  const all = [...cursors.values()];
  for (const c of all) c.speeds = c.speeds.filter(([t]) => now - t < 10000);
  const pxToCm = 2.54 / 96;
  board("b-fast", all.map((c) => [c, Math.max(0, ...c.speeds.map(([, s]) => s))]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c, s]) => [c, `${(s * pxToCm / 100).toFixed(2)} m/s`]));
  board("b-far", all.filter((c) => c.dist > 0).sort((a, b) => b.dist - a.dist).map((c) => [c, `${(c.dist * pxToCm / 100).toFixed(1)} m`]));
  board("b-ping", all.filter((c) => c.ping > 0).sort((a, b) => b.ping - a.ping).map((c) => [c, `${c.ping}ms`]));
  board("b-idle", all.filter((c) => c.tx >= 0).sort((a, b) => a.moved - b.moved).map((c) => [c, `${Math.round((now - c.moved) / 1000)}s`]));
}, 1000);

// ---------- ops feed ----------
let prev = null;
const history = [];
async function poll() {
  const o = await fn("cursors-ops").catch(() => null);
  if (!o) return;
  $("t-peak").textContent = fmt(o.totals.peak_concurrent);
  $("t-loads").textContent = fmt(o.counts.page_loads);
  $("t-uniq").textContent = fmt(o.counts.uniques_today);
  $("t-countries").textContent = fmt(o.counts.countries);
  $("t-cities").textContent = fmt(o.counts.cities);
  $("t-km").textContent = ((o.totals.distance_px ?? 0) * PX_TO_KM).toFixed(4);
  $("t-clicks").textContent = fmt(o.totals.clicks);
  $("t-rage").textContent = fmt(o.totals.rage_clicks);

  const s = o.server;
  const mem = s.container.memory_bytes / 1048576;
  $("s-mem").textContent = `${mem.toFixed(1)} MB`;
  $("s-cpu").textContent = s.container.cpu_cores == null ? "-" : `${(s.container.cpu_cores * 100).toFixed(1)}% of a core`;
  if (prev) {
    const dt = (new Date(o.at) - new Date(prev.at)) / 1000;
    if (dt > 0) {
      const inS = (s.realtime.msgs_in - prev.server.realtime.msgs_in) / dt;
      const outS = (s.realtime.msgs_out - prev.server.realtime.msgs_out) / dt;
      const bw = (s.realtime.bytes_out - prev.server.realtime.bytes_out) / dt;
      $("s-in").textContent = fmt(inS);
      $("s-out").textContent = fmt(outS);
      $("s-bw").textContent = bw > 1048576 ? `${(bw / 1048576).toFixed(2)} MB/s` : `${(bw / 1024).toFixed(1)} KB/s`;
      history.push(outS);
      if (history.length > 60) history.shift();
      const max = Math.max(1, ...history);
      $("spark-line").setAttribute("points", history.map((v, i) => `${(i / 59) * 200},${40 - (v / max) * 38}`).join(" "));
    }
  }
  $("s-drop").textContent = fmt(s.realtime.dropped);
  $("s-tick").textContent = `${s.tick_ms}ms`;
  $("s-up").textContent = `${Math.floor(s.uptime_s / 3600)}h ${Math.floor((s.uptime_s % 3600) / 60)}m`;
  // Railway: $10 per GB-month RAM, $20 per vCPU-month, ~730 hours a month, ~0.79 GBP per USD.
  const usdHour = ((mem / 1024) * 10 + (s.container.cpu_cores ?? 0) * 20) / 730;
  $("s-cost").textContent = `£${(usdHour * 0.79).toFixed(6)}`;
  prev = o;

  $("countries").replaceChildren(
    ...o.top_countries.map((c) => {
      const li = document.createElement("li");
      li.textContent = `${flag(c.country)} ${c.country} ${fmt(c.n)}`;
      return li;
    }),
  );
  $("feed").replaceChildren(
    ...o.recent.map((v) => {
      const li = document.createElement("li");
      const ago = Math.max(0, Math.round((Date.now() - new Date(v.at)) / 1000));
      const when = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`;
      li.textContent = `${flag(v.country)} ${v.city ?? "somewhere"}${v.country ? ", " + v.country : ""} · ${v.browser ?? "?"}/${v.os ?? "?"} · ${when} ago`;
      return li;
    }),
  );
  dots = o.dots;
  drawGlobe();
}
setInterval(poll, 3000);
poll();

// ---------- map ----------
let land = null;
let dots = [];
const globe = $("globe");
const g = globe.getContext("2d");
const proj = (lon, lat) => [((lon + 180) / 360) * globe.width, ((90 - lat) / 180) * globe.height];
function drawGlobe() {
  g.clearRect(0, 0, globe.width, globe.height);
  g.strokeStyle = "rgba(0,255,170,.08)";
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = proj(lon, 0);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, globe.height);
    g.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = proj(0, lat);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(globe.width, y);
    g.stroke();
  }
  if (land) {
    g.fillStyle = "rgba(0,255,170,.14)";
    for (const poly of land) {
      g.beginPath();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => {
          const [x, y] = proj(lon, lat);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
      }
      g.fill("evenodd");
    }
  }
  const pulse = (Math.sin(performance.now() / 300) + 1) / 2;
  for (const d of dots) {
    const [x, y] = proj(Number(d.lon), Number(d.lat));
    g.beginPath();
    g.arc(x, y, 1.5 + Math.min(6, Math.log2(d.n + 1)), 0, Math.PI * 2);
    g.fillStyle = `rgba(255,${120 + pulse * 80},60,.85)`;
    g.fill();
  }
}
setInterval(drawGlobe, 250);
// Land outlines are decoration: if the CDN is down the dots still draw on the grid.
import("https://cdn.jsdelivr.net/npm/topojson-client@3/+esm")
  .then(async (topojson) => {
    const world = await (await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json")).json();
    const geo = topojson.feature(world, world.objects.land);
    land = geo.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
    drawGlobe();
  })
  .catch(() => {});

// ---------- theatre ----------
function threat(n) {
  const levels = [
    [1000, "UNPRECEDENTED", "#ff2d55"],
    [500, "SEVERE", "#ff3b30"],
    [100, "ELEVATED", "#ff9500"],
    [10, "GUARDED", "#ffcc00"],
    [2, "COMPANY", "#30d158"],
    [0, "LONELY", "#64d2ff"],
  ];
  const [, label, color] = levels.find(([min]) => n >= min);
  $("threat-level").textContent = label;
  $("threat").style.color = color;
}
setInterval(() => ($("clock").textContent = new Date().toISOString().slice(11, 19) + " UTC"), 1000);
$("hud-toggle").addEventListener("click", () => {
  document.body.classList.toggle("nohud");
  $("hud-toggle").textContent = document.body.classList.contains("nohud") ? "show HUD" : "hide HUD";
});
