// All configuration comes from env vars. Only DATABASE_URL and JWT_SECRET are required.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[cheapabase] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT ?? 8000);

// Railway sets RAILWAY_PUBLIC_DOMAIN for services with a public domain.
const publicUrl = (
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)
).replace(/\/$/, "");

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  console.error("[cheapabase] JWT_SECRET must be at least 32 characters");
  process.exit(1);
}

export const config = {
  port,
  publicUrl,
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  jwtExpiry: Number(process.env.JWT_EXPIRY ?? 3600),
  postgrestBin: process.env.POSTGREST_BIN ?? "postgrest",
  authBin: process.env.AUTH_BIN ?? "auth",
  authMigrationsPath: process.env.AUTH_MIGRATIONS_PATH ?? "/usr/local/etc/auth/migrations",
  postgrestPort: Number(process.env.POSTGREST_PORT ?? 3000),
  authPort: Number(process.env.AUTH_PORT ?? 9999),
  // Extra env passed straight through to the auth server (GOTRUE_*), e.g. SMTP or OAuth settings.
  disableSignup: process.env.DISABLE_SIGNUP === "true",
  autoconfirm: process.env.MAILER_AUTOCONFIRM !== "false",
  dbSchemas: process.env.DB_SCHEMAS ?? "public",
};
