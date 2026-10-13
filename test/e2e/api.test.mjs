// End-to-end test against a running cheapabase (docker compose up, then `npm run test:e2e`).
// Uses the real supabase-js client to prove compatibility.
// Runs on Node, not Bun: Bun's WebSocket client intermittently fails to parse the server's frames
// ("control frame is fragmented", close 1002) while Node and Chromium handle the same stream fine.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { RealtimeClient } from "../../client/realtime.js";

const URL = process.env.CHEAPABASE_URL ?? "http://localhost:8000";
let anonKey = "";

async function newUser() {
  const sb = createClient(URL, anonKey, { auth: { persistSession: false } });
  const email = `u${crypto.randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await sb.auth.signUp({ email, password: "password123" });
  if (error) throw error;
  return { sb, email, id: data.user.id, token: data.session.access_token };
}

function realtimeFor(token) {
  return new RealtimeClient(URL, () => token);
}

async function until(fn, what, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let alice, bob;

before(async () => {
  anonKey = (await (await fetch(`${URL}/config.json`)).json()).anonKey;
  alice = await newUser();
  bob = await newUser();
});

describe("rest + rls", () => {
  test("users only see their own docs", async () => {
    const { data: doc, error } = await alice.sb.from("docs").insert({ title: "secret" }).select().single();
    assert.equal(error, null);
    assert.equal(doc.owner_id, alice.id);
    const { data: bobs } = await bob.sb.from("docs").select().eq("id", doc.id);
    assert.deepEqual(bobs, []);
    const anon = createClient(URL, anonKey, { auth: { persistSession: false } });
    const { data: anonDocs, error: anonErr } = await anon.from("docs").select();
    assert.deepEqual(anonDocs ?? [], []);
    assert.ok(anonErr === null || anonErr.code === "42501");
  });
});

describe("functions", () => {
  test("hello knows who you are", async () => {
    const { data } = await alice.sb.functions.invoke("hello");
    assert.equal(data.message, `hello ${alice.email}`);
  });

  test("only the owner can share", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "shared" }).select().single();
    const denied = await bob.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    assert.notEqual(denied.error, null);
    const ok = await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    assert.equal(ok.data.user_id, bob.id);
    const { data: seen } = await bob.sb.from("docs").select().eq("id", doc.id);
    assert.equal(seen?.length, 1);
  });
});

describe("realtime", () => {
  test("changes respect rls and filters", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "live" }).select().single();
    const a = realtimeFor(alice.token);
    const b = realtimeFor(bob.token);
    const aEvents = [];
    const bEvents = [];
    await a.on("docs", { filter: `id=eq.${doc.id}` }, (e) => aEvents.push(e));
    await b.on("docs", {}, (e) => bEvents.push(e));

    await alice.sb.from("docs").update({ content: "hello world" }).eq("id", doc.id);
    await until(() => aEvents.length === 1, "alice's update");
    assert.equal(aEvents[0].event, "UPDATE");
    assert.equal(aEvents[0].new.content, "hello world");
    await sleep(200);
    assert.deepEqual(bEvents, []); // bob can't see alice's doc

    await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    await alice.sb.from("docs").update({ content: "now bob sees it" }).eq("id", doc.id);
    await until(() => bEvents.length === 1, "bob's update");
    assert.equal(bEvents[0].new.content, "now bob sees it");

    await alice.sb.from("docs").delete().eq("id", doc.id);
    await until(() => aEvents.length === 3, "the delete");
    assert.equal(aEvents.at(-1).event, "DELETE");
    assert.equal(aEvents.at(-1).old.id, doc.id);
    a.close();
    b.close();
  });

  test("channels: presence, broadcast and can_join", async () => {
    const { data: doc } = await alice.sb.from("docs").insert({ title: "chan" }).select().single();
    const a = realtimeFor(alice.token);
    const b = realtimeFor(bob.token);
    const ca = a.channel(`doc:${doc.id}`, { presence: { name: "alice" } });
    await ca.join();
    await assert.rejects(b.channel(`doc:${doc.id}`).join(), /not allowed/);

    await alice.sb.functions.invoke("share-doc", { body: { doc_id: doc.id, email: bob.email } });
    const cb = b.channel(`doc:${doc.id}`, { presence: { name: "bob" } });
    const got = [];
    cb.on("cursor", (payload) => got.push(payload));
    await cb.join();
    const names = () => (ca.users ?? []).map((u) => u.name).sort().join(",");
    await until(() => names() === "alice,bob", "both users in presence");
    ca.send("cursor", { pos: 5 });
    await until(() => got.length === 1, "the broadcast");
    assert.deepEqual(got[0], { pos: 5 });
    a.close();
    b.close();
  });
});
