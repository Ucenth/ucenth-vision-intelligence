/* UCENTH-hosted production entry point (Cloud Run). Not part of the educational ZIP.
 *
 *   vision.ucenth.com → Cloud Run → this process → the educational server (server.js)
 *                                   + production/ layer: quota, abuse signals, circuit
 *                                   breaker, health, source download, hosted metadata
 *
 * Configuration (environment variables):
 *   PORT                   set by Cloud Run; defaults to 8080
 *   GOOGLE_CLOUD_PROJECT   project for Gemini, Text-to-Speech and Firestore
 *   PUBLIC_ORIGIN          e.g. https://vision.ucenth.com (canonical URLs, sitemap)
 *   VISITOR_COOKIE_SECRET  ≥32 random characters; signs visitor cookies and hashes IPs
 *   QUOTA_STORE            "firestore" (default in production) or "memory" (local only)
 *   INTELLIGENCE_PAUSED    "1" pauses all intelligence requests (circuit breaker)
 *   TURNSTILE_SECRET / TURNSTILE_SITE_KEY   optional challenge escalation
 *   DIAGNOSTICS            "1" injects the mobile diagnostics panel (staging only)
 *   ACCEPTANCE_TEST_LIMIT  staging only: raises the per-visitor request limit for a
 *                          physical acceptance run; refused unless DIAGNOSTICS=1 and
 *                          PUBLIC_ORIGIN is a *.run.app host (see acceptance.js)
 * Credentials come from the Cloud Run service identity through ADC; nothing is read
 * from files and nothing is ever sent to the browser. */
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { createServer } from "../server.js";
import { files } from "../scripts/release-files.js";
import { PUBLIC_LIMITS, HOSTED_GUARDS } from "./limits.js";
import { createHostedLayer } from "./middleware.js";
import { acceptanceOverride } from "./acceptance.js";
import { createMemoryStore } from "./quota/memory-store.js";
import { createFirestoreStore } from "./quota/firestore-store.js";

const root = new URL("../", import.meta.url);

/** Builds the educational source ZIP once from the allowlist (never the live directory). */
export async function buildEducationalZip() {
  const zip = new JSZip();
  for (const file of files) zip.file(`ucenth-vision-intelligence/${file}`, await readFile(new URL(file, root)));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

export async function createHostedServer({ env = process.env, store, services = {} } = {}) {
  const publicOrigin = (env.PUBLIC_ORIGIN || "http://localhost:8080").replace(/\/$/, "");
  let secret = env.VISITOR_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    if (env.NODE_ENV === "production") throw new Error("VISITOR_COOKIE_SECRET (≥32 chars) is required in production");
    secret = randomBytes(32).toString("base64url"); // local runs: cookies reset on restart
  }
  store ||= (env.QUOTA_STORE || (env.NODE_ENV === "production" ? "firestore" : "memory")) === "firestore"
    ? createFirestoreStore({ project: env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT })
    : createMemoryStore();
  // AI_MOCK=1 replaces Google services with instant fakes so infrastructure load tests
  // never create Gemini or Charon traffic. It is only for staging load tests; the
  // start-up log line makes any accidental use obvious.
  if (env.AI_MOCK === "1") {
    process.stdout.write(JSON.stringify({ severity: "WARNING", message: "AI_MOCK=1: Google services are stubbed. Never run the public service this way." }) + "\n");
    services = {
      identify: async () => ({ provider: "mock", status: "hypothesis", confidence: "high", name: "Mock object", brand: "", category: "Mock", subjectType: "object", observations: ["Stubbed result"], needsAnotherView: false, requestedView: "", description: "AI_MOCK", identityEstablished: false, identityName: "", identitySource: "none" }),
      followUp: async () => ({ answer: "Mock answer.", userSuppliedIdentity: "" }),
      synthesize: async () => Buffer.alloc(44 + 2400),
      analyzeDocument: async ({ kind, name }) => ({ subjectType: "document", source: kind, fileName: name, pageCount: 1, documentType: "General Document", title: "Mock", name: "Mock", language: { primary: "English", code: "en", additional: [], direction: "ltr" }, translationAvailable: false, translationPartial: false, translatedPages: [], summary: "AI_MOCK", fields: [], warnings: [], pages: [{ page: 1, original: "mock", english: "", scanned: false }], scannedPages: 0, confidence: "high", needsAnotherView: false, status: "hypothesis", conversationIntro: "Mock.", usage: {}, elapsedMs: 0 }),
      ...services,
    };
  }
  const zip = await buildEducationalZip();
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const source = { version: pkg.version, files: files.length, bytes: zip.length, license: "MIT" };
  const publicHost = new URL(publicOrigin).host.replace(/\./g, "\\.");
  // Staging-only acceptance override: honoured only when acceptance.js says so, and
  // always announced in the log so it can never run unnoticed.
  const acceptance = acceptanceOverride(env);
  if (acceptance?.error) process.stdout.write(JSON.stringify({ severity: "ERROR", message: acceptance.error }) + "\n");
  else if (acceptance) process.stdout.write(JSON.stringify({ severity: "WARNING", message: `ACCEPTANCE_TEST_LIMIT=${acceptance.limit}: per-visitor allowance raised for physical acceptance testing on ${publicOrigin}. Never run the public service this way.` }) + "\n");
  const limits = acceptance && !acceptance.error ? { limit: acceptance.limit, speechLimit: acceptance.speechLimit } : {};
  // DIAGNOSTICS=1 injects the mobile voice diagnostics panel (staging only).
  const before = createHostedLayer({ store, secret, publicOrigin, root, zip, source, diagnostics: env.DIAGNOSTICS === "1", secureCookies: publicOrigin.startsWith("https"), env, ...limits });
  const server = createServer({
    ...services,
    allowedHosts: new RegExp(`^(${publicHost}|localhost(:\\d+)?|127\\.0\\.0\\.1(:\\d+)?|[a-z0-9-]+\\.[a-z0-9-]+\\.run\\.app)$`, "i"),
    documentLimits: PUBLIC_LIMITS,
    guards: HOSTED_GUARDS,
    before,
  });
  // Document analysis and Charon can legitimately take a while; nothing may hang forever.
  server.requestTimeout = 125 * 1000;
  server.headersTimeout = 15 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  return { server, store, zip };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const { server, store } = await createHostedServer();
  // Cloud Run routes traffic to the container's PORT on all interfaces.
  server.listen(port, "0.0.0.0", () =>
    console.log(JSON.stringify({ severity: "INFO", message: `UCENTH Vision Intelligence hosted edition listening on ${port} (quota store: ${store.kind})` })),
  );
}
