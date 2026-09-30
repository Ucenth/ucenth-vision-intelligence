// Hosted edition in Chrome: allowance line, exhaustion message, source download and share.
// The server runs in-process with fake Google services, so the real quota path is
// exercised end to end without billing. Production-only; not in the release allowlist.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { createHostedServer } from "../production/server.js";
import { createMemoryStore } from "../production/quota/memory-store.js";
import { LIMIT } from "../production/quota/policy.js";

const identity = { provider: "gemini", status: "hypothesis", confidence: "high", name: "Blue notebook", brand: "Not determined", category: "Notebook", subjectType: "object", observations: ["Blue cover"], needsAnotherView: false, requestedView: "", description: "Fixture.", identityEstablished: false, identityName: "", identitySource: "none" };
const wav = Buffer.alloc(44 + 2400);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2400, 40);
const store = createMemoryStore();
const { server } = await createHostedServer({
  env: { PUBLIC_ORIGIN: "http://localhost", VISITOR_COOKIE_SECRET: "hosted-browser-test-secret-1234567890abcdef", QUOTA_STORE: "memory" },
  store,
  services: { identify: async () => identity, followUp: async () => ({ answer: "It is blue.", userSuppliedIdentity: "" }), synthesize: async () => wav },
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const image = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#5a6a7a" } }).png().toBuffer();
let page;
const errors = [], trail = [];
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (r.url().includes("/api/")) trail.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()} remaining=${r.headers()["x-quota-remaining"]}`); });
  await page.addInitScript(() => {
    localStorage.setItem("ucenth-voice", "on");
    window.SpeechRecognition = class { start() {} abort() { this.onend?.(); } };
    // Headless Chrome may expose navigator.share with a dialog that never resolves;
    // force the clipboard / link fallback so the share check is deterministic.
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await page.goto(base);
  // The allowance lives in the masthead: a count and a countdown to the next credit.
  await page.waitForFunction((n) => document.querySelector(".hosted-usage-count")?.textContent === `${n} / ${n} requests`, LIMIT, { timeout: 30000 });
  assert.equal(await page.locator(".hosted-usage").getAttribute("aria-label"), `${LIMIT} of ${LIMIT} free requests available.`);
  assert.match(await page.locator(".hosted-source h2").textContent(), /Learn how it works./);
  assert.match(await page.locator(".hosted-meta-version").textContent(), /Source Edition · v\d+\.\d+\.\d+/);
  const download = await page.request.get(`${base}/download/ucenth-vision-intelligence-source.zip`);
  assert.equal(download.status(), 200);
  assert.equal(download.headers()["content-type"], "application/zip");
  const upload = () => page.locator("#upload").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: image });
  // Five real trips through the hosted layer (fake Gemini), Charon intro allowed each time.
  for (let i = 1; i <= LIMIT; i++) {
    await upload();
    await page.waitForFunction(() => ["LISTENING", "USER_SPEAKING"].includes(document.querySelector(".voice-panel")?.dataset.state), null, { timeout: 20000 });
    // After the last credit the line switches to the exhaustion wording with the wait time.
    await page.waitForFunction((n) => document.querySelector(".hosted-usage-count")?.textContent === `${n} / 5 requests` && /^Next available in \d\d:\d\d:\d\d$/.test(document.querySelector(".hosted-usage-detail")?.textContent || ""), LIMIT - i, { timeout: 15000 });
    if (i < LIMIT) assert.equal(await page.locator("dialog.hosted-limit").evaluate((d) => d.open), false, `no limit notification with ${LIMIT - i} remaining`);
    else {
      // The fifth success took the last credit: the result is shown, then the notification.
      await page.waitForFunction(() => document.querySelector("dialog.hosted-limit")?.open === true, null, { timeout: 5000 });
      assert.match(await page.locator(".identity-name").textContent(), /Blue notebook/, "the fifth result is still shown");
      assert.match(await page.locator("#hosted-limit-title").textContent(), /^FREE LIMIT REACHED$/);
      assert.equal(await page.locator("#hosted-limit-text").textContent(), "You've used your 5 free requests.");
      // The countdown is the server's rolling-window timestamp, formatted HH:MM:SS.
      const q = await (await page.request.get(`${base}/api/quota`)).json();
      const shown = await page.locator(".hosted-limit-time").textContent();
      assert.match(shown, /^\d\d:[0-5]\d:[0-5]\d$/);
      const [h, m, s] = shown.split(":").map(Number), expected = Math.round((q.nextAt - q.serverTime) / 1000);
      assert.ok(Math.abs(h * 3600 + m * 60 + s - expected) <= 3, `countdown ${shown} matches the authoritative next-available time (${expected} s)`);
      const first = await page.locator(".hosted-limit-time").textContent();
      await page.waitForTimeout(1100);
      assert.notEqual(await page.locator(".hosted-limit-time").textContent(), first, "the countdown ticks");
      assert.equal(await page.locator(".hosted-limit-time").textContent(), await page.evaluate(() => document.querySelector(".hosted-usage-detail").textContent.replace("Next available in ", "")), "one timing source with the header");
      await page.getByRole("button", { name: "Got it" }).click();
      await page.waitForTimeout(1500);
      assert.equal(await page.locator("dialog.hosted-limit").evaluate((d) => d.open), false, "closed stays closed");
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("ucenth:result-presented", { detail: {} })));
      await page.waitForTimeout(1200);
      assert.equal(await page.locator("dialog.hosted-limit").evaluate((d) => d.open), false, "a quota re-read at zero does not reopen it");
    }
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.locator("#reset").click();
  }
  await upload();
  await page.locator(".error-title").waitFor();
  assert.match(await page.locator(".error-title").textContent(), /^Free usage limit reached\. You can use UCENTH Vision Intelligence again in \d+h \d{2}m\.$/);
  assert.match(await page.locator(".hosted-usage").getAttribute("aria-label"), /^0 of 5 requests remaining. Next request available in /);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no overflow at phone width");
  // The notification at phone width: within the viewport, a touch-sized close control.
  await page.evaluate(() => document.querySelector("dialog.hosted-limit").showModal());
  const box = await page.locator("dialog.hosted-limit").boundingBox(), close = await page.getByRole("button", { name: "Got it" }).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `dialog within 390 px (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
  assert.ok(close.height >= 44, "touch-friendly close control");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no overflow with the notification open");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Share Project" }).click();
  await page.waitForFunction(() => document.querySelector(".hosted-share-status")?.textContent);
  assert.match(await page.locator(".hosted-share-status").textContent(), /Link copied|Shared|http/);
  assert.deepEqual(errors, []);
  console.log("Hosted Chrome checks passed: allowance line, five charged requests, exhaustion countdown, download card, share, phone layout.");
} catch (error) {
  console.error("Hosted Chrome checks failed:", error.message);
  console.error("API trail:\n" + trail.join("\n"));
  console.error("usage:", await page.locator(".hosted-usage").textContent().catch(() => "(missing)"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
