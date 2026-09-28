const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
await mkdir("artifacts/release", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${baseUrl}/how-to.html`);
  assert.match(await page.title(), /How To/);
  const links = page.locator(".contents a");
  for (let i = 0; i < (await links.count()); i++) {
    const link = links.nth(i),
      target = await link.getAttribute("href");
    await link.click();
    assert.ok(page.url().endsWith(target));
    assert.equal(await page.locator(target).count(), 1);
  }
  const copy = page.locator(".command:has(code:text-matches('git clone')) .copy").first();
  await copy.click();
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).replace(
      /\r\n/g,
      "\n",
    ),
    await page.locator(".command:has(code:text-matches('git clone')) code").first().textContent(),
  );
  await page.goto(`${baseUrl}/how-to.html`);
  await page.screenshot({ path: "artifacts/release/how-to-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "artifacts/release/how-to-mobile.png" });
  await page.locator("#credentials").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/release/how-to-security-mobile.png" });
  // Search filters sections and their links; clearing restores them.
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${baseUrl}/how-to.html`);
  await page.fill("#search", "magic bytes");
  assert.ok((await page.locator(".guide section:not([hidden])").count()) < (await page.locator(".guide section").count()));
  assert.ok(await page.locator("#uploads:not([hidden])").count());
  await page.fill("#search", "");
  assert.equal(await page.locator(".guide section[hidden]").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".top a").last().click();
  await page.getByRole("button", { name: "Open Camera" }).waitFor();
  await page.screenshot({
    path: "artifacts/release/scanner-mobile.png",
    fullPage: true,
  });
  for (const [name, url] of [
    ["Source Code", "https://github.com/Ucenth/ucenth-vision-intelligence"],
    ["How To", new URL("how-to.html", baseUrl).href],
    ["License", new URL("LICENSE", baseUrl).href],
  ]) {
    const originalUrl = page.url();
    const opened = page.context().waitForEvent("page");
    await page.getByRole("link", { name, exact: true }).click();
    const tab = await opened;
    await tab.waitForURL(url);
    assert.equal(page.url(), originalUrl, "scanner stays open");
    assert.equal(await tab.evaluate(() => window.opener), null);
    await tab.close();
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(baseUrl);
  await page.screenshot({
    path: "artifacts/release/scanner-desktop.png",
    fullPage: true,
  });
  // The release screenshot contains only the empty interface, never a private capture.
  await page.screenshot({ path: "public/assets/scanner.png", fullPage: true });
  await page.goto(pathToFileURL(resolve("how-to.html")).href);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", { value: undefined }),
  );
  await page.locator(".command:has(code:text-matches('git clone')) .copy").first().click();
  assert.match(await page.locator(".command:has(code:text-matches('git clone')) .copy").first().textContent(), /Selected/);
  assert.ok(
    await page.evaluate(() =>
      window.getSelection().toString().includes("git clone"),
    ),
  );
  await page.keyboard.press("Tab");
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/release/how-to-checks.json",
    JSON.stringify(
      {
        passed: true,
        anchors: await links.count(),
        copy: true,
        fileFallback: true,
        mobileOverflow: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Chrome How To checks passed: anchors, copy, search, file fallback, navigation, desktop and 390px.",
  );
} finally {
  await browser.close();
}
