// Server-side realtime helpers that don't need a database.
import { expect, test } from "bun:test";

process.env.JWT_SECRET ??= "unit-test-secret-0123456789abcdef0123";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
const { allow, newKey } = await import("../../server/realtime");

test("rate limit allows a 2x burst, then refills at the per-second rate", () => {
  const d = { budget: 20, refilled: 0 };
  let ok = 0;
  for (let i = 0; i < 30; i++) if (allow(d, 0, 10)) ok++;
  expect(ok).toBe(20);
  expect(allow(d, 0, 10)).toBe(false);
  expect(allow(d, 500, 10)).toBe(true); // half a second refills 5
  for (let i = 0; i < 4; i++) allow(d, 500, 10);
  expect(allow(d, 500, 10)).toBe(false);
});

test("socket keys are short and unique", () => {
  const keys = new Set(Array.from({ length: 5000 }, () => newKey()));
  expect(keys.size).toBe(5000);
  expect(Math.max(...[...keys].map((k) => k.length))).toBeLessThanOrEqual(6);
});
