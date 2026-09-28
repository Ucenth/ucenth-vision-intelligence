/* Gemini identification (server side).
 *
 *   browser (JPEG) → /api/identify → this file → Gemini 3.8 Flash → structured JSON
 *     → summarizeIdentity() validates and normalizes → browser renders
 *
 * Why is this on the server? Because browser JavaScript is visible to every visitor.
 * Cloud credentials live only here, discovered through Application Default Credentials
 * (ADC): Google's SDK reads the developer's local sign-in, so no key is ever pasted into
 * a file or shipped to the page. */
import { GoogleGenAI } from "@google/genai";
import { systemInstruction, schema, prompt } from "./identity-prompt.js";

/**
 * Turns the model's raw JSON into the object the interface renders.
 *
 * Structured output makes this possible: instead of parsing prose like "looks like maybe
 * an iPhone", every required key is checked against the schema (types and enums), and
 * then a few cautious rules apply: an exact model is kept only at high confidence with no
 * stated uncertainty; phone ambiguity always requests another view; a person's name
 * survives only with an explicit non-biometric source and evidence; document routing
 * fields are passed through for the browser. Anything unexpected throws, and the route
 * turns that into a safe error rather than showing half a result.
 */
export function summarizeIdentity(value) {
  if (!value || typeof value !== "object")
    throw new Error("Invalid identity response");
  for (const key of schema.required) {
    const spec = schema.properties[key],
      item = value[key];
    if (
      spec.type === "array"
        ? !Array.isArray(item) || item.some((x) => typeof x !== "string")
        : typeof item !== spec.type
    )
      throw new Error("Invalid identity response");
    if (spec.enum && !spec.enum.includes(item))
      throw new Error("Invalid identity response");
  }
  const clean = (text) => text.trim().slice(0, 700);
  const brand = clean(value.likely_brand);
  let category = clean(value.object_category);
  const uncertainty = clean(value.uncertainty_reason);
  // how-to:start uncertainty-rules
  const model =
    value.confidence === "high" && !uncertainty && !value.needs_another_view
      ? clean(value.likely_model)
      : "";
  const product =
    clean(value.likely_product) || category || "Unidentified object";
  let name =
    brand && !product.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${product}`
      : product;
  if (
    model &&
    !name.toLowerCase().includes(model.toLowerCase()) &&
    !model.toLowerCase().includes(product.toLowerCase())
  )
    name += ` · ${model}`;
  const needsAnotherView =
    value.needs_another_view ||
    !!(uncertainty && /phone|smartphone/i.test(category));
  // how-to:end uncertainty-rules
  // how-to:start person-identity
  // A person's name survives only with an explicit non-biometric source and evidence.
  const person = value.subject_type === "person";
  const identityName = person ? clean(value.person_identity_name) : "";
  const identityEvidence = person ? clean(value.person_identity_evidence) : "";
  const identitySource =
    person && value.person_identity_source !== "none" ? value.person_identity_source : "none";
  const identityEstablished =
    person &&
    value.person_identity_established === true &&
    !!identityName &&
    identitySource !== "none" &&
    !!identityEvidence;
  // how-to:end person-identity
  const sceneDescription = person ? clean(value.scene_description) : "";
  if (person) {
    name = identityEstablished ? identityName : "Person";
    category = "Human";
  }
  return {
    provider: "gemini",
    status: needsAnotherView ? "needs-view" : "hypothesis",
    identityBasis: identityEstablished ? "contextual-evidence" : "visual-hypothesis",
    name,
    brand: person ? "" : brand,
    category,
    model: person ? "" : model,
    confidence: value.confidence,
    needsAnotherView,
    subjectType: value.subject_type,
    // Document routing only: the full analysis happens in /api/document with the clean capture.
    documentType: value.subject_type === "document" ? clean(value.document_type) : "",
    documentLanguage: value.subject_type === "document" ? clean(value.document_language) : "",
    identityEstablished,
    identityName: identityEstablished ? identityName : "",
    identitySource: identityEstablished ? identitySource : "none",
    identityEvidence: identityEstablished ? identityEvidence : "",
    roleOrTitle: identityEstablished ? clean(value.person_role_or_title) : "",
    sceneDescription,
    conversationIntro: !person
      ? ""
      : identityEstablished
        ? `I've identified the person shown here as ${identityName}. What would you like to know about them?`
        : "I can see a person in this image, but I don't have enough context to establish who they are. I can still tell you about what is visible.",
    description: person
      ? sceneDescription ||
        (identityEstablished
          ? "Identified from contextual information supplied with the image, not from facial appearance."
          : "A person is visible. Identity is not established from the available context.")
      : uncertainty ||
        "Identified from visible features and readable text in your captured image. Exact variants are not independently verified.",
    observations: value.visible_identifying_features.slice(0, 6).map(clean),
    requestedView: needsAnotherView
      ? clean(value.requested_view) ||
        "Show a clearer identifying detail or a different angle."
      : "",
    recommendedSearchQuery: clean(value.recommended_search_query),
    sources: [],
    sourceCount: 0,
    apiCalls: 1,
  };
}

/**
 * Creates the identification function used by the server. The client is built once
 * and reused. The request asks for JSON that matches our schema (responseJsonSchema),
 * uses a low temperature for consistency, a low thinking level for speed, and a 25 s
 * timeout with no retries so a hung request cannot bill twice. The original captured
 * bytes are sent unchanged: the visual scan effect never touches this image.
 */
export function createGeminiDetector() {
  let client;
  return async (content, mimeType) => {
    // ADC is discovered by the server SDK. No access token belongs in browser code.
    // how-to:start gemini-client
    if (!process.env.GOOGLE_CLOUD_PROJECT?.trim())
      throw new Error(
        "Google project configuration is missing; check credentials setup.",
      );
    client ||= new GoogleGenAI({
      enterprise: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: "global",
      apiVersion: "v1beta1",
      httpOptions: { timeout: 25000, retryOptions: { attempts: 1 } },
    });
    // how-to:end gemini-client
    // how-to:start gemini-request
    const response = await client.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${prompt} Do not use external search; evidence_urls must be empty. Keep likely_product at the broader family when the exact model is uncertain. Do not infer publisher, ingredients, performance specifications or other facts absent from the image.`,
            },
            { inlineData: { mimeType, data: content.toString("base64") } },
          ],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature: 0.1,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
    if (response.candidates?.[0]?.finishReason !== "STOP")
      throw new Error("Incomplete identity response");
    return summarizeIdentity(JSON.parse(response.text));
    // how-to:end gemini-request
  };
}
