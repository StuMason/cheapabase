# cheapabase docs: Ruby on Rails

The docs example app (see [`../CONTRACT.md`](../CONTRACT.md)) as a small server-rendered Rails 8 app.
It shows that a plain Rails app can use cheapabase like it would use Supabase:

- **Auth**: sign up / sign in against GoTrue (`/auth/v1`). The access token, refresh token and email
  live in Rails' normal cookie session; there is no database on the Rails side. Expired access tokens
  are refreshed with the refresh token (`grant_type=refresh_token`); if that fails the user is signed out.
- **Data**: docs are read and written through PostgREST (`/rest/v1/docs`) with the user's own JWT,
  so Postgres RLS decides what each user can see. Another user's doc is simply "not found".
- **Functions**: the home page calls `GET /functions/v1/hello` as the user.
- **Realtime**: the doc page loads `$CHEAPABASE_URL/realtime.js` in a small `<script type="module">`
  and subscribes to its row, so saves from another tab show up without a reload.

All HTTP calls go through one stdlib `Net::HTTP` class, [`app/models/cheapabase.rb`](app/models/cheapabase.rb).
The anon key is fetched once from `$CHEAPABASE_URL/config.json`. The service key is never used.

| File | What it does |
|---|---|
| `app/models/cheapabase.rb` | the cheapabase client (auth, REST, functions) |
| `app/controllers/application_controller.rb` | session helpers and token refresh |
| `app/controllers/sessions_controller.rb` | sign up, sign in, sign out |
| `app/controllers/docs_controller.rb` | list, create, show, save docs |
| `app/views/docs/*.html.erb` | the pages; `show` holds the realtime script |

## Prerequisites

- Ruby 3.3 (`.ruby-version` says 3.3.6) and Bundler
- cheapabase running with the docs migration (`db/migrations/001_docs.sql`), e.g. `docker compose up` in the repo root

## Run it

```sh
cd examples/rails
bundle config set --local path vendor/bundle
bundle install
bin/rails server -b 127.0.0.1 -p 3004
```

Open http://localhost:3004. Run the shared browser test from the repo root:

```sh
node examples/smoke.mjs http://localhost:3004
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CHEAPABASE_URL` | `http://localhost:8000` | cheapabase gateway. Used by the server and by the browser (realtime), so it must be reachable from both |
| `PORT` | `3004` | port when you start without `-p` |
| `SECRET_KEY_BASE` | generated in `tmp/` in development | signs and encrypts the session cookie. **Required** with `RAILS_ENV=production` (the app ships no credentials file): `SECRET_KEY_BASE=$(bin/rails secret)` |

Production mode also turns on `force_ssl`, so put it behind HTTPS (or edit `config/environments/production.rb`).

## Notes

- The doc page embeds the user's access token in the page so the realtime client can connect as them.
  That's their own JWT and fine for a demo; it is valid until it expires (reload the page to get a fresh one).
- The sign in form has one form with two buttons (`intent=signin` / `intent=signup`) posting to `/session`,
  because Rails' per-form CSRF tokens are bound to the form's action.
