// Realtime docs: plain supabase-js for auth + data, cheapabase realtime for live updates.
import { RealtimeClient } from "/realtime.js";

const { anonKey } = await (await fetch("/config.json")).json();
const sb = window.supabase.createClient(location.origin, anonKey);

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  docs: [],
  current: null, // the open doc row
  dirty: false, // local edits not saved yet
  token: null,
  rt: null,
  room: null, // presence/broadcast channel for the open doc
  stopDoc: null,
};

// ---------- auth ----------
let signingUp = false;
$("auth-toggle").onclick = () => {
  signingUp = !signingUp;
  $("auth-submit").textContent = signingUp ? "Sign up" : "Sign in";
  $("auth-toggle").textContent = signingUp ? "Have an account? Sign in" : "Need an account? Sign up";
  $("auth-error").textContent = "";
};
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const creds = { email: $("email").value, password: $("password").value };
  const { error } = signingUp ? await sb.auth.signUp(creds) : await sb.auth.signInWithPassword(creds);
  $("auth-error").textContent = error?.message ?? "";
};
$("sign-out").onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange((event, session) => {
  state.token = session?.access_token;
  if (event === "TOKEN_REFRESHED" && session) state.rt?.setAuth(session.access_token);
  // Defer so we don't call supabase from inside its own callback.
  setTimeout(() => (session ? start(session) : stop()), 0);
});

function stop() {
  state.rt?.close();
  Object.assign(state, { user: null, rt: null, room: null, current: null, docs: [] });
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
}

async function start(session) {
  if (state.user?.id === session.user.id) return;
  state.user = session.user;
  $("me-email").textContent = session.user.email;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");

  // getToken is called on every (re)connect, so it always uses the latest session.
  state.rt = new RealtimeClient(location.origin, () => state.token ?? anonKey);

  // Any doc I can see changes -> update the sidebar. RLS filters this server side.
  await state.rt.on("docs", {}, onDocChange);
  // Someone shared a doc with me -> reload the list.
  await state.rt.on("doc_members", { filter: `user_id=eq.${state.user.id}` }, loadDocs);
  await loadDocs();
  const fromHash = location.hash.slice(1);
  if (fromHash) openDoc(fromHash);
}

// ---------- doc list ----------
async function loadDocs() {
  const { data, error } = await sb.from("docs").select("id,title,owner_id,updated_at").order("updated_at", { ascending: false });
  if (error) return console.error(error);
  state.docs = data;
  renderList();
}

function renderList() {
  const ul = $("doc-list");
  ul.replaceChildren(
    ...state.docs.map((d) => {
      const li = document.createElement("li");
      li.className = d.id === state.current?.id ? "active" : "";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.title || "Untitled";
      li.append(name);
      if (d.owner_id !== state.user.id) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "shared";
        li.append(tag);
      }
      li.onclick = () => openDoc(d.id);
      return li;
    }),
  );
}

function onDocChange(change) {
  if (change.event === "DELETE") {
    state.docs = state.docs.filter((d) => d.id !== change.old.id);
    if (state.current?.id === change.old.id) closeDoc();
  } else {
    const row = change.new;
    state.docs = [row, ...state.docs.filter((d) => d.id !== row.id)];
    if (state.current?.id === row.id) applyRemote(row);
  }
  renderList();
}

$("new-doc").onclick = async () => {
  const { data, error } = await sb.from("docs").insert({ title: "Untitled" }).select().single();
  if (error) return alert(error.message);
  openDoc(data.id);
};

// ---------- editor ----------
async function openDoc(id) {
  const { data: doc, error } = await sb.from("docs").select().eq("id", id).maybeSingle();
  if (error || !doc) {
    location.hash = "";
    return;
  }
  closeDoc();
  state.current = doc;
  location.hash = id;
  $("empty").classList.add("hidden");
  $("doc").classList.remove("hidden");
  $("title").value = doc.title;
  $("content").value = doc.content;
  $("delete").classList.toggle("hidden", doc.owner_id !== state.user.id);
  $("share").classList.toggle("hidden", doc.owner_id !== state.user.id);
  setStatus("Saved");
  renderList();
  loadMembers();

  // Presence + "typing" indicator. realtime.can_join() only lets people with access in.
  state.room = state.rt.channel(`doc:${id}`, { presence: { email: state.user.email } });
  state.room.onPresence(renderPresence);
  state.room.on("typing", (_p, from) => showTyping(from.email));
  await state.room.join().catch((e) => console.warn(e.message));
}

function closeDoc() {
  state.room?.leave();
  state.room = null;
  state.current = null;
  $("doc").classList.add("hidden");
  $("empty").classList.remove("hidden");
}

function applyRemote(row) {
  const mine = row.updated_by === state.user.id;
  state.current = { ...state.current, ...row };
  if (mine || state.dirty) return; // our own echo, or we have newer local edits
  if (document.activeElement !== $("title")) $("title").value = row.title;
  const ta = $("content");
  if (ta.value === row.content) return;
  // Keep the caret roughly where it was when text before it changes.
  const { selectionStart: s, selectionEnd: e } = ta;
  let i = 0;
  while (i < ta.value.length && ta.value[i] === row.content[i]) i++;
  const shift = row.content.length - ta.value.length;
  ta.value = row.content;
  if (document.activeElement === ta) {
    ta.setSelectionRange(s > i ? s + shift : s, e > i ? e + shift : e);
  }
}

// Throttle, not debounce: while someone types continuously we still push an update
// at most every SAVE_MS, so the other side sees text stream in instead of waiting
// for the typist to pause. Only one save is in flight at a time.
const SAVE_MS = 100;
let saveTimer;
let saving = false;
let lastSave = 0;
let lastTyping = 0;
function scheduleSave() {
  if (saveTimer || saving) return;
  const wait = Math.max(0, SAVE_MS - (Date.now() - lastSave));
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    saving = true;
    lastSave = Date.now();
    try {
      await save();
    } finally {
      saving = false;
    }
    if (state.dirty) scheduleSave(); // more edits arrived while saving
  }, wait);
}
function onEdit() {
  state.dirty = true;
  state.editSeq = (state.editSeq ?? 0) + 1;
  setStatus("Saving...");
  scheduleSave();
  if (Date.now() - lastTyping > 1000) {
    lastTyping = Date.now();
    state.room?.send("typing", {});
  }
}
$("content").oninput = onEdit;
$("title").oninput = onEdit;

async function save() {
  if (!state.current) return;
  const seq = state.editSeq;
  const patch = { title: $("title").value, content: $("content").value };
  const { error } = await sb.from("docs").update(patch).eq("id", state.current.id);
  // Only clear dirty if nothing was typed while the request was in flight.
  if (state.editSeq === seq) state.dirty = false;
  setStatus(error ? `Error: ${error.message}` : state.dirty ? "Saving..." : "Saved");
}

function setStatus(s) {
  $("status").textContent = s;
}

let typingTimer;
function showTyping(email) {
  $("typing").textContent = `${email} is typing...`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => ($("typing").textContent = ""), 2000);
}

function color(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function renderPresence(users) {
  const seen = new Map();
  for (const u of users) seen.set(u.user_id, u); // one avatar per person, even with many tabs
  $("presence").replaceChildren(
    ...[...seen.values()].map((u) => {
      const el = document.createElement("div");
      el.className = "avatar";
      el.title = u.email + (u.user_id === state.user.id ? " (you)" : "");
      el.textContent = (u.email ?? "?").slice(0, 2).toUpperCase();
      el.style.background = color(u.email ?? "");
      return el;
    }),
  );
}

async function loadMembers() {
  const id = state.current.id;
  const { data } = await sb.from("doc_members").select("email").eq("doc_id", id);
  if (state.current?.id !== id) return;
  $("members").textContent = data?.length ? `Shared with ${data.map((m) => m.email).join(", ")}` : "";
}

$("share").onclick = async () => {
  const email = prompt("Share with (their email, they need an account):");
  if (!email) return;
  const { error } = await sb.functions.invoke("share-doc", { body: { doc_id: state.current.id, email } });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    return alert(body?.error ?? error.message);
  }
  loadMembers();
};

$("delete").onclick = async () => {
  if (!confirm("Delete this doc for everyone?")) return;
  await sb.from("docs").delete().eq("id", state.current.id);
};

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== state.current?.id && state.user) openDoc(id);
});
