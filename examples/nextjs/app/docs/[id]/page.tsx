"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getRealtime, getSupabase, useSession, type Doc } from "@/lib/cheapabase";

export default function DocPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const [doc, setDoc] = useState<Doc | null | undefined>(undefined); // null = not found
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const dirty = useRef(false); // unsaved local edits: don't let realtime overwrite them

  useEffect(() => {
    if (session === null) router.replace("/"); // signed out -> sign-in form
  }, [session, router]);

  // Load the doc. RLS returns no row if this user can't see it.
  useEffect(() => {
    if (!session) return;
    getSupabase().then(async ({ supabase }) => {
      const { data, error } = await supabase.from("docs").select("id,title,content").eq("id", id).maybeSingle();
      if (error) setStatus(error.message);
      setDoc(data);
      setContent(data?.content ?? "");
    });
  }, [id, session?.user.id]);

  // Live updates from cheapabase realtime, also filtered by RLS on the server.
  useEffect(() => {
    if (!session || !doc) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    getRealtime()
      .then((rt) =>
        rt.on<Doc>("docs", { event: "UPDATE", filter: `id=eq.${id}` }, ({ new: row }) => {
          if (!row) return;
          setDoc(row);
          if (!dirty.current) setContent(row.content);
        }),
      )
      .then((unsubscribe) => (cancelled ? unsubscribe() : (stop = unsubscribe)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [id, session?.user.id, doc?.id]);

  async function save() {
    setStatus("Saving...");
    const { supabase } = await getSupabase();
    const { error } = await supabase.from("docs").update({ content }).eq("id", id);
    if (error) return setStatus(error.message);
    dirty.current = false;
    setStatus("Saved");
  }

  if (!session || doc === undefined) return <p className="muted">Loading...</p>;

  return (
    <>
      <p><Link href="/">&larr; All docs</Link></p>
      {doc === null ? (
        <p id="not-found">Doc not found, or you don&apos;t have access to it.</p>
      ) : (
        <>
          <h1 id="doc-title">{doc.title}</h1>
          <textarea
            id="content"
            value={content}
            onChange={(e) => {
              dirty.current = true;
              setStatus("");
              setContent(e.target.value);
            }}
          />
          <div className="row">
            <button id="save" onClick={save}>Save</button>
            <span id="status">{status}</span>
          </div>
        </>
      )}
    </>
  );
}
