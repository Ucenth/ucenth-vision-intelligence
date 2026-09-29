// The header globe in real Chrome: it draws in both themes, it costs almost nothing per
// frame, it turns (frames differ over time), it stops when the page is hidden, and it
// is a single static frame under reduced motion. Also: no layout shift and no overflow.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const snapshot = (page) => page.evaluate(() => { const c = document.querySelector("canvas.brand-globe"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0, sum = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) { lit++; sum += d[i - 3] + d[i - 2] + d[i - 1]; } return { lit, sum, w: c.width, h: c.height, css: c.getBoundingClientRect().width }; });
try {
  for (const theme of ["dark", "light"]) {
    for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((t) => localStorage.setItem("ucenth-theme", t), theme);
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector("canvas.brand-globe")?.dataset.frameMs !== undefined, null, { timeout: 15000 });
      const a = await snapshot(page);
      assert.ok(a.lit > a.w * a.h * 0.3, `${theme} ${name}: the sphere is drawn (${a.lit} lit pixels of ${a.w * a.h})`);
      assert.equal(a.css, name === "desktop" ? 32 : 32, `${theme} ${name}: 32 px in the header`);
      await page.waitForTimeout(700);
      const b = await snapshot(page);
      assert.notEqual(a.sum, b.sum, `${theme} ${name}: the globe turns`);
      const frameMs = Number(await page.evaluate(() => document.querySelector("canvas.brand-globe").dataset.frameMs));
      assert.ok(frameMs < 1.5, `${theme} ${name}: a frame costs ${frameMs} ms (must be well under 1.5 ms)`);
      // The header keeps its height and the page keeps its width.
      const header = await page.locator(".masthead").boundingBox();
      assert.ok(header.height <= (name === "desktop" ? 101 : 79), `${theme} ${name}: header height ${header.height}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${name}: no overflow`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  // Hidden page: no further frames are drawn.
  const hidden = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await hidden.goto(base);
  await hidden.waitForFunction(() => document.querySelector("canvas.brand-globe")?.dataset.frameMs !== undefined, null, { timeout: 15000 });
  await hidden.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await hidden.waitForTimeout(300);
  const f1 = await hidden.evaluate(() => document.querySelector("canvas.brand-globe").dataset.frames);
  await hidden.waitForTimeout(700);
  const f2 = await hidden.evaluate(() => document.querySelector("canvas.brand-globe").dataset.frames);
  assert.equal(f1, f2, `no frames while the page is hidden (${f1} → ${f2})`);
  await hidden.close();
  // Reduced motion: one static frame, still a globe.
  const still = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const sp = await still.newPage();
  // Count real draws: reading pixels back from an idle canvas can differ by a few
  // antialiased edge values in headless Chrome, so the clear count is the evidence.
  await sp.addInitScript(() => { window.__globeDraws = 0; const clear = CanvasRenderingContext2D.prototype.clearRect; CanvasRenderingContext2D.prototype.clearRect = function (...args) { if (this.canvas.classList.contains("brand-globe")) window.__globeDraws++; return clear.apply(this, args); }; });
  await sp.goto(base);
  // The theme attribute lands after load and triggers one repaint; settle first.
  await sp.waitForFunction(() => document.documentElement.dataset.theme !== undefined, null, { timeout: 5000 });
  await sp.waitForTimeout(500);
  const s1 = await snapshot(sp);
  const d1 = await sp.evaluate(() => window.__globeDraws);
  await sp.waitForTimeout(1200);
  const d2 = await sp.evaluate(() => window.__globeDraws);
  assert.ok(s1.lit > s1.w * s1.h * 0.3, "reduced motion still shows the sphere");
  assert.equal(d1, d2, `reduced motion: no animation (${d1} → ${d2} draws)`);
  assert.ok(d1 <= 3, `reduced motion: a static frame, drawn at most a few times at load (${d1})`);
  await still.close();
  // The How To carries the same globe.
  const howto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await howto.goto(`${base}/how-to.html`);
  await howto.waitForFunction(() => document.querySelector("canvas.brand-globe")?.dataset.frameMs !== undefined, null, { timeout: 15000 });
  assert.equal(await howto.evaluate(() => document.querySelector("canvas.brand-globe").getBoundingClientRect().width), 28);
  await howto.close();
  console.log("Globe Chrome checks passed: drawn in both themes at desktop and phone width, turning, under 1.5 ms per frame, no layout shift or overflow, paused when hidden, static under reduced motion, present on the How To.");
} catch (error) {
  console.error("Globe Chrome checks failed:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
