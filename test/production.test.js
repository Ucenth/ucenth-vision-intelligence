// Hosted-production layer tests. This file is intentionally NOT in the educational
// release allowlist: the production layer is UCENTH's operational concern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserve, settle, reserveSpeech, status, emptyRecord, formatWait, LIMIT, WINDOW_MS, SPEECH_LIMIT } from "../production/quota/policy.js";
import { createVisitorIdentity, COOKIE } from "../production/abuse/visitor.js";
import { createMemoryStore } from "../production/quota/memory-store.js";
import { createHostedServer } from "../production/server.js";
import { PUBLIC_LIMITS } from "../production/limits.js";
import { files } from "../scripts/release-files.js";
import { tinyPdf } from "./document.test.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const SECRET = "test-secret-test-secret-test-secret-1234567890";

test("allowance: five per rolling five hours, refunds on failure, accurate reset time", () => {
  let r = emptyRecord();
  const t0 = 1_000_000;
  for (let i = 0; i < LIMIT; i++) {
    const d = reserve(r, `r${i}`, t0 + i * 1000);
    assert.equal(d.allowed, true, `request ${i}`);
    r = settle(d.record, `r${i}`, true, t0 + i * 1000 + 10);
  }
  const denied = reserve(r, "r5", t0 + 6000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "exhausted");
  assert.equal(denied.resetAt, t0 + WINDOW_MS, "reset when the oldest use leaves the window");
  assert.equal(reserve(r, "r6", t0 + WINDOW_MS + 1).allowed, true, "rolling window, not a fixed reset");
  // A failed request gives the credit back.
  let fresh = emptyRecord();
  const d = reserve(fresh, "x", t0);
  fresh = settle(d.record, "x", false, t0 + 5);
  assert.equal(status(fresh, t0 + 6).remaining, LIMIT);
  // One expensive request at a time per visitor.
  const first = reserve(emptyRecord(), "a", t0);
  assert.equal(reserve(first.record, "b", t0 + 1).reason, "busy");
  // Speech is bounded separately and requires at least one accepted request.
  assert.equal(reserveSpeech(emptyRecord(), t0).allowed, false);
  let s = settle(reserve(emptyRecord(), "q", t0).record, "q", true, t0 + 1);
  for (let i = 0; i < SPEECH_LIMIT; i++) s = reserveSpeech(s, t0 + 2 + i).record;
  assert.equal(reserveSpeech(s, t0 + 100).allowed, false);
  assert.equal(formatWait(2 * 3600000 + 14 * 60000), "2h 14m");
  assert.equal(formatWait(30000), "1m");
});

test("visitor cookie is random, signed, verifiable and tamper-proof", () => {
  const identity = createVisitorIdentity({ secret: SECRET, secure: false });
  const headers = {};
  const res = { setHeader: (k, v) => (headers[k] = v) };
  const first = identity.resolve({ headers: {} }, res);
  assert.equal(first.isNew, true);
  assert.match(headers["Set-Cookie"], new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{27}; Max-Age=\\d+; Path=/; HttpOnly; SameSite=Strict$`));
  const value = headers["Set-Cookie"].split(";")[0].split("=")[1];
  const again = identity.resolve({ headers: { cookie: `${COOKIE}=${value}` } }, res);
  assert.equal(again.isNew, false);
  assert.equal(again.id, first.id);
  const tampered = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
  assert.equal(identity.resolve({ headers: { cookie: `${COOKIE}=${tampered}` } }, res).isNew, true, "a forged signature gets a new identity");
  assert.equal(identity.verify("x.y"), null);
  assert.throws(() => createVisitorIdentity({ secret: "short" }));
});

async function hosted(services, run, env = {}) {
  const store = createMemoryStore();
  const { server } = await createHostedServer({
    env: { PUBLIC_ORIGIN: "http://localhost", VISITOR_COOKIE_SECRET: SECRET, QUOTA_STORE: "memory", ...env },
    store,
    services: { identify: async () => ({ name: "Notebook", subjectType: "object" }), followUp: async () => ({ answer: "Blue.", userSuppliedIdentity: "" }), synthesize: async () => Buffer.from("RIFF"), transcribe: async () => "typed by fake", ...services },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#4d5a6b" } }).png().toBuffer();
const identifyBody = () => JSON.stringify({ image: "data:image/png;base64," + png.toString("base64") });

test("hosted server: health, metadata, download, quota headers, exhaustion, refunds, speech and circuit breaker", async () => {
  await hosted({}, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /<link rel="canonical" href="http:\/\/localhost\/" \/>/);
    assert.match(home, /hosted\.js/);
    const howTo = await (await fetch(`${base}/how-to.html`)).text();
    assert.match(howTo, /canonical" href="http:\/\/localhost\/how-to.html"/);
    assert.doesNotMatch(howTo, /hosted\.js/);
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/api\//);
    const zip = await fetch(`${base}/download/ucenth-vision-intelligence-source.zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.ok(Number(zip.headers.get("content-length")) > 100000);
    // A first quota read issues the visitor cookie; keep it for the rest of the session.
    const q = await fetch(`${base}/api/quota`);
    const cookie = q.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^uvi=/);
    assert.equal((await q.json()).remaining, LIMIT);
    const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body });
    // A rejected upload (validation) is refunded: it never reached Google.
    const bad = await post("/api/identify", JSON.stringify({ image: "data:image/png;base64,YWJj" }));
    assert.equal(bad.status, 400);
    assert.equal((await (await fetch(`${base}/api/quota`, { headers: { Cookie: cookie } })).json()).remaining, LIMIT);
    // Five successful intelligence requests, then a clear message with the wait time.
    for (let i = 0; i < LIMIT; i++) {
      const r = await post("/api/identify", identifyBody());
      assert.equal(r.status, 200, `request ${i}`);
      assert.equal(r.headers.get("x-quota-remaining"), String(LIMIT - 1 - i));
    }
    const denied = await post("/api/identify", identifyBody());
    assert.equal(denied.status, 429);
    const body = await denied.json();
    assert.match(body.error, /^Free usage limit reached\. You can use UCENTH Vision Intelligence again in \d+h \d{2}m\.$/);
    assert.ok(body.resetAt > Date.now() + WINDOW_MS - 60000);
    assert.equal((await post("/api/follow-up", JSON.stringify({ identification: { name: "x" }, question: "?", history: [], document: { pages: [] } }))).status, 429);
    // Speech and clip transcription are not intelligence requests and still work after exhaustion.
    const speech = await post("/api/speech", JSON.stringify({ text: "Hello" }));
    assert.equal(speech.status, 200);
    const clip = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "audio/webm", Cookie: cookie }, body: Buffer.alloc(4000, 1) });
    assert.equal(clip.status, 200);
    assert.equal((await clip.json()).text, "typed by fake");
    // A visitor who has never spent a credit gets no free transcription either.
    const stranger = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(4000, 1) });
    assert.equal(stranger.status, 429);
    // A fresh visitor (no cookie) has a full allowance: quota is per visitor, not per address.
    const other = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: identifyBody() });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("x-quota-remaining"), String(LIMIT - 1));
  });
  // Circuit breaker via environment.
  await hosted({}, async (base) => {
    const r = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: identifyBody() });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /temporarily at public capacity/);
    assert.equal((await fetch(`${base}/how-to.html`)).status, 200, "static pages stay up");
    assert.equal((await fetch(`${base}/download/ucenth-vision-intelligence-source.zip`)).status, 200);
  }, { INTELLIGENCE_PAUSED: "1" });
  // Circuit breaker via the store document, no restart needed.
  await hosted({}, async (base, store) => {
    await store.update("control:circuit", async () => ({ value: { paused: true }, result: null }));
    const r = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: identifyBody() });
    assert.equal(r.status, 503);
  });
});

test("hosted server: upstream failure is refunded and public document limits apply", async () => {
  // The real document analyzer runs page-limit checks before any Google call; a project id
  // only needs to be present for the client to be constructed.
  const previous = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT ||= "test-project";
  let fail = true;
  await hosted({ identify: async () => { if (fail) throw Object.assign(new Error("upstream"), { status: 502 }); return { name: "ok" }; } }, async (base) => {
    const q = await fetch(`${base}/api/quota`);
    const cookie = q.headers.get("set-cookie").split(";")[0];
    const r = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: identifyBody() });
    assert.equal(r.status, 502);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await (await fetch(`${base}/api/quota`, { headers: { Cookie: cookie } })).json()).remaining, LIMIT, "no credit for a failed upstream call");
    fail = false;
    // An 11-page PDF is over the public page limit and says so plainly.
    const pdf = tinyPdf(Array(PUBLIC_LIMITS.pages + 1).fill("page"));
    const doc = await fetch(`${base}/api/document`, { method: "POST", headers: { "Content-Type": "application/pdf", Cookie: cookie }, body: pdf });
    assert.equal(doc.status, 422);
    assert.match((await doc.json()).error, /up to 10 pages/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await (await fetch(`${base}/api/quota`, { headers: { Cookie: cookie } })).json()).remaining, LIMIT);
  });
  if (previous === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
});

test("release gate: the educational allowlist contains no production layer and the core never imports it", () => {
  assert.ok(files.every((f) => !f.startsWith("production/") && f !== "Procfile" && f !== "test/production.test.js"), "production files are not distributed");
  for (const file of ["server.js", "script.js", "voice.js", "document.js", "how-to.html", "how-to.js", "lib/document.js", "lib/document-routes.js", "lib/voice-routes.js"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/production\//.test(text) && !/5 (intelligence )?requests per 5 hours|VISITOR_COOKIE_SECRET|INTELLIGENCE_PAUSED/i.test(text), `${file} stays free of hosted-only code`);
  }
});
