/* Keeps the How To guide's real-source excerpts synchronized with the code.
 *
 * Production files mark a few teaching regions:
 *
 *   // how-to:start camera-capture
 *   …real implementation…
 *   // how-to:end camera-capture
 *
 * how-to.html shows each region in a block tagged data-source-example="camera-capture".
 * `node scripts/how-to-sync.js` compares every block with its region and reports drift;
 * `node scripts/how-to-sync.js --write` copies the current regions into the page.
 * The check runs in `npm test` and `npm run release:check`, so a release cannot ship a
 * stale teaching example. Only harmless formatting is normalized (line endings, trailing
 * whitespace, common indentation); any change to the code itself is reported.
 *
 * Two excerpts live inside template strings (the prompt and the GLSL shader), where a
 * marker line is not possible. Those use quote mode: the excerpt must appear verbatim
 * in the file, ignoring whitespace only. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const regions = {
  "camera-access": { file: "script.js" },
  "camera-capture": { file: "script.js" },
  "stability-update": { file: "lib/stability.js" },
  "gemini-client": { file: "lib/gemini.js" },
  "gemini-request": { file: "lib/gemini.js" },
  "uncertainty-rules": { file: "lib/gemini.js" },
  "person-identity": { file: "lib/gemini.js" },
  "document-validation": { file: "lib/document.js" },
  "pdf-extraction": { file: "lib/document.js" },
  "docx-extraction": { file: "lib/document.js" },
  "viewer-direction": { file: "document.js" },
  "speech-recognition": { file: "voice.js" },
  "charon-playback": { file: "voice.js" },
  "charon-synthesis": { file: "lib/conversation.js" },
  "audio-analysis": { file: "lib/particle-presence.js" },
  "local-boundary": { file: "server.js" },
  "prompt-presented-product": { file: "lib/identity-prompt.js", quote: true },
  "particle-shader": { file: "lib/particle-presence.js", quote: true },
};

const lf = (text) => text.replace(/\r\n/g, "\n");
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeHtml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Normalizes only formatting: line endings, trailing spaces, shared indentation. */
export function normalizeBlock(text) {
  const lines = lf(text).replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
  );
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/** Returns the marked region's code, or throws when the markers are missing or doubled. */
export function extractRegion(source, id) {
  const lines = lf(source).split("\n");
  const start = lines.findIndex((l) => l.trim() === `// how-to:start ${id}`);
  const end = lines.findIndex((l) => l.trim() === `// how-to:end ${id}`);
  if (start === -1 || end === -1 || end <= start)
    throw new Error(`Region "${id}" markers not found or out of order.`);
  if (lines.filter((l) => l.trim() === `// how-to:start ${id}`).length > 1)
    throw new Error(`Region "${id}" is marked more than once.`);
  return normalizeBlock(lines.slice(start + 1, end).join("\n"));
}

const blockPattern =
  /(<div class="command[^"]*" data-source-example="([^"]+)">[\s\S]*?<pre><code>)([\s\S]*?)(<\/code><\/pre>)/g;

function readAll(root) {
  const html = lf(readFileSync(new URL("how-to.html", root), "utf8"));
  const blocks = new Map();
  for (const match of html.matchAll(blockPattern))
    blocks.set(match[2], unescapeHtml(match[3]));
  return { html, blocks };
}

/** Compares every tagged block with its source region. Returns a list of problems. */
export function checkHowTo(root = new URL("../", import.meta.url)) {
  const { blocks } = readAll(root);
  const problems = [];
  for (const [id, spec] of Object.entries(regions)) {
    const source = readFileSync(new URL(spec.file, root), "utf8");
    if (!blocks.has(id)) {
      problems.push({ id, file: spec.file, message: `how-to.html has no block tagged data-source-example="${id}".` });
      continue;
    }
    const excerpt = blocks.get(id);
    try {
      if (spec.quote) {
        const strip = (s) => lf(s).replace(/\s+/g, "");
        if (!strip(source).includes(strip(excerpt)))
          problems.push({ id, file: spec.file, message: "The quoted excerpt no longer appears verbatim in the source (whitespace ignored)." });
      } else if (extractRegion(source, id) !== normalizeBlock(excerpt)) {
        problems.push({ id, file: spec.file, message: "The production implementation changed but the How To excerpt was not updated." });
      }
    } catch (error) {
      problems.push({ id, file: spec.file, message: error.message });
    }
  }
  for (const id of blocks.keys())
    if (!regions[id]) problems.push({ id, file: "(none)", message: `how-to.html tags "${id}" but scripts/how-to-sync.js knows no such region.` });
  return problems;
}

/** Copies the current source regions into how-to.html (quote blocks are left as written). */
export function writeHowTo(root = new URL("../", import.meta.url)) {
  const { html } = readAll(root);
  let updated = 0;
  const output = html.replace(blockPattern, (whole, open, id, _body, close) => {
    const spec = regions[id];
    if (!spec || spec.quote) return whole;
    const code = extractRegion(readFileSync(new URL(spec.file, root), "utf8"), id);
    updated++;
    return `${open}${escapeHtml(code)}${close}`;
  });
  writeFileSync(new URL("how-to.html", root), output);
  return updated;
}

export function formatReport(problems) {
  if (!problems.length) return "How To source sync: all real-source excerpts match the code.";
  return [
    "HOW TO SOURCE DRIFT",
    "",
    ...problems.flatMap((p) => [
      `Example: ${p.id}`,
      `Source: ${p.file}`,
      "Documentation: how-to.html",
      "",
      p.message,
      "",
    ]),
    "Update the How To example before release: review the change, then run",
    "  node scripts/how-to-sync.js --write",
    "and re-read the surrounding lesson so the prose still matches the code.",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    const updated = writeHowTo();
    console.log(`Updated ${updated} real-source excerpts in how-to.html from the marked regions.`);
  }
  const problems = checkHowTo();
  console.log(formatReport(problems));
  if (problems.length) process.exit(1);
}
