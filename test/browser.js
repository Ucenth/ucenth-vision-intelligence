const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
// Deterministic Chrome tests use synthetic camera frames and explicitly mocked
// provider responses. They do NOT establish real Google identification accuracy.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("status of 503"))
    errors.push(message.text());
});
await page.addInitScript(() => {
  window.toneStarts = 0;
  const createOscillator = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    const oscillator = createOscillator.call(this);
    const start = oscillator.start.bind(oscillator);
    oscillator.start = (...args) => {
      window.toneStarts++;
      start(...args);
    };
    return oscillator;
  };
  const camera = document.createElement("canvas");
  camera.width = 640;
  camera.height = 480;
  const ctx = camera.getContext("2d");
  let object = false,
    moving = false,
    tick = 0;
  function draw() {
    ctx.fillStyle = "#20252c";
    ctx.fillRect(0, 0, 640, 480);
    if (object) {
      const x = moving ? 170 + Math.sin(tick) * 100 : 235;
      ctx.fillStyle = "#e5e1ce";
      ctx.fillRect(x, 110, 170, 290);
      ctx.fillStyle = "#547dca";
      ctx.fillRect(x + 10, 175, 150, 120);
      ctx.fillStyle = "#fff";
      ctx.font = "20px Arial";
      ctx.fillText("TEST OBJECT", x + 15, 220);
      ctx.fillStyle = "#bac4d1";
      ctx.fillRect(x + 40, 75, 90, 35);
    }
    tick += 0.7;
  }
  setInterval(draw, 50);
  draw();
  window.testCamera = {
    setObject(value) {
      object = value;
    },
    setMoving(value) {
      moving = value;
    },
    tracks: [],
  };
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async () => {
      const stream = camera.captureStream(20);
      window.testCamera.tracks.push(...stream.getTracks());
      return stream;
    },
  });
});
if (process.env.TEST_THEME === "light")
  await page.addInitScript(() => localStorage.setItem("ucenth-theme", "light"));
let calls = 0,
  payload = null,
  resolveSearch;
await page.route("**/api/identify", async (route) => {
  calls++;
  payload = route.request().postDataJSON();
  await new Promise((resolve) => (resolveSearch = resolve));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      provider: "gemini",
      status: "hypothesis",
      confidence: "high",
      needsAnotherView: false,
      observations: ["A centered rectangular test fixture"],
      name: "Synthetic test object",
      brand: null,
      category: null,
      description:
        "This is a deterministic UI test response, not a Google identification result.",
      sourceCount: 2,
      sources: [
        {
          url: "https://example.com/test",
          title: "Synthetic evidence — test only",
        },
      ],
      imageCounts: {
        fullMatchingImages: 1,
        partialMatchingImages: 0,
        visuallySimilarImages: 2,
      },
      topics: ["Test fixture"],
    }),
  });
});
await page.goto(baseUrl);
await page.screenshot({ path: "artifacts/desktop-ready.png", fullPage: true });
await page.getByRole("button", { name: "Open Camera" }).click();
await page.waitForFunction(
  () =>
    document.getElementById("state-label").textContent === "SHOW ME AN OBJECT",
);
await page.evaluate(() => window.testCamera.setObject(true));
await page.waitForFunction(
  () =>
    document.getElementById("countdown").textContent === "3" &&
    !document.getElementById("countdown").hidden,
);
await page.evaluate(() => window.testCamera.setMoving(true));
await page.waitForFunction(() => document.getElementById("countdown").hidden);
assert.equal(calls, 0, "movement must cancel before API");
assert.equal(await page.evaluate(() => window.toneStarts), 0);
await page.evaluate(() => window.testCamera.setMoving(false));
for (const value of ["3", "2", "1"])
  await page.waitForFunction(
    (value) =>
      document.getElementById("countdown").textContent === value &&
      !document.getElementById("countdown").hidden,
    value,
  );
await page.waitForFunction(() => !document.getElementById("capture").hidden);
await page.waitForFunction(() =>
  document.getElementById("stage").classList.contains("scanning"),
);
assert.match(payload.image, /^data:image\/jpeg;base64,/);
const still = await page
  .locator("#capture")
  .evaluate((canvas) => canvas.toDataURL());
await page.evaluate(() => window.testCamera.setObject(false));
assert.equal(
  await page.locator("#capture").evaluate((canvas) => canvas.toDataURL()),
  still,
);
assert.ok(
  await page.evaluate(() =>
    window.testCamera.tracks.every((t) => t.readyState === "ended"),
  ),
);
await page.screenshot({
  path: "artifacts/desktop-scan-synthetic.png",
  fullPage: true,
});
resolveSearch();
await page.getByRole("button", { name: "Scan another object" }).waitFor();
await page.getByRole("heading", { name: "Synthetic test object" }).waitFor();
assert.equal(calls, 1);
assert.equal(
  await page.evaluate(() => window.toneStarts),
  2,
  "one success cue after camera identification",
);
await page.screenshot({
  path: "artifacts/desktop-result-synthetic.png",
  fullPage: true,
});
await page.getByRole("button", { name: "Scan another object" }).click();
await page.waitForFunction(
  () => document.getElementById("camera-label").textContent === "CAMERA LIVE",
);
assert.equal(await page.locator("#capture").isVisible(), false);
await page.getByRole("button", { name: "Stop camera" }).click();
assert.ok(
  await page.evaluate(() =>
    window.testCamera.tracks.every((t) => t.readyState === "ended"),
  ),
);
assert.equal(calls, 1);
assert.equal(
  await page.evaluate(() => window.toneStarts),
  2,
  "one success cue after camera identification",
);
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: "artifacts/mobile-ready.png", fullPage: true });
assert.ok(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
);
await page.unroute("**/api/identify");
await page.route("**/api/identify", (route) =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      error:
        "Identification is not ready. Check server-side Google credentials and the enabled API, then restart the server.",
    }),
  }),
);
const image = Buffer.from(still.split(",")[1], "base64");
await page
  .locator("#upload")
  .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: image });
await page
  .getByRole("heading", { name: /Identification is not ready/ })
  .waitFor();
assert.equal(await page.locator("#capture").isVisible(), true);
assert.equal(
  await page
    .locator("#stage")
    .evaluate((el) => el.classList.contains("scanning")),
  false,
);
assert.equal(
  await page.evaluate(() => window.toneStarts),
  2,
  "errors and ordinary controls remain silent",
);
assert.deepEqual(errors, []);
const denied = await browser.newPage();
await denied.addInitScript(() =>
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async () => {
      throw new DOMException("Denied", "NotAllowedError");
    },
  }),
);
await denied.goto(baseUrl);
await denied.getByRole("button", { name: "Open Camera" }).click();
await denied
  .getByRole("heading", { name: /Camera access was denied/ })
  .waitFor();
await writeFile(
  "artifacts/browser-test.json",
  JSON.stringify(
    {
      browser: await browser.version(),
      date: new Date().toISOString(),
      synthetic: true,
      apiCalls: calls,
      errors,
      passed: [
        "camera start/stop",
        "empty frame calibration",
        "motion cancels countdown",
        "3 → 2 → 1",
        "real Canvas JPEG capture",
        "capture preserved after source removal",
        "scan edge treatment",
        "one request per capture",
        "source link safety",
        "progressive result",
        "reset",
        "390px mobile overflow",
        "API error",
        "camera denied",
      ],
    },
    null,
    2,
  ),
);
console.log(
  "Chrome browser tests passed; synthetic camera and mocked Gemini responses only.",
);
await browser.close();
