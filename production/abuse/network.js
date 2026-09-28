/* Network-level abuse signals. The IP address is never treated as the user: mobile
 * carriers, CGNAT, VPNs and offices put many people behind one address. It is used
 * only to notice patterns a single person does not produce, and it is stored as a
 * salted hash with a short TTL, never raw.
 *
 * Signals per hashed source address, in hourly buckets (current + previous bucket are
 * summed, so the window is between one and two hours):
 *   newVisitors  fresh visitor ids issued (cookie clearing / identity rotation)
 *   accepted     intelligence requests accepted across all visitors behind the address
 * Crossing a threshold flags the source: further intelligence requests must pass a
 * challenge when one is configured, or are refused politely until the counters roll
 * over. Ordinary shared networks stay far below these numbers.
 *
 * Counters use atomic increments (no read-modify-write), so a burst of requests from
 * one address never contends on a single document. */
import { createHash } from "node:crypto";

export const BUCKET_MS = 60 * 60 * 1000;
// Thresholds are deliberately generous: a carrier's CGNAT or a campus network can put
// hundreds of real people behind one address, and each of them can only ever spend
// five credits per five hours. These numbers catch identity rotation and automation,
// not a popular shared network. Load tests from one machine reach them quickly.
export const NEW_VISITORS_PER_HOUR = 150;
export const ACCEPTED_PER_HOUR = 400;

export function sourceAddress(req) {
  // Behind Cloud Run the trusted proxy appends the real client address as the LAST entry
  // of X-Forwarded-For, so a client cannot pick its own by sending the header itself.
  const forwarded = (req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) || req.socket?.remoteAddress || "unknown";
}
export function createNetworkSignals({ store, secret }) {
  const hash = (ip) => createHash("sha256").update(`${secret}:${ip}`).digest("base64url").slice(0, 32);
  const key = (req, bucket) => `net:${hash(sourceAddress(req))}:${bucket}`;
  const bucketOf = (now) => Math.floor(now / BUCKET_MS);
  const total = async (req, field, now) => {
    const [current, previous] = await Promise.all([store.get(key(req, bucketOf(now))), store.get(key(req, bucketOf(now) - 1))]);
    return Number(current?.[field] || 0) + Number(previous?.[field] || 0);
  };
  return {
    key,
    /** Records an event: "new-visitor" or "accepted". */
    async note(req, event, now = Date.now()) {
      const field = event === "new-visitor" ? "newVisitors" : "accepted";
      await store.increment(key(req, bucketOf(now)), field, 1);
    },
    async flagged(req, now = Date.now()) {
      const [newVisitors, accepted] = await Promise.all([total(req, "newVisitors", now), total(req, "accepted", now)]);
      return newVisitors > NEW_VISITORS_PER_HOUR || accepted > ACCEPTED_PER_HOUR;
    },
  };
}
