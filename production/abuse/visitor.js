/* Anonymous visitor identity: a random, server-signed first-party cookie.
 *
 * The cookie value is <random 128-bit id>.<HMAC-SHA256(id, secret) truncated>. The
 * browser cannot forge or edit a valid id without the secret, and the quota record is
 * looked up by this id on the server, so nothing the client stores is authoritative.
 * It is HttpOnly (page scripts never need it), Secure behind HTTPS, and SameSite=Strict
 * because every API call is same-origin. Nothing about the person is stored in it. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "uvi";
const MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookies at about 400 days

export function createVisitorIdentity({ secret, secure = true }) {
  if (!secret || secret.length < 32) throw new Error("VISITOR_COOKIE_SECRET must be at least 32 characters");
  const sign = (id) => createHmac("sha256", secret).update(id).digest("base64url").slice(0, 27);
  const verify = (value) => {
    const [id, sig] = String(value || "").split(".");
    if (!id || !sig || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const expected = Buffer.from(sign(id)), given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
  };
  return {
    /** Reads a valid visitor id from the request, or issues a new one on the response. */
    resolve(req, res) {
      const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2),
      );
      const existing = verify(cookies[COOKIE]);
      if (existing) return { id: existing, isNew: false };
      const id = randomBytes(16).toString("base64url");
      res.setHeader(
        "Set-Cookie",
        `${COOKIE}=${id}.${sign(id)}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
      );
      return { id, isNew: true };
    },
    verify,
  };
}
