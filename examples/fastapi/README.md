# cheapabase + FastAPI

A small server-rendered docs app built with FastAPI and Jinja2 on top of cheapabase. It uses the
official Python client, [`supabase`](https://github.com/supabase/supabase-py) (supabase-py), unchanged.
Point it at a cheapabase URL instead of a `*.supabase.co` one and it works.

What it shows:

- **Auth**: sign up / sign in with `client.auth.sign_up` and `sign_in_with_password`. The access and refresh
  tokens live in a signed session cookie (Starlette `SessionMiddleware`). Each request makes a short-lived
  client and calls `client.auth.set_session(access, refresh)`, which refreshes the access token when it has
  expired. The new tokens go back into the cookie. If the refresh token is no good, you're signed out.
- **REST + RLS**: `client.table("docs").select/insert/update` run as the user. Row level security in
  `db/migrations/001_docs.sql` decides what they can see, so the app never uses the service key.
- **Functions**: `client.functions.invoke("hello", {"method": "GET"})` calls `functions/hello.ts`.
- **Realtime**: the doc page loads `$CHEAPABASE_URL/realtime.js` and subscribes to changes on its row with
  the user's access token, so an edit saved in another tab shows up without a reload.

The pages and element ids follow [`../CONTRACT.md`](../CONTRACT.md).

## Prerequisites

- cheapabase running (from the repo root: `docker compose up -d`), at `http://localhost:8000` by default
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)

## Run it

```sh
cd examples/fastapi
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 3003
```

Open http://localhost:3003. Add `--reload` while you're hacking on it.

To run the browser smoke test against it, from the repo root:

```sh
node examples/smoke.mjs http://localhost:3003
```

## Config

| Env var | Default | Meaning |
|---|---|---|
| `CHEAPABASE_URL` | `http://localhost:8000` | Where the cheapabase gateway is. The anon key is fetched from `$CHEAPABASE_URL/config.json`. |
| `SESSION_SECRET` | a dev-only value | Signs the session cookie. Set a long random value anywhere that isn't your laptop. |

## Files

- `app/cheapabase.py`: builds a per-request supabase-py client and keeps the session cookie in sync
- `app/main.py`: the routes (`/`, `/docs/{id}`, and POST `/signup`, `/signin`, `/signout`, `/docs`, `/docs/{id}`)
- `app/templates/`: Jinja2 templates; `doc.html` has the small realtime `<script type="module">`

## Notes

- Realtime runs in the browser with cheapabase's own `realtime.js` client. supabase-py creates a realtime
  client but only connects it when you subscribe, which this app never does from Python, so it doesn't
  matter that it speaks a different protocol than cheapabase's websocket.
- The doc page embeds the user's own access token for the websocket. That's fine for a demo. If the page is
  left open past the token's expiry, reconnects will fail until you reload it.
- `set_session` calls `GET /auth/v1/user` on every request to validate the token. It's one extra local
  round trip; cache the user if that ever matters.
