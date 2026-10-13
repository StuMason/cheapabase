// POST /functions/v1/cursors-visit  { browser, os, referrer }
// Records one page load for the cursors room and hands back the visitor's codename + location.
// Location comes from Cloudflare's visitor location headers (city level at most). The IP is
// never stored: it's HMAC'd with a key that changes daily, which is enough to count uniques.
import { createHmac } from "node:crypto";
import type { Handler } from "../server/functions";
import { config } from "../server/config";

const ADJ = ["Turquoise", "Velvet", "Feral", "Cosmic", "Sneaky", "Turbo", "Gilded", "Haunted", "Mighty", "Electric", "Lunar", "Rogue", "Crimson", "Quantum", "Fuzzy", "Stealth"];
const ANIMAL = ["Badger", "Otter", "Heron", "Lynx", "Walrus", "Gecko", "Moth", "Yak", "Falcon", "Narwhal", "Ferret", "Puffin", "Mantis", "Bison", "Axolotl", "Stoat"];

export function codename(hash: string) {
  const n = parseInt(hash.slice(0, 8), 16);
  return `${ADJ[n % ADJ.length]} ${ANIMAL[(n >>> 4) % ANIMAL.length]}`;
}

function header(req: Request, name: string) {
  const v = req.headers.get(name);
  // Cloudflare sends city names as raw UTF-8 bytes; re-decode so "São Paulo" survives.
  return v ? Buffer.from(v, "latin1").toString("utf8").slice(0, 80) : null;
}

const short = (v: unknown, n = 40) => (typeof v === "string" && v ? v.slice(0, n) : null);

const handler: Handler = async (req, { admin }) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = await req.json().catch(() => ({}));
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const visitor = createHmac("sha256", `${config.jwtSecret}:cursors:${day}`).update(ip).digest("hex").slice(0, 32);

  // A reload loop shouldn't be able to run the counter up forever.
  const [{ n }] = await admin`select count(*)::int as n from cursor_visits where day = ${day} and visitor = ${visitor}`;
  const lat = Number(req.headers.get("cf-iplatitude"));
  const lon = Number(req.headers.get("cf-iplongitude"));
  const row = {
    visitor,
    day,
    country: short(req.headers.get("cf-ipcountry"), 2),
    city: header(req, "cf-ipcity"),
    region: header(req, "cf-region"),
    timezone: short(req.headers.get("cf-timezone"), 60),
    // One decimal place is roughly 10km: enough for a dot on a globe, not for finding a house.
    lat: Number.isFinite(lat) && lat ? Math.round(lat * 10) / 10 : null,
    lon: Number.isFinite(lon) && lon ? Math.round(lon * 10) / 10 : null,
    browser: short(body.browser),
    os: short(body.os),
    referrer: short(body.referrer, 80),
  };
  if (n < 200) await admin`insert into cursor_visits ${admin(row)}`;
  const [{ loads }] = await admin`select count(*)::int as loads from cursor_visits`;

  return Response.json({
    name: codename(visitor),
    country: row.country,
    city: row.city,
    timezone: row.timezone,
    lat: row.lat,
    lon: row.lon,
    visit_number: loads,
  });
};

export default handler;
