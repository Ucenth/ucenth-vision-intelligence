/* Stability detection: decides when the object is held still enough to capture.
 *
 * This is deliberately not machine learning. Each frame is a 48×48 grayscale sample of
 * the center crop; comparing consecutive samples measures motion, comparing against the
 * empty-frame baseline tells us something was introduced. Simple arithmetic, runs on
 * any laptop at ten frames a second, and is easy to tune. */
/**
 * Mean absolute pixel difference between two samples, normalized to 0..1. The average
 * brightness offset is removed first so automatic exposure changes do not look like motion.
 */
export function difference(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let offset = 0;
  for (let i = 0; i < a.length; i++) offset += a[i] - b[i];
  offset /= a.length;
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta += Math.abs(a[i] - b[i] - offset);
  return delta / a.length / 255;
}
/**
 * State machine fed by update(frame, time):
 *   calibrating → waiting (frame empty) → moving / found → steady → locking (3·2·1) → capture
 *
 * The first 1.3 s record the empty baseline. "entered" means the frame differs from that
 * baseline; "motion" compares with the previous frame; "drift" compares with the frame
 * where the lock began, so slowly sliding the object away still cancels the countdown.
 * Thresholds allow hand tremor and sensor noise but not deliberate movement.
 */
export class StabilityTracker {
  constructor() {
    this.reset();
  }
  reset() {
    this.baseline = null;
    this.previous = null;
    this.anchor = null;
    this.stableSince = null;
    this.countdownAt = null;
    this.calibrateUntil = null;
  }
  update(frame, time) {
    if (this.calibrateUntil === null) this.calibrateUntil = time + 1300;
    if (time < this.calibrateUntil) {
      this.baseline = frame.slice();
      this.previous = frame.slice();
      return { state: "calibrating" };
    }
    // how-to:start stability-update
    const motion = difference(frame, this.previous);
    const entered = difference(frame, this.baseline) > 0.055;
    this.previous = frame.slice();
    const drift = this.anchor ? difference(frame, this.anchor) : 0;
    // Allow small hand tremor and sensor noise; substantial motion or sustained
    // displacement from the lock anchor still cancels the countdown.
    if (!entered || motion > 0.065 || drift > 0.11) {
      const cancelled = this.countdownAt !== null;
      this.stableSince = null;
      this.countdownAt = null;
      this.anchor = null;
      return { state: entered ? "moving" : "waiting", cancelled };
    }
    if (this.stableSince === null) {
      this.stableSince = time;
      this.anchor = frame.slice();
    }
    const elapsed = time - this.stableSince;
    if (elapsed < 400) return { state: "found" };
    if (elapsed < 1100) return { state: "steady" };
    if (this.countdownAt === null) this.countdownAt = time;
    const remaining = 3 - Math.floor((time - this.countdownAt) / 700);
    return remaining > 0
      ? { state: "locking", remaining }
      : { state: "capture" };
    // how-to:end stability-update
  }
}
