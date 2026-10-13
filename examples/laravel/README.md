# cheapabase + Laravel

The docs app from [`examples/CONTRACT.md`](../CONTRACT.md), built as a plain server-rendered Laravel 12 app.

What it shows:

- **Auth**: sign up and sign in through cheapabase's GoTrue (`/auth/v1`). Tokens live in the normal Laravel session, and the access token is refreshed with the refresh token when it expires.
- **Data with RLS**: list, create and save docs through PostgREST (`/rest/v1`) with the user's own JWT. The app never holds the service key, so Postgres row level security decides what each user can see.
- **Functions**: the home page shows the result of `GET /functions/v1/hello`.
- **Realtime**: the doc page loads `/realtime.js` from cheapabase in a small inline module script and subscribes to changes on that doc, so edits made elsewhere show up without a reload.

All of the HTTP calls go through one small class, [`app/Services/Cheapabase.php`](app/Services/Cheapabase.php), which uses Laravel's `Http` facade. Laravel needs no database of its own here (sessions and cache are file based), and there's no npm or Vite step: just Blade with an inline `<style>`.

## Prerequisites

- PHP 8.2+ (tested with 8.3) and Composer
- cheapabase running with the docs migration, e.g. `docker compose up` from the repo root (http://localhost:8000)

## Install and run

```bash
cd examples/laravel
composer install
cp .env.example .env && php artisan key:generate
php artisan serve --host=127.0.0.1 --port=3002
```

Open http://localhost:3002. Run the browser smoke test from the repo root:

```bash
node examples/smoke.mjs http://localhost:3002
```

For CI or scripts, the same steps non-interactively:

```bash
composer install --no-interaction --no-progress
cp .env.example .env && php artisan key:generate --no-interaction
PHP_CLI_SERVER_WORKERS=4 php artisan serve --host=127.0.0.1 --port=3002
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CHEAPABASE_URL` | `http://localhost:8000` | Where the cheapabase gateway is. The anon key is fetched from `$CHEAPABASE_URL/config.json` and cached for an hour. |
| `PHP_CLI_SERVER_WORKERS` | `4` | Lets `php artisan serve` handle requests in parallel. |
| `SESSION_DRIVER`, `CACHE_STORE` | `file` | No database needed. |

The browser also talks to `CHEAPABASE_URL` directly for realtime, so it has to be reachable from the browser, not just from PHP.

## Where things are

| File | What it does |
|---|---|
| `app/Services/Cheapabase.php` | Anon key, sign up/in/out, token refresh, `rest()` and `function()` calls as the user |
| `app/Http/Controllers/AuthController.php` | `POST /signup`, `/signin`, `/signout` |
| `app/Http/Controllers/DocController.php` | `GET /`, `POST /docs`, `GET /docs/{id}`, `PATCH /docs/{id}` |
| `app/Http/Middleware/SignedIn.php` | Sends signed-out visitors back to `/` |
| `resources/views/` | Blade templates; `docs/show.blade.php` has the realtime script |
