/* UCENTH Vision Intelligence local server.
 *
 * This file is the boundary between the browser and Google Cloud:
 *
 *   browser ──► http://localhost:3000 ──► this server ──► Gemini / Text-to-Speech
 *                                              (holds the credentials)
 *
 * Design choices worth copying in your own projects:
 *   - Serve only an explicit allowlist of files. A generic static server could expose
 *     .env, tests or credentials by accident.
 *   - Bind to loopback (127.0.0.1) and check Host / Origin: this is a personal local
 *     tool, not a public service.
 *   - Send a strict Content-Security-Policy so scripts run only from this origin.
 *   - Validate every upload by decoding it; never trust a declared type.
 *   - One active cloud request and a small per-minute limit protect your own bill.
 *   - Log one word about failures and return your own safe messages; provider errors
 *     can contain request details you do not want on a web page. */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createGeminiDetector } from "./lib/gemini.js";
import { createVoiceRoutes } from "./lib/voice-routes.js";
import { createDocumentRoute } from "./lib/document-routes.js";

const root = new URL("./", import.meta.url);
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_BODY = Math.ceil((MAX_IMAGE * 4) / 3) + 1024;
// The complete public surface of the app. Anything not listed here is a 404, which is
// how backend code under lib/ and files like .env stay private even though they sit
// in the same folder.
const types = {
  "/": "text/html",
  "/index.html": "text/html",
  "/style.css": "text/css",
  "/script.js": "text/javascript",
  "/lib/stability.js": "text/javascript",
  "/voice.js": "text/javascript",
  "/voice.css": "text/css",
  "/lib/particle-presence.js": "text/javascript",
  "/document.js": "text/javascript",
  "/document.css": "text/css",
};
// Serve only public application files. A directory-wide static server could expose .env.
Object.assign(types, {
  "/how-to.html": "text/html",
  "/how-to.css": "text/css",
  "/appearance.css": "text/css",
  "/appearance.js": "text/javascript",
  "/how-to.js": "text/javascript",
  "/LICENSE": "text/plain",
  "/THIRD-PARTY-NOTICES.md": "text/plain",
  "/public/assets/scanner.png": "image/png",
});
const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
/**
 * Builds the HTTP server. Every cloud-facing function is injectable so the tests can
 * exercise the real routes with fakes and no billing. The route order is: static files,
 * health, conversation routes, document route, then the identification route below.
 */
export function createServer({
  identify,
  followUp,
  synthesize,
  analyzeDocument,
  // Hosts this server answers to. The educational server is a personal local tool,
  // so only localhost is accepted; a hosted deployment passes its own pattern.
  allowedHosts = /^(localhost|127\.0\.0\.1)(:\d+)?$/,
  // Document limits are injectable so a public deployment can choose smaller ones.
  documentLimits,
  // Optional hook that runs before routing. It may answer the request itself and
  // return true, or return false to let the normal routes continue.
  before,
} = {}) {
  const identifyOriginal = identify || createGeminiDetector();
  const voiceRoutes = createVoiceRoutes({ followUp, synthesize });
  const documentRoute = createDocumentRoute({
    ...(analyzeDocument ? { analyze: analyzeDocument } : {}),
    ...(documentLimits ? { limits: documentLimits } : {}),
  });
  let busy = false;
  let requests = [];
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
    // how-to:start local-boundary
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const host = req.headers.host;
    if (!allowedHosts.test(host || ""))
      return json(res, 403, { error: "This host is not served here." });
    // how-to:end local-boundary
    // Behind a TLS-terminating proxy the browser's origin is https://host; locally it is http.
    const scheme = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const origin = `${scheme}://${host}`;
    const pathname = new URL(req.url, origin).pathname;
    if (before && (await before(req, res, { pathname, origin }))) return;
    if (req.method === "GET" && types[pathname]) {
      try {
        res.setHeader("Content-Type", types[pathname] + "; charset=utf-8");
        return res.end(
          await readFile(
            new URL(pathname === "/" ? "index.html" : pathname.slice(1), root),
          ),
        );
      } catch {
        return json(res, 500, { error: "Application file unavailable." });
      }
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && pathname === "/api/health")
      return json(res, 200, { ok: true, provider: "Gemini 3.8 Flash vision" });
    if (req.method === "POST" && ["/api/follow-up", "/api/speech"].includes(pathname))
      return voiceRoutes(req, res, pathname, origin);
    if (req.method === "POST" && pathname === "/api/document")
      return documentRoute(req, res, origin);
    if (req.method !== "POST" || pathname !== "/api/identify")
      return json(res, 404, { error: "Not found." });
        // Same-origin only. Together with Sec-Fetch-Site this stops another website in the
        // same browser from spending this machine's Gemini quota.
    if (req.headers.origin && req.headers.origin !== origin)
      return json(res, 403, {
        error: "This request must come from the local scanner.",
      });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return json(res, 403, { error: "Cross-site requests are not allowed." });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
      return json(res, 415, { error: "Send a JSON image payload." });
    // Prevent overlapping billable scans; count attempts only after image validation.
    if (busy)
      return json(res, 409, {
        error: "A scan is already running. Please wait.",
      });
    requests = requests.filter((t) => Date.now() - t < 60000);
    if (requests.length >= 6) {
      res.setHeader("Retry-After", "60");
      return json(res, 429, {
        error: "Scan limit reached. Wait one minute before trying again.",
      });
    }
    busy = true;
    let called = false;
    const started = Date.now();
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          json(res, 413, {
            error: "Image is too large. Maximum image size is 2 MB.",
          });
          return;
        }
        chunks.push(chunk);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return json(res, 400, { error: "Invalid JSON payload." });
      }
            // The browser sent a data URL. Parse it strictly: only JPEG or PNG, valid base64.
      const match =
        typeof payload?.image === "string" &&
        payload.image.match(
          /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/,
        );
      if (!match || match[2].length % 4)
        return json(res, 400, { error: "Send a valid JPEG or PNG image." });
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > MAX_IMAGE)
        return json(res, 413, { error: "Image must be smaller than 2 MB." });
      try {
        const decoder = sharp(buffer, {
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
          throw new Error("Invalid image");
        // Fully decode for validation, but Gemini receives the original captured bytes.
        await decoder.raw().toBuffer();
      } catch {
        return json(res, 400, {
          error:
            "The image could not be decoded. Try another clear JPEG or PNG.",
        });
      }
      requests.push(Date.now());
      called = true;
      return json(res, 200, {
        ...(await identifyOriginal(buffer, `image/${match[1]}`)),
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      // Provider errors can contain request details. Return only our own safe messages.
      const code = Number(error.status || error.code);
      const auth =
        [7, 16, 401, 403].includes(code) ||
        /credentials|authentication|ENOENT/i.test(error.message || "");
      const quota = [8, 429].includes(code);
      console.error(
        `Identification request failed (${auth ? "authentication" : quota ? "quota" : "upstream"}).`,
      );
      return json(res, quota ? 429 : auth ? 503 : 502, {
        error: quota
          ? "Identification quota is exhausted. Check the project quota and billing before retrying."
          : auth
            ? "Identification is not ready. Check server-side Google credentials and the enabled API, then restart the server."
            : "Identification could not complete. Please try again shortly.",
      });
    } finally {
      busy = false;
      if (called)
        console.log(
          `Identification attempt finished in ${Date.now() - started} ms.`,
        );
    }
  });
}
// Start listening only when run directly (node server.js). Tests import createServer()
// instead and pick a free port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT) || 3000, "127.0.0.1", () =>
    console.log(
      `UCENTH Vision Intelligence: http://localhost:${Number(process.env.PORT) || 3000}`,
    ),
  );
}
