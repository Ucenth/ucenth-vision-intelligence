/* /api/follow-up and /api/speech: the two conversation routes.
 *
 *   follow-up: image and/or bounded document context + identification + question
 *              + recent history → Gemini → { answer, userSuppliedIdentity }
 *   speech:    answer text → Cloud Text-to-Speech (Charon) → WAV bytes
 *
 * Both accept only same-origin JSON, allow one active request each, rate-limit per
 * minute, bound every input and return sanitized errors. The browser never sees a
 * credential or a raw provider message. */
import sharp from "sharp";
import { createFollowUp, createSpeech } from "./conversation.js";

const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 300000;
// Only plain text fields of the session's document context are forwarded, within a fixed budget.
/**
 * Only plain text fields of the session's document context are forwarded, each cut to
 * a fixed length. If the whole context would exceed the budget the pages are dropped
 * and the summary/fields remain, so a giant payload cannot inflate the model prompt.
 */
function boundDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const pages = (Array.isArray(value.pages) ? value.pages : [])
    .slice(0, 60)
    .map((p) => ({
      page: Number.isInteger(p?.page) ? p.page : 0,
      original: text(p?.original, 60000),
      english: text(p?.english, 60000),
    }));
  const document = {
    documentType: text(value.documentType, 60),
    title: text(value.title, 120),
    language: {
      primary: text(value.language?.primary, 40),
      code: text(value.language?.code, 12),
    },
    summary: text(value.summary, 1500),
    fields: (Array.isArray(value.fields) ? value.fields : [])
      .slice(0, 16)
      .map((f) => ({ label: text(f?.label, 60), value: text(f?.value, 300) })),
    pages,
  };
  if (JSON.stringify(document).length > MAX_DOCUMENT_CHARS)
    return { ...document, pages: [], truncated: true };
  return document;
}
/**
 * Creates the handler for both routes. followUp and synthesize are injectable for tests.
 * The identification object from the browser is rebuilt field by field (allowlisted
 * keys, bounded strings, explicit booleans): the browser is a client, not a trusted source.
 */
export function createVoiceRoutes({
  followUp = createFollowUp(),
  synthesize = createSpeech(),
} = {}) {
  const busy = new Set(),
    attempts = { "/api/follow-up": [], "/api/speech": [] };
  return async (req, res, path, host) => {
    if (
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(res, 403, {
        error: "Use the local scanner for this request.",
      });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
      return json(res, 415, { error: "Send a JSON payload." });
    if (busy.has(path))
      return json(res, 409, {
        error: "A voice request is already running. Please wait.",
      });
    attempts[path] = attempts[path].filter((t) => Date.now() - t < 60000);
    if (attempts[path].length >= (path === "/api/speech" ? 18 : 12)) {
      res.setHeader("Retry-After", "60");
      return json(res, 429, {
        error:
          "Conversation limit reached. Wait one minute before trying again.",
      });
    }
    busy.add(path);
    const start = Date.now();
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (
          length >
          (path === "/api/speech"
            ? 12000
            : Math.ceil((MAX_IMAGE * 4) / 3) + MAX_DOCUMENT_CHARS + 20000)
        )
          return json(res, 413, {
            error: "Conversation payload is too large.",
          });
        chunks.push(chunk);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return json(res, 400, { error: "Invalid JSON payload." });
      }
      if (path === "/api/speech") {
        if (
          typeof payload?.text !== "string" ||
          !payload.text.trim() ||
          payload.text.length > 1800
        )
          return json(res, 400, {
            error: "Speech text must contain 1–1800 characters.",
          });
        attempts[path].push(Date.now());
        const audio = await synthesize(payload.text.trim());
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "X-Voice-Latency-Ms": String(Date.now() - start),
          "X-Audio-Characters": String(payload.text.trim().length),
        });
        return res.end(audio);
      }
      // Document conversations carry bounded extracted text instead of (or as well as) the image.
      const document = boundDocument(payload?.document);
      const match =
        typeof payload?.image === "string" &&
        payload.image.match(
          /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/,
        );
      if (
        (!match && !document) ||
        (match && match[2].length % 4) ||
        typeof payload.question !== "string" ||
        !payload.question.trim() ||
        payload.question.length > 700
      )
        return json(res, 400, {
          error:
            "Send the captured image or document context and a question of 1–700 characters.",
        });
      let image = null;
      if (match) {
        image = Buffer.from(match[2], "base64");
        if (!image.length || image.length > MAX_IMAGE)
          return json(res, 413, { error: "Image must be smaller than 2 MB." });
        try {
          const decoder = sharp(image, {
            limitInputPixels: 16000000,
            failOn: "warning",
          });
          const meta = await decoder.metadata();
          if (
            !["jpeg", "png"].includes(meta.format) ||
            meta.width < 64 ||
            meta.height < 64 ||
            (meta.pages || 1) > 1
          )
            throw Error();
          await decoder.raw().toBuffer();
        } catch {
          return json(res, 400, {
            error: "The captured image could not be decoded.",
          });
        }
      }
      if (
        !payload.identification ||
        typeof payload.identification !== "object" ||
        Array.isArray(payload.identification)
      )
        return json(res, 400, { error: "Identification context is required." });
      const identification = {};
      for (const key of [
        "name",
        "brand",
        "category",
        "confidence",
        "description",
        "status",
        "subjectType",
        "identityName",
        "identityEvidence",
        "roleOrTitle",
        "sceneDescription",
      ])
        if (typeof payload.identification[key] === "string")
          identification[key] = payload.identification[key].slice(0, 700);
      identification.needsAnotherView =
        payload.identification.needsAnotherView === true;
      // Contextual person identity travels only as explicit flags; user-supplied names stay labelled as such.
      identification.identitySource = [
        "visible_text",
        "caption",
        "page_context",
        "user_context",
      ].includes(payload.identification.identitySource)
        ? payload.identification.identitySource
        : "none";
      identification.identityEstablished =
        payload.identification.identityEstablished === true &&
        !!identification.identityName &&
        !["none", "user_context"].includes(identification.identitySource);
      if (
        identification.identitySource === "none" ||
        (!identification.identityEstablished &&
          identification.identitySource !== "user_context")
      )
        identification.identityName = "";
      if (!identification.name)
        return json(res, 400, { error: "Identification context is required." });
      if (
        !Array.isArray(payload.history) ||
        payload.history.length > 6 ||
        payload.history.some(
          (x) =>
            !x ||
            !["user", "assistant"].includes(x.role) ||
            typeof x.text !== "string" ||
            x.text.length > 1800,
        )
      )
        return json(res, 400, {
          error: "Send at most six short conversation messages.",
        });
      const history = payload.history.map(({ role, text }) => ({ role, text }));
      attempts[path].push(Date.now());
      const result = await followUp({
        image,
        mimeType: match ? `image/${match[1]}` : "",
        identification,
        question: payload.question.trim(),
        history,
        document,
      });
      const answer = typeof result === "string" ? result : result?.answer;
      if (typeof answer !== "string" || !answer.trim())
        throw new Error("Incomplete conversational response");
      const userSuppliedIdentity =
        typeof result?.userSuppliedIdentity === "string"
          ? result.userSuppliedIdentity.slice(0, 120)
          : "";
      return json(res, 200, {
        answer,
        userSuppliedIdentity,
        elapsedMs: Date.now() - start,
      });
    } catch (error) {
      const code = Number(error.status || error.code || error.response?.status);
      const quota = [8, 429].includes(code),
        auth =
          [7, 16, 401, 403].includes(code) ||
          /credentials|authentication|ENOENT/i.test(error.message || "");
      console.error(
        `Conversation service failed (${quota ? "quota" : auth ? "authentication" : "upstream"}).`,
      );
      return json(res, quota ? 429 : auth ? 503 : 502, {
        error:
          path === "/api/speech"
            ? "Voice is unavailable. The written answer is still available. Check Cloud Text-to-Speech setup or try again later."
            : "The follow-up could not complete. Please retry your question shortly.",
      });
    } finally {
      busy.delete(path);
    }
  };
}
