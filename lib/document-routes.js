/* /api/document: one bounded, in-memory analysis of an uploaded or captured document.
 *
 * The request body is the raw file. It is buffered in memory up to the format's limit,
 * validated by its bytes, parsed and analyzed, and then forgotten. There are no
 * temporary files, so there is nothing to clean up or accidentally serve. */
import {
  LIMITS,
  TYPES,
  validateFile,
  createDocumentAnalyzer,
  safeName,
} from "./document.js";

const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
/**
 * Creates the route handler. "analyze" is injectable so tests can run the whole HTTP
 * path with a fake analyzer and no cloud calls. Same-origin checks, one request at a time
 * and six per minute protect the student's own billing; provider errors are logged in
 * one word and replaced by safe messages.
 */
export function createDocumentRoute({
  limits = LIMITS,
  analyze = createDocumentAnalyzer({ limits }),
} = {}) {
  let busy = false,
    attempts = [];
  return async (req, res, origin) => {
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(res, 403, {
        error: "Use the local scanner for this request.",
      });
    const mimeType = (req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!TYPES[mimeType])
      return json(res, 415, {
        error: "Choose a JPEG, PNG, PDF or Word (.docx) file.",
      });
    if (busy)
      return json(res, 409, {
        error: "A document is already being analyzed. Please wait.",
      });
    attempts = attempts.filter((t) => Date.now() - t < 60000);
    if (attempts.length >= 6) {
      res.setHeader("Retry-After", "60");
      return json(res, 429, {
        error: "Document limit reached. Wait one minute before trying again.",
      });
    }
    busy = true;
    try {
      // The body is the raw file. It is buffered up to the format's limit and never written to disk.
      const max = Math.max(limits.pdfBytes, limits.docxBytes);
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > max)
          return json(res, 413, {
            error: "This file is larger than UCENTH Vision Intelligence currently supports.",
          });
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length)
        return json(res, 400, { error: "The file was empty." });
      const name = safeName(
        decodeURIComponent(req.headers["x-file-name"] || ""),
      );
      const check = validateFile({ buffer, mimeType, name }, limits);
      if (check.error) return json(res, 400, { error: check.error });
      attempts.push(Date.now());
      const result = await analyze({
        kind: check.kind,
        buffer,
        mimeType,
        name,
      });
      if (result?.error) return json(res, 422, { error: result.error });
      return json(res, 200, result);
    } catch (error) {
      const code = Number(error.status || error.code || error.response?.status);
      const quota = [8, 429].includes(code),
        auth =
          [7, 16, 401, 403].includes(code) ||
          /credentials|authentication|ENOENT/i.test(error.message || "");
      console.error(
        `Document analysis failed (${quota ? "quota" : auth ? "authentication" : "upstream"}).`,
      );
      return json(res, quota ? 429 : auth ? 503 : 502, {
        error: quota
          ? "The document service limit was reached. Try again in a minute."
          : "The document could not be analyzed right now. Please try again.",
      });
    } finally {
      busy = false;
    }
  };
}
