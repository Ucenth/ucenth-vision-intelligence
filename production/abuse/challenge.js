/* Challenge escalation. Ordinary visitors are never challenged. A source flagged by
 * network.js must present a challenge token with its next intelligence request.
 *
 * Cloudflare Turnstile is the intended provider: privacy-conscious, no CAPTCHA puzzles
 * for most people, free at this scale. It is OFF until TURNSTILE_SECRET (server) and
 * TURNSTILE_SITE_KEY (client widget) are configured, so the baseline deployment ships
 * without a third-party script. When enabled, the client widget's token travels in the
 * X-Challenge-Token header and is verified here before the request is accepted. While
 * disabled, flagged sources simply receive the capacity message until their counters
 * decay. See production/README.md for the enablement steps and CSP additions. */
export function createChallenge({ secret = process.env.TURNSTILE_SECRET, siteKey = process.env.TURNSTILE_SITE_KEY } = {}) {
  const enabled = !!(secret && siteKey);
  return {
    enabled,
    siteKey: enabled ? siteKey : null,
    async verify(token, remoteip) {
      if (!enabled || !token) return false;
      try {
        const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret, response: token, remoteip }),
          signal: AbortSignal.timeout(5000),
        });
        return r.ok && (await r.json()).success === true;
      } catch {
        return false;
      }
    },
  };
}
