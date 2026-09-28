// Viewport guidance in real Chrome at phone width: camera reveal, result reveal, no
// scrolling for answers, scan-another, upload, denied camera, manual-scroll cancel,
// reduced motion, and no desktop scrolling. Synthetic camera, mocked Gemini.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const identity = { provider: "gemini", status: "hypothesis", confidence: "high", needsAnotherView: false, observations: ["A centered rectangular test fixture"], name: "Synthetic test object", brand: null, category: null, description: "Deterministic UI test response.", sourceCount: 0, sources: [], topics: [] };
const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#5a6a7a" } }).png().toBuffer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
async function open({ viewport = { width: 390, height: 844 }, denyCamera = false, reducedMotion = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((deny) => {
    localStorage.setItem("ucenth-voice", "off"); // typed conversation only: no Charon, no microphone
    window.guideLog = [];
    // Every programmatic scroll is counted, so "did not move the page" is checked directly.
    window.scrollCalls = 0;
    const native = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) { window.scrollCalls++; return native.apply(this, a); };
    document.addEventListener("ucenth:viewport-guide", (e) =>
      window.guideLog.push({ ...e.detail, scrollY: Math.round(scrollY), viewerTop: Math.round(document.querySelector(".viewer").getBoundingClientRect().top), resultsTop: Math.round(document.getElementById("results").getBoundingClientRect().top) }),
    );
    const camera = document.createElement("canvas");
    camera.width = 640; camera.height = 480;
    const ctx = camera.getContext("2d");
    let object = false;
    setInterval(() => {
      ctx.fillStyle = "#20252c"; ctx.fillRect(0, 0, 640, 480);
      if (object) { ctx.fillStyle = "#e5e1ce"; ctx.fillRect(235, 110, 170, 290); ctx.fillStyle = "#547dca"; ctx.fillRect(245, 175, 150, 120); ctx.fillStyle = "#fff"; ctx.font = "20px Arial"; ctx.fillText("TEST OBJECT", 250, 220); }
    }, 50);
    window.testCamera = { setObject: (v) => (object = v) };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        if (deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        return camera.captureStream(20);
      },
    });
  }, denyCamera);
  let release = null, hold = false;
  await page.route("**/api/identify", async (route) => {
    if (hold) await new Promise((r) => (release = r));
    await route.fulfill({ json: identity });
  });
  await page.route("**/api/follow-up", (route) => route.fulfill({ json: { answer: "It is a test fixture.", userSuppliedIdentity: "" } }));
  await page.route("**/api/speech", (route) => route.fulfill({ status: 503, json: { error: "off" } }));
  await page.goto(base);
  const log = () => page.evaluate(() => window.guideLog);
  const count = async (reason, outcome) => (await log()).filter((e) => e.reason === reason && e.outcome === outcome).length;
  const waitFor = (reason, outcome, n = 1) => page.waitForFunction(([r, o, n]) => window.guideLog.filter((e) => e.reason === r && e.outcome === o).length >= n, [reason, outcome, n], { timeout: 20000 });
  const top = (selector) => page.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), selector);
  const settled = (selector) => page.waitForFunction((s) => { const t = document.querySelector(s).getBoundingClientRect().top; return t >= 0 && t <= 60; }, selector, { timeout: 5000 });
  const scan = async () => {
    await page.evaluate(() => window.testCamera.setObject(false)); // calibrate on an empty frame first
    await page.waitForFunction(() => document.getElementById("state-label").textContent === "SHOW ME AN OBJECT", null, { timeout: 30000 });
    await page.evaluate(() => window.testCamera.setObject(true));
    await page.getByRole("heading", { name: "Synthetic test object" }).waitFor({ timeout: 30000 });
  };
  return { page, context, log, count, waitFor, top, settled, scan, holdIdentify: (v) => (hold = v), releaseIdentify: () => release?.() };
}
try {
  console.log("step 1");
  // 1. Phone: Open Camera reveals the live stage once the video plays; result reveals the identity.
  const m = await open();
  assert.equal(await m.page.evaluate(() => scrollY), 0);
  await m.page.getByRole("button", { name: "Open Camera" }).click();
  await m.page.waitForFunction(() => document.getElementById("camera-label").textContent === "CAMERA LIVE");
  await m.waitFor("camera", "scrolled");
  await m.settled(".viewer");
  const cameraEvent = (await m.log()).find((e) => e.reason === "camera" && e.outcome === "scrolled");
  assert.equal(cameraEvent.behavior, "smooth");
  // Playwright scrolls the button into view before clicking; the arm simply records that position.
  assert.ok((await m.log()).some((e) => e.reason === "camera" && e.outcome === "armed"), "armed by the tap");
  await m.scan();
  await m.waitFor("result", "scrolled");
  await m.settled("#results");
  const heading = await m.page.getByRole("heading", { name: "Synthetic test object" }).boundingBox();
  assert.ok(heading.y >= 0 && heading.y < 400, `identity heading visible near the top (y=${heading.y})`);
  assert.equal(await m.page.locator(".voice-panel").count(), 1, "conversation presence mounted");
  console.log("step 2");
  // 2. No scrolling for questions and answers.
  const before = await m.page.evaluate(() => scrollY);
  await m.page.locator(".voice-typed").evaluate((n) => (n.open = true));
  await m.page.getByRole("textbox", { name: "Question about the scanned object" }).fill("What is it?");
  await m.page.getByRole("button", { name: "Send" }).click();
  await m.page.waitForFunction(() => document.querySelector(".voice-answer")?.textContent.includes("test fixture"));
  await m.page.waitForTimeout(800);
  assert.equal(await m.count("result", "scrolled"), 1);
  assert.equal(await m.count("camera", "scrolled"), 1);
  assert.ok(Math.abs((await m.page.evaluate(() => scrollY)) - before) < 3, "answer did not move the page");
  assert.equal(await m.page.evaluate(() => window.scrollCalls), 2, "exactly the two guided moves so far");
  console.log("step 3");
  // 3. Scan another object: guided back to the camera only when it is live again.
  await m.page.evaluate(() => window.testCamera.setObject(false));
  await m.page.getByRole("button", { name: "Scan another object" }).click();
  await m.page.waitForFunction(() => document.getElementById("camera-label").textContent === "CAMERA LIVE");
  await m.waitFor("camera", "scrolled", 2);
  await m.settled(".viewer");
  console.log("step 4");
  // 4. Upload: no camera scroll, straight to the result.
  await m.page.getByRole("button", { name: "Stop camera" }).click();
  await m.page.evaluate(() => scrollTo(0, 0));
  await m.page.locator("#upload").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
  await m.page.getByRole("heading", { name: "Synthetic test object" }).waitFor({ timeout: 30000 });
  await m.waitFor("result", "scrolled", 2);
  await m.settled("#results");
  assert.equal(await m.count("camera", "scrolled"), 2, "upload never scrolled to the camera");
  console.log("step 5");
  // 5. Focused text field (keyboard open) suppresses a result reveal.
  await m.page.evaluate(() => window.testCamera.setObject(false));
  await m.page.getByRole("button", { name: "Scan another object" }).click();
  await m.page.waitForFunction(() => document.getElementById("camera-label").textContent === "CAMERA LIVE");
  await m.waitFor("camera", "scrolled", 3);
  await m.page.evaluate(() => { const i = document.createElement("input"); i.id = "probe"; document.body.append(i); i.focus(); });
  await m.scan();
  await m.waitFor("result", "skipped-keyboard");
  await m.context.close();
  console.log("step 6");
  // 6. Manual scroll during analysis cancels the pending result reveal.
  const s = await open();
  await s.page.getByRole("button", { name: "Open Camera" }).click();
  await s.waitFor("camera", "scrolled");
  await s.settled(".viewer");
  s.holdIdentify(true);
  await s.page.waitForFunction(() => document.getElementById("state-label").textContent === "SHOW ME AN OBJECT", null, { timeout: 30000 });
  await s.page.evaluate(() => window.testCamera.setObject(true));
  await s.page.waitForFunction(() => document.getElementById("stage").classList.contains("scanning"), null, { timeout: 30000 });
  await s.page.mouse.move(195, 400);
  await s.page.mouse.wheel(0, 500);
  await s.page.waitForTimeout(400);
  const parked = await s.page.evaluate(() => ({ y: scrollY, calls: window.scrollCalls }));
  s.releaseIdentify();
  await s.page.getByRole("heading", { name: "Synthetic test object" }).waitFor({ timeout: 30000 });
  await s.waitFor("result", "cancelled-user");
  await s.page.waitForTimeout(600);
  assert.equal(await s.count("result", "scrolled"), 0, "not dragged back after a manual scroll");
  // The viewer shrinks when a result renders, so the raw offset may shift with the layout;
  // what must not happen is any programmatic scroll after the person took control.
  assert.equal(await s.page.evaluate(() => window.scrollCalls), parked.calls, "no programmatic scroll after the manual one");
  await s.context.close();
  console.log("step 7");
  // 7. Denied camera: nothing to reveal, no scroll.
  const d = await open({ denyCamera: true });
  await d.page.getByRole("button", { name: "Open Camera" }).click();
  await d.page.locator(".error-title").waitFor();
  await d.waitFor("camera", "cancelled");
  await d.page.waitForTimeout(400);
  assert.equal(await d.count("camera", "scrolled"), 0);
  assert.equal(await d.page.evaluate(() => window.scrollCalls), 0, "no programmatic scroll after a denied camera");
  await d.context.close();
  console.log("step 8");
  // 8. Reduced motion: instant positioning, correct in the same frame.
  const r = await open({ reducedMotion: true });
  await r.page.getByRole("button", { name: "Open Camera" }).click();
  await r.waitFor("camera", "scrolled");
  const instant = (await r.log()).find((e) => e.reason === "camera" && e.outcome === "scrolled");
  assert.equal(instant.behavior, "auto");
  assert.ok(instant.viewerTop >= 0 && instant.viewerTop <= 60, `positioned immediately (top=${instant.viewerTop})`);
  await r.context.close();
  console.log("step 9");
  // 9. Desktop keeps its stationary two-column layout.
  const w = await open({ viewport: { width: 1440, height: 1060 } });
  await w.page.getByRole("button", { name: "Open Camera" }).click();
  await w.waitFor("camera", "skipped-desktop");
  await w.scan();
  await w.waitFor("result", "skipped-desktop");
  assert.equal((await w.log()).filter((e) => e.outcome === "scrolled").length, 0);
  assert.equal(await w.page.evaluate(() => window.scrollCalls), 0, "desktop never scrolls programmatically");
  await w.context.close();
  assert.deepEqual(errors, []);
  console.log("Viewport guidance Chrome checks passed: camera reveal, result reveal, no answer scrolling, scan-another, upload, keyboard, manual-scroll cancel, denied camera, reduced motion, desktop unchanged.");
} catch (error) {
  console.error("Viewport guidance Chrome checks failed:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
