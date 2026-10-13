# Realtime

One websocket at `/realtime/v1` gives you two things:

1. **Database changes**: get told when rows you are allowed to see are inserted, updated or deleted.
2. **Channels**: send messages to other clients (broadcast) and see who is online (presence).

## Turn it on for a table

```sql
select realtime.enable('public.todos');          -- primary key column "id"
select realtime.enable('public.things', 'uuid'); -- or name the primary key column
select realtime.disable('public.todos');
```

This adds a trigger that sends the row's primary key over Postgres `NOTIFY`. Nothing else is stored.

## How RLS is enforced

When a row changes, the gateway reads that row once per distinct subscriber, using the subscriber's role and JWT claims, exactly the way PostgREST does:

```sql
set local role authenticated;
select set_config('request.jwt.claims', '<their claims>', true);
select to_jsonb(t) from public.todos t where t.id = $1;
```

If RLS hides the row, that subscriber gets nothing. So your existing `select` policies are your realtime security, no extra rules to write.

Deletes are different: the row is gone, so it can't be checked. Delete events only carry the primary key (`old: { id }`) and go to everyone subscribed to that table. Don't use guessable primary keys for secret data if the id itself is sensitive.

## Client

`client/realtime.js` is a dependency-free ES module, served by the app at `/realtime.js`. It reconnects automatically and restores subscriptions and channels.

```js
import { RealtimeClient } from "/realtime.js";

// getToken is called on every (re)connect. Return the user's access token, or the anon key.
const rt = new RealtimeClient(location.origin, () => session?.access_token ?? anonKey);

// Row changes. event: "*" | "INSERT" | "UPDATE" | "DELETE". filter: "column=eq.value" (optional)
const unsubscribe = await rt.on("todos", { event: "*", filter: "list_id=eq.42" }, (change) => {
  change.event; // "INSERT" | "UPDATE" | "DELETE"
  change.new;   // the full row, as this user is allowed to see it (INSERT/UPDATE)
  change.old;   // { id } (DELETE)
});
unsubscribe();

// When supabase-js refreshes the session, pass the new token along
supabase.auth.onAuthStateChange((event, session) => {
  if (event === "TOKEN_REFRESHED") rt.setAuth(session.access_token);
});
```

### Channels: broadcast and presence

```js
const room = rt.channel("doc:3f1c...", { presence: { name: "Ada", color: "teal" } });

room.on("cursor", (payload, from) => moveCursor(from.user_id, payload));
room.onPresence((users) => renderAvatars(users)); // [{ key, user_id, email, name, color }]

await room.join();                 // throws if realtime.can_join() says no
room.send("cursor", { x: 10, y: 20 });
room.track({ name: "Ada", color: "pink" }); // update your presence
room.leave();
```

Broadcast messages go straight to other clients in the channel. They are not stored.

### State: latest value only, batched per tick

For data that changes many times a second and where only the newest value matters (cursors,
positions, "is typing"), use state instead of broadcast:

```js
room.setState([x, y]);                       // as often as you like
room.onStates((states) => {                  // once per server tick, only what changed
  for (const [key, value] of states) moveCursor(key, value); // key matches presence entries
});
```

The server keeps one value per client and flushes every `REALTIME_TICK_MS` (default 100ms), so a
room of N movers costs N frames a second per client, not N x moves. Your own state comes back to you too.

### Who can join a channel

Joining runs `realtime.can_join(channel)` as the user. The default lets any signed-in user join any channel. Override it in a migration, it's just SQL so it can use your RLS helpers:

```sql
create or replace function realtime.can_join(channel text) returns boolean
language plpgsql stable as $$
begin
  if channel like 'doc:%' then
    return public.can_access_doc(substr(channel, 5)::uuid);
  end if;
  return auth.uid() is not null;
end
$$;
```

The docs example (`db/migrations/001_docs.sql`) does exactly this so only people with access to a doc can see who's in it.

## Wire protocol

If you want a client in another language, it's plain JSON over a websocket.

Connect to `wss://<host>/realtime/v1?token=<jwt or anon key>`. The server replies `{"type":"ready","key":"<connection id>","user":{...}}`. Keys are short and unique per server process.

| Client sends | Server replies |
|---|---|
| `{"type":"subscribe","ref":"s1","table":"todos","schema":"public","event":"*","filter":"id=eq.5"}` | `{"type":"subscribed","ref":"s1"}` |
| `{"type":"unsubscribe","ref":"s1"}` | `{"type":"ok","ref":"s1"}` |
| `{"type":"join","ref":"j1","channel":"room:1","presence":{...}}` | `{"type":"joined","ref":"j1","channel":"room:1"}` |
| `{"type":"track","channel":"room:1","presence":{...}}` | `presence_diff` to the channel |
| `{"type":"broadcast","channel":"room:1","event":"cursor","payload":{...},"self":false}` | nothing to you, `broadcast` to the others |
| `{"type":"state","channel":"room:1","payload":...}` | nothing now; the next `states` frame carries it |
| `{"type":"leave","ref":"l1","channel":"room:1"}` | `{"type":"ok","ref":"l1"}` |
| `{"type":"auth","ref":"a1","token":"<new jwt>"}` | `{"type":"ok","ref":"a1"}` |
| `{"type":"ping","ref":"p1"}` | `{"type":"pong","ref":"p1"}` |

Server pushes:

```json
{"type":"change","ref":"s1","event":"UPDATE","schema":"public","table":"todos","new":{...}}
{"type":"change","ref":"s1","event":"DELETE","schema":"public","table":"todos","old":{"id":5}}
{"type":"broadcast","channel":"room:1","event":"cursor","payload":{...},"from":{"key":"...","user_id":"...","email":"..."}}
{"type":"presence","channel":"room:1","users":[{"key":"...","user_id":"...","email":"...", "...": "your presence fields"}]}
{"type":"presence_diff","channel":"room:1","joins":[{"key":"...", "...": "..."}],"leaves":["<key>"]}
{"type":"states","channel":"room:1","states":[["<key>", <payload>], ...]}
{"type":"error","ref":"j1","message":"not allowed to join channel"}
```

`presence` (the full roster) is sent only to the client that just joined. After that everyone gets
`presence_diff`: entries in `joins` replace any existing entry with the same key, keys in `leaves`
are removed. `client/realtime.js` applies the diffs and still calls `onPresence(users)` with the full list.

## Limits

- Filters support `eq` only.
- Inbound guards (env vars): `REALTIME_MAX_MSGS_PER_SEC` (default 60 per socket, 2x burst; extra
  messages are dropped with one error), `REALTIME_MAX_PAYLOAD` (64KB), `REALTIME_MAX_CHANNEL_MEMBERS`
  (2000). `REALTIME_COMPRESS=true` turns on per-message deflate. Browsers and the `ws` package read
  compressed frames fine; Node's built-in `WebSocket` (Node 22 and 24) receives published frames as
  empty strings, so use `ws` for Node clients when compression is on.
- One RLS read per distinct user per change. Fine for hundreds of listeners on a table, not for tens of thousands.
- Broadcast and presence are per instance. Run one instance, or put a shared pub/sub in front if you scale out.
- **Bun as a realtime client:** Bun's built-in WebSocket client sometimes drops the connection with
  `1002 control frame is fragmented` on a stream that browsers and Node read fine. The client
  reconnects and restores its subscriptions, but events sent during the gap are missed. Prefer
  Node or the browser for long-lived realtime clients until that's fixed in Bun. (The cheapabase
  server itself runs on Bun and is not affected.)
