/* Viewport guidance for the single-column (phone) layout.
 *
 * On a phone the camera stage and the report stack vertically, so the thing the person
 * needs to see next is often below the fold: the live camera after they tap Open
 * Camera, and the identification with its conversation presence once a scan is done.
 * This module moves the viewport for exactly those two workflow transitions and
 * nothing else. It never scrolls for answers, state changes or quota updates.
 *
 * Rules, each of which has a test:
 *   - single-column layouts only, decided from the workspace's real grid, not the UA;
 *   - a transition is ARMED by the person's own action (Open Camera, a capture, an
 *     upload) and FULFILLED only when the destination genuinely exists (video playing,
 *     result rendered); a failed camera or analysis fulfils nothing;
 *   - a substantial manual scroll while the transition is pending cancels it, so
 *     nobody is dragged back seconds later;
 *   - a focused text field (on-screen keyboard) suppresses the move;
 *   - prefers-reduced-motion switches to instant positioning;
 *   - the header offset lives in CSS (scroll-margin-top with --guide-offset), and the
 *     offset is measured from any sticky or fixed header rather than typed in;
 *   - scrolling is visual only: focus is never moved.
 * Every decision is announced as "ucenth:viewport-guide" for diagnostics and tests. */
const USER_MOVE_PX = 80; // a deliberate scroll, not an address-bar nudge
const PENDING_TTL_MS = 120000; // an armed transition that never completes just expires

let pending = null; // { reason, at, scrollY }
let lastGesture = 0;

function announce(reason, outcome, extra = {}) {
  document.dispatchEvent(
    new CustomEvent("ucenth:viewport-guide", { detail: { reason, outcome, ...extra } }),
  );
}
/** Single column means the workspace grid has one track: the phone/narrow layout. */
export function isSingleColumn(workspace = document.querySelector(".workspace")) {
  if (!workspace) return false;
  const columns = getComputedStyle(workspace).gridTemplateColumns.trim();
  return columns === "none" || columns.split(/\s+/).length === 1;
}
/** Height of a sticky or fixed header touching the top edge, else 0. */
export function headerOffset() {
  let offset = 0;
  for (const el of document.querySelectorAll("header, .masthead, [data-sticky-header]")) {
    const style = getComputedStyle(el);
    if (!["sticky", "fixed"].includes(style.position)) continue;
    const box = el.getBoundingClientRect();
    if (box.top <= 0 && box.bottom > 0) offset = Math.max(offset, box.bottom);
  }
  return Math.round(offset);
}
function textFieldFocused() {
  const el = document.activeElement;
  return !!el && (el.matches("input:not([type=file]):not([type=button]):not([type=submit]), textarea") || el.isContentEditable);
}
function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
// Gestures mark the moment; the scroll event that follows decides whether the person
// moved far enough to take control. Programmatic smooth scrolling has no gesture.
function onGesture() {
  lastGesture = performance.now();
}
function onScroll() {
  if (!pending || performance.now() - lastGesture > 1000) return;
  if (Math.abs(window.scrollY - pending.scrollY) >= USER_MOVE_PX) {
    announce(pending.reason, "cancelled-user");
    pending = null;
  }
}
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("wheel", onGesture, { passive: true });
  window.addEventListener("touchmove", onGesture, { passive: true });
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) onGesture();
  });
  window.addEventListener("scroll", onScroll, { passive: true });
}
/** The person started a transition (Open Camera, capture, upload). */
export function armGuide(reason) {
  listen();
  pending = { reason, at: performance.now(), scrollY: window.scrollY };
  announce(reason, "armed");
}
/** The transition failed or was abandoned: forget it. */
export function cancelGuide(reason) {
  if (pending && (!reason || pending.reason === reason)) {
    announce(pending.reason, "cancelled");
    pending = null;
  }
}
const frames = (n) =>
  new Promise((resolve) => {
    const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
    step();
  });
/**
 * The destination now exists. Waits two frames for layout to settle, re-checks the
 * rules and moves the viewport once. Resolves to the outcome string.
 */
export async function guideTo(target, reason) {
  if (!pending || pending.reason !== reason || performance.now() - pending.at > PENDING_TTL_MS) {
    announce(reason, "not-armed");
    return "not-armed";
  }
  const armed = pending;
  pending = null;
  if (!target || !target.isConnected) return announce(reason, "no-target"), "no-target";
  if (!isSingleColumn()) return announce(reason, "skipped-desktop"), "skipped-desktop";
  await frames(2);
  if (textFieldFocused()) return announce(reason, "skipped-keyboard"), "skipped-keyboard";
  // The person may have moved during the two frames; the scroll handler already
  // cancelled if so, and it has cleared nothing here, so check once more.
  if (performance.now() - lastGesture < 1000 && Math.abs(window.scrollY - armed.scrollY) >= USER_MOVE_PX)
    return announce(reason, "cancelled-user"), "cancelled-user";
  const offset = headerOffset();
  document.documentElement.style.setProperty("--guide-offset", `${offset}px`);
  const behavior = reducedMotion() ? "auto" : "smooth";
  target.scrollIntoView({ behavior, block: "start" });
  announce(reason, "scrolled", { behavior, offset });
  return "scrolled";
}
/** Resolves when the video has real frames (or after a bounded wait). */
export function videoReady(video, timeoutMs = 4000) {
  if (video.readyState >= 2 && !video.paused) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadeddata", onPlaying);
      resolve(ok);
    };
    const onPlaying = () => done(true);
    const timer = setTimeout(() => done(video.readyState >= 2), timeoutMs);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadeddata", onPlaying);
  });
}
