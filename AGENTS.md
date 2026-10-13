# AGENTS.md

Guide for AI coding agents (Claude Code, Codex, Cursor, ...) and humans working on this repo.
Read this before changing anything.

## What this is

cheapabase is a small Supabase-compatible backend: one Bun process (`server/`) that starts
Supabase Auth (GoTrue) and PostgREST as child processes on localhost and adds realtime,
functions and static file serving in front of them. Postgres is the only other service.

```
browser / any framework ──▶ gateway :8000 (Bun, server/index.ts)
                              /auth/v1/*        ──▶ GoTrue    127.0.0.1:9999
                              /rest/v1/*        ──▶ PostgREST 127.0.0.1:3000
                              /realtime/v1      websocket (server/realtime.ts)
                              /functions/v1/*   functions/*.ts (server/functions.ts)
                              /realtime.js      client/realtime.js
                              /config.json      { url, anonKey }
                              /health
                              /*                STATIC_DIR (default examples/vanilla)
```

## Boot order (server/index.ts `main`)

1. `bootstrap()` runs `db/bootstrap.sql` (idempotent, every boot): roles `anon`, `authenticated`,
   `service_role`, `authenticator`, `supabase_auth_admin`, the `auth` schema, the `realtime` schema
   with `realtime.enable()`, `realtime.notify()` and the default `realtime.can_join()`.
   Login role passwords are derived from `JWT_SECRET` (`rolePassword()` in `server/db.ts`).
2. `startAuth()` spawns GoTrue, which migrates the `auth` schema, and waits for `/health`.
3. `migrate()` applies `db/migrations/*.sql` once each, in filename order, recorded in
   `cheapabase.migrations`, then `notify pgrst, 'reload schema'`.
4. `startPostgrest()`, then `startRealtime()` (LISTEN `cheapabase_realtime`), then `Bun.serve`.

If a child process dies, the gateway exits so Docker/Railway restarts it.

## Commands

```bash
docker compose up -d --build --wait   # stack on http://localhost:8000
bun install
bun run typecheck                     # tsc --noEmit
bun run test                          # unit tests (no database)
bun run test:e2e                      # needs the stack: supabase-js API, RLS, realtime
npm run test:ui                       # needs the stack + Chromium: the vanilla docs app
node examples/smoke.mjs <url>         # contract test for a framework example
bun run loadtest 30 20                # load test, watch `docker stats`
```

Run `typecheck`, `test` and (if you touched server, db, client or examples) the e2e and browser
tests before pushing. CI (`.github/workflows/ci.yml`) runs all of them.

To run the gateway without Docker you need the `postgrest` and `auth` binaries on PATH (or
`POSTGREST_BIN`, `AUTH_BIN`, `AUTH_MIGRATIONS_PATH`) plus `DATABASE_URL` and `JWT_SECRET`,
then `bun run start`.

## Layout

| Path | What |
|---|---|
| `server/index.ts` | gateway: routing, proxy, CORS, static files, boot order |
| `server/services.ts` | spawns GoTrue + PostgREST with a clean env, `GOTRUE_*` / `PGRST_*` pass-through |
| `server/db.ts` | postgres.js client, `asUser()` (role + claims, so RLS applies), migrations |
| `server/realtime.ts` | websocket protocol, row change fan-out with per-user RLS reads, channels |
| `server/functions.ts` | loads `functions/<name>.ts`, gives handlers `user`, `asUser`, `admin` |
| `server/jwt.ts` | HS256 sign/verify, anon/service keys derived from `JWT_SECRET` |
| `db/bootstrap.sql` | roles + realtime schema. Must stay idempotent |
| `db/migrations/` | app schema. Never edit an applied migration, add a new file |
| `functions/` | example functions (`hello`, `share-doc`) |
| `client/realtime.js` | browser/Bun realtime client, plus `realtime.d.ts` types |
| `examples/vanilla/` | default frontend: realtime collaborative docs |
| `examples/{nextjs,laravel,fastapi,rails}/` | the same app in other frameworks, see `examples/CONTRACT.md` |
| `test/unit`, `test/e2e`, `test/ui` | tests (see Commands) |
| `docs/` | `realtime.md` (protocol + client API), `cost.md` (Railway estimate) |

## Rules and gotchas

- **RLS is the security model.** Every table in `public` exposed to users needs
  `enable row level security`, policies, and explicit `grant`s to `authenticated` (and `anon` only
  if public). Never hand the service key to a browser.
- **`insert ... returning` + STABLE helpers:** a STABLE function can't see the row being inserted
  by the same statement. In `select` policies check plain columns inline
  (`owner_id = auth.uid() or helper(id)`), otherwise `.insert().select()` fails with 42501.
- **Realtime needs a primary key column** (default `id`, or `realtime.enable('t', 'pk')`). Only the
  pk goes over NOTIFY; rows are re-read per subscriber as that user. Deletes carry only the pk.
- **Channel access** is `realtime.can_join(channel)`, run as the user. Override it in a migration.
- **GoTrue env:** keep `GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated` even though it logs a
  deprecation warning. Without it user JWTs have no role and PostgREST fails with
  `role "" does not exist`.
- **Children get a clean env** on purpose: Railway's `PORT` must not reach GoTrue.
- **Functions run in-process** with full DB access via `admin`. Check permissions yourself.
- **`bun.lock` must be readable by the Bun version in the Dockerfile** (1.3.0). A newer local Bun
  can write a lockfile the image can't parse; regenerate it with Bun 1.3.0 if you see
  `Unknown lockfile version`.
- Keep the server dependency-light: `postgres` and `@supabase/supabase-js` (only for its UMD
  bundle, served at `/vendor/supabase.js`) are the runtime deps.
- Style: TypeScript, ES modules, 2-space indent, small modules, comments explain why.

## Adding things

- **Table:** new `db/migrations/NNN_name.sql` with table, RLS, grants, optional
  `select realtime.enable('public.name');`. Restart the app. Add an e2e test in `test/e2e`.
- **Function:** `functions/name.ts` exporting `default` a `Handler` (see `functions/hello.ts`).
  Callable at `/functions/v1/name` and via `supabase.functions.invoke("name")`.
- **Example:** follow `examples/CONTRACT.md`, pass `node examples/smoke.mjs <url>`, add a job to
  the `examples` matrix in CI and a row to `examples/README.md`.

## Deploy

Railway: Dockerfile + `railway.json`, a Railway Postgres, and two variables
(`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_SECRET`). Full steps in README.md.
