// Opt-in real, billable Document Intelligence test against the running server.
// Every fixture is SYNTHETIC and built at run time (rendered HTML, generated PDFs and
// Word files). Nothing private is used; downloads and outputs stay in ignored artifacts/.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { tinyDocx, p, li, table } from "./document.test.js";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const dir = "artifacts/document-real";
await mkdir(dir, { recursive: true });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const usage = { documents: [], followUps: [] };
async function analyze(name, body, type, attempt = 0) {
  const started = Date.now();
  const response = await fetch(`${base}/api/document`, { method: "POST", headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(name) }, body });
  if (response.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 61000)); return analyze(name, body, type, attempt + 1); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  usage.documents.push({ name, ...result.usage, elapsedMs: Date.now() - started, pages: result.pageCount, bytes: body.length });
  return result;
}
async function ask(document, question, attempt = 0) {
  const started = Date.now();
  const response = await fetch(`${base}/api/follow-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, history: [], identification: { name: document.documentType, subjectType: "document", category: "Document", confidence: "high", status: "hypothesis" }, document: { documentType: document.documentType, title: document.title, language: { primary: document.language.primary, code: document.language.code }, summary: document.summary, fields: document.fields.map(({ label, value }) => ({ label, value })), pages: document.pages.map(({ page, original, english }) => ({ page, original, english })) } }) });
  if (response.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 61000)); return ask(document, question, attempt + 1); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  usage.followUps.push({ question, elapsedMs: Date.now() - started });
  return result.answer;
}
const style = `<style>body{margin:0;background:#fff;color:#111;font-family:Arial,sans-serif;font-size:15px}.sheet{width:460px;padding:26px;border:1px solid #bbb}h1{font-size:22px;margin:0 0 10px}h2{font-size:17px;margin:14px 0 6px}table{border-collapse:collapse;width:100%}td{padding:4px 2px;border-bottom:1px solid #ddd}p{margin:8px 0;line-height:1.5}.rtl{direction:rtl;text-align:right;font-family:"Segoe UI",Tahoma,sans-serif}.cjk{font-family:"Microsoft YaHei","Yu Gothic","Malgun Gothic",sans-serif}</style>`;
// SYNTHETIC fixtures. Names, companies, amounts and addresses are invented for testing.
const fixtures = {
  receiptEn: `<div class="sheet"><h1>CORNER MARKET</h1><p>41 Elm Street, Springfield · SYNTHETIC TEST RECEIPT</p><p>Date: 12/09/2026 &nbsp; Receipt #: 88213</p><table><tr><td>Organic apples 1.2 kg</td><td>4.80</td></tr><tr><td>Sourdough loaf</td><td>5.50</td></tr><tr><td>Oat milk 1 L</td><td>3.10</td></tr><tr><td>Sales tax 8%</td><td>1.07</td></tr></table><p><b>TOTAL: $14.47</b></p><p>Paid: Visa ending 4412. Thank you!</p></div>`,
  receiptFr: `<div class="sheet"><h1>CAFÉ DU MARCHÉ</h1><p>12 rue de Rivoli, Paris · REÇU DE TEST SYNTHÉTIQUE</p><p>Date : 14/09/2026 &nbsp; Ticket : 4471</p><table><tr><td>Croissant x2</td><td>3,80 €</td></tr><tr><td>Café crème</td><td>4,20 €</td></tr><tr><td>Salade niçoise</td><td>12,50 €</td></tr></table><p><b>TOTAL : 20,50 €</b></p><p>Payé par carte bancaire. Aucun remboursement sans ce reçu. Merci de votre visite !</p></div>`,
  letterEs: `<div class="sheet"><p>Madrid, 3 de septiembre de 2026</p><p>Estimada Sra. Lucía Herrera:</p><p>Le escribo para confirmar que su solicitud de traslado a la oficina de Valencia ha sido aprobada. La fecha de incorporación será el <b>1 de noviembre de 2026</b>. No es necesario que devuelva el equipo informático actual; podrá conservarlo.</p><p>Por favor, confirme su aceptación antes del 20 de septiembre.</p><p>Atentamente,<br>Carlos Mendoza<br>Director de Recursos Humanos, Grupo Albor (empresa ficticia)</p></div>`,
  letterDe: `<div class="sheet"><p>Berlin, 5. September 2026</p><p>Sehr geehrter Herr Weber,</p><p>hiermit bestätigen wir Ihre Buchung Nr. 7731 für den 18. Oktober 2026. Der Gesamtbetrag von <b>320,00 €</b> ist bis zum 1. Oktober zu zahlen. Bitte bringen Sie diesen Brief nicht zur Veranstaltung mit; Ihre Eintrittskarte wird per E-Mail versandt.</p><p>Mit freundlichen Grüßen<br>Anna Fischer, Kundenservice (fiktives Unternehmen)</p></div>`,
  letterPt: `<div class="sheet"><p>Lisboa, 8 de setembro de 2026</p><p>Caro Sr. João Almeida,</p><p>Informamos que a sua fatura n.º 2026-554, no valor de <b>780,00 €</b>, vence em 30 de setembro de 2026. O pagamento não pode ser feito em numerário; utilize transferência bancária.</p><p>Com os melhores cumprimentos,<br>Marta Sousa, Departamento Financeiro (empresa fictícia)</p></div>`,
  letterIt: `<div class="sheet"><p>Milano, 9 settembre 2026</p><p>Gentile Sig.ra Giulia Romano,</p><p>Le confermiamo che il contratto n. 4410 sarà rinnovato il <b>15 novembre 2026</b> per un importo annuo di <b>1.200,00 €</b>. Non è necessario firmare nuovamente il contratto. Per disdire, ci scriva entro il 31 ottobre.</p><p>Cordiali saluti,<br>Marco Bianchi, Ufficio Clienti (azienda fittizia)</p></div>`,
  letterAr: `<div class="sheet rtl"><p>القاهرة، 10 سبتمبر 2026</p><p>السيد أحمد مصطفى المحترم،</p><p>نفيدكم بأن فاتورتكم رقم 118 بمبلغ <b>4,250 جنيه مصري</b> مستحقة السداد قبل <b>15 أكتوبر 2026</b>. لا يشمل هذا المبلغ رسوم التوصيل. يرجى عدم إرسال الدفع نقدًا.</p><p>مع خالص التحية،<br>سارة عبد الله، قسم الحسابات (شركة افتراضية)</p></div>`,
  letterZh: `<div class="sheet cjk"><p>上海，2026年9月11日</p><p>尊敬的王丽女士：</p><p>兹确认您的订单编号 5521 将于 <b>2026年10月20日</b> 发货，总金额为 <b>人民币 3,600 元</b>。请勿在收到发票前付款。如有疑问，请在 10 月 5 日前联系我们。</p><p>此致敬礼<br>李明，客户服务部（虚构公司）</p></div>`,
  letterJa: `<div class="sheet cjk"><p>東京、2026年9月12日</p><p>佐藤健様</p><p>ご注文番号 9034 の商品は <b>2026年10月25日</b> にお届けします。合計金額は <b>28,000円</b> です。請求書が届くまでお支払いはしないでください。ご不明な点は10月10日までにご連絡ください。</p><p>敬具<br>田中花子、カスタマーサービス（架空の会社）</p></div>`,
  letterKo: `<div class="sheet cjk"><p>서울, 2026년 9월 13일</p><p>김민준 님께</p><p>주문 번호 7712의 총 금액은 <b>450,000원</b>이며, 배송일은 <b>2026년 10월 22일</b>입니다. 청구서를 받기 전에는 결제하지 마십시오. 문의 사항은 10월 8일까지 연락해 주십시오.</p><p>감사합니다.<br>박서연, 고객 지원팀 (가상의 회사)</p></div>`,
  invoiceEn: `<div class="sheet"><h1>INVOICE</h1><p>Northwind Studio Ltd (fictional) · 9 Harbour Lane, Bristol</p><p>Invoice No: NW-2026-0412 &nbsp; Date: 2 September 2026</p><p>Bill to: Meadow Bakery (fictional), 17 Mill Road, Bath</p><table><tr><td>Brand identity design</td><td>£1,800.00</td></tr><tr><td>Packaging artwork</td><td>£650.00</td></tr><tr><td>Subtotal</td><td>£2,450.00</td></tr><tr><td>VAT 20%</td><td>£490.00</td></tr><tr><td><b>Total due</b></td><td><b>£2,940.00</b></td></tr></table><p><b>Due date: 2 October 2026.</b> Please pay by bank transfer, quoting the invoice number.</p></div>`,
};
const report = () => { let pages = ""; for (let i = 1; i <= 12; i++) pages += `<div style="page-break-after:always;padding:40px;font-family:Arial"><h1>Section ${i}: ${["Overview", "Scope", "Payment terms", "Delivery", "Support", "Warranty", "Liability", "Confidentiality", "Term", "Termination", "Notices", "Signatures"][i - 1]}</h1><p>${i === 3 ? "Payment terms: the client pays 40% (£3,200) on signing and the remaining 60% (£4,800) within 30 days of delivery. Late payments accrue interest at 2% per month. Payments are not refundable once milestones are accepted." : `Synthetic contract text for section ${i}. ${"This clause is illustrative only and carries no legal effect. ".repeat(12)}`}</p></div>`; return pages; };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
const shot = async (key) => { await page.setContent(style + fixtures[key]); const buffer = await page.locator(".sheet").screenshot({ type: "png" }); await writeFile(`${dir}/${key}.png`, buffer); return buffer; };
const pdf = async (html, name) => { await page.setContent(html); const buffer = await page.pdf({ format: "A4" }); await writeFile(`${dir}/${name}`, buffer); return buffer; };
const results = []; let failures = 0;
const check = (label, condition, detail) => { const ok = !!condition; if (!ok) failures++; results.push({ label, ok, detail }); console.log(JSON.stringify({ label, ok, detail: typeof detail === "string" ? detail.slice(0, 220) : detail })); };
try {
  // Camera-style images
  const receiptEn = await analyze("receipt-en.png", await shot("receiptEn"), "image/png");
  check("image EN receipt type/language", /receipt/i.test(receiptEn.documentType) && /english/i.test(receiptEn.language.primary) && !receiptEn.translationAvailable, `${receiptEn.documentType} / ${receiptEn.language.primary}`);
  check("image EN receipt total field grounded", receiptEn.fields.some((f) => /14\.47/.test(f.value)), JSON.stringify(receiptEn.fields.slice(0, 5)));
  check("Q receipt: What is the total?", /14\.47/.test(await ask(receiptEn, "What is the total?").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  const receiptFr = await analyze("receipt-fr.png", await shot("receiptFr"), "image/png");
  const frEnglish = receiptFr.pages[0].english;
  check("image FR receipt language/translation", /french/i.test(receiptFr.language.primary) && receiptFr.translationAvailable, `${receiptFr.language.primary}; intro: ${receiptFr.conversationIntro}`);
  check("FR translation keeps merchant, date, total, negation", /caf[ée] du march[ée]/i.test(frEnglish) && /14\/09\/2026|14 september 2026|september 14, 2026/i.test(frEnglish) && /20[.,]50/.test(frEnglish) && /no refund|without this receipt/i.test(frEnglish), frEnglish);
  check("Q FR: Translate the main message.", /20[.,]50|refund|thank/i.test(await ask(receiptFr, "Translate the main message.").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  const letterEs = await analyze("letter-es.png", await shot("letterEs"), "image/png");
  const esEnglish = letterEs.pages[0].english;
  check("image ES letter language/type", /spanish/i.test(letterEs.language.primary) && /letter/i.test(letterEs.documentType), `${letterEs.documentType} / ${letterEs.language.primary}`);
  check("ES translation keeps names, dates, negation", /luc[ií]a herrera/i.test(esEnglish) && /carlos mendoza/i.test(esEnglish) && /1 november 2026|november 1, 2026/i.test(esEnglish) && /not necessary|do not need|need not|no need/i.test(esEnglish) && /20 september|september 20/i.test(esEnglish), esEnglish);
  check("Q ES: Summarize this in two sentences.", /valencia|transfer|relocation/i.test(await ask(letterEs, "Summarize this in two sentences.").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  // Language matrix (images)
  const matrix = {
    letterDe: ["German", [/weber/i, /7731/, /18 october 2026|october 18, 2026/i, /320[.,]00/, /do not bring|not bring|don't bring/i]],
    letterPt: ["Portuguese", [/jo[ãa]o almeida/i, /2026-554/, /780[.,]00/, /30 september 2026|september 30, 2026/i, /cannot be (made|paid)\s+in\s+cash|not be (made|paid)\s+in\s+cash|no cash/i]],
    letterIt: ["Italian", [/giulia romano/i, /4410/, /15 november 2026|november 15, 2026/i, /1[.,]200[.,]00/, /not necessary|no need|do not need|need not/i]],
    letterAr: ["Arabic", [/ahmed mostafa|ahmad mustafa|ahmed mustafa|ahmad mostafa/i, /118/, /4,?250/, /15 october,? 2026|october 15,? 2026/i, /does not include|not include|exclud/i, /not (send|pay).*cash|no cash|cash/i]],
    letterZh: ["Chinese", [/wang li/i, /5521/, /october 20, 2026|20 october 2026/i, /3,?600/, /do not pay|not pay|before receiving/i]],
    letterJa: ["Japanese", [/sato/i, /9034/, /october 25, 2026|25 october 2026/i, /28,?000/, /do not pay|not pay|until.*invoice/i]],
    letterKo: ["Korean", [/kim/i, /7712/, /450,?000/, /october 22, 2026|22 october 2026/i, /do not pay|not pay|before receiving/i]],
  };
  for (const [key, [language, patterns]] of Object.entries(matrix)) {
    const doc = await analyze(`${key}.png`, await shot(key), "image/png");
    const english = doc.pages[0].english;
    const missed = patterns.filter((r) => !r.test(english)).map(String);
    check(`${language} letter detected, RTL flag, translation preserves key facts`, new RegExp(language, "i").test(doc.language.primary) && doc.translationAvailable && missed.length === 0 && (language !== "Arabic" || doc.language.direction === "rtl"), { language: doc.language.primary, direction: doc.language.direction, missed, english });
  }
  // PDFs
  const invoicePdf = await analyze("invoice-en.pdf", await pdf(style + fixtures.invoiceEn, "invoice-en.pdf"), "application/pdf");
  check("1-page EN text PDF invoice", /invoice/i.test(invoicePdf.documentType) && invoicePdf.pageCount === 1 && invoicePdf.scannedPages === 0 && invoicePdf.fields.some((f) => /2,940\.00/.test(f.value)) && invoicePdf.fields.some((f) => /NW-2026-0412/.test(f.value)), JSON.stringify(invoicePdf.fields));
  check("Q invoice: When is this due?", /2 october 2026|october 2, 2026/i.test(await ask(invoicePdf, "When is this due?").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  const multi = await analyze("contract-12.pdf", await pdf(report(), "contract-12.pdf"), "application/pdf");
  check("12-page text PDF extracted with page count", multi.pageCount === 12 && multi.scannedPages === 0 && multi.pages[2].original.includes("£3,200") && /english/i.test(multi.language.primary), `${multi.documentType}, ${multi.pageCount} pages, usage ${JSON.stringify(multi.usage)}`);
  check("Q PDF: What does page three say about payment?", /40\s?%|3,200|4,800|30 days/.test(await ask(multi, "What does page three say about payment?").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  const frShot = `data:image/png;base64,${(await shot("receiptFr")).toString("base64")}`;
  const scanned = await analyze("scanned-fr.pdf", await pdf(`<div style="page-break-after:always"><img src="${frShot}" style="width:460px"></div><div><img src="${frShot}" style="width:460px;transform:rotate(1.5deg)"></div>`, "scanned-fr.pdf"), "application/pdf");
  check("scanned 2-page PDF read natively, transcribed and translated", scanned.pageCount === 2 && scanned.scannedPages === 2 && /20[.,]50/.test(scanned.pages[0].original) && /20[.,]50/.test(scanned.pages[0].english) && /french/i.test(scanned.language.primary), `${scanned.documentType} ${scanned.language.primary}; p1 original: ${scanned.pages[0].original.slice(0, 80)}`);
  const mixed = await analyze("mixed.pdf", await pdf(`<div style="page-break-after:always;padding:40px;font-family:Arial"><h1>Cover note</h1><p>This synthetic file combines a typed cover page with a scanned French receipt on page two. Reimbursement request total: 20,50 €.</p></div><div><img src="${frShot}" style="width:460px"></div>`, "mixed.pdf"), "application/pdf");
  check("mixed PDF combines extracted text and scanned page", mixed.pageCount === 2 && mixed.scannedPages === 1 && mixed.pages[0].original.includes("Cover note") && /20[.,]50/.test(mixed.pages[1].original), `${mixed.documentType}; languages ${[mixed.language.primary, ...mixed.language.additional].join(" · ")}`);
  // DOCX
  const reportDocx = await tinyDocx(p("Quarterly Operations Report", "Heading1") + p("SYNTHETIC TEST DOCUMENT. This report covers the third quarter of 2026 for Harbor Logistics (fictional).") + p("Main points", "Heading2") + li("On-time delivery rose to 96%") + li("Fuel costs fell by 8%") + li("Two new depots opened in Leeds and Cardiff") + table([["Month", "Shipments", "On-time"], ["July", "12,400", "95%"], ["August", "13,100", "96%"], ["September", "13,900", "97%"]]) + p("Prepared by Helen Marsh, 4 October 2026."));
  const docxEn = await analyze("report-en.docx", reportDocx, DOCX);
  check("EN DOCX report with table parsed", /report/i.test(docxEn.documentType) && /english/i.test(docxEn.language.primary) && docxEn.pages[0].original.includes("| July | 12,400 | 95% |"), `${docxEn.documentType}; fields ${JSON.stringify(docxEn.fields.slice(0, 4))}`);
  check("Q DOCX: What are the main points?", /96\s?%|fuel|depots|leeds/i.test(await ask(docxEn, "What are the main points?").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  const docxEs = await analyze("informe-es.docx", await tinyDocx(p("Informe trimestral de ventas", "Heading1") + p("DOCUMENTO DE PRUEBA SINTÉTICO. Este informe resume las ventas del tercer trimestre de 2026. Las ventas totales alcanzaron 48.500 €, un aumento del 12 % respecto al trimestre anterior. No se registraron devoluciones.") + table([["Mes", "Ventas"], ["Julio", "15.200 €"], ["Agosto", "16.100 €"], ["Septiembre", "17.200 €"]]) + p("Preparado por: Lucía Herrera, 2 de octubre de 2026")), DOCX);
  check("ES DOCX translated with table and negation preserved", /spanish/i.test(docxEs.language.primary) && /48[.,]500/.test(docxEs.pages[0].english) && /no returns|were recorded|no refunds/i.test(docxEs.pages[0].english) && /12\s?%/.test(docxEs.pages[0].english), docxEs.pages[0].english);
  check("Q ES DOCX: Explain this in simple English.", /48[.,]500|sales|12/i.test(await ask(docxEs, "Explain this in simple English.").then((a) => (results.at(-1).answer = a))), results.at(-1).answer);
  // Routing through the existing identification step: a photographed receipt and a resume
  // with a portrait must be classified as documents, so the scanner hands them to /api/document.
  const identify = async (buffer, mime) => {
    const response = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: `data:${mime};base64,${buffer.toString("base64")}` }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
  const routedReceipt = await identify(await shot("receiptEn"), "image/png");
  check("routing: photographed receipt → document", routedReceipt.subjectType === "document", `${routedReceipt.subjectType} / ${routedReceipt.documentType} / ${routedReceipt.documentLanguage}`);
  const portrait = await fetch("https://images.pexels.com/photos/7862615/pexels-photo-7862615.jpeg?w=400", { headers: { "User-Agent": "UCENTH-Vision-Intelligence-test/1.0 (local development test)" } }).then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null);
  if (portrait) {
    await page.setContent(`${style}<div class="sheet" style="width:520px"><div style="display:flex;gap:16px;align-items:flex-start"><img src="data:image/jpeg;base64,${Buffer.from(portrait).toString("base64")}" style="width:110px;height:140px;object-fit:cover"><div><h1>Alex Rivera</h1><p>Product designer · Lisbon · SYNTHETIC TEST RESUME</p><p>alex.rivera@example.com · +351 000 000 000</p></div></div><h2>Experience</h2><p>2022–2026 Senior product designer, Brightline Studio (fictional). Led design for a scheduling app used by 40,000 people.</p><p>2018–2022 UX designer, Nortelab (fictional). Research, prototyping and design systems.</p><h2>Education</h2><p>BA Design, University of Porto, 2018</p><h2>Skills</h2><p>Figma, prototyping, accessibility, user research, Portuguese, English, Spanish</p></div>`);
    const resume = await page.locator(".sheet").screenshot({ type: "png" });
    await writeFile(`${dir}/resume-portrait.png`, resume);
    const routedResume = await identify(resume, "image/png");
    check("routing: resume with portrait → document, not person", routedResume.subjectType === "document" && /resume|cv/i.test(routedResume.documentType), `${routedResume.subjectType} / ${routedResume.documentType}`);
  } else check("routing: resume with portrait (fixture download unavailable)", true, "skipped: portrait download failed");
} finally { await browser.close(); }
const totals = usage.documents.reduce((a, d) => ({ prompt: a.prompt + (d.promptTokens || 0), output: a.output + (d.outputTokens || 0), thought: a.thought + (d.thoughtTokens || 0) }), { prompt: 0, output: 0, thought: 0 });
console.log(JSON.stringify({ usage: usage.documents, followUps: usage.followUps.length, totals }, null, 0));
await writeFile(`${dir}/results.json`, JSON.stringify({ results, usage, totals }, null, 2));
console.log(failures ? `Document checks: ${failures} of ${results.length} failed.` : `Document checks passed: ${results.length} of ${results.length} real analyses and questions behaved as specified.`);
process.exit(failures ? 1 : 0);
