import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkHowTo, formatReport, extractRegion, normalizeBlock, regions } from "../scripts/how-to-sync.js";

test("How To real-source excerpts match the marked regions in the code", () => {
  const problems = checkHowTo();
  assert.equal(problems.length, 0, "\n" + formatReport(problems));
});
test("every marked region exists exactly once and simplified examples are labelled", () => {
  for (const [id, spec] of Object.entries(regions)) {
    if (spec.quote) continue;
    const source = readFileSync(new URL(`../${spec.file}`, import.meta.url), "utf8");
    assert.ok(extractRegion(source, id).length > 20, id);
  }
  const html = readFileSync(new URL("../how-to.html", import.meta.url), "utf8");
  assert.ok((html.match(/data-simplified/g) || []).length >= 4, "simplified examples are tagged");
  // Normalization is formatting only: a changed call or parameter must still differ.
  assert.equal(normalizeBlock("  a;\r\n    b;  \n"), "a;\n  b;");
  assert.notEqual(normalizeBlock("fetch('/api/identify')"), normalizeBlock("fetch('/api/other')"));
});
