import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { summarizeIdentity } from "../lib/gemini.js";
import { createServer } from "../server.js";
const identity = {
  object_category: "smartphone",
  likely_brand: "Apple",
  likely_product: "iPhone Pro series",
  likely_model: "",
  confidence: "medium",
  visible_identifying_features: ["Triple rear cameras"],
  visible_text: [],
  alternative_candidates: ["iPhone 13 Pro", "iPhone 13 Pro Max"],
  recommended_search_query: "iPhone Pro",
  needs_another_view: false,
  requested_view: "",
  identification_basis: "physical appearance",
  uncertainty_reason: "Pro versus Pro Max cannot be determined without scale.",
  evidence_urls: [],
  subject_type: "object",
  person_identity_established: false,
  person_identity_name: "",
  person_identity_source: "none",
  person_identity_evidence: "",
  person_role_or_title: "",
  scene_description: "",
};
test("phone ambiguity requests another view even when the model forgets its flag", async () => {
  const result = summarizeIdentity(identity);
  assert.equal(result.needsAnotherView, true);
  assert.equal(result.model, "");
  assert.equal(result.status, "needs-view");
  assert.equal(result.sourceCount, 0);
  assert.deepEqual(result.sources, []);
});
test("malformed identity JSON is rejected; model-written URLs never become evidence", async () => {
  assert.throws(() => summarizeIdentity({ likely_product: "Anything" }));
  const output = {
    ...identity,
    evidence_urls: ["https://example.com/unverified"],
  };
  assert.ok(output.evidence_urls.length);
  assert.deepEqual(summarizeIdentity(output).sources, []);
});
test("Gemini receives original captured bytes and MIME, never a transformed image", async () => {
  const bytes = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#8b192e" },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  let calls = 0;
  const server = createServer({
    provider: "gemini",
    identify: async (content, mime) => {
      calls++;
      assert.equal(mime, "image/jpeg");
      assert.deepEqual(content, bytes);
      return { provider: "gemini", name: "Eucerin", status: "hypothesis" };
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/identify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: "data:image/jpeg;base64," + bytes.toString("base64"),
        }),
      },
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).name, "Eucerin");
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
