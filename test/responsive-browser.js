// Presentation stress fixtures: mocked identities, synthetic pixels, real Chrome.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const directory = "artifacts/responsive";
await mkdir(directory, { recursive: true });
const image = await sharp({
  create: { width: 450, height: 700, channels: 3, background: "#546a82" },
})
  .png()
  .toBuffer();
const eucerin = {
  status: "hypothesis",
  confidence: "high",
  needsAnotherView: false,
  name: "Eucerin Intensive Repair Lotion",
  brand: "Eucerin",
  category: "Personal Care / Skincare",
  description:
    "A visual identification; exact variants are not independently verified.",
  observations: [
    "White plastic pump bottle with red cap/pump dispenser",
    "Prominent Eucerin red triangle logo header",
    "Blue rectangular label band with 'Intensive Repair Lotion' text",
    "Richness scale indicator showing rich level",
    "Text indication '16.9 FL. OZ. 500mL' at base",
    "Rounded shoulders on the bottle",
  ],
  requestedView: "",
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const metrics = [];
try {
  for (const theme of ["dark", "light"])
    for (const width of [1440, 1280, 1024, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // Voice off (set before navigation so voice.js reads it on load) keeps the object result layout; voice-browser.js covers the conversation keeps the object result layout; voice-browser.js covers the conversation layout.
      await page.addInitScript(() => localStorage.setItem("ucenth-voice", "off"));
      await page.goto(base);
      if (theme === "light") await page.locator("#theme-toggle").click();
      const idle = (await page.locator(".workspace").boundingBox()).height;
      await page.screenshot({
        path: `${directory}/${theme}-${width}-idle.png`,
        fullPage: true,
        animations: "disabled",
      });
      let response = eucerin;
      await page.route("**/api/identify", (route) =>
        route.fulfill({
          status: response.error ? 502 : 200,
          contentType: "application/json",
          body: JSON.stringify(response),
        }),
      );
      const upload = async () => {
        await page.locator("#upload").setInputFiles({
          name: "fixture.png",
          mimeType: "image/png",
          buffer: image,
        });
        await page.locator("#reset").waitFor();
      };
      await upload();
      const check = async () =>
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "no horizontal overflow",
        );
      await check();
      assert.equal(
        await page.locator(".observations li:visible").count(),
        width > 900 ? 4 : 3,
      );
      assert.equal(
        await page.locator(".full-observations li").count(),
        6,
        "all model features retained",
      );
      assert.ok(
        await page
          .locator(".observations")
          .evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16),
      );
      // The conversation panel sits below the result; the scanner result itself stays compact.
      const voice =
        (await page.locator(".voice-panel").boundingBox())?.height ?? 0;
      const result =
        (await page.locator(".workspace").boundingBox()).height - voice;
      if (width > 900)
        assert.ok(
          result <= idle * 1.2,
          "desktop remains close to idle footprint",
        );
      else
        assert.ok(
          (await page.locator(".viewer").boundingBox()).height <= 312,
          "bounded mobile capture",
        );
      const action = await page.locator("#reset").boundingBox();
      const disclosure = await page.locator("summary", { hasText: "View full analysis" }).boundingBox();
      assert.ok(
        action.y < disclosure.y,
        "primary action precedes secondary details",
      );
      if (width === 390)
        assert.ok(
          (await page.locator(".identity-explanation").boundingBox()).y < 900,
          "summary within first viewport",
        );
      const pixels = await page
        .locator("#capture")
        .evaluate((c) => c.toDataURL());
      await page.screenshot({
        path: `${directory}/${theme}-${width}-result.png`,
        fullPage: true,
        animations: "disabled",
      });
      await page.locator("summary", { hasText: "View full analysis" }).click();
      for (const observation of eucerin.observations)
        assert.ok(
          (await page.locator(".full-observations").innerText()).includes(
            observation,
          ),
        );
      assert.equal(
        await page.locator("#capture").evaluate((c) => c.toDataURL()),
        pixels,
      );
      if (width > 900)
        assert.ok(
          (await page.locator(".viewer").boundingBox()).height <= 622,
          "disclosure does not enlarge photograph",
        );
      await check();
      metrics.push({ theme, width, idle, result });
      for (const fixture of [
        {
          ...eucerin,
          name: "Person",
          brand: "",
          category: "Human",
          observations: ["Person seated in a chair"],
        },
        {
          ...eucerin,
          name: "Gaming Chair",
          brand: "",
          category: "Furniture",
          observations: ["High backrest", "Padded armrests", "Five-spoke base"],
        },
        {
          ...eucerin,
          status: "needs-view",
          name: "NuPhy Halo Series Mechanical Keyboard — exact model not established",
          brand: "NuPhy",
          category: "Mechanical Keyboard",
          observations: [
            "Grey translucent outer frame",
            "RGB under-glow",
            "White rounded keycaps",
            "Orange accent keys",
            "Keyboard partially outside the photograph",
          ],
          confidence: "medium",
          needsAnotherView: true,
          requestedView:
            "Show the entire keyboard from above and include the rear model label.",
        },
        {
          error: "Identification could not complete. Please try again shortly.",
        },
      ]) {
        response = fixture;
        await page.reload();
        await upload();
        await check();
        if (fixture.needsAnotherView) {
          assert.ok(await page.locator(".next-view").isVisible());
          await page.screenshot({
            path: `${directory}/${theme}-${width}-uncertain.png`,
            fullPage: true,
            animations: "disabled",
          });
        }
        if (fixture.error)
          assert.ok(await page.locator(".error-title").isVisible());
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  await writeFile(
    `${directory}/metrics.json`,
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    "Responsive Chrome checks passed: 5 widths × 2 themes; long/short/uncertain/error results, complete disclosure, action order, photograph bounds, typography, no overflow.",
  );
} finally {
  await browser.close();
}
