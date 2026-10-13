// GET /functions/v1/cursors-ops - everything the operations centre shows, cached for 2s
// so a thousand dashboards polling it cost one set of queries.
import type { Handler } from "../server/functions";
import { channelSize, limits, stats } from "../server/realtime";

let cache: { at: number; body: string } | null = null;
let cpuPrev: { at: number; usec: number } | null = null;

async function cgroup() {
  // cgroup v2 inside the container: this covers the gateway, GoTrue and PostgREST, not Postgres.
  const read = (f: string) => Bun.file(`/sys/fs/cgroup/${f}`).text().catch(() => null);
  const mem = Number((await read("memory.current"))?.trim()) || null;
  const usec = Number((await read("cpu.stat"))?.match(/usage_usec (\d+)/)?.[1]) || null;
  let cpu: number | null = null;
  if (usec !== null) {
    const now = Date.now();
    if (cpuPrev && now > cpuPrev.at) cpu = (usec - cpuPrev.usec) / ((now - cpuPrev.at) * 1000);
    cpuPrev = { at: now, usec };
  }
  // Real bytes on the wire (after any websocket compression), summed over non-loopback interfaces.
  const net = (await Bun.file("/proc/net/dev").text().catch(() => ""))
    .split("\n")
    .slice(2)
    .map((l) => l.trim().split(/[:\s]+/))
    .filter((f) => f.length > 9 && f[0] !== "lo")
    .reduce((sum, f) => sum + Number(f[9]), 0);
  return { memory_bytes: mem ?? process.memoryUsage().rss, cpu_cores: cpu, net_tx_bytes: net || null };
}

const handler: Handler = async (_req, { admin }) => {
  if (cache && Date.now() - cache.at < 2000) {
    return new Response(cache.body, { headers: { "content-type": "application/json" } });
  }
  const live = channelSize("cursors");
  await admin`update cursor_totals set value = ${live} where name = 'peak_concurrent' and value < ${live}`;

  const [counts] = await admin`
    select count(*)::int as page_loads,
           count(distinct visitor) filter (where day = current_date)::int as uniques_today,
           count(distinct (day, visitor))::int as visitor_days,
           count(distinct country)::int as countries,
           count(distinct city)::int as cities
    from cursor_visits`;
  const totals = Object.fromEntries((await admin`select name, value from cursor_totals`).map((r) => [r.name, r.value]));
  const top = await admin`
    select country, count(*)::int as n from cursor_visits where country is not null
    group by country order by n desc limit 12`;
  const recent = await admin`
    select at, country, city, browser, os from cursor_visits order by at desc limit 15`;
  const dots = await admin`
    select lat, lon, count(*)::int as n from cursor_visits where lat is not null
    group by lat, lon order by n desc limit 500`;

  const body = JSON.stringify({
    at: new Date().toISOString(),
    live,
    counts,
    totals,
    top_countries: top,
    recent,
    dots,
    server: { realtime: stats(), tick_ms: limits.tickMs, container: await cgroup(), uptime_s: Math.round(process.uptime()) },
  });
  cache = { at: Date.now(), body };
  return new Response(body, { headers: { "content-type": "application/json" } });
};

export default handler;
