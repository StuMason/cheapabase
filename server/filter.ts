export type Filter = { column: string; value: string };

// PostgREST style realtime filter: "doc_id=eq.123". Only eq is supported, which covers most UI needs.
// Returns undefined for "no filter" and null for an invalid one.
export function parseFilter(f: unknown): Filter | undefined | null {
  if (f == null || f === "") return undefined;
  const m = typeof f === "string" ? /^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.*)$/.exec(f) : null;
  return m ? { column: m[1], value: m[2] } : null;
}
