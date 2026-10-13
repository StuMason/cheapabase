import { describe, expect, test } from "bun:test";
import { apiKeys, bearer, sign, verify } from "../../server/jwt";

const secret = "unit-test-secret-unit-test-secret-1234";

describe("jwt", () => {
  test("sign then verify round trips the claims", async () => {
    const token = await sign({ role: "authenticated", sub: "u1" }, secret);
    expect(await verify(token, secret)).toEqual({ role: "authenticated", sub: "u1" });
  });

  test("rejects a token signed with another secret", async () => {
    const token = await sign({ role: "service_role" }, "some-other-secret-some-other-secret-12");
    expect(await verify(token, secret)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const [h, , s] = (await sign({ role: "anon" }, secret)).split(".");
    const forged = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    expect(await verify(`${h}.${forged}.${s}`, secret)).toBeNull();
  });

  test("rejects expired tokens", async () => {
    const token = await sign({ role: "authenticated", exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(await verify(token, secret)).toBeNull();
  });

  test("rejects alg none and garbage", async () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    expect(await verify(`${head}.${body}.`, secret)).toBeNull();
    expect(await verify("not-a-jwt", secret)).toBeNull();
    expect(await verify("a.b.c", secret)).toBeNull();
  });

  test("api keys are stable and carry the right roles", async () => {
    const a = await apiKeys(secret);
    const b = await apiKeys(secret);
    expect(a).toEqual(b);
    expect((await verify(a.anonKey, secret))?.role).toBe("anon");
    expect((await verify(a.serviceKey, secret))?.role).toBe("service_role");
  });

  test("bearer reads the Authorization header, then apikey", () => {
    expect(bearer(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(bearer(new Request("http://x", { headers: { apikey: "key" } }))).toBe("key");
    expect(bearer(new Request("http://x"))).toBeNull();
  });
});
