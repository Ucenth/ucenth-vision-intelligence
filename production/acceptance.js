/* Staging-only acceptance override for longer physical voice tests.
 *
 * The public policy is five Google-backed requests per rolling five hours. A physical
 * acceptance run (one scan plus five or more spoken turns, repeated on two phones)
 * needs more than that, so the staging service may raise the per-visitor limit for its
 * own visitors. The algorithm, the window, the refunds and the messages are unchanged;
 * only the numbers differ, and only when every one of these holds:
 *
 *   1. ACCEPTANCE_TEST_LIMIT is set to a whole number between 6 and 60;
 *   2. DIAGNOSTICS=1 is set (the staging marker that also injects the diagnostics panel);
 *   3. PUBLIC_ORIGIN is a Cloud Run default host (…-<project number>.<region>.run.app).
 *      The production origin is https://vision.ucenth.com, which can never match, so
 *      copying the staging environment onto the public service cannot activate this.
 *
 * Anything else is refused with a reason that the entry point logs at start-up, and the
 * service keeps the public numbers. /health reports the override while it is active.
 * This file lives in production/ and is therefore never part of the educational ZIP. */
import { LIMIT, SPEECH_LIMIT } from "./quota/policy.js";

export const ACCEPTANCE_MIN = 6;
export const ACCEPTANCE_MAX = 60;
export const CLOUD_RUN_HOST = /^[a-z0-9-]+-\d+\.[a-z0-9-]+\.run\.app$/;

/** Returns { limit, speechLimit } when the override may apply, { error } when it must not, null when unset. */
export function acceptanceOverride(env = process.env) {
  const raw = env.ACCEPTANCE_TEST_LIMIT;
  if (raw === undefined || raw === "") return null;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < ACCEPTANCE_MIN || limit > ACCEPTANCE_MAX)
    return { error: `ACCEPTANCE_TEST_LIMIT must be a whole number from ${ACCEPTANCE_MIN} to ${ACCEPTANCE_MAX}; ignored.` };
  if (env.DIAGNOSTICS !== "1") return { error: "ACCEPTANCE_TEST_LIMIT requires DIAGNOSTICS=1 (staging marker); ignored." };
  let host = "";
  try {
    host = new URL(env.PUBLIC_ORIGIN || "").hostname;
  } catch {}
  if (!CLOUD_RUN_HOST.test(host)) return { error: "ACCEPTANCE_TEST_LIMIT is only honoured on a Cloud Run default host (*.run.app); ignored." };
  // Speech keeps the same ratio to requests as the public policy.
  return { limit, speechLimit: Math.ceil((SPEECH_LIMIT / LIMIT) * limit) };
}
