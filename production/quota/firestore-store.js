/* Firestore-backed quota store, used by every Cloud Run instance.
 *
 * Why Firestore: it is serverless (no VPC connector, no always-on instance like a
 * managed Redis), pay per operation with a generous free tier, has a per-document
 * TTL policy for automatic expiry, and Cloud Run's service identity can reach it with
 * one IAM role. Quota traffic is tiny (a few reads/writes per intelligence request).
 *
 * Atomicity: every change goes through update(key, fn) which reads the document,
 * applies fn, and commits with a precondition on the document's updateTime (or
 * "must not exist" for a new record). If two instances race, one commit fails with
 * FAILED_PRECONDITION and is retried with the fresh value, so counts are never lost.
 *
 * Only the REST API and google-auth-library are used; no extra SDK dependency. The
 * document holds the serialized quota record and an expireAt timestamp for the TTL
 * policy on the collection (configure it once: field "expireAt"). */
import { GoogleAuth } from "google-auth-library";
import { createHash } from "node:crypto";

const RETRIES = 10;
export function createFirestoreStore({
  project = process.env.FIRESTORE_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
  database = process.env.FIRESTORE_DATABASE || "(default)",
  collection = "quota",
  ttlMs = 6 * 60 * 60 * 1000,
} = {}) {
  if (!project) throw new Error("FIRESTORE_PROJECT or GOOGLE_CLOUD_PROJECT is required");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] });
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(database)}/documents`;
  let client;
  // Visitor and network records are stored under a hash of their key. Operator
  // controls keep a readable path (control/circuit) so they can be edited in the console.
  const docName = (key) =>
    key.startsWith("control:")
      ? `${base}/control/${key.slice("control:".length)}`
      : `${base}/${collection}/${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  async function request(url, init = {}) {
    client ||= await auth.getClient();
    return client.request({ url, timeout: 8000, retry: false, validateStatus: () => true, ...init });
  }
  async function read(key) {
    const r = await request(docName(key));
    if (r.status === 404) return { value: null, updateTime: null };
    if (r.status !== 200) throw new Error(`Firestore read failed (${r.status})`);
    const state = r.data.fields?.state?.stringValue;
    return { value: state ? JSON.parse(state) : null, updateTime: r.data.updateTime };
  }
  async function write(key, value, updateTime) {
    const precondition = updateTime ? { updateTime } : { exists: false };
    const body = {
      writes: [
        value === null
          ? { delete: docName(key).replace(`${base}/`, `projects/${project}/databases/${database}/documents/`), currentDocument: precondition }
          : {
              update: {
                name: docName(key).replace(`${base}/`, `projects/${project}/databases/${database}/documents/`),
                fields: {
                  state: { stringValue: JSON.stringify(value) },
                  expireAt: { timestampValue: new Date(Date.now() + ttlMs).toISOString() },
                },
              },
              currentDocument: precondition,
            },
      ],
    };
    const r = await request(`${base}:commit`, { method: "POST", data: body });
    if (r.status === 200) return true;
    if (r.status === 409 || r.status === 412 || r.status === 400) return false; // precondition failed: retry
    throw new Error(`Firestore write failed (${r.status})`);
  }
  const fullName = (key) => docName(key).replace(`${base}/`, `projects/${project}/databases/${database}/documents/`);
  return {
    kind: "firestore",
    async update(key, fn) {
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        const { value: current, updateTime } = await read(key);
        const { value, result } = await fn(current);
        if (await write(key, value, updateTime)) return result;
        // Exponential backoff with jitter so concurrent writers to one record spread out.
        await new Promise((r) => setTimeout(r, Math.round((30 * 2 ** attempt) * (0.5 + Math.random()))));
      }
      throw new Error("Firestore update contended too many times");
    },
    async get(key) {
      const r = await request(docName(key));
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`Firestore read failed (${r.status})`);
      const fields = r.data.fields || {};
      if (fields.state?.stringValue) return JSON.parse(fields.state.stringValue);
      // Counter documents: plain integer fields.
      return Object.fromEntries(Object.entries(fields).filter(([, v]) => v.integerValue !== undefined).map(([k, v]) => [k, Number(v.integerValue)]));
    },
    // Server-side atomic increment: no read, no precondition, so it never contends.
    async increment(key, field, n) {
      const name = fullName(key);
      const r = await request(`${base}:commit`, { method: "POST", data: { writes: [
        { update: { name, fields: { expireAt: { timestampValue: new Date(Date.now() + ttlMs).toISOString() } } }, updateMask: { fieldPaths: ["expireAt"] } },
        { transform: { document: name, fieldTransforms: [{ fieldPath: field, increment: { integerValue: String(n) } }] } },
      ] } });
      if (r.status !== 200) throw new Error(`Firestore increment failed (${r.status})`);
    },
    async close() {},
  };
}
