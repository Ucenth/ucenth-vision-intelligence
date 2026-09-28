import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { summarizeIdentity } from "../lib/gemini.js";
import { schema } from "../lib/identity-prompt.js";
import { createServer } from "../server.js";

const person = {
  object_category: "Human", likely_brand: "", likely_product: "Person", likely_model: "",
  confidence: "high", visible_identifying_features: ["Dark jacket", "Leadership card layout"],
  visible_text: ["Jensen Huang", "President and CEO"], alternative_candidates: [],
  recommended_search_query: "", needs_another_view: false, requested_view: "",
  identification_basis: "page context", uncertainty_reason: "", evidence_urls: [],
  subject_type: "person", person_identity_established: true, person_identity_name: "Jensen Huang",
  person_identity_source: "page_context",
  person_identity_evidence: "Leadership card heading directly under the photograph reads Jensen Huang, President and CEO.",
  person_role_or_title: "President and CEO · NVIDIA",
  scene_description: "A man in a dark jacket photographed on a corporate leadership page.",
};
test("contextual identity survives only with an explicit non-biometric source and evidence", () => {
  const found = summarizeIdentity(person);
  assert.equal(found.subjectType, "person");
  assert.equal(found.identityEstablished, true);
  assert.equal(found.name, "Jensen Huang");
  assert.equal(found.roleOrTitle, "President and CEO · NVIDIA");
  assert.equal(found.identitySource, "page_context");
  assert.equal(found.identityBasis, "contextual-evidence");
  assert.equal(found.category, "Human");
  assert.equal(found.brand, "");
  assert.match(found.conversationIntro, /^I've identified the person shown here as Jensen Huang\./);
  assert.equal(found.description, person.scene_description);
  for (const variant of [
    { person_identity_source: "none" },
    { person_identity_evidence: "" },
    { person_identity_established: false },
    { person_identity_name: "" },
  ]) {
    const result = summarizeIdentity({ ...person, ...variant });
    assert.equal(result.identityEstablished, false, JSON.stringify(variant));
    assert.equal(result.name, "Person");
    assert.equal(result.identityName, "");
    assert.equal(result.roleOrTitle, "");
    assert.equal(result.identityEvidence, "");
    assert.equal(result.identitySource, "none");
    assert.match(result.conversationIntro, /don't have enough context to establish who they are/);
  }
  for (const key of ["subject_type", "person_identity_established", "person_identity_name",
    "person_identity_source", "person_identity_evidence", "person_role_or_title", "scene_description"])
    assert.ok(schema.required.includes(key), key);
  assert.deepEqual(schema.properties.person_identity_source.enum, ["visible_text", "caption", "page_context", "none"]);
});
test("objects ignore stray person fields and keep the object result shape", () => {
  const object = summarizeIdentity({ ...person, subject_type: "object", object_category: "Notebook",
    likely_brand: "Moleskine", likely_product: "Hardcover notebook" });
  assert.equal(object.subjectType, "object");
  assert.equal(object.identityEstablished, false);
  assert.equal(object.identityName, "");
  assert.equal(object.conversationIntro, "");
  assert.equal(object.name, "Moleskine Hardcover notebook");
  assert.equal(object.brand, "Moleskine");
  assert.equal(object.category, "Notebook");
  assert.throws(() => summarizeIdentity({ ...person, subject_type: "face" }));
});
test("follow-up route passes contextual identity flags through and labels user-supplied names", async () => {
  const picture = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#4d5a6b" } }).jpeg().toBuffer();
  const seen = [];
  const server = createServer({ identify: async () => ({}), followUp: async ({ identification, question }) => {
    seen.push(identification);
    return /this is/i.test(question) ? { answer: "Noted.", userSuppliedIdentity: "Jensen Huang" } : "Plain answer.";
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = (identification, question) => fetch(`http://127.0.0.1:${server.address().port}/api/follow-up`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${picture.toString("base64")}`, identification, question, history: [] }),
  });
  try {
    const established = await post({ name: "Jensen Huang", subjectType: "person", identityEstablished: true,
      identityName: "Jensen Huang", identitySource: "page_context", roleOrTitle: "President and CEO", identityEvidence: "Caption." }, "Who is this?");
    assert.equal(established.status, 200);
    assert.deepEqual(await established.json().then((x) => [x.answer, x.userSuppliedIdentity]), ["Plain answer.", ""]);
    assert.equal(seen[0].identityEstablished, true);
    assert.equal(seen[0].identityName, "Jensen Huang");
    assert.equal(seen[0].roleOrTitle, "President and CEO");
    const supplied = await post({ name: "Person", subjectType: "person", identityEstablished: false,
      identityName: "Jensen Huang", identitySource: "user_context" }, "This is Jensen Huang. Where is he?");
    assert.deepEqual(await supplied.json().then((x) => [x.answer, x.userSuppliedIdentity]), ["Noted.", "Jensen Huang"]);
    assert.equal(seen[1].identityEstablished, false);
    assert.equal(seen[1].identitySource, "user_context");
    assert.equal(seen[1].identityName, "Jensen Huang");
    // A name without an accepted source, or a claimed establishment with an invalid source, is stripped.
    await post({ name: "Person", subjectType: "person", identityEstablished: true, identityName: "Someone", identitySource: "face" }, "Who?");
    assert.equal(seen[2].identityEstablished, false);
    assert.equal(seen[2].identityName, "");
    assert.equal(seen[2].identitySource, "none");
  } finally { await new Promise((r) => server.close(r)); }
});
