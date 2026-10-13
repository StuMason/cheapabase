// POST /functions/v1/cursors-tally  { distance_px, clicks, rage_clicks }
// Adds a visitor's last few seconds of mouse activity to the all-time totals.
// Client-reported, so each call is clamped and each visitor is limited to one call per 4s.
import type { Handler } from "../server/functions";

const last = new Map<string, number>();
const caps = { distance_px: 200_000, clicks: 100, rage_clicks: 20 } as const;

const handler: Handler = async (req, { admin }) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const now = Date.now();
  if (now - (last.get(who) ?? 0) < 4000) return Response.json({ ok: false, error: "too soon" }, { status: 429 });
  last.set(who, now);
  if (last.size > 50_000) last.clear();

  const body = await req.json().catch(() => ({}));
  for (const [name, cap] of Object.entries(caps)) {
    const v = Math.min(cap, Math.max(0, Number(body[name]) || 0));
    if (v > 0) await admin`update cursor_totals set value = value + ${v} where name = ${name}`;
  }
  return Response.json({ ok: true });
};

export default handler;
