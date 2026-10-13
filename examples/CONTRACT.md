# Example app contract

Every example (Next.js, Laravel, FastAPI, Rails) builds the same small app against the same
cheapabase backend and the same `docs` table, so one browser test (`examples/smoke.mjs`) can
check all of them. That's the point: same backend, any framework.

## Config

| Env var | Meaning | Local default |
|---|---|---|
| `CHEAPABASE_URL` | Where the gateway is | `http://localhost:8000` |
| `PORT` | Port the example listens on | see the table in examples/README.md |

The anon key is not configured anywhere: fetch it from `GET $CHEAPABASE_URL/config.json` (`{ "anonKey": "..." }`).

## Pages and selectors

**Signed out, `GET /`** shows a form with:
- `#email`, `#password` inputs
- `#signup` button (calls `POST /auth/v1/signup`) and `#signin` button (calls `POST /auth/v1/token?grant_type=password`)
- errors shown in `#error`

**Signed in, `GET /`** shows:
- `#hello`: the `message` returned by `GET /functions/v1/hello` called with the user's token (it contains their email)
- `#new-doc-title` input and `#create-doc` button. Creating a doc (`POST /rest/v1/docs` with `Prefer: return=representation`) then goes to `/docs/<id>`
- one `a.doc-link` per doc the user can see (`GET /rest/v1/docs?select=id,title&order=updated_at.desc`), text = title, href = `/docs/<id>`
- `#signout` button or link

**`GET /docs/<id>`** (signed in):
- `#doc-title` element containing the title
- `#content` textarea with the content
- `#save` button that saves the textarea (`PATCH /rest/v1/docs?id=eq.<id>`). After saving, `#status` contains `Saved`
- a doc the user can't see (RLS returns no rows) shows an element `#not-found` instead
- **realtime**: the page loads `$CHEAPABASE_URL/realtime.js` as an ES module and subscribes with
  `rt.on("docs", { filter: "id=eq.<id>" }, ...)` using the user's access token. When the row changes
  elsewhere, `#content` updates without a reload (skip the update while the textarea has unsaved edits)

Signed-out requests to `/docs/<id>` redirect to `/`.

## Rules

- Every REST/function call sends `apikey: <anon key>` and `Authorization: Bearer <user access token>`.
  RLS does the authorization; the example never uses the service key.
- Keep it small and idiomatic for the framework. No extra database: server-side frameworks keep
  the session (access token, refresh token, email) in their normal session/cookie store.
- When the access token expires, refresh it with `POST /auth/v1/token?grant_type=refresh_token`
  or sign the user out.
