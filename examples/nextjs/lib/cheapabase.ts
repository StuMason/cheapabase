"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import type { RealtimeClient } from "./realtime";

import { CHEAPABASE_URL } from "./config";

export { CHEAPABASE_URL };

export type Doc = { id: string; title: string; content: string };

let client: Promise<{ supabase: SupabaseClient; anonKey: string }> | undefined;

/**
 * The official supabase-js client, pointed at cheapabase. The anon key comes from
 * $CHEAPABASE_URL/config.json at runtime, so there's nothing to configure but the URL.
 */
export function getSupabase() {
  client ??= fetch(`${CHEAPABASE_URL}/config.json`)
    .then((res) => res.json() as Promise<{ anonKey: string }>)
    .then(({ anonKey }) => ({ supabase: createClient(CHEAPABASE_URL, anonKey), anonKey }));
  return client;
}

let realtime: Promise<RealtimeClient> | undefined;

/**
 * cheapabase's own realtime client (supabase.channel() is not supported).
 * realtime.js is served by the gateway as an ES module, so load it at runtime
 * instead of bundling it. getToken is called on every (re)connect.
 */
export async function getRealtime() {
  realtime ??= (async () => {
    const { supabase, anonKey } = await getSupabase();
    const mod: typeof import("./realtime") = await import(/* webpackIgnore: true */ `${CHEAPABASE_URL}/realtime.js`);
    let token: string | undefined = (await supabase.auth.getSession()).data.session?.access_token;
    const rt = new mod.RealtimeClient(CHEAPABASE_URL, () => token ?? anonKey);
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        // Signed out: drop the socket, the next getRealtime() connects as the next user.
        data.subscription.unsubscribe();
        rt.close();
        realtime = undefined;
      } else if (session.access_token !== token) {
        token = session.access_token; // refreshed or a new sign-in
        rt.setAuth(token);
      }
    });
    return rt;
  })();
  return realtime;
}

/** The current session: undefined while loading, null when signed out. */
export function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    getSupabase().then(({ supabase }) => {
      if (!active) return;
      // onAuthStateChange fires INITIAL_SESSION right away, then every sign in/out/refresh.
      const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
      unsubscribe = () => data.subscription.unsubscribe();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return session;
}
