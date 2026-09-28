/* Document Intelligence presentation (browser side).
 *
 * Routing, as seen from this file:
 *
 *   Upload a File → PDF or DOCX → "ucenth:document-file" → POST /api/document
 *   Camera / image → /api/identify says subject_type "document"
 *                  → "ucenth:document-image" (same clean capture) → POST /api/document
 *
 * The server does all parsing (PDF.js, mammoth) and the single Gemini analysis; this
 * module only uploads the file, renders the structured result and hands the
 * conversation to voice.js through "ucenth:result-presented", exactly like an object.
 * The document text, translation, summary and fields stay in browser memory for the
 * session so follow-up questions do not re-analyze the file, and are dropped on reset. */
/* Document Intelligence presentation. Routes PDF/Word uploads and photographed documents
 * to /api/document, then renders a document-specific result and hands the conversation
 * to the existing voice loop. Nothing here changes the object or person pipelines. */
const $ = (id) => document.getElementById(id);
// Only two document containers are accepted in this release. Browsers report a MIME
// type for known extensions; the server re-checks the real bytes regardless.
const KINDS = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
};
let token = 0,
  current = null;

document.addEventListener("ucenth:scan-reset", () => {
  // Reset clears the session's document, translation and conversation context.
  token++;
  current = null;
  $("document-stage")?.remove();
});
document.addEventListener("ucenth:document-file", (event) =>
  analyzeFile(event.detail.file),
);
document.addEventListener("ucenth:document-image", (event) =>
  analyzeImage(event.detail),
);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function status(text) {
  $("state-label").textContent = text;
}
/**
 * Same error presentation as the scanner: a readable message, never a raw server error.
 */
function showError(message) {
  $("document-stage")?.remove();
  $("empty-state").hidden = false;
  $("results").hidden = false;
  $("results").replaceChildren(
    element("p", "result-state", "SEARCH PAUSED"),
    element("h2", "error-title", message),
  );
  $("reset").hidden = false;
  $("start").hidden = true;
  $("upload-label").hidden = true;
  status("SCAN PAUSED");
}
/**
 * Interim state while the server extracts and analyzes. Document analysis can take
 * several seconds for multi-page files, so the page explains what is happening.
 */
function showReading(label) {
  $("instructions").hidden = true;
  $("results").hidden = false;
  $("results").replaceChildren(
    element("p", "result-state", "INVESTIGATING"),
    element("h2", "", "Reading the document."),
    element(
      "p",
      "description",
      `${label} Text, language and key details are being identified. Your file stays in memory only.`,
    ),
  );
  $("capture-label").textContent = "02 / READ";
  status("READING DOCUMENT…");
  $("hint").textContent =
    "Document content is sent to Google for analysis. Nothing is saved by UCENTH Vision Intelligence.";
}
// A small stage card stands in for the camera frame when there is no photograph.
/**
 * PDF and Word uploads have no photograph, so a small card stands in for the camera
 * frame and later shows the page count ("PDF · 12 pages").
 */
function showStage(kind, name) {
  $("document-stage")?.remove();
  $("empty-state").hidden = true;
  const card = element("div", "document-stage");
  card.id = "document-stage";
  card.append(
    element("span", "document-kind", kind === "pdf" ? "PDF" : "WORD"),
    element("strong", "document-name", name),
    element("span", "document-pages", "Reading…"),
  );
  $("stage").append(card);
  $("camera-label").textContent = "FILE PRESERVED";
  $("frame-label").textContent = kind === "pdf" ? "PDF" : "DOCX";
}
/**
 * Uploads the raw file bytes with their MIME type as the request body. Raw bodies are
 * used instead of base64 JSON because a 15 MB PDF would grow by a third as base64 and
 * would have to be parsed as a giant string. The file name travels only as a display
 * label header; the server never uses it as a path. A 120-second timer bounds slow files.
 */
async function send(body, mimeType, name, mine) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch("/api/document", {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "X-File-Name": encodeURIComponent(name),
      },
      body,
      signal: controller.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "The scanner backend is unavailable. Start the local server and try again.",
      );
    }
    if (!response.ok)
      throw new Error(data.error || "The document could not be analyzed.");
    if (mine === token) render(data);
  } catch (error) {
    if (mine !== token) return;
    showError(
      error.name === "AbortError"
        ? "Reading the document took too long. Try a smaller file."
        : error instanceof TypeError
          ? "Cannot reach the scanner server. Check your connection and restart the local server."
          : error.message,
    );
  } finally {
    clearTimeout(timeout);
  }
}
/**
 * PDF/DOCX path. The size check here gives quick feedback; the server enforces the
 * same limits and additionally validates magic bytes, page counts and text length.
 */
function analyzeFile(file) {
  const kind =
    KINDS[file.type] ||
    (/\.pdf$/i.test(file.name)
      ? "pdf"
      : /\.docx$/i.test(file.name)
        ? "docx"
        : null);
  const mimeType =
    kind === "pdf"
      ? "application/pdf"
      : KINDS[
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ] &&
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!kind) return showError("Choose a JPEG, PNG, PDF or Word (.docx) file.");
  if (file.size > (kind === "pdf" ? 15 : 10) * 1024 * 1024)
    return showError(
      `This ${kind === "pdf" ? "PDF" : "Word file"} is larger than UCENTH Vision Intelligence currently supports (${kind === "pdf" ? 15 : 10} MB).`,
    );
  const mine = ++token;
  current = null;
  showStage(kind, file.name);
  showReading(
    kind === "pdf"
      ? "Pages are being extracted."
      : "The Word document is being parsed.",
  );
  send(file, mimeType, file.name, mine);
}
/**
 * Photographed document path. The identification step already decided this capture is
 * a document; the same JPEG is now analyzed for text, language and translation.
 */
async function analyzeImage({ image, identification }) {
  const mine = ++token;
  current = null;
  showReading(
    identification?.documentType
      ? `It looks like a ${identification.documentType.toLowerCase()}.`
      : "It looks like a document.",
  );
  // The clean capture is already a JPEG data URL; decode it locally (CSP blocks fetching data: URLs).
  const bytes = Uint8Array.from(atob(image.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  if (mine !== token) return;
  send(
    new Blob([bytes], { type: "image/jpeg" }),
    "image/jpeg",
    "capture.jpg",
    mine,
  );
}
// Script hints for CSS: CJK languages get a font stack with full glyph coverage and
// right-to-left languages get dir="rtl". Derived from the BCP-47 code the server returned.
const LANGUAGE_FONT = (code) =>
  /^(zh|ja|ko)/i.test(code)
    ? "cjk"
    : /^(ar|he|fa|ur|ps|sd|ug|yi|dv)/i.test(code)
      ? "rtl"
      : "";

/**
 * Renders the document result in priority order for small screens: type, language and
 * pages, summary, key details, then the Original / English viewer, then a disclosure
 * with everything else. Fields marked uncertain by the model are labelled as such rather
 * than hidden or guessed. Finally the conversation starts with the bounded document
 * context, so Charon's intro and follow-up questions work exactly as for objects.
 */
function render(data) {
  current = {
    ...data,
    view: data.translationAvailable ? "english" : "original",
    page: 1,
  };
  const results = $("results");
  results.replaceChildren();
  results.closest(".workspace").classList.add("has-result");
  $("edges").hidden = true;
  status("DOCUMENT IDENTIFIED");
  $("capture-label").textContent = "03 / DOCUMENT";
  const stage = $("document-stage");
  if (stage)
    stage.querySelector(".document-pages").textContent =
      `${data.source === "pdf" ? "PDF" : "Word"} · ${data.pageCount} page${data.pageCount === 1 ? "" : "s"}`;
  results.append(
    element("p", "result-state", "DOCUMENT IDENTIFIED"),
    element("h2", "identity-name", data.documentType),
  );
  if (data.title && data.title !== data.documentType)
    results.append(element("p", "identity-meta identity-role", data.title));
  const meta = element("dl", "identity-meta document-meta");
  const languages = [data.language.primary, ...data.language.additional];
  for (const [label, value] of [
    [languages.length > 1 ? "Languages" : "Language", languages.join(" · ")],
    [
      "Pages",
      data.source === "image"
        ? "1 (photograph)"
        : `${data.source === "pdf" ? "PDF" : "Word"} · ${data.pageCount}`,
    ],
  ]) {
    const pair = element("div"),
      dt = element("dt", "", label),
      dd = element("dd", "", value);
    pair.append(dt, dd);
    meta.append(pair);
  }
  results.append(meta);
  const summary = element("section", "document-summary keep-visible");
  summary.append(
    element("h3", "analysis-heading", "Summary"),
    element(
      "p",
      "document-summary-text",
      data.summary || "No summary available.",
    ),
  );
  results.append(summary);
  if (data.fields.length) {
    const block = element("section", "document-fields keep-visible");
    block.append(element("h3", "analysis-heading", "Key details"));
    const list = element("dl", "document-field-list");
    for (const field of data.fields.slice(0, 8)) {
      const pair = element("div", field.uncertain ? "uncertain" : ""),
        dt = element("dt", "", field.label),
        dd = element("dd", "", field.value);
      if (field.uncertain)
        dd.append(element("span", "uncertain-mark", " (uncertain)"));
      pair.append(dt, dd);
      list.append(pair);
    }
    block.append(list);
    results.append(block);
  }
  results.append(buildViewer(data));
  const details = element("details", "identification-notes");
  details.append(element("summary", "", "View full analysis"));
  if (data.fields.length > 8) {
    details.append(element("h3", "", "All extracted details"));
    const all = element("dl", "document-field-list");
    for (const field of data.fields) {
      const pair = element("div"),
        dt = element("dt", "", field.label),
        dd = element(
          "dd",
          "",
          field.value + (field.uncertain ? " (uncertain)" : ""),
        );
      pair.append(dt, dd);
      all.append(pair);
    }
    details.append(all);
  }
  if (data.warnings.length) {
    details.append(element("h3", "", "Please verify"));
    const list = element("ul", "document-warnings");
    for (const warning of data.warnings)
      list.append(element("li", "", warning));
    details.append(list);
  }
  details.append(
    element(
      "p",
      "",
      `Read from ${data.source === "pdf" ? `the PDF's ${data.scannedPages ? `${data.pageCount - data.scannedPages} text page(s) and ${data.scannedPages} scanned page(s)` : "extracted text"}` : data.source === "docx" ? "the Word document's paragraphs, headings, lists and tables" : "the photographed page"}. Values are read from the document, not verified externally; check important figures against the original.`,
    ),
  );
  results.append(details);
  $("reset").hidden = false;
  $("hint").textContent = "";
  document.dispatchEvent(
    new CustomEvent("ucenth:result-presented", {
      detail: {
        status: data.status,
        confidence: data.confidence,
        needsAnotherView: false,
        identification: {
          name: data.documentType,
          subjectType: "document",
          category: "Document",
          confidence: "high",
          status: "hypothesis",
          needsAnotherView: false,
          description: data.summary,
          conversationIntro: data.conversationIntro,
          documentType: data.documentType,
          documentLanguage: data.language.primary,
          identityEstablished: false,
          identityName: "",
          identitySource: "none",
        },
        document: {
          documentType: data.documentType,
          title: data.title,
          language: {
            primary: data.language.primary,
            code: data.language.code,
          },
          summary: data.summary,
          fields: data.fields.map(({ label, value }) => ({ label, value })),
          pages: data.pages.map(({ page, original, english }) => ({
            page,
            original,
            english,
          })),
        },
      },
    }),
  );
}
// Original and English stay side by side as tabs; only one page renders at a time so a
// long document never becomes one giant page of text.
/**
 * Original / English tabs with page navigation.
 *
 * Accessibility follows the WAI-ARIA tabs pattern: role="tablist", role="tab" with
 * aria-selected, a roving tabindex so Arrow keys move between tabs, and a tabpanel that
 * is focusable for keyboard scrolling. Direction and language attributes follow the text
 * actually shown: an Arabic original renders right-to-left, its English translation
 * left-to-right. Only one page is rendered at a time so an 80-page document never
 * becomes one giant DOM tree; the panel has a bounded height with its own scrollbar.
 */
function buildViewer(data) {
  const viewer = element("section", "document-viewer keep-visible");
  viewer.setAttribute("aria-label", "Document text");
  const tabs = element("div", "document-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Document language");
  const views = data.translationAvailable
    ? [
        ["original", `Original (${data.language.primary})`],
        ["english", "English"],
      ]
    : [
        [
          "original",
          data.language.code.startsWith("en")
            ? "Text"
            : `Original (${data.language.primary})`,
        ],
      ];
  const panel = element("div", "document-page");
  panel.setAttribute("role", "tabpanel");
  panel.tabIndex = 0;
  const nav = element("div", "document-nav");
  const prev = element("button", "voice-button", "Previous page"),
    next = element("button", "voice-button", "Next page"),
    where = element("span", "document-where");
  prev.type = next.type = "button";
  where.setAttribute("aria-live", "polite");
  const note = element("p", "document-note");
  const buttons = new Map();
  const select = (view) => {
    current.view = view;
    for (const [key, button] of buttons) {
      button.setAttribute("aria-selected", String(key === view));
      button.tabIndex = key === view ? 0 : -1;
    }
    paint();
  };
  for (const [key, label] of views) {
    const button = element("button", "document-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.id = `document-tab-${key}`;
    button.onclick = () => select(key);
    button.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const keys = views.map((v) => v[0]),
        index = keys.indexOf(current.view);
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? keys.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : keys.length - 1)) %
              keys.length;
      select(keys[target]);
      buttons.get(keys[target]).focus();
    };
    buttons.set(key, button);
    tabs.append(button);
  }
  const paint = () => {
    const page = data.pages[current.page - 1] || { original: "", english: "" };
    const english = current.view === "english";
    const text = english ? page.english : page.original;
    panel.replaceChildren();
    // how-to:start viewer-direction
    // Direction and language follow the text actually shown; translations are never mirrored.
    panel.setAttribute("dir", english ? "ltr" : data.language.direction);
    panel.setAttribute("lang", english ? "en" : data.language.code);
    panel.dataset.script = english ? "" : LANGUAGE_FONT(data.language.code);
    // how-to:end viewer-direction
    panel.setAttribute("aria-labelledby", `document-tab-${current.view}`);
    if (!text)
      panel.append(
        element(
          "p",
          "document-empty",
          english
            ? "No English translation for this page yet. Ask for it in the conversation."
            : page.scanned && !page.original
              ? "This page could not be transcribed."
              : "This page has no readable text.",
        ),
      );
    else
      for (const block of text.split(/\n{2,}/)) {
        const heading = block.match(/^(#{1,6}) (.+)$/);
        if (heading) panel.append(element("h4", "", heading[2]));
        else if (/^\|.*\|$/m.test(block)) {
          const table = element("table", "");
          for (const row of block.split("\n")) {
            if (!row.startsWith("|")) continue;
            const tr = element("tr");
            for (const cell of row.slice(1, -1).split(" | "))
              tr.append(element("td", "", cell.trim()));
            table.append(tr);
          }
          panel.append(table);
        } else {
          const p = element("p");
          p.textContent = block;
          panel.append(p);
        }
      }
    where.textContent = `Page ${current.page} of ${data.pageCount}`;
    prev.disabled = current.page <= 1;
    next.disabled = current.page >= data.pageCount;
    note.textContent =
      data.translationPartial && english
        ? `English translation shown for page${data.translatedPages.length === 1 ? "" : "s"} ${data.translatedPages.join(", ")}. Ask for other pages in the conversation.`
        : "";
  };
  prev.onclick = () => {
    current.page = Math.max(1, current.page - 1);
    paint();
    panel.focus();
  };
  next.onclick = () => {
    current.page = Math.min(data.pageCount, current.page + 1);
    paint();
    panel.focus();
  };
  nav.append(prev, where, next);
  viewer.append(tabs, panel);
  if (data.pageCount > 1) viewer.append(nav);
  viewer.append(note);
  select(current.view);
  return viewer;
}
