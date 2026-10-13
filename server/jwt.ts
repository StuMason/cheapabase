// Minimal HS256 JWT sign/verify with Web Crypto. No dependencies.

const enc = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return Buffer.from(bytes).toString("base64url");
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

export type Claims = { role?: string; sub?: string; email?: string; exp?: number; [k: string]: unknown };

export async function sign(payload: Claims, secret: string): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verify(token: string, secret: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString());
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      Buffer.from(sig, "base64url"),
      enc.encode(`${head}.${body}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
    if (claims.exp && claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

// The anon and service keys are just long-lived JWTs signed with the same secret,
// exactly like Supabase. They are derived from JWT_SECRET so they stay stable.
const TEN_YEARS = 10 * 365 * 24 * 3600;
export async function apiKeys(secret: string) {
  const iat = 1700000000;
  return {
    anonKey: await sign({ role: "anon", iss: "cheapabase", iat, exp: iat + TEN_YEARS }, secret),
    serviceKey: await sign({ role: "service_role", iss: "cheapabase", iat, exp: iat + TEN_YEARS }, secret),
  };
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.headers.get("apikey");
}
