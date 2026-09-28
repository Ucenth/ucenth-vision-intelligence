/* Hosted-service request layer, plugged into the educational server's `before` hook.
 *
 * Responsibilities, in request order:
 *   /health, /robots.txt, /sitemap.xml, /hosted.js, /hosted.css, /api/quota,
 *   /download/<zip>            cheap hosted-only routes answered here
 *   /  and /how-to.html        served with hosted metadata and the hosted script injected
 *   intelligence POSTs         visitor identity → circuit breaker → network signals →
 *                              per-visitor concurrency → 5-per-5-hours reservation →
 *                              refund on failure, headers with remaining allowance
 *   /api/speech                bounded per visitor, never counted as a request
 * Everything else falls through to the normal routes. */
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { reserve, settle, reserveSpeech, status, emptyRecord, formatWait, WINDOW_MS } from "./quota/policy.js";
import { createVisitorIdentity } from "./abuse/visitor.js";
import { createNetworkSignals } from "./abuse/network.js";
import { createChallenge } from "./abuse/challenge.js";
import { createCircuit } from "./cloud/circuit.js";
import { logEvent, requestType } from "./cloud/logging.js";

const INTELLIGENCE = new Set(["/api/identify", "/api/document", "/api/follow-up"]);
const ZIP_NAME = "ucenth-vision-intelligence-source.zip";
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
export const MESSAGES = {
  exhausted: (wait) => `Free usage limit reached. You can use UCENTH Vision Intelligence again in ${wait}.`,
  paused: "UCENTH Vision Intelligence is temporarily at public capacity. Please try again later.",
  busy: "One request at a time, please. Wait for the current one to finish.",
  flagged: "Unusual traffic from your network. Please try again later.",
  speech: "Voice is unavailable right now. The written answer is still available.",
};

export function createHostedLayer({
  store,
  secret,
  publicOrigin,
  root,
  zip,
  source = {},
  diagnostics = false,
  secureCookies = true,
  env = process.env,
} = {}) {
  const visitors = createVisitorIdentity({ secret, secure: secureCookies });
  const network = createNetworkSignals({ store, secret });
  const challenge = createChallenge({ secret: env.TURNSTILE_SECRET, siteKey: env.TURNSTILE_SITE_KEY });
  const circuit = createCircuit({ store, env });
  const pages = new Map();
  async function page(name) {
    // Educational pages are served unchanged except for hosted metadata and the
    // hosted script, injected at serve time so the shared files never fork.
    if (!pages.has(name)) {
      let html = await readFile(new URL(name, root), "utf8");
      const canonical = `${publicOrigin}/${name === "index.html" ? "" : name}`;
      const meta = `    <link rel="canonical" href="${canonical}" />\n    <meta property="og:url" content="${canonical}" />\n    <meta name="robots" content="index, follow" />\n`;
      // The diagnostics panel is a staging-only script: never injected in production.
      const hosted = name === "index.html" ? `    <link rel="stylesheet" href="/hosted.css" />\n    <script type="module" src="/hosted.js"></script>\n${diagnostics ? `    <script type="module" src="/diag.js"></script>\n` : ""}` : "";
      html = html.replace("</head>", `${meta}${hosted}  </head>`);
      pages.set(name, html);
    }
    return pages.get(name);
  }
  const quotaHeaders = (res, s) => {
    res.setHeader("X-Quota-Remaining", String(s.remaining));
    res.setHeader("X-Quota-Limit", String(s.limit));
    if (s.resetAt) res.setHeader("X-Quota-Reset", String(Math.ceil(s.resetAt / 1000)));
  };
  return async function before(req, res, { pathname, origin }) {
    const started = Date.now();
    const type = requestType(pathname);
    const done = (status, extra = {}) => logEvent({ path: pathname, type, status, ms: Date.now() - started, ...extra });
    if (req.method === "GET" && pathname === "/health") {
      json(res, 200, { status: "ok" });
      return true;
    }
    if (req.method === "GET" && pathname === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${publicOrigin}/sitemap.xml\n`);
      return true;
    }
    if (req.method === "GET" && pathname === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${publicOrigin}/</loc></url>\n  <url><loc>${publicOrigin}/how-to.html</loc></url>\n</urlset>\n`);
      return true;
    }
    if (req.method === "GET" && (pathname === "/hosted.js" || pathname === "/hosted.css" || (diagnostics && pathname === "/diag.js"))) {
      res.writeHead(200, { "Content-Type": (pathname.endsWith(".js") ? "text/javascript" : "text/css") + "; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(await readFile(new URL(`production/public${pathname}`, root)));
      return true;
    }
    if (req.method === "GET" && pathname === `/download/${ZIP_NAME}`) {
      // The reviewed educational artifact, built once at start-up from the allowlist.
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zip.length, "Content-Disposition": `attachment; filename="${ZIP_NAME}"`, "Cache-Control": "public, max-age=3600" });
      res.end(zip);
      done(200);
      return true;
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/how-to.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await page(pathname === "/how-to.html" ? "how-to.html" : "index.html"));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/quota") {
      const visitor = visitors.resolve(req, res);
      const s = status((await store.get(`visitor:${visitor.id}`)) || emptyRecord());
      quotaHeaders(res, s);
      json(res, 200, { remaining: s.remaining, limit: s.limit, resetAt: s.resetAt, nextAt: s.nextAt, serverTime: Date.now(), windowHours: WINDOW_MS / 3600000, paused: await circuit.paused(), challenge: challenge.siteKey });
      return true;
    }
    if (req.method === "GET" && pathname === "/api/source") {
      json(res, 200, source);
      return true;
    }
    if (req.method !== "POST" || !(INTELLIGENCE.has(pathname) || pathname === "/api/speech" || pathname === "/api/transcribe")) return false;
    try {
      return await gate(req, res, pathname, type, done);
    } catch (error) {
      // A store failure must never leak or hang; fail closed with the capacity message.
      logEvent({ path: pathname, type, status: 503, quota: "store-error", error: error.message });
      json(res, 503, { error: MESSAGES.paused });
      return true;
    }
  };
  async function gate(req, res, pathname, type, done) {
    const visitor = visitors.resolve(req, res);
    if (visitor.isNew) await network.note(req, "new-visitor");
    const key = `visitor:${visitor.id}`;
    // Speech synthesis and clip transcription belong to the same user action as the
    // question; they share one bounded budget and never cost a request credit.
    if (pathname === "/api/speech" || pathname === "/api/transcribe") {
      const ok = await store.update(key, async (current) => {
        const r = reserveSpeech(current || emptyRecord());
        return { value: r.record, result: r.allowed };
      });
      if (!ok) {
        json(res, 429, { error: MESSAGES.speech });
        done(429, { quota: "speech-denied" });
        return true;
      }
      return false;
    }
    if (await circuit.paused()) {
      json(res, 503, { error: MESSAGES.paused, paused: true });
      done(503, { quota: "paused" });
      return true;
    }
    if (await network.flagged(req)) {
      const token = req.headers["x-challenge-token"];
      if (!(challenge.enabled && (await challenge.verify(token, req.headers["x-forwarded-for"]?.split(",")[0]?.trim())))) {
        json(res, 429, { error: MESSAGES.flagged, challenge: challenge.siteKey });
        done(429, { quota: "flagged" });
        return true;
      }
    }
    const id = randomBytes(8).toString("base64url");
    const decision = await store.update(key, async (current) => {
      const r = reserve(current || emptyRecord(), id);
      return { value: r.record, result: r };
    });
    if (!decision.allowed) {
      if (decision.reason === "busy") json(res, 429, { error: MESSAGES.busy });
      else {
        quotaHeaders(res, decision);
        json(res, 429, { error: MESSAGES.exhausted(formatWait(decision.resetAt - Date.now())), remaining: 0, resetAt: decision.resetAt });
      }
      done(429, { quota: decision.reason });
      return true;
    }
    quotaHeaders(res, decision);
    // Settle when the response finishes: only a successful upstream result keeps the credit.
    res.on("finish", async () => {
      const success = res.statusCode < 400;
      try {
        await store.update(key, async (current) => ({ value: settle(current || emptyRecord(), id, success), result: null }));
        if (success) await network.note(req, "accepted");
      } catch (error) {
        logEvent({ path: pathname, type, status: 500, quota: "settle-failed", error: error.message });
      }
      done(res.statusCode, { quota: success ? "charged" : "refunded", remaining: success ? decision.remaining : decision.remaining + 1 });
    });
    return false;
  }
}
