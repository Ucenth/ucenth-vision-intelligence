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
 * Credentials come from the Cloud Run service identity through ADC; nothing is read
 * from files and nothing is ever sent to the browser. */
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { createServer } from "../server.js";
import { files } from "../scripts/release-files.js";
import { PUBLIC_LIMITS } from "./limits.js";
import { createHostedLayer } from "./middleware.js";
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
  const zip = await buildEducationalZip();
  const publicHost = new URL(publicOrigin).host.replace(/\./g, "\\.");
  const before = createHostedLayer({ store, secret, publicOrigin, root, zip, secureCookies: publicOrigin.startsWith("https"), env });
  const server = createServer({
    ...services,
    allowedHosts: new RegExp(`^(${publicHost}|localhost(:\\d+)?|127\\.0\\.0\\.1(:\\d+)?|[a-z0-9-]+\\.[a-z0-9-]+\\.run\\.app)$`, "i"),
    documentLimits: PUBLIC_LIMITS,
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
