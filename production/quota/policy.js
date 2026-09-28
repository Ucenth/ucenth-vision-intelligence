/* Public allowance policy: 5 intelligence requests per rolling 5 hours, per visitor.
 *
 * Algorithm: an exact sliding window. Each accepted intelligence request records a
 * timestamp. A new request is allowed when fewer than LIMIT timestamps fall inside the
 * last WINDOW_MS; otherwise it is refused and the visitor is told when the oldest
 * timestamp leaves the window ("Available again in 2h 14m"). There is no fixed reset
 * time and the browser never holds the count: the record lives in the server-side store
 * and every decision is computed here from that record.
 *
 * Reservations: the middleware reserves a slot BEFORE the upstream call and refunds it
 * if the request is rejected before any Google work happens (bad upload, validation
 * error, upstream failure). So only successful intelligence actions cost a credit.
 *
 * Charon speech is not an intelligence request. It is bounded separately so a visitor
 * cannot generate unlimited synthesis without ever asking a question. */
export const LIMIT = 5;
export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const SPEECH_LIMIT = 15; // introductions + answers for five questions, with slack
export const INFLIGHT_MAX = 1; // one expensive request at a time per visitor
export const INFLIGHT_TTL_MS = 150 * 1000; // a hung request stops blocking after this

export function emptyRecord() {
  return { uses: [], speech: [], inflight: {} };
}
function prune(record, now) {
  const since = now - WINDOW_MS;
  const uses = (record.uses || []).filter((u) => u.t > since);
  const speech = (record.speech || []).filter((t) => t > since);
  const inflight = Object.fromEntries(
    Object.entries(record.inflight || {}).filter(([, t]) => now - t < INFLIGHT_TTL_MS),
  );
  return { uses, speech, inflight };
}
export function status(record, now = Date.now()) {
  const r = prune(record, now);
  const remaining = Math.max(0, LIMIT - r.uses.length);
  const oldest = r.uses.length ? Math.min(...r.uses.map((u) => u.t)) : null;
  return {
    remaining,
    limit: LIMIT,
    resetAt: remaining === 0 && oldest !== null ? oldest + WINDOW_MS : null,
    inflight: Object.keys(r.inflight).length,
  };
}
/** Reserve one intelligence request. Returns { allowed, record, remaining, resetAt, reason }. */
export function reserve(record, id, now = Date.now()) {
  const r = prune(record, now);
  if (Object.keys(r.inflight).length >= INFLIGHT_MAX)
    return { allowed: false, reason: "busy", record: r, ...status(r, now) };
  if (r.uses.length >= LIMIT) return { allowed: false, reason: "exhausted", record: r, ...status(r, now) };
  r.uses.push({ t: now, id });
  r.inflight[id] = now;
  return { allowed: true, record: r, ...status(r, now) };
}
/** Finish a reserved request: keep the credit on success, give it back otherwise. */
export function settle(record, id, success, now = Date.now()) {
  const r = prune(record, now);
  delete r.inflight[id];
  if (!success) r.uses = r.uses.filter((u) => u.id !== id);
  return r;
}
export function reserveSpeech(record, now = Date.now()) {
  const r = prune(record, now);
  if (r.uses.length === 0 || r.speech.length >= SPEECH_LIMIT) return { allowed: false, record: r };
  r.speech.push(now);
  return { allowed: true, record: r };
}
/** "2h 14m" style wording for the user-facing message. */
export function formatWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}
