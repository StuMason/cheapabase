// Starts the two upstream binaries (auth + PostgREST) as child processes on localhost.
// If either dies, we exit so the platform (Docker, Railway) restarts the container.
import { config } from "./config";
import { urlForRole } from "./db";

const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;

function stopAll(code: number) {
  stopping = true;
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGTERM", () => stopAll(0));
process.on("SIGINT", () => stopAll(0));

function spawn(name: string, cmd: string[], env: Record<string, string>) {
  const proc = Bun.spawn(cmd, {
    // Clean env on purpose: Railway's PORT must not leak into the children.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(proc);
  proc.exited.then((code) => {
    if (stopping) return;
    console.error(`[cheapabase] ${name} exited with code ${code}, shutting down`);
    stopAll(1);
  });
  return proc;
}

async function waitFor(name: string, url: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

function passthrough(prefix: string) {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => k.startsWith(prefix) && v !== undefined),
  ) as Record<string, string>;
}

export async function startAuth() {
  spawn("auth", [config.authBin], {
    GOTRUE_API_HOST: "127.0.0.1",
    GOTRUE_API_PORT: String(config.authPort),
    API_EXTERNAL_URL: `${config.publicUrl}/auth/v1`,
    GOTRUE_SITE_URL: config.publicUrl,
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_NAMESPACE: "auth",
    GOTRUE_DB_DATABASE_URL: urlForRole("supabase_auth_admin"),
    GOTRUE_DB_MIGRATIONS_PATH: config.authMigrationsPath,
    GOTRUE_JWT_SECRET: config.jwtSecret,
    GOTRUE_JWT_EXP: String(config.jwtExpiry),
    GOTRUE_JWT_AUD: "authenticated",
    // Logs a deprecation warning but is still what puts role=authenticated in user JWTs.
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_DISABLE_SIGNUP: String(config.disableSignup),
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_MAILER_AUTOCONFIRM: String(config.autoconfirm),
    GOTRUE_LOG_LEVEL: "warn",
    // Anything you set as GOTRUE_* (SMTP, OAuth providers, ...) overrides the defaults above.
    ...passthrough("GOTRUE_"),
  });
  await waitFor("auth", `http://127.0.0.1:${config.authPort}/health`);
}

export async function startPostgrest() {
  spawn("postgrest", [config.postgrestBin], {
    PGRST_DB_URI: urlForRole("authenticator"),
    PGRST_DB_SCHEMAS: config.dbSchemas,
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: config.jwtSecret,
    PGRST_SERVER_HOST: "127.0.0.1",
    PGRST_SERVER_PORT: String(config.postgrestPort),
    PGRST_DB_CHANNEL_ENABLED: "true",
    PGRST_LOG_LEVEL: "warn",
    ...passthrough("PGRST_"),
  });
  await waitFor("postgrest", `http://127.0.0.1:${config.postgrestPort}/`);
}
