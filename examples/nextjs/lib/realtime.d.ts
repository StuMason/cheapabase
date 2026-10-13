// Types for $CHEAPABASE_URL/realtime.js (copied from client/realtime.d.ts in the cheapabase repo).

export type ChangeEvent<Row = Record<string, unknown>> = {
  type: "change";
  ref: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  new?: Row;
  old?: Partial<Row>;
};

export type PresenceUser = { key: string; user_id: string | null; email: string | null; [k: string]: unknown };
export type Sender = { key: string; user_id: string | null; email: string | null };

export type SubscribeOptions = {
  schema?: string;
  event?: "*" | "INSERT" | "UPDATE" | "DELETE";
  /** PostgREST style, eq only: "column=eq.value" */
  filter?: string;
};

export class RealtimeClient {
  constructor(url: string, getToken: () => string);
  channels: Map<string, Channel>;
  on<Row = Record<string, unknown>>(table: string, opts: SubscribeOptions, cb: (change: ChangeEvent<Row>) => void): Promise<() => void>;
  channel(name: string, opts?: { presence?: Record<string, unknown> }): Channel;
  setAuth(token: string): Promise<unknown>;
  close(): void;
}

export class Channel {
  name: string;
  users?: PresenceUser[];
  join(): Promise<Channel>;
  leave(): void;
  track(meta: Record<string, unknown>): void;
  send(event: string, payload: unknown, opts?: { self?: boolean }): void;
  on(event: string, cb: (payload: any, from: Sender, event?: string) => void): Channel;
  onPresence(cb: (users: PresenceUser[]) => void): Channel;
  /** Latest-value state, batched by the server once per tick. */
  setState(payload: unknown): void;
  /** Called once per tick with [presence key, payload] for every state that changed. */
  onStates(cb: (states: [string, any][]) => void): Channel;
}
