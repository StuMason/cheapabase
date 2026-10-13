// cheapabase gateway: one Bun process that
//   - runs migrations and starts auth (GoTrue) + PostgREST on localhost
//   - proxies /auth/v1 and /rest/v1 with the same paths Supabase uses (supabase-js just works)
//   - serves realtime (/realtime/v1), functions (/functions/v1/<name>) and the static frontend
import { isAbsolute, join } from "node:path";
import { config } from "./config";
import { bootstrap, migrate } from "./db";
import { startAuth, startPostgrest } from "./services";
import { attach, startRealtime, upgradeData, websocket, stats, type SocketData } from "./realtime";
import { handleFunction } from "./functions";
import { apiKeys } from "./jwt";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,apikey,content-type,prefer,range,accept-profile,content-profile,x-client-info,x-supabase-api-version",
  "access-control-expose-headers": "content-range,content-location,location",
};

async function proxy(req: Request, target: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", new URL(config.publicUrl).host);
  headers.set("x-forwarded-proto", new URL(config.publicUrl).protocol.replace(":", ""));
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  for (const [k, v] of Object.entries(cors)) if (!out.has(k)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

const root = join(import.meta.dir, "..");
const clientDir = join(root, "client");
const supabaseUmd = join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js");

// Files every app can load from the gateway, cross-origin too.
const shared: Record<string, string> = {
  "/realtime.js": join(clientDir, "realtime.js"),
  "/realtime.d.ts": join(clientDir, "realtime.d.ts"),
  "/vendor/supabase.js": supabaseUmd,
};

async function staticFile(pathname: string): Promise<Response> {
  const headers = { "access-control-allow-origin": "*" };
  if (shared[pathname]) return new Response(Bun.file(shared[pathname]), { headers });
  if (!config.staticDir) {
    return Response.json({ name: "cheapabase", health: "/health", docs: "https://github.com/alnutile/cheapabase" }, { status: pathname === "/" ? 200 : 404 });
  }
  const dir = isAbsolute(config.staticDir) ? config.staticDir : join(root, config.staticDir);
  const clean = pathname === "/" ? "/index.html" : pathname;
  if (clean.includes("..")) return new Response("not found", { status: 404 });
  const file = Bun.file(join(dir, clean));
  if (await file.exists()) return new Response(file, { headers });
  // SPA fallback
  return new Response(Bun.file(join(dir, "index.html")), { headers });
}

async function main() {
  console.log(`[cheapabase] starting, public url ${config.publicUrl}`);
  await bootstrap();
  await startAuth(); // creates the auth schema on first boot
  await migrate(); // your tables can now reference auth.users / auth.uid()
  await startPostgrest();
  await startRealtime();
  const { anonKey } = await apiKeys(config.jwtSecret);

  const server = Bun.serve<SocketData>({
    port: config.port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

      if (p.startsWith("/rest/v1")) {
        return proxy(req, `http://127.0.0.1:${config.postgrestPort}${p.slice(8) || "/"}${url.search}`);
      }
      if (p.startsWith("/auth/v1")) {
        return proxy(req, `http://127.0.0.1:${config.authPort}${p.slice(8) || "/"}${url.search}`);
      }
      if (p.startsWith("/functions/v1/")) {
        const res = await handleFunction(req, p.slice(14).split("/")[0]);
        for (const [k, v] of Object.entries(cors)) if (!res.headers.has(k)) res.headers.set(k, v);
        return res;
      }
      if (p === "/realtime/v1" || p === "/realtime/v1/websocket") {
        const data = await upgradeData(req);
        if (!data) return Response.json({ error: "valid token or apikey query param required" }, { status: 401 });
        return server.upgrade(req, { data }) ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      if (p === "/health") return Response.json({ ok: true, realtime: stats() }, { headers: cors });
      // Public config for the frontend: the anon key is safe to expose, same as on Supabase.
      if (p === "/config.json") return Response.json({ url: config.publicUrl, anonKey }, { headers: cors });

      return staticFile(p);
    },
    websocket,
  });
  attach(server);
  console.log(`[cheapabase] ready on :${config.port}`);
}

main().catch((e) => {
  console.error("[cheapabase] failed to start", e);
  process.exit(1);
});
