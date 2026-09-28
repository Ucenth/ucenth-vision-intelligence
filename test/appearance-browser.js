import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const base = process.env.TEST_BASE_URL || "http://localhost:3000";
await mkdir("artifacts/appearance", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const fixture = await sharp({
  create: { width: 400, height: 500, channels: 3, background: "#426cb1" },
})
  .png()
  .toBuffer();
try {
  for (const theme of ["dark", "light"])
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.audioProbe = { starts: [], stops: [], contexts: 0 };
        const Native = window.AudioContext;
        window.AudioContext = class extends Native {
          constructor(...args) {
            super(...args);
            window.audioProbe.contexts++;
          }
          createOscillator() {
            const o = super.createOscillator();
            const start = o.start.bind(o),
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
      });
      let response = {
        status: "hypothesis",
        confidence: "high",
        needsAnotherView: false,
        name: "A blue notebook",
        brand: "Not determined",
        category: "Notebook",
        description: "Synthetic UI fixture.",
        observations: [
          "Blue rectangular cover",
          "Plain front surface",
          "Portrait format",
        ],
        requestedView: "Show the back cover.",
      };
      // Voice off keeps the object result layout; voice-browser.js covers the conversation layout.
      await page.addInitScript(() => localStorage.setItem("ucenth-voice", "off"));
      await page.route("**/api/identify", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(response),
        }),
      );
      await page.goto(base);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      assert.equal(await page.evaluate(() => window.audioProbe.contexts), 0);
      if (theme === "light") await page.locator("#theme-toggle").click();
      await page.reload();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme,
      );
      const checkOverflow = async () =>
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
      await checkOverflow();
      await page.screenshot({
        path: `artifacts/appearance/${theme}-${width}-idle.png`,
        fullPage: true,
      });
      for (const href of [
        "https://github.com/Ucenth/ucenth-vision-intelligence",
        "how-to.html",
        "LICENSE",
      ])
        assert.ok(
          await page.locator(`.project-footer a[href="${href}"]`).count(),
        );
      const upload = async () => {
        const chooser = page.waitForEvent("filechooser");
        await page.locator("#upload").click();
        await (
          await chooser
        ).setFiles({
          name: "fixture.png",
          mimeType: "image/png",
          buffer: fixture,
        });
        await page.locator(".identity-name").waitFor();
      };
      await upload();
      assert.equal(
        await page.evaluate(() => window.audioProbe.starts.length),
        2,
        "exactly one two-note cue",
      );
      const times = await page.evaluate(() => window.audioProbe);
      assert.ok(Math.abs(times.stops[1] - times.starts[0] - 0.56) < 0.001);
      const pixels = await page
        .locator("#capture")
        .evaluate((c) => c.toDataURL());
      await page.locator("#theme-toggle").click();
      assert.equal(
        await page.locator("#capture").evaluate((c) => c.toDataURL()),
        pixels,
      );
      assert.equal(
        await page
          .locator("#capture")
          .evaluate((c) => getComputedStyle(c).filter),
        "none",
      );
      await page.locator("#theme-toggle").click();
      await page.locator("summary", { hasText: "View full analysis" }).click();
      assert.equal(
        await page.evaluate(() => window.audioProbe.starts.length),
        2,
      );
      await checkOverflow();
      await page.screenshot({
        path: `artifacts/appearance/${theme}-${width}-result.png`,
        fullPage: true,
      });
      await page.locator("#sound-toggle").click();
      await page.reload();
      assert.equal(
        await page.locator("#sound-toggle").getAttribute("aria-pressed"),
        "false",
      );
      await upload();
      assert.equal(
        await page.evaluate(() => window.audioProbe.starts.length),
        0,
      );
      await page.goto(base + "/how-to.html");
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme,
      );
      await checkOverflow();
      await page.screenshot({
        path: `artifacts/appearance/${theme}-${width}-setup.png`,
      });
      await page.getByRole("link", { name: "Open scanner" }).first().click();
      await page.waitForLoadState();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme,
      );
      await page.locator("#sound-toggle").click();
      for (const [confidence, needsAnotherView, expected] of [
        ["medium", false, 2],
        ["high", true, 0],
        ["low", false, 0],
      ]) {
        response = { ...response, confidence, needsAnotherView };
        await page.reload();
        await upload();
        if (expected)
          await page.waitForFunction(
            () => window.audioProbe.starts.length === 2,
          );
        assert.equal(
          await page.evaluate(() => window.audioProbe.starts.length),
          expected,
        );
      }
      await page.addInitScript(() => {
        window.AudioContext = class {
          constructor() {
            throw Error("Audio unavailable");
          }
        };
      });
      response = { ...response, confidence: "high", needsAnotherView: false };
      await page.reload();
      await upload();
      assert.ok(await page.locator(".identity-name").isVisible());
      assert.deepEqual(errors, []);
      await page.close();
    }
  console.log(
    "Chrome appearance checks passed: both themes at 1440/390px, uploads, unchanged pixels, persistence, setup navigation, exact two-note cue, uncertainty/mute silence, audio failure isolation.",
  );
} finally {
  await browser.close();
}
