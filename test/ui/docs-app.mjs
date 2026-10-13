// Browser test for the example docs app: two users, sharing, presence, live edits, live delete.
// Needs a running stack (docker compose up). Run: npm run test:ui
// Set CHROMIUM_PATH to use an existing Chromium instead of the one playwright-core installs.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const URL = process.env.CHEAPABASE_URL ?? "http://localhost:8000";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
let shareWith = "";

async function signUp(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name} console: ${m.text()}`));
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? shareWith : undefined));
  await page.goto(URL);
  const email = `${name}${Date.now()}@example.com`;
  await page.click("#auth-toggle");
  await page.fill("#email", email);
  await page.fill("#password", "password123");
  await page.click("#auth-submit");
  await page.waitForSelector("#app:not(.hidden)");
  return { page, email };
}

const step = async (name, fn) => {
  process.stdout.write(`- ${name} ... `);
  await fn();
  console.log("ok");
};

try {
  const bob = await signUp("bob");
  const alice = await signUp("alice");
  shareWith = bob.email;
  const content = (p) => p.$eval("#content", (el) => el.value);

  await step("alice creates and saves a doc", async () => {
    await alice.page.click("#new-doc");
    await alice.page.waitForSelector("#doc:not(.hidden)");
    await alice.page.fill("#title", "Launch plan");
    await alice.page.fill("#content", "First draft from Alice.");
    await alice.page.waitForFunction(() => document.getElementById("status").textContent === "Saved");
  });

  await step("bob can't see it yet", async () => {
    assert.equal(await bob.page.$$eval("#doc-list li", (l) => l.length), 0);
  });

  await step("alice shares it, bob's sidebar updates live", async () => {
    await alice.page.click("#share");
    await alice.page.waitForFunction(() => document.getElementById("members").textContent.includes("Shared"));
    await bob.page.waitForSelector("#doc-list li .tag", { timeout: 5000 });
  });

  await step("both show up in presence", async () => {
    await bob.page.click("#doc-list li");
    await bob.page.waitForFunction(() => document.getElementById("content").value.includes("Alice"));
    await alice.page.waitForFunction(() => document.querySelectorAll("#presence .avatar").length === 2, null, { timeout: 5000 });
  });

  await step("bob types, alice sees the text and the typing indicator", async () => {
    await bob.page.click("#content");
    await bob.page.keyboard.press("End");
    await bob.page.keyboard.type(" Bob was here.");
    await alice.page.waitForFunction(() => document.getElementById("content").value.includes("Bob was here"), null, { timeout: 5000 });
    assert.match(await alice.page.textContent("#typing"), /is typing/);
    assert.equal(await content(alice.page), "First draft from Alice. Bob was here.");
  });

  await step("alice deletes, bob's editor closes live", async () => {
    await alice.page.click("#delete");
    await bob.page.waitForSelector("#empty:not(.hidden)", { timeout: 5000 });
    assert.equal(await bob.page.$$eval("#doc-list li", (l) => l.length), 0);
  });

  await step("no page errors", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
}
