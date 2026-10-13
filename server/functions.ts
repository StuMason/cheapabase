// "Edge functions": every file in functions/ is served at /functions/v1/<file name>.
// A function default-exports (req, ctx) => Response. It runs in-process with Bun.
import { join } from "node:path";
import { asUser, sql } from "./db";
import { config } from "./config";
import { apiKeys, bearer, verify, type Claims } from "./jwt";

export type FunctionContext = {
  /** Verified JWT claims of the caller, or null for anonymous calls. */
  user: Claims | null;
  /** Run queries as the caller. RLS applies, same as PostgREST. */
  asUser: <T>(fn: Parameters<typeof asUser<T>>[1]) => Promise<T>;
  /** Admin connection that bypasses RLS. Check permissions yourself. */
  admin: typeof sql;
  config: { publicUrl: string; anonKey: string };
};
export type Handler = (req: Request, ctx: FunctionContext) => Response | Promise<Response>;

const dir = process.env.FUNCTIONS_DIR ?? join(import.meta.dir, "..", "functions");
const cache = new Map<string, Handler | null>();

async function load(name: string): Promise<Handler | null> {
  if (cache.has(name)) return cache.get(name)!;
  let handler: Handler | null = null;
  for (const ext of [".ts", ".js"]) {
    const file = join(dir, name + ext);
    if (await Bun.file(file).exists()) {
      handler = (await import(file)).default ?? null;
      break;
    }
  }
  cache.set(name, handler);
  return handler;
}

export async function handleFunction(req: Request, name: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return Response.json({ error: "bad function name" }, { status: 400 });
  const handler = await load(name);
  if (!handler) return Response.json({ error: `function ${name} not found` }, { status: 404 });

  const token = bearer(req);
  const claims = token ? await verify(token, config.jwtSecret) : null;
  if (token && !claims) return Response.json({ error: "invalid JWT" }, { status: 401 });
  // The anon key is a valid JWT with role anon; treat it as "no user".
  const user = claims && claims.role !== "anon" ? claims : null;

  const { anonKey } = await apiKeys(config.jwtSecret);
  try {
    return await handler(req, {
      user,
      asUser: (fn) => asUser(claims, fn),
      admin: sql,
      config: { publicUrl: config.publicUrl, anonKey },
    });
  } catch (e: any) {
    console.error(`[functions/${name}]`, e);
    return Response.json({ error: e?.message ?? "function failed" }, { status: 500 });
  }
}
