# cheapabase

The parts of Supabase you actually use, in **two containers** and about **100MB of RAM**.

- **Postgres** with **RLS**, the same `anon` / `authenticated` / `service_role` roles and `auth.uid()`
- **Auth** with JWTs (Supabase's own auth server, GoTrue)
- **REST API** generated from your schema (PostgREST)
- **Realtime**: row changes filtered by RLS, plus broadcast and presence channels
- **Functions**: drop a file in `functions/`, call it at `/functions/v1/<name>`
- **supabase-js works unchanged** for auth, database and functions

It comes with an example app: **realtime collaborative docs** (sign up, write, share, see each other type).

```
                       one container (Bun, ~45MB RAM)
                ┌─────────────────────────────────────────────┐
 browser ──────▶│ gateway :8000                               │
 supabase-js    │   /auth/v1/*       ──▶ auth (GoTrue)  :9999 │──┐
                │   /rest/v1/*       ──▶ PostgREST      :3000 │──┤
                │   /realtime/v1     websocket, LISTEN/NOTIFY │──┼──▶ Postgres
                │   /functions/v1/*  your functions/*.ts      │──┤
                │   /*               public/ (the frontend)   │  │
                └─────────────────────────────────────────────┘  │
```

## Why is Supabase so heavy, and why is this light?

Self-hosted Supabase runs about 12 services in 5 languages: Kong, GoTrue, PostgREST, Realtime (Elixir), Storage + imgproxy, Edge Runtime (Deno), Studio (Next.js), postgres-meta, Logflare, Vector and Supavisor. Most of the memory goes to the dashboard, logging and Elixir services, not to the parts your app talks to.

cheapabase keeps the two Supabase pieces that are small and great (GoTrue and PostgREST are static binaries) and replaces everything else with about 700 lines of TypeScript and SQL:

| Supabase service | cheapabase |
|---|---|
| Kong | the Bun gateway (`server/index.ts`) |
| Realtime (Elixir) | `server/realtime.ts`: Postgres `LISTEN/NOTIFY` + RLS re-check per subscriber |
| Edge Runtime (Deno) | `server/functions.ts`: plain Bun handlers |
| Studio, Logflare, Vector, Supavisor, Storage | not included. Use `psql` or any Postgres GUI, and S3/R2 for files |

## Run it locally

```bash
docker compose up --build
```

Open http://localhost:8000, sign up with any email (no confirmation needed), make a doc. Open a second browser (or a private window), sign up as someone else, share the doc with them from the first window and type in either one.

Run the end-to-end tests (they use the real supabase-js client) against the running stack:

```bash
bun install
bun test
```

## Deploy to Railway

You need two things on Railway: a Postgres database and this repo.

1. **New Project** → **Deploy from GitHub repo** → pick this repo. Railway finds the `Dockerfile` and `railway.json`.
2. In the same project, **+ Create** → **Database** → **PostgreSQL**.
3. Open the cheapabase service → **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = a long random string, for example the output of `openssl rand -hex 32`
4. **Settings** → **Networking** → **Generate Domain** (target port `8000`).

That's it. On boot the app creates roles, lets the auth server migrate its schema, applies `db/migrations/*.sql`, and starts serving. The public URL is picked up from Railway's `RAILWAY_PUBLIC_DOMAIN` automatically.

Railway bills for what you use. This app idles at roughly 45MB of RAM plus Postgres, so a small project should be cheap to run. Check Railway's pricing page for current numbers.

## Using it from your own app

```js
import { createClient } from "@supabase/supabase-js";
import { RealtimeClient } from "https://your-app.up.railway.app/realtime.js";

const { anonKey } = await (await fetch("https://your-app.up.railway.app/config.json")).json();
const supabase = createClient("https://your-app.up.railway.app", anonKey);

await supabase.auth.signUp({ email, password });
const { data } = await supabase.from("docs").select();
await supabase.functions.invoke("hello");

const { data: { session } } = await supabase.auth.getSession();
const rt = new RealtimeClient("https://your-app.up.railway.app", () => session.access_token);
await rt.on("docs", { event: "*" }, (change) => console.log(change.event, change.new));
```

`supabase.channel(...)` (Supabase Realtime) is **not** supported. Use the small `RealtimeClient` instead, see [docs/realtime.md](docs/realtime.md).

Print the anon and service_role keys for your secret:

```bash
JWT_SECRET=... bun run keys
```

## Adding your own tables

Add a numbered file to `db/migrations/`, for example `002_todos.sql`. Each file runs once, in order, inside a transaction.

```sql
create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  done boolean not null default false
);

alter table public.todos enable row level security;
create policy "own todos" on public.todos
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.todos to authenticated;

-- live updates for this table (needs an "id" column, or pass the pk name as 2nd arg)
select realtime.enable('public.todos');
```

Restart the app (or redeploy) and `/rest/v1/todos` exists. PostgREST picks up schema changes automatically.

**RLS gotcha:** in `select` policies, check simple columns like `owner_id = auth.uid()` directly rather than only through a `stable` helper function that queries the same table. A stable function can't see the row being inserted by the same statement, so `insert ... returning` (what `.insert().select()` does) fails with an RLS error.

## Functions

Every file in `functions/` is served at `/functions/v1/<file name>`:

```ts
// functions/hello.ts
import type { Handler } from "../server/functions";

const handler: Handler = async (req, { user, asUser, admin }) => {
  // user:   verified JWT claims, or null
  // asUser: run SQL as the caller, RLS applies
  // admin:  SQL that bypasses RLS, check permissions yourself
  const todos = await asUser((sql) => sql`select * from todos`);
  return Response.json({ hello: user?.email, todos });
};
export default handler;
```

`functions/share-doc.ts` is a real example: it checks ownership as the user, then uses `admin` to look up another user by email.

Functions run inside the gateway process with full access. Treat them like your own server code, not like sandboxed user code.

For most CRUD you don't need a function at all. A Postgres function is exposed at `/rest/v1/rpc/<name>` and supabase-js calls it with `supabase.rpc("name", args)`.

## Configuration

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection. Needs a user that can create roles (the default `postgres` user on Railway or Docker is fine) |
| `JWT_SECRET` | yes | | Signs every JWT. At least 32 characters. Changing it logs everyone out and changes the anon key |
| `PUBLIC_URL` | no | Railway domain or `http://localhost:$PORT` | Used for auth redirect links |
| `PORT` | no | `8000` | |
| `JWT_EXPIRY` | no | `3600` | Access token lifetime in seconds |
| `MAILER_AUTOCONFIRM` | no | `true` | Set `false` once you configure SMTP so people must confirm their email |
| `DISABLE_SIGNUP` | no | `false` | |
| `GOTRUE_*` | no | | Passed straight to the auth server: SMTP (`GOTRUE_SMTP_HOST`, ...), OAuth (`GOTRUE_EXTERNAL_GITHUB_ENABLED`, ...). See the [Supabase auth docs](https://github.com/supabase/auth#configuration) |
| `PGRST_*` | no | | Passed straight to PostgREST |

## What's not included (yet)

- **Storage.** Use S3, R2 or MinIO with presigned URLs from a function.
- **Dashboard.** Use `psql`, TablePlus, DBeaver or similar.
- **Email.** Signups are auto-confirmed by default. Set `GOTRUE_SMTP_*` and `MAILER_AUTOCONFIRM=false` for real email confirmation and password resets.
- **Conflict-free editing.** The docs example is last-write-wins with a 300ms save debounce. Good for a demo, not for Google Docs-level concurrent typing (that needs a CRDT like Yjs).
- **Multiple replicas.** Database change events work with any number of replicas, but broadcast and presence only reach clients on the same instance. Run one instance, which is plenty for most apps.

## Project layout

```
server/        Bun gateway: proxy, realtime, functions, migrations, child processes
db/bootstrap.sql   roles + realtime schema, runs every boot (idempotent)
db/migrations/     your schema, each file runs once
functions/     your functions
public/        the example docs app + realtime.js client
test/          end-to-end tests using supabase-js
```
