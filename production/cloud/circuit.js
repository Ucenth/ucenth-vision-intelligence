/* Global circuit breaker: pause every new intelligence request without a code deploy.
 *
 * Two switches, either one pauses:
 *   1. Environment variable INTELLIGENCE_PAUSED=1 on the Cloud Run service
 *      (gcloud run services update … --update-env-vars INTELLIGENCE_PAUSED=1 creates a
 *      new revision in seconds, no build).
 *   2. A Firestore document control/circuit with { paused: true }, editable in the
 *      console and picked up by every instance within CACHE_MS. This one needs no
 *      revision at all.
 * Static pages, the How To guide, the source download and health stay available. */
const CACHE_MS = 30 * 1000;
export function createCircuit({ store, env = process.env } = {}) {
  let cached = { paused: false, at: 0 };
  return {
    async paused(now = Date.now()) {
      if (env.INTELLIGENCE_PAUSED === "1" || env.INTELLIGENCE_PAUSED === "true") return true;
      if (!store) return false;
      if (now - cached.at < CACHE_MS) return cached.paused;
      try {
        const doc = await store.get("control:circuit");
        cached = { paused: doc?.paused === true, at: now };
      } catch {
        cached = { paused: cached.paused, at: now }; // keep the last known state on store errors
      }
      return cached.paused;
    },
  };
}
