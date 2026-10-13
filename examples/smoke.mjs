// Browser smoke test every example must pass. See examples/CONTRACT.md.
// usage: node examples/smoke.mjs http://localhost:3001
// Set CHROMIUM_PATH to use an existing Chromium.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const base = (process.argv[2] ?? process.env.EXAMPLE_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node examples/smoke.mjs <example url>");
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const T = { timeout: 10000 };
const errors = [];
const step = async (name, fn) => {
  process.stdout.write(`- ${name} ... `);
  await fn();
  console.log("ok");
};

async function signUp(ctx, name) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base);
  const email = `${name}${Date.now()}@example.com`;
  await page.fill("#email", email);
  await page.fill("#password", "password123");
  await page.click("#signup");
  await page.waitForSelector("#hello", T);
  return { page, email };
}

try {
  console.log(`smoke test: ${base}`);
  const aliceCtx = await browser.newContext();
  let alice, docUrl;
  const title = `Smoke ${Date.now()}`;

  await step("sign up and call the hello function", async () => {
    alice = await signUp(aliceCtx, "alice");
    await alice.page.waitForFunction((e) => document.querySelector("#hello")?.textContent.includes(e), alice.email, T);
  });

  await step("create a doc", async () => {
    await alice.page.fill("#new-doc-title", title);
    await alice.page.click("#create-doc");
    await alice.page.waitForURL(/\/docs\/[0-9a-f-]{36}/, T);
    docUrl = alice.page.url();
    await alice.page.waitForFunction((t) => document.querySelector("#doc-title")?.textContent.includes(t), title, T);
  });

  await step("save content and see it after a reload", async () => {
    await alice.page.fill("#content", "hello from the smoke test");
    await alice.page.click("#save");
    await alice.page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Saved"), null, T);
    await alice.page.goto(docUrl);
    assert.equal(await alice.page.inputValue("#content"), "hello from the smoke test");
  });

  await step("doc shows up in the list", async () => {
    await alice.page.goto(base);
    await alice.page.waitForSelector("a.doc-link", T);
    const titles = await alice.page.$$eval("a.doc-link", (l) => l.map((a) => a.textContent.trim()));
    assert.ok(titles.includes(title), `list: ${titles}`);
  });

  await step("realtime: an edit in another tab shows up live", async () => {
    const viewer = await aliceCtx.newPage();
    viewer.on("pageerror", (e) => errors.push(`viewer: ${e.message}`));
    await viewer.goto(docUrl);
    await viewer.waitForSelector("#content", T);
    await viewer.waitForTimeout(1000); // let the websocket subscribe
    await alice.page.goto(docUrl);
    await alice.page.fill("#content", "edited live");
    await alice.page.click("#save");
    await viewer.waitForFunction(() => document.querySelector("#content").value === "edited live", null, T);
  });

  await step("rls: another user can't see the doc", async () => {
    const bob = await signUp(await browser.newContext(), "bob");
    const titles = await bob.page.$$eval("a.doc-link", (l) => l.map((a) => a.textContent.trim()));
    assert.ok(!titles.includes(title));
    await bob.page.goto(docUrl);
    await bob.page.waitForSelector("#not-found", T);
  });

  await step("signed out users are sent back to sign in", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(docUrl);
    await page.waitForSelector("#email", T);
  });

  await step("no page errors", async () => assert.deepEqual(errors, []));
  console.log("PASS");
} finally {
  await browser.close();
}
