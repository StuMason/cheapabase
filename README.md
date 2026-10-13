# cheapabase

The parts of Supabase you actually use, in **two containers** and about **100MB of RAM**.
A small app runs on Railway's **$5/month** Hobby plan ([cost breakdown](docs/cost.md)).

- **Postgres** with **RLS**, the same `anon` / `authenticated` / `service_role` roles and `auth.uid()`
- **Auth** with JWTs (Supabase's own auth server, GoTrue): email + password out of the box, OAuth and SMTP via env vars
- **REST API** generated from your schema (PostgREST)
- **Realtime**: row changes filtered by RLS, plus broadcast and presence channels
- **Functions**: drop a file in `functions/`, call it at `/functions/v1/<name>`
- **supabase-js works unchanged** for auth, database and functions. So does the Python `supabase` client
- **Works with any framework.** The same example app is built in [vanilla JS](examples/vanilla), [Next.js](examples/nextjs), [Laravel](examples/laravel), [FastAPI](examples/fastapi) and [Rails](examples/rails), and CI tests every one of them

```
                       one container (Bun, ~40MB RAM idle)
                ┌─────────────────────────────────────────────┐
 browser ──────▶│ gateway :8000                               │
 supabase-js    │   /auth/v1/*       ──▶ auth (GoTrue)        │──┐
 Laravel, Rails │   /rest/v1/*       ──▶ PostgREST            │──┤
 FastAPI, ...   │   /realtime/v1     websocket, RLS-filtered  │──┼──▶ Postgres
                │   /functions/v1/*  your functions/*.ts      │──┤   (~60MB idle)
                │   /*               your frontend (optional) │  │
                └─────────────────────────────────────────────┘  │
```

**Contents:** [Quickstart](#quickstart-5-minutes) ·
[Examples](#examples-same-app-five-frameworks) ·
[Deploy to Railway](#deploy-to-railway) ·
[Cost](#cost) ·
[Build your own app](#build-your-own-app) ·
[Configuration](#configuration) ·
[Tests](#tests) ·
[Troubleshooting](#troubleshooting) ·
[Why it's light](#why-is-supabase-heavy-and-this-light) ·
[Limits](#limits)

## Quickstart (5 minutes)

You need [Docker](https://docs.docker.com/get-docker/) with Compose. That's all.

```bash
git clone https://github.com/alnutile/cheapabase.git
cd cheapabase
docker compose up --build
```

Wait for this line in the logs (first boot takes a minute while images download):

```
app-1  | [cheapabase] ready on :8000
```

Then open **http://localhost:8000**:

1. Click **Need an account? Sign up**, use any email (e.g. `ada@example.com`) and a password of 6+ characters. No email confirmation needed locally.
2. Click **+ New doc** and type.
3. Open a **private window**, sign up as someone else (e.g. `bob@example.com`).
4. Back in the first window click **Share** and enter `bob@example.com`. The doc appears in Bob's sidebar right away.
5. Open the doc in both windows and type. You'll see the other person's avatar, "is typing" and their edits live.

Check the API directly:

```bash
curl http://localhost:8000/health        # {"ok":true,...}
curl http://localhost:8000/config.json   # {"url":"...","anonKey":"eyJ..."}
```

Stop with `Ctrl+C`. Start fresh (deletes the database) with `docker compose down -v`.

## Examples: same app, five frameworks

Every example builds the same docs app against the same backend: sign up and sign in, call a function,
create and edit docs under RLS, and get live updates over realtime. One browser test
(`examples/smoke.mjs`) checks all of them, and CI runs it on every pull request.

| Example | Stack | Talks to cheapabase with | Port |
|---|---|---|---|
| [`examples/vanilla`](examples/vanilla) | plain HTML/JS, **the default**, served at `/` | supabase-js | 8000 |
| [`examples/nextjs`](examples/nextjs) | Next.js (App Router) | supabase-js | 3001 |
| [`examples/laravel`](examples/laravel) | Laravel + Blade | Laravel `Http` client | 3002 |
| [`examples/fastapi`](examples/fastapi) | FastAPI + Jinja | the official `supabase` Python client | 3003 |
| [`examples/rails`](examples/rails) | Ruby on Rails | `Net::HTTP` | 3004 |

Start the stack with `docker compose up`, then follow the README in the example's folder. All of them
read `CHEAPABASE_URL` (default `http://localhost:8000`). See [examples/README.md](examples/README.md)
for the shared contract and how to add your own.

The default frontend is set by `STATIC_DIR` (default `examples/vanilla`). Set `STATIC_DIR=` (empty)
to run cheapabase as a pure API for a frontend hosted elsewhere.

## Deploy to Railway

You need a [Railway](https://railway.com) account (the trial includes $5 of credit) and this repo on
your GitHub account (fork it, or push your copy).

1. **Create the project.** Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick your cheapabase repo.
   Railway finds the `Dockerfile` and `railway.json` automatically. The first deploy will fail
   because the variables aren't set yet. That's expected.
2. **Add Postgres.** In the same project: **+ Create** → **Database** → **PostgreSQL**.
3. **Set two variables.** Click the cheapabase service → **Variables** → add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly like this; Railway fills in the real URL) |
   | `JWT_SECRET` | a random string of 32+ characters. Generate one with `openssl rand -hex 32` |

4. **Give it a URL.** cheapabase service → **Settings** → **Networking** → **Generate Domain** → port **8000**.
5. **Deploy.** Railway redeploys when variables change. Watch **Deployments** → **View logs** for
   `[cheapabase] ready on :8000`.
6. **Check it.** Open `https://<your-domain>/health`, then the domain itself for the docs app.

On every boot cheapabase creates its roles, lets the auth server migrate, applies any new
`db/migrations/*.sql` and starts serving. Railway's healthcheck (`/health`) only passes once all of
that is done, so a bad migration never replaces a working deploy.

**Custom domain:** add it under Networking, then set `PUBLIC_URL=https://your.domain` so auth links
point at it. **Connect with psql:** Postgres service → **Connect** → copy the public URL.
**Back up your `JWT_SECRET`:** changing it logs everyone out and changes the anon key.

## Cost

| | Resource use | Railway estimate |
|---|---|---|
| Side project (mostly idle) | ~100MB RAM total, ~0 CPU | **$5/month** (inside the Hobby plan's included usage) |
| Busy (20 req/s 24/7, 100 live sockets) | ~200MB RAM, ~0.4 vCPU | **~$11/month** |
| Full self-hosted Supabase | Supabase recommends 4GB+ RAM, 2+ cores | $40+/month for the RAM alone |

Measured, not guessed. [docs/cost.md](docs/cost.md) has the method and Railway's prices, and
`bun run loadtest` reproduces the numbers.

## Build your own app

### 1. Add a table

Create a numbered file in `db/migrations/`, e.g. `db/migrations/002_todos.sql`. Each file runs once, in
filename order, inside a transaction. Never edit a file that has already run; add a new one.

```sql
create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  done boolean not null default false
);

-- 1. RLS on, 2. policies, 3. grants. Forget any of the three and requests fail (or worse, leak).
alter table public.todos enable row level security;
create policy "own todos" on public.todos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.todos to authenticated;

-- optional: live updates (needs a primary key column, "id" by default)
select realtime.enable('public.todos');
```

Restart (`docker compose restart app`, or redeploy on Railway). `/rest/v1/todos` now exists.

### 2. Use it from the browser

```js
import { createClient } from "@supabase/supabase-js";
import { RealtimeClient } from "https://your-app.up.railway.app/realtime.js";

const URL = "https://your-app.up.railway.app";
const { anonKey } = await (await fetch(`${URL}/config.json`)).json();
const supabase = createClient(URL, anonKey);

await supabase.auth.signUp({ email: "ada@example.com", password: "password123" });
await supabase.from("todos").insert({ title: "Ship it" });
const { data } = await supabase.from("todos").select();

const { data: { session } } = await supabase.auth.getSession();
const rt = new RealtimeClient(URL, () => session.access_token);
await rt.on("todos", { event: "*" }, (change) => console.log(change.event, change.new));
```

Realtime uses cheapabase's own small client, not `supabase.channel()`. See [docs/realtime.md](docs/realtime.md)
for row changes, broadcast, presence and the wire protocol. TypeScript types are at `/realtime.d.ts`.

### 3. Use it from a server (Laravel, Rails, Django, Go, ...)

It's plain HTTP, the same as Supabase:

```bash
ANON=$(curl -s localhost:8000/config.json | jq -r .anonKey)

# sign up (returns access_token and refresh_token)
curl -s localhost:8000/auth/v1/signup -H "apikey: $ANON" -H "content-type: application/json" \
  -d '{"email":"ada@example.com","password":"password123"}'

# query as that user, RLS applies
curl -s "localhost:8000/rest/v1/todos?select=*" -H "apikey: $ANON" -H "authorization: Bearer $ACCESS_TOKEN"
```

The Laravel, FastAPI and Rails examples each wrap this in one small class.

### 4. Add a function

Every file in `functions/` is served at `/functions/v1/<file name>`:

```ts
// functions/todo-count.ts
import type { Handler } from "../server/functions";

const handler: Handler = async (req, { user, asUser, admin }) => {
  // user:   verified JWT claims, or null for anonymous calls
  // asUser: run SQL as the caller, RLS applies
  // admin:  SQL that bypasses RLS. Check permissions yourself
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });
  const [row] = await asUser((sql) => sql`select count(*)::int as n from todos`);
  return Response.json(row);
};
export default handler;
```

Call it with `supabase.functions.invoke("todo-count")`. `functions/share-doc.ts` is a fuller example.
Functions run inside the gateway with full database access, so treat them like your own server code.

For plain CRUD you often don't need a function: a Postgres function is exposed at
`/rest/v1/rpc/<name>` and supabase-js calls it with `supabase.rpc("name", args)`.

### 5. Keys

```bash
JWT_SECRET=... bun run keys     # prints ANON_KEY and SERVICE_ROLE_KEY
```

The anon key is public (it's what `/config.json` returns). The service role key bypasses RLS: keep it
on servers only.

## Configuration

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection. The user must be able to create roles (`postgres` on Docker and Railway is) |
| `JWT_SECRET` | yes | | Signs every JWT. 32+ characters. Changing it logs everyone out and changes the anon key |
| `PUBLIC_URL` | no | Railway domain, else `http://localhost:$PORT` | Used in auth redirect links |
| `PORT` | no | `8000` | |
| `STATIC_DIR` | no | `examples/vanilla` | Frontend served at `/`. Empty = API only |
| `JWT_EXPIRY` | no | `3600` | Access token lifetime in seconds |
| `MAILER_AUTOCONFIRM` | no | `true` | Set `false` once SMTP is configured so users must confirm their email |
| `DISABLE_SIGNUP` | no | `false` | |
| `GOTRUE_*` | no | | Passed to the auth server: SMTP (`GOTRUE_SMTP_HOST`, ...), OAuth (`GOTRUE_EXTERNAL_GITHUB_ENABLED`, ...). See the [auth server docs](https://github.com/supabase/auth#configuration) |
| `PGRST_*` | no | | Passed to PostgREST |

## Tests

```bash
bun install
bun run typecheck
bun run test                  # unit tests, no database needed

# these need the stack running (docker compose up -d --wait)
bun run test:e2e              # real supabase-js: RLS, functions, realtime, presence
npx playwright-core install chromium
npm run test:ui               # two browser users share a doc and edit it live
node examples/smoke.mjs http://localhost:3001   # contract test for a framework example
```

CI (`.github/workflows/ci.yml`) runs all of it on every pull request: a real `docker compose up --build`,
the API and browser tests, and the smoke test against every framework example.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `missing required env var DATABASE_URL` / `JWT_SECRET` | Set both. On Railway, `DATABASE_URL` must be exactly `${{Postgres.DATABASE_URL}}` and the Postgres service must be in the same project |
| `JWT_SECRET must be at least 32 characters` | Use `openssl rand -hex 32` |
| Railway deploy stuck on the healthcheck | Open the deploy logs. Usually a variable is missing or a migration has an SQL error |
| A migration failed | It ran in a transaction, so nothing was half-applied. Fix the file and restart |
| `new row violates row-level security policy` on `.insert().select()` | In `select` policies, check simple columns like `owner_id = auth.uid()` directly, not only through a `stable` helper function. The helper can't see the row being inserted by the same statement |
| `permission denied for table ...` | Missing `grant ... to authenticated` in your migration |
| Requests return `[]` but the data exists | RLS is hiding it: check your `select` policy and that the request sends the user's token, not just the anon key |
| No realtime events | Did you run `select realtime.enable('public.your_table')`? Does the table have an `id` column (or did you pass the pk name)? Can the user `select` the row? |
| `not allowed to join channel` | Your `realtime.can_join()` returned false for that user and channel |
| Port 8000 already in use | Change `"8000:8000"` to `"8080:8000"` in `docker-compose.yml` and set `PUBLIC_URL=http://localhost:8080` |
| Everyone got logged out | `JWT_SECRET` changed |
| Want a clean local database | `docker compose down -v && docker compose up` |

## Why is Supabase heavy and this light?

Self-hosted Supabase runs about 12 services in 5 languages: Kong, GoTrue, PostgREST, Realtime
(Elixir), Storage + imgproxy, Edge Runtime (Deno), Studio (Next.js), postgres-meta, Logflare, Vector
and Supavisor. Most of the memory goes to the dashboard, logging and Elixir services, not to the parts
your app talks to.

cheapabase keeps the two Supabase pieces that are small and great (GoTrue and PostgREST, both static
binaries) and replaces the rest with about 700 lines of TypeScript and SQL:

| Supabase service | cheapabase |
|---|---|
| Kong | the Bun gateway (`server/index.ts`) |
| Realtime (Elixir) | `server/realtime.ts`: Postgres `LISTEN/NOTIFY` + an RLS re-check per subscriber |
| Edge Runtime (Deno) | `server/functions.ts`: plain Bun handlers |
| Studio, Logflare, Vector, Supavisor, Storage | not included. Use `psql` or any Postgres GUI, and S3/R2 for files |

## Limits

- **No storage.** Use S3, R2 or MinIO with presigned URLs from a function.
- **No dashboard.** Use `psql`, TablePlus, DBeaver or similar.
- **No email by default.** Signups are auto-confirmed. Set `GOTRUE_SMTP_*` and `MAILER_AUTOCONFIRM=false` for confirmation and password reset emails.
- **`supabase.channel()` doesn't work.** Use `realtime.js` (row changes, broadcast and presence are all there).
- **Realtime filters support `eq` only**, and delete events carry only the primary key.
- **One instance.** Row change events work across replicas, but broadcast and presence only reach clients on the same instance.
- **The docs example is last-write-wins.** Good for a demo, not for heavy simultaneous typing (that needs a CRDT like Yjs).

## Project layout

```
server/             Bun gateway: proxy, realtime, functions, migrations, child processes
db/bootstrap.sql    roles + realtime schema, runs every boot (idempotent)
db/migrations/      your schema, each file runs once
functions/          your functions
client/             realtime.js client + TypeScript types, served at /realtime.js
examples/           the docs app in vanilla JS (default), Next.js, Laravel, FastAPI and Rails
test/               unit, end-to-end (supabase-js) and browser tests
scripts/loadtest.ts load test used for docs/cost.md
docs/               realtime.md, cost.md
AGENTS.md           guide for AI coding agents and contributors
```
