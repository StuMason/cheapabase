// Load test: N users, 5 realtime sockets each, steady mix of reads and writes.
// usage: bun run loadtest [seconds=30] [requests per second=20]
// Watch resource use meanwhile with: docker stats
import { createClient } from "@supabase/supabase-js";
import { RealtimeClient } from "../client/realtime.js";
const URL = process.env.CHEAPABASE_URL ?? "http://localhost:8000";
const { anonKey } = await (await fetch(`${URL}/config.json`)).json();
const users: any[] = [];
for (let i = 0; i < 20; i++) {
  const sb = createClient(URL, anonKey, { auth: { persistSession: false } });
  const { data } = await sb.auth.signUp({ email: `load${Date.now()}_${i}@example.com`, password: "password123" });
  const { data: doc } = await sb.from("docs").insert({ title: "load" }).select().single();
  users.push({ sb, token: data.session!.access_token, doc });
}
// 5 realtime clients per user = 100 sockets, each subscribed to all docs
let events = 0;
const rts: any[] = [];
for (const u of users) for (let k = 0; k < 5; k++) {
  const rt = new RealtimeClient(URL, () => u.token);
  await rt.on("docs", {}, () => events++);
  rts.push(rt);
}
const secs = Number(process.argv[2] ?? 30), rps = Number(process.argv[3] ?? 20);
let ok = 0, fail = 0;
const start = Date.now();
while (Date.now() - start < secs * 1000) {
  const t = Date.now();
  await Promise.all(Array.from({ length: rps }, (_, j) => {
    const u = users[(Math.random() * users.length) | 0];
    const p = j % 2 ? u.sb.from("docs").update({ content: "x" + Math.random() }).eq("id", u.doc.id)
                    : u.sb.from("docs").select("id,title").limit(20);
    return p.then((r: any) => (r.error ? fail++ : ok++));
  }));
  await Bun.sleep(Math.max(0, 1000 - (Date.now() - t)));
}
console.log(JSON.stringify({ requests: ok, failed: fail, realtimeEvents: events, sockets: rts.length }));
rts.forEach((r) => r.close());
process.exit(0);
