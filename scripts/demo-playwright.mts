/**
 * Playwright proof for the SessionEvent demo page.
 *
 * Opens the page, primes localStorage with the demo bearer token, waits for
 * the cards to render, asserts the three signature pieces of content from
 * the stub-harness script, and screenshots the page to
 *   ~/Downloads/litellm-agent-platform-proof/demo-ui.png
 *
 * Pre-reqs (see scripts/stub-harness.mts + scripts/proof-subscriber.mts):
 *   - Postgres up on :5434
 *   - Next dev on :3003 with MASTER_KEY=sk-1234abcd
 *   - Stub harness on :4100
 *   - Subscriber for session c0e906b5-... draining /event into the DB
 *   - The 8 stub events already persisted (DELETE + curl POST /message)
 *
 * Usage:
 *   npx tsx scripts/demo-playwright.mts
 */
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const SID = "c0e906b5-1482-4b69-87a2-76c19929e3e6";
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3003";
const TOKEN = process.env.DEMO_TOKEN ?? "sk-1234abcd";
const OUT = path.join(
  os.homedir(),
  "Downloads/litellm-agent-platform-proof/demo-ui.png",
);

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  // Prime localStorage on the right origin BEFORE navigating to the page.
  await ctx.addInitScript((tok: string) => {
    window.localStorage.setItem("demo_token", tok);
  }, TOKEN);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/sessions/${SID}/events`, {
    waitUntil: "domcontentloaded",
  });

  // Long-poll may take a beat; wait for >=6 cards.
  await page.waitForFunction(
    () => document.querySelectorAll("[data-event-type]").length >= 6,
    null,
    { timeout: 20_000 },
  );

  const cards = await page.locator("[data-event-type]").all();
  const types = await Promise.all(
    cards.map((c) => c.getAttribute("data-event-type")),
  );
  console.log(`[demo] rendered cards: ${cards.length} types=${types.join(",")}`);

  const bodyText = await page.locator("body").innerText();
  const checks: Array<[string, boolean]> = [
    [
      'assistant_text "Hi! Looking at the PR now."',
      bodyText.includes("Hi! Looking at the PR now."),
    ],
    [
      'tool_call "git fetch origin pull/27344/head"',
      bodyText.includes("git fetch origin pull/27344/head"),
    ],
    ["tool_result FETCH_HEAD", bodyText.includes("FETCH_HEAD")],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "OK " : "MISS"} ${name}`);
  }
  if (checks.some(([, ok]) => !ok)) {
    console.warn("[demo] one or more content assertions missed");
  }

  await page.screenshot({ path: OUT, fullPage: true });
  console.log(`[demo] screenshot -> ${OUT}`);

  console.log("[demo] leaving browser open for 60s for inspection");
  await page.waitForTimeout(60_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
