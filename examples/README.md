# Examples

The same app, five ways, against the same cheapabase backend and the same `docs` table
(`db/migrations/001_docs.sql`). The point is to show that cheapabase is a normal HTTP backend:
anything that can make HTTP requests can use it, and supabase-js and the Python `supabase` client
work unchanged.

| Folder | Stack | Talks to cheapabase with | Port | Run |
|---|---|---|---|---|
| [`vanilla`](vanilla) | HTML + JS, **the default**, served by the gateway at `/` | supabase-js | 8000 | nothing to run |
| [`nextjs`](nextjs) | Next.js 15 (App Router), React 19 | supabase-js | 3001 | `npm ci && npm run build && npm start` |
| [`laravel`](laravel) | Laravel 12, Blade | Laravel `Http` client | 3002 | see [laravel/README.md](laravel/README.md) |
| [`fastapi`](fastapi) | FastAPI, Jinja2 | the official `supabase` Python client | 3003 | `uv sync && uv run uvicorn app.main:app --port 3003` |
| [`rails`](rails) | Rails 8, ERB | `Net::HTTP` | 3004 | `bundle install && bin/rails server -p 3004` |

Every example needs the backend running first:

```bash
# from the repo root
docker compose up -d --build --wait
```

and reads `CHEAPABASE_URL` (default `http://localhost:8000`). The anon key is fetched from
`$CHEAPABASE_URL/config.json`, so there's nothing else to configure.

## What each one does

- Sign up / sign in with email and password (`/auth/v1`), session kept the framework's usual way
- Calls the `hello` function (`/functions/v1/hello`) with the user's token
- Lists, creates and edits docs through `/rest/v1/docs` with the user's token, so **RLS** decides what
  they see. Another user can't see your docs
- The doc page loads `$CHEAPABASE_URL/realtime.js` and updates live when the doc changes elsewhere

The vanilla app goes further (sharing, presence, "is typing"). The four framework examples stick to
[CONTRACT.md](CONTRACT.md) so one test can check them all.

## Testing an example

```bash
# from the repo root, with cheapabase and the example running
bun install
npx playwright-core install chromium
node examples/smoke.mjs http://localhost:3003
```

CI runs this against every example on every pull request (the `examples` job in
`.github/workflows/ci.yml`).

## Adding an example

1. Make `examples/<name>/` following [CONTRACT.md](CONTRACT.md): same routes, element ids and API calls.
2. Give it a README with exact install and run commands, and commit its lockfile.
3. Pass `node examples/smoke.mjs http://localhost:<port>` twice in a row.
4. Add it to the `examples` matrix in `.github/workflows/ci.yml` and to the table above.
