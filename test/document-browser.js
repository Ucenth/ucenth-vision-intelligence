// Document Intelligence interface and voice hand-off with explicit mocked analysis responses.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const artifact = "artifacts/document";
await mkdir(artifact, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const wav = Buffer.alloc(44 + 24000 * 0.3 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");
const image = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#e8e4d8" } }).png().toBuffer();
const arabic = {
  subjectType: "document", source: "pdf", fileName: "فاتورة.pdf", pageCount: 3, documentType: "Invoice", title: "فاتورة رقم 118", name: "فاتورة رقم 118",
  language: { primary: "Arabic", code: "ar", additional: [], direction: "rtl" }, translationAvailable: true, translationPartial: true, translatedPages: [1, 2],
  summary: "An invoice from a Cairo supplier for office furniture, total 4,250 EGP, due 15 October 2026.",
  fields: [{ label: "Invoice number", value: "118", uncertain: false }, { label: "Total", value: "4,250 EGP", uncertain: false }, { label: "Due date", value: "15/10/2026", uncertain: true }],
  warnings: ["Stamp on page 3 partly unreadable."], scannedPages: 0, confidence: "high", needsAnotherView: false, status: "hypothesis",
  pages: [
    { page: 1, original: "فاتورة رقم 118\nالإجمالي: 4,250 جنيه مصري.\nيرجى السداد قبل 15/10/2026.", english: "Invoice No. 118\nTotal: 4,250 EGP.\nPlease pay before 15/10/2026.", scanned: false },
    { page: 2, original: "الصفحة الثانية: لا يشمل السعر التوصيل.", english: "Page two: the price does not include delivery.", scanned: false },
    { page: 3, original: "شروط الدفع.", english: "", scanned: false },
  ],
  conversationIntro: "I've identified this as an Arabic invoice. I've made an English translation available. What would you like to know about it?",
  usage: { promptTokens: 1, outputTokens: 1 }, elapsedMs: 1,
};
const receipt = { ...arabic, source: "image", fileName: "capture.jpg", pageCount: 1, documentType: "Receipt", title: "Receipt", name: "Receipt", language: { primary: "English", code: "en", additional: [], direction: "ltr" }, translationAvailable: false, translationPartial: false, translatedPages: [], summary: "A grocery receipt for 23.40 USD.", fields: [{ label: "Merchant", value: "Corner Market", uncertain: false }, { label: "Total", value: "23.40 USD", uncertain: false }], warnings: [], pages: [{ page: 1, original: "CORNER MARKET\nTOTAL 23.40 USD", english: "", scanned: true }], conversationIntro: "I've identified this as a receipt. What would you like to know about it?" };
const identityDocument = { provider: "gemini", status: "hypothesis", confidence: "high", name: "Receipt", brand: "", category: "Document", subjectType: "document", documentType: "receipt", documentLanguage: "English", observations: [], needsAnotherView: false, requestedView: "", identityEstablished: false, identityName: "", identitySource: "none", description: "" };
const identityObject = { ...identityDocument, subjectType: "object", name: "Blue notebook", category: "Notebook", documentType: "", documentLanguage: "" };
try {
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [], speech = [], followUps = [], documentRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem("ucenth-voice", "on"); window.SpeechRecognition = class { start() {} abort() { this.onend?.(); } }; });
  let analysis = arabic, identity = identityObject, fail = false;
  await page.route("**/api/document", async (route) => {
    const request = route.request(); documentRequests.push({ type: request.headers()["content-type"], name: request.headers()["x-file-name"], size: (request.postDataBuffer() || Buffer.alloc(0)).length });
    return route.fulfill(fail ? { status: 422, json: { error: "This PDF has 90 pages. UCENTH Vision Intelligence currently supports PDFs up to 60 pages." } } : { json: analysis });
  });
  await page.route("**/api/identify", (route) => route.fulfill({ json: identity }));
  await page.route("**/api/speech", (route) => { speech.push(route.request().postDataJSON().text); return route.fulfill({ contentType: "audio/wav", body: wav }); });
  await page.route("**/api/follow-up", (route) => { followUps.push(route.request().postDataJSON()); return route.fulfill({ json: { answer: "The total is 4,250 EGP.", userSuppliedIdentity: "" } }); });
  const text = (selector) => page.locator(selector).first().textContent();
  const listening = () => page.waitForFunction(() => document.querySelector(".voice-panel")?.dataset.state === "LISTENING", null, { timeout: 20000 });
  await page.goto(base);
  assert.equal(await page.locator("#upload-label strong").textContent(), "Upload a File");
  assert.equal(await page.locator("#upload-label small").textContent(), "Images, PDF or Word");
  assert.match(await page.locator("#upload").getAttribute("accept"), /\.pdf,\.docx/);
  await page.locator("#upload").setInputFiles({ name: "فاتورة.pdf", mimeType: "application/pdf", buffer: pdfBytes });
  await page.locator(".document-viewer").waitFor();
  assert.equal(documentRequests[0].type, "application/pdf");
  assert.equal(decodeURIComponent(documentRequests[0].name), "فاتورة.pdf");
  assert.equal(documentRequests[0].size, pdfBytes.length);
  assert.equal(await text(".result-state"), "DOCUMENT IDENTIFIED");
  assert.equal(await text(".identity-name"), "Invoice");
  assert.equal(await text(".identity-role"), "فاتورة رقم 118");
  assert.equal(await text("#document-stage .document-pages"), "PDF · 3 pages");
  assert.equal(await page.locator(".document-meta dd").nth(0).textContent(), "Arabic");
  assert.equal(await page.locator(".document-meta dd").nth(1).textContent(), "PDF · 3");
  assert.match(await text(".document-summary-text"), /4,250 EGP/);
  assert.equal(await page.locator(".document-field-list dt").count(), 3);
  assert.match(await page.locator(".document-field-list .uncertain dd").textContent(), /15\/10\/2026 \(uncertain\)/);
  assert.equal(await page.locator("#state-label").textContent(), "DOCUMENT IDENTIFIED");
  // English is the default view for a translated document; the original keeps its own direction.
  const tabs = page.locator("[role=tab]");
  assert.equal(await tabs.count(), 2);
  assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator(".document-page").getAttribute("dir"), "ltr");
  assert.equal(await page.locator(".document-page").getAttribute("lang"), "en");
  assert.match(await text(".document-page"), /Invoice No\. 118/);
  await tabs.nth(0).click();
  assert.equal(await page.locator(".document-page").getAttribute("dir"), "rtl");
  assert.equal(await page.locator(".document-page").getAttribute("lang"), "ar");
  assert.match(await text(".document-page"), /فاتورة رقم 118/);
  assert.equal(await page.locator(".document-page").evaluate((n) => getComputedStyle(n).direction), "rtl");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "document-tab-english");
  assert.equal(await text(".document-where"), "Page 1 of 3");
  await page.getByRole("button", { name: "Next page" }).click();
  assert.equal(await text(".document-where"), "Page 2 of 3");
  assert.match(await text(".document-page"), /does not include delivery/);
  await page.getByRole("button", { name: "Next page" }).click();
  assert.match(await text(".document-page"), /No English translation for this page yet/);
  assert.match(await text(".document-note"), /pages 1, 2/);
  assert.ok(await page.getByRole("button", { name: "Next page" }).isDisabled());
  await listening();
  assert.equal(speech[0], arabic.conversationIntro);
  assert.equal(await text(".voice-heading"), "Ask about this document");
  assert.ok(await page.locator(".document-summary").isVisible(), "summary stays visible beside the conversation");
  assert.ok(await page.locator(".document-viewer").isVisible());
  await page.locator(".voice-typed").evaluate((n) => (n.open = true));
  await page.getByRole("textbox", { name: "Question about the scanned object" }).fill("What is the total?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForFunction(() => document.querySelector(".voice-answer")?.textContent, null, { timeout: 20000 });
  assert.equal(followUps[0].image, undefined);
  assert.equal(followUps[0].document.pages.length, 3);
  assert.equal(followUps[0].document.language.code, "ar");
  assert.equal(followUps[0].identification.subjectType, "document");
  await listening();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.screenshot({ path: `${artifact}/${width}-${theme}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width} ${theme}`);
      assert.ok((await page.locator(".document-page").boundingBox()).height <= (width === 390 ? 244 : 324), "document text stays bounded");
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator("#reset").click();
  assert.equal(await page.locator("#document-stage").count(), 0);
  assert.equal(await page.locator(".voice-panel").count(), 0);
  assert.equal(await page.locator(".document-viewer").count(), 0);
  // A photographed document is routed by the identification step, then analyzed from the clean capture.
  identity = identityDocument; analysis = receipt;
  await page.locator("#upload").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: image });
  await page.locator(".document-viewer").waitFor();
  assert.equal(documentRequests[1].type, "image/jpeg");
  assert.ok(documentRequests[1].size > 1000);
  assert.equal(await text(".identity-name"), "Receipt");
  assert.equal(await page.locator("#document-stage").count(), 0, "the photograph itself stays in the viewer");
  assert.ok(await page.locator("#capture").isVisible());
  assert.equal(await page.locator("[role=tab]").count(), 1);
  assert.equal(await text("[role=tab]"), "Text");
  assert.equal(await page.locator(".document-nav").count(), 0);
  await listening();
  assert.equal(speech.at(-1), receipt.conversationIntro);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator("#reset").click();
  // Objects keep the object presentation.
  identity = identityObject;
  await page.locator("#upload").setInputFiles({ name: "object.png", mimeType: "image/png", buffer: image });
  await page.locator("#reset").waitFor();
  assert.equal(await text(".result-state"), "LIKELY IDENTIFICATION");
  assert.equal(await page.locator(".document-viewer").count(), 0);
  assert.equal(documentRequests.length, 2);
  await listening();
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  await page.locator("#reset").click();
  // Oversized or unreadable files produce a clear message, not a raw error.
  fail = true;
  await page.locator("#upload").setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: pdfBytes });
  await page.locator(".error-title").waitFor();
  assert.match(await text(".error-title"), /90 pages/);
  await page.locator("#reset").click();
  await page.locator("#upload").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.locator(".error-title").waitFor();
  assert.match(await text(".error-title"), /JPEG or PNG smaller than 2 MB, or a PDF or Word/);
  assert.deepEqual(errors, []);
  console.log("Document Chrome checks passed: upload control, PDF/image routing, Arabic RTL original with LTR English, keyboard tabs, page navigation, partial-translation note, voice intro and document-context follow-up, bounded text at 1440/390 in both themes, reset cleanup and clear errors.");
} finally { await browser.close(); }
