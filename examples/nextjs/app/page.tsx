"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, useSession, type Doc } from "@/lib/cheapabase";

export default function Home() {
  const session = useSession();
  if (session === undefined) return <p className="muted">Loading...</p>;
  return session ? <Dashboard session={session} /> : <SignIn />;
}

function SignIn() {
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const creds = { email: String(form.get("email")), password: String(form.get("password")) };
    const signUp = (e.nativeEvent as SubmitEvent).submitter?.id === "signup";
    const { supabase } = await getSupabase();
    const { error } = signUp ? await supabase.auth.signUp(creds) : await supabase.auth.signInWithPassword(creds);
    setError(error?.message ?? "");
    // On success useSession() sees the new session and Home re-renders as the dashboard.
  }

  return (
    <>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <input id="email" name="email" type="email" placeholder="Email" required autoComplete="email" />
        <input id="password" name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        <button id="signin" type="submit">Sign in</button>
        <button id="signup" type="submit" className="secondary">Sign up</button>
      </form>
      <p id="error" role="alert">{error}</p>
    </>
  );
}

function Dashboard({ session }: { session: Session }) {
  const router = useRouter();
  const [hello, setHello] = useState("");
  const [docs, setDocs] = useState<Pick<Doc, "id" | "title">[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    getSupabase().then(async ({ supabase }) => {
      // Edge-function style call: supabase-js sends the user's token, the function sees the user.
      const fn = await supabase.functions.invoke<{ message: string }>("hello", { method: "GET" });
      if (fn.error) setError(fn.error.message);
      else setHello(fn.data?.message ?? "");

      // RLS decides which docs come back.
      const list = await supabase.from("docs").select("id,title").order("updated_at", { ascending: false });
      if (list.error) setError(list.error.message);
      else setDocs(list.data);
    });
  }, [session.user.id]);

  async function createDoc(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get("title")).trim() || "Untitled";
    const { supabase } = await getSupabase();
    const { data, error } = await supabase.from("docs").insert({ title }).select("id").single();
    if (error) return setError(error.message);
    router.push(`/docs/${data.id}`);
  }

  async function signOut() {
    const { supabase } = await getSupabase();
    await supabase.auth.signOut();
  }

  return (
    <>
      <div className="row">
        <h1 style={{ flex: 1 }}>Docs</h1>
        <span className="muted">{session.user.email}</span>
        <button id="signout" className="secondary" onClick={signOut}>Sign out</button>
      </div>
      <p id="hello">{hello}</p>
      <form onSubmit={createDoc}>
        <input id="new-doc-title" name="title" placeholder="New doc title" />
        <button id="create-doc" type="submit">Create</button>
      </form>
      <p id="error" role="alert">{error}</p>
      <ul>
        {docs.map((d) => (
          <li key={d.id}>
            <Link className="doc-link" href={`/docs/${d.id}`}>{d.title}</Link>
          </li>
        ))}
      </ul>
      {docs.length === 0 && <p className="muted">No docs yet.</p>}
    </>
  );
}
