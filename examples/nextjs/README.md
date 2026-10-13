# cheapabase + Next.js

The realtime docs app from [`examples/CONTRACT.md`](../CONTRACT.md), built with the Next.js App Router.

What it shows:

- **The official `@supabase/supabase-js` works against cheapabase unchanged**: sign up / sign in
  (`supabase.auth`), queries and writes through PostgREST (`supabase.from("docs")`), and functions
  (`supabase.functions.invoke("hello")`). RLS on the `docs` table does all the authorization; the app
  only ever has the anon key and the user's token.
- **cheapabase realtime**: the doc page loads `$CHEAPABASE_URL/realtime.js` at runtime
  (`import(/* webpackIgnore: true */ ...)`) and subscribes with `rt.on("docs", { filter: "id=eq.<id>" })`.
  Edits saved in another tab show up live. (`supabase.channel()` is not supported by cheapabase.)

Pages: `/` (sign in, or your docs + the hello message) and `/docs/[id]` (edit a doc). Everything
that talks to cheapabase runs in client components. The anon key is read from
`$CHEAPABASE_URL/config.json` at runtime, so the only setting is the URL.

## Prerequisites

- Node.js 20+ (tested with Node 22) and npm
- cheapabase running with the docs migration, e.g. `docker compose up` in the repo root
  (gateway at http://localhost:8000)

## Run

```sh
cd examples/nextjs
npm ci
npm run build
npm start            # http://localhost:3001
```

For development with hot reload: `npm run dev`.

Smoke test, from the repo root:

```sh
node examples/smoke.mjs http://localhost:3001
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CHEAPABASE_URL` | `http://localhost:8000` | The cheapabase gateway. Inlined into the client bundle at **build** time, so set it before `npm run build`. |
| `PORT` | `3001` | Port for `npm start` / `npm run dev`. |

## Files

- `lib/cheapabase.ts`: the supabase-js client, the realtime client loader and a `useSession()` hook
- `lib/realtime.d.ts`: types for `realtime.js` (copy of `client/realtime.d.ts`)
- `app/page.tsx`: sign in / sign up, hello function, doc list, create doc
- `app/docs/[id]/page.tsx`: doc editor with save and live updates
