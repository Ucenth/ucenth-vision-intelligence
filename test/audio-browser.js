// Real Web Audio graph under Chrome's user-activation autoplay policy.
// Output samples establish signal delivery, not subjective speaker audibility.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADED_AUDIO !== "1",
  ignoreDefaultArgs: ["--mute-audio"],
  args: ["--autoplay-policy=document-user-activation-required"],
});
const buffer = await sharp({
  create: { width: 200, height: 300, channels: 3, background: "#ccc" },
})
  .png()
  .toBuffer();
const reports = [];
try {
  for (const mode of ["on", "muted", "unmute-during-scan", "interrupted"]) {
    const page = await browser.newPage();
    await page.addInitScript(
      ({ mode }) => {
        if (!localStorage.getItem("ucenth-sound"))
          localStorage.setItem(
            "ucenth-sound",
            ["muted", "unmute-during-scan"].includes(mode) ? "off" : "on",
          );
        window.audioProbe = { starts: [], stops: [], peak: 0, states: [] };
        const Native = AudioContext;
        window.AudioContext = class extends Native {
          constructor(...args) {
            super(...args);
            window.audioContext = this;
            window.audioProbe.states.push(this.state);
            this.addEventListener("statechange", () =>
              window.audioProbe.states.push(this.state),
            );
            this.analyser = this.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.connect(this.destination);
            setInterval(() => {
              const b = new Float32Array(2048);
              this.analyser.getFloatTimeDomainData(b);
              for (const v of b)
                window.audioProbe.peak = Math.max(
                  window.audioProbe.peak,
                  Math.abs(v),
                );
            }, 8);
          }
          createGain() {
            const g = super.createGain(),
              connect = g.connect.bind(g);
            g.connect = (to, ...rest) =>
              connect(to === this.destination ? this.analyser : to, ...rest);
            return g;
          }
          createOscillator() {
            const o = super.createOscillator(),
              start = o.start.bind(o),
              stop = o.stop.bind(o);
            o.start = (t) => {
              window.audioProbe.starts.push(t);
              start(t);
            };
            o.stop = (t) => {
              window.audioProbe.stops.push(t);
              stop(t);
            };
            return o;
          }
        };
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          value: async () => {
            const c = document.createElement("canvas");
            c.width = 640;
            c.height = 480;
            c.getContext("2d").fillRect(0, 0, 640, 480);
            return c.captureStream(20);
          },
        });
      },
      { mode },
    );
    let deliver;
    // Voice off keeps the object result layout; voice-browser.js covers the conversation layout.
    await page.addInitScript(() => localStorage.setItem("ucenth-voice", "off"));
    await page.route("**/api/identify", async (route) => {
      await new Promise((r) => (deliver = r));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "hypothesis",
          confidence: "high",
          needsAnotherView: false,
          name: "Test notebook",
          brand: "",
          category: "Stationery",
          observations: ["Rectangular cover"],
          description: "Synthetic UI test",
        }),
      });
    });
    await page.goto(base);
    assert.equal(await page.evaluate(() => !!window.audioContext), false);
    await page.locator("#start").click();
    await page.waitForFunction(() => window.audioContext?.state === "running");
    assert.equal(
      await page.evaluate(() => window.audioProbe.starts.length),
      0,
      "camera only unlocks",
    );
    await page.locator("#stop").click();
    // Reload to prove Upload independently unlocks a fresh AudioContext.
    await page.reload();
    assert.equal(await page.evaluate(() => !!window.audioContext), false);
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#upload").click();
    await (
      await chooser
    ).setFiles({ name: "fixture.png", mimeType: "image/png", buffer });
    await page.locator(".scanning").waitFor();
    await page.waitForFunction(() => window.audioContext?.state === "running");
    if (mode === "unmute-during-scan")
      await page
        .getByRole("button", { name: "Enable interface sounds" })
        .click();
    if (mode === "interrupted")
      await page.evaluate(() => window.audioContext.suspend());
    deliver();
    await page.locator(".identity-name").waitFor();
    // Sample the complete 560 ms graph, including its tail.
    await page.waitForTimeout(650);
    const probe = await page.evaluate(() => ({
      ...window.audioProbe,
      state: window.audioContext.state,
    }));
    if (mode === "muted") {
      assert.equal(probe.starts.length, 0);
      assert.equal(probe.peak, 0);
    } else {
      assert.equal(probe.starts.length, 2);
      assert.equal(probe.state, "running");
      assert.ok(probe.peak > 0.06 && probe.peak < 0.2);
      assert.ok(Math.abs(probe.stops[1] - probe.starts[0] - 0.56) < 0.001);
    }
    await page.locator("summary", { hasText: "View full analysis" }).click();
    assert.equal(
      await page.evaluate(() => window.audioProbe.starts.length),
      probe.starts.length,
      "disclosure cannot replay",
    );
    const preference = await page
      .locator("#sound-toggle")
      .getAttribute("aria-pressed");
    await page.reload();
    assert.equal(
      await page.locator("#sound-toggle").getAttribute("aria-pressed"),
      preference,
    );
    reports.push({ mode, ...probe });
    await page.close();
  }
  await mkdir("artifacts/audio", { recursive: true });
  await writeFile(
    "artifacts/audio/graph-checks.json",
    JSON.stringify(reports, null, 2),
  );
  console.log(
    "Chrome audio graph verified: gesture unlock for camera/upload, 560 ms output, mute/unmute regression, interrupted-context recovery, no duplicate cue, persisted preference. Speaker perception requires human verification.",
  );
} finally {
  await browser.close();
}
