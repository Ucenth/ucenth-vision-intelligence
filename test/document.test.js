import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createServer } from "../server.js";
import { sniff, validateFile, safeName, extractPdf, extractDocx, htmlToText, summarizeDocument, displayType, conversationIntro, LIMITS } from "../lib/document.js";

// A minimal but valid PDF: page 1 carries text, page 2 is empty (behaves like a scanned page).
export function tinyPdf(texts = ["Hello invoice total 42.00"]) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const pageIds = [];
  const pagesId = texts.length + 1 + texts.length * 2 + 2; // computed below instead
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contents = texts.map((text) => {
    const stream = text ? `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const pagesPlaceholder = objects.length + texts.length + 1;
  for (const content of contents)
    pageIds.push(add(`<< /Type /Page /Parent ${pagesPlaceholder} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  const pages = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  assert.equal(pages, pagesPlaceholder);
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
export async function tinyDocx(bodyXml) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
export const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
export const li = (text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
export const table = (rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc><w:tcPr/>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

test("file validation trusts magic bytes, not declared types, extensions or names", async () => {
  const pdf = tinyPdf(), docx = await tinyDocx(p("Hola"));
  assert.equal(sniff(pdf), "pdf");
  assert.equal(sniff(docx), "docx");
  assert.equal(sniff(PNG), "image");
  assert.equal(sniff(JPEG), "image");
  assert.equal(sniff(Buffer.from("PK\u0003\u0004 not a docx zip")), null);
  assert.equal(sniff(Buffer.from("<script>alert(1)</script>")), null);
  assert.equal(validateFile({ buffer: pdf, mimeType: "application/pdf", name: "a.pdf" }).kind, "pdf");
  assert.match(validateFile({ buffer: pdf, mimeType: "image/png", name: "a.png" }).error, /did not match/);
  assert.match(validateFile({ buffer: PNG, mimeType: "image/png", name: "a.pdf" }).error, /did not match/);
  assert.match(validateFile({ buffer: Buffer.alloc(LIMITS.docxBytes + 1, 0x50), mimeType: "application/pdf", name: "x" }).error, /did not match|larger/);
  assert.match(validateFile({ buffer: Buffer.concat([pdf, Buffer.alloc(LIMITS.pdfBytes)]), mimeType: "application/pdf", name: "big.pdf" }).error, /larger than UCENTH Vision Intelligence currently supports \(15 MB\)/);
  const name = safeName("../../etc/passwd\\..\\secret.pdf");
  assert.ok(!/[\\/]/.test(name) && name.length <= 80);
  assert.equal(safeName(""), "document");
});
test("PDF extraction keeps page text, flags scanned pages and refuses oversized page counts", async () => {
  const result = await extractPdf(tinyPdf(["Hello invoice total 42.00", ""]));
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0].text, /Hello invoice total 42\.00/);
  assert.equal(result.pages[0].scanned, false);
  assert.equal(result.pages[1].scanned, true);
  assert.equal(result.scanned, 1);
  const many = await extractPdf(tinyPdf(Array(LIMITS.pages + 1).fill("x")));
  assert.match(many.error, /up to 60 pages/);
  const damaged = await extractPdf(Buffer.from("%PDF-1.4 garbage"));
  assert.match(damaged.error, /could not be read/);
});
test("DOCX extraction keeps headings, lists and table rows as readable structure", async () => {
  const docx = await tinyDocx(p("Informe trimestral", "Heading1") + p("Ventas totales 48.500 €") + li("Nuevo cliente") + table([["Mes", "Ventas"], ["Julio", "15.200 €"]]));
  const { text } = await extractDocx(docx);
  assert.match(text, /^# Informe trimestral/m);
  assert.match(text, /Ventas totales 48\.500 €/);
  assert.match(text, /\| Mes \| Ventas \|/);
  assert.match(text, /\| Julio \| 15\.200 € \|/);
  assert.equal(htmlToText("<p>a &amp; b</p><img src=\"x\"><ul><li>one</li></ul>"), "a & b\n\n- one");
  assert.match((await extractDocx(Buffer.from("not a zip"))).error, /could not be read/);
});
test("summaries merge local text with model pages, mark direction and never invent translation", () => {
  const model = { document_type: "invoice", title: "Facture 2026-118", language_primary: "French", language_code: "fr", languages_additional: [], summary: "An invoice.", important_fields: [{ label: "Total", value: "145,50 €", uncertain: false }, { label: "Due", value: "", uncertain: true }], warnings: ["Stamp partly unreadable"], pages: [{ page: 1, original: "ignored", english: "Invoice total 145.50 €" }, { page: 2, original: "Page deux", english: "" }] };
  const result = summarizeDocument(model, { kind: "pdf", name: "facture.pdf", pageCount: 2, localPages: [{ page: 1, text: "Facture total 145,50 €", scanned: false }, { page: 2, text: "", scanned: true }], transcribe: [2], translate: [1] });
  assert.equal(result.subjectType, "document");
  assert.equal(result.documentType, "Invoice");
  assert.equal(result.pages[0].original, "Facture total 145,50 €", "local text wins over model transcription");
  assert.equal(result.pages[1].original, "Page deux");
  assert.equal(result.translationAvailable, true);
  assert.equal(result.translationPartial, true);
  assert.deepEqual(result.translatedPages, [1]);
  assert.deepEqual(result.fields, [{ label: "Total", value: "145,50 €", uncertain: false }]);
  assert.equal(result.language.direction, "ltr");
  assert.match(result.conversationIntro, /French invoice\. I've made an English translation available/);
  const arabic = summarizeDocument({ ...model, language_primary: "Arabic", language_code: "ar" }, { kind: "image", name: "", pageCount: 1 });
  assert.equal(arabic.language.direction, "rtl");
  const english = summarizeDocument({ ...model, language_primary: "English", language_code: "en", pages: [{ page: 1, original: "Invoice", english: "Should be dropped" }] }, { kind: "image", name: "", pageCount: 1 });
  assert.equal(english.pages[0].english, "");
  assert.equal(english.translationAvailable, false);
  assert.equal(english.conversationIntro, "I've identified this as an invoice. What would you like to know about it?");
  assert.equal(displayType("purchase receipt"), "Receipt");
  assert.equal(displayType(""), "General Document");
  assert.equal(conversationIntro({ typeName: "Letter", language: { primary: "Spanish", code: "es" }, translationAvailable: true }), "I've identified this as a Spanish letter. I've made an English translation available. What would you like to know about it?");
  assert.throws(() => summarizeDocument({ summary: "x" }, { kind: "pdf", name: "", pageCount: 1 }));
});
test("document route validates uploads in memory and follow-ups accept document context without an image", async () => {
  const calls = [];
  const server = createServer({ identify: async () => ({}), analyzeDocument: async (input) => { calls.push(input); return { subjectType: "document", documentType: "Invoice", pages: [] }; }, followUp: async (input) => { calls.push(input); return { answer: `Total is ${input.document?.fields?.[0]?.value}.`, userSuppliedIdentity: "" }; } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (body, type, headers = {}) => fetch(`${base}/api/document`, { method: "POST", headers: { "Content-Type": type, ...headers }, body });
  try {
    const ok = await upload(tinyPdf(), "application/pdf", { "X-File-Name": encodeURIComponent("../facture été.pdf") });
    assert.equal(ok.status, 200);
    assert.equal(calls[0].kind, "pdf");
    assert.equal(calls[0].name, "facture été.pdf");
    assert.equal((await upload(PNG, "application/pdf")).status, 400);
    assert.equal((await upload(tinyPdf(), "text/plain")).status, 415);
    assert.equal((await upload(tinyPdf(), "application/pdf", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await upload(Buffer.alloc(0), "application/pdf")).status, 400);
    const docx = await tinyDocx(p("Hi"));
    assert.equal((await upload(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).status, 200);
    assert.equal(calls.at(-1).kind, "docx");
    const followUp = await fetch(`${base}/api/follow-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identification: { name: "Invoice", subjectType: "document" }, question: "What is the total?", history: [], document: { documentType: "Invoice", title: "F-118", language: { primary: "French", code: "fr" }, summary: "s", fields: [{ label: "Total", value: "145,50 €" }], pages: [{ page: 1, original: "Facture", english: "Invoice" }] } }) });
    assert.equal(followUp.status, 200);
    assert.equal((await followUp.json()).answer, "Total is 145,50 €.");
    assert.equal(calls.at(-1).image, null);
    assert.deepEqual(calls.at(-1).document.pages, [{ page: 1, original: "Facture", english: "Invoice" }]);
    const neither = await fetch(`${base}/api/follow-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identification: { name: "x" }, question: "?", history: [] }) });
    assert.equal(neither.status, 400);
    assert.equal((await fetch(`${base}/lib/document.js`)).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
