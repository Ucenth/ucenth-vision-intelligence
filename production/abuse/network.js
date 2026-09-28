/* Network-level abuse signals. The IP address is never treated as the user: mobile
 * carriers, CGNAT, VPNs and offices put many people behind one address. It is used
 * only to notice patterns a single person does not produce, and it is stored as a
 * salted hash with a short TTL, never raw.
 *
 * Signals (per hashed source address, rolling one hour):
 *   newVisitors  how many fresh visitor ids were issued (cookie clearing / rotation)
 *   accepted     how many intelligence requests were accepted across all visitors
 * Crossing a threshold flags the source: further intelligence requests from it are
 * asked to pass a challenge when one is configured, or refused politely until the
 * counters decay. Ordinary shared networks stay far below these numbers. */
import { createHash } from "node:crypto";

export const WINDOW_MS = 60 * 60 * 1000;
export const NEW_VISITORS_PER_HOUR = 30;
export const ACCEPTED_PER_HOUR = 60;

export function sourceAddress(req) {
  // Cloud Run puts the client address first in X-Forwarded-For; locally use the socket.
  const forwarded = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}
export function createNetworkSignals({ store, secret }) {
  const hash = (ip) => createHash("sha256").update(`${secret}:${ip}`).digest("base64url").slice(0, 32);
  const prune = (r, now) => ({
    newVisitors: (r?.newVisitors || []).filter((t) => now - t < WINDOW_MS),
    accepted: (r?.accepted || []).filter((t) => now - t < WINDOW_MS),
  });
  return {
    key: (req) => `net:${hash(sourceAddress(req))}`,
    /** Records an event and reports whether the source now looks abusive. */
    async note(req, event, now = Date.now()) {
      return store.update(this.key(req), async (current) => {
        const r = prune(current, now);
        if (event === "new-visitor") r.newVisitors.push(now);
        if (event === "accepted") r.accepted.push(now);
        const flagged = r.newVisitors.length > NEW_VISITORS_PER_HOUR || r.accepted.length > ACCEPTED_PER_HOUR;
        return { value: r, result: { flagged, newVisitors: r.newVisitors.length, accepted: r.accepted.length } };
      });
    },
    async flagged(req, now = Date.now()) {
      const r = prune(await store.get(this.key(req)), now);
      return r.newVisitors.length > NEW_VISITORS_PER_HOUR || r.accepted.length > ACCEPTED_PER_HOUR;
    },
  };
}
