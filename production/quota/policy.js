/* Public allowance policy: 5 intelligence requests per rolling 5 hours, per visitor.
 *
 * Algorithm: an exact sliding window. Each accepted intelligence request records a
 * timestamp. A new request is allowed when fewer than LIMIT timestamps fall inside the
 * last WINDOW_MS; otherwise it is refused and the visitor is told when the oldest
 * timestamp leaves the window ("Available again in 2h 14m"). There is no fixed reset
 * time and the browser never holds the count: the record lives in the server-side store
 * and every decision is computed here from that record.
 *
 * An intelligence request is any Google-backed answer: an image identification, a
 * document analysis or a Gemini follow-up question. Reservations: the middleware
 * reserves a slot BEFORE the upstream call and refunds it if the request is rejected
 * before any Google work happens (bad upload, validation error, upstream failure). So
 * only successful intelligence actions cost a credit.
 *
 * Charon speech and clip transcription belong to an accepted request and never cost a
 * credit. They are bounded separately so a visitor cannot generate unlimited synthesis
 * without ever asking a question.
 *
 * The limits are parameters (defaulting to the public values) so the staging service
 * can run a longer physical acceptance test under the same algorithm; see
 * production/acceptance.js for the guard that keeps that override out of production. */
export const LIMIT = 5;
export const WINDOW_MS = 5 * 60 * 60 * 1000;
export const SPEECH_LIMIT = 15; // introductions, answers and transcriptions for five requests, with slack
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
export function status(record, now = Date.now(), limit = LIMIT) {
  const r = prune(record, now);
  const remaining = Math.max(0, limit - r.uses.length);
  const oldest = r.uses.length ? Math.min(...r.uses.map((u) => u.t)) : null;
  return {
    remaining,
    limit,
    resetAt: remaining === 0 && oldest !== null ? oldest + WINDOW_MS : null,
    // Rolling window: the next single credit returns when the oldest use expires.
    nextAt: oldest !== null ? oldest + WINDOW_MS : null,
    inflight: Object.keys(r.inflight).length,
  };
}
/** Reserve one intelligence request. Returns { allowed, record, remaining, resetAt, reason }. */
export function reserve(record, id, now = Date.now(), limit = LIMIT) {
  const r = prune(record, now);
  if (Object.keys(r.inflight).length >= INFLIGHT_MAX)
    return { allowed: false, reason: "busy", record: r, ...status(r, now, limit) };
  if (r.uses.length >= limit) return { allowed: false, reason: "exhausted", record: r, ...status(r, now, limit) };
  r.uses.push({ t: now, id });
  r.inflight[id] = now;
  return { allowed: true, record: r, ...status(r, now, limit) };
}
/** Finish a reserved request: keep the credit on success, give it back otherwise. */
export function settle(record, id, success, now = Date.now()) {
  const r = prune(record, now);
  delete r.inflight[id];
  if (!success) r.uses = r.uses.filter((u) => u.id !== id);
  return r;
}
export function reserveSpeech(record, now = Date.now(), speechLimit = SPEECH_LIMIT) {
  const r = prune(record, now);
  if (r.uses.length === 0 || r.speech.length >= speechLimit) return { allowed: false, record: r };
  r.speech.push(now);
  return { allowed: true, record: r };
}
/** "2h 14m" style wording for the user-facing message. */
export function formatWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}
