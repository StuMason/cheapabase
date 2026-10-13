import postgres from "postgres";
import { createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import type { Claims } from "./jwt";

// Admin connection (the DATABASE_URL user, usually `postgres`). Used for migrations,
// realtime LISTEN, and running queries "as" a user via SET LOCAL ROLE.
export const sql = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });

// Passwords for the internal login roles are derived from JWT_SECRET so every boot
// (and every replica) agrees without storing anything extra.
export function rolePassword(role: string) {
  return createHmac("sha256", config.jwtSecret).update(`cheapabase:${role}`).digest("hex");
}

export function urlForRole(role: string) {
  const u = new URL(config.databaseUrl);
  u.username = role;
  u.password = rolePassword(role);
  return u.toString();
}

const ALLOWED_ROLES = new Set(["anon", "authenticated", "service_role"]);

// Run queries with the same role + claims PostgREST would use, so RLS applies.
export async function asUser<T>(claims: Claims | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const role = claims?.role && ALLOWED_ROLES.has(claims.role) ? claims.role : "anon";
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims ?? { role })}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function runDir(dir: string, label: string) {
  await sql`create schema if not exists cheapabase`;
  await sql`create table if not exists cheapabase.migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await sql`select name from cheapabase.migrations`).map((r) => r.name));
  for (const file of files) {
    const name = `${label}/${file}`;
    if (done.has(name)) continue;
    const body = await Bun.file(join(dir, file)).text();
    console.log(`[cheapabase] applying ${name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into cheapabase.migrations (name) values (${name})`;
    });
  }
}

// Step 1: roles and schemas the auth server and PostgREST expect. Runs every boot (idempotent).
export async function bootstrap() {
  const dir = join(import.meta.dir, "..", "db");
  await sql.unsafe(await Bun.file(join(dir, "bootstrap.sql")).text());
  for (const role of ["authenticator", "supabase_auth_admin"]) {
    await sql.unsafe(`alter role ${role} with login password '${rolePassword(role)}'`);
  }
}

// Step 2: your app migrations in db/migrations, applied once each, in filename order.
export async function migrate() {
  await runDir(join(import.meta.dir, "..", "db", "migrations"), "app");
  await sql`notify pgrst, 'reload schema'`;
}
