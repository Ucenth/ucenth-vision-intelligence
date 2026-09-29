/* The living UCENTH globe in the header: a small dotted world on a shaded sphere,
 * turning once every 16 seconds.
 *
 * Built to cost almost nothing next to the camera, particles and audio work:
 *   - Canvas 2D on a 32 px canvas (64 px at 2x), no WebGL context, no library;
 *   - about 250 land dots per frame as tiny filled squares, at 15 frames per second
 *     (a slow rotation needs no more; the difference from 60 is invisible here);
 *   - nothing drawn while the page is hidden or the header is scrolled away;
 *   - one static, fully lit frame when the person prefers reduced motion;
 *   - the cheapest calls only (arc + fill), no shadow blur, no per-frame gradients.
 * The land map is a 10° grid (18 rows × 36 columns, one character per cell), coarse
 * on purpose: at 32 px only the continents' silhouettes can read. The palette follows
 * the theme so the globe sits on the page with no box around it. */

// 18 rows from +85° to −85° latitude, 36 columns from −175° to +175° longitude.
// "#" is land. The polar caps (±85°) stay empty: sea ice and the pole itself would only
// draw as dense rings once the meridians converge.
const LAND = [
  "....................................",
  ".##########.###....#################",
  ".#########...##...##################",
  "...########.....######.######.##....",
  "....#######.....######.#######......",
  "....######......##################..",
  ".....####.......##########..###.....",
  ".......###.#.....#########...#......",
  "..........####...#####.....######...",
  "..........#####...#####....#####....",
  "...........####....####.#...#####...",
  "...........###....###......####.....",
  "...........##..............###...#..",
  "...........##....................#..",
  "....................................",
  "....................................",
  "####################################",
  "....................................",
];
const ROTATION_MS = 16000; // one relaxed turn
const FRAME_MS = 66; // 15 frames per second: a 16-second turn moves 1.5° per frame
const TILT = (23 * Math.PI) / 180; // the familiar axial tilt, for depth
const ORBIT_MS = 9000; // one lap of the data pulse
// Points on the unit sphere for every land cell, computed once.
const POINTS = [];
LAND.forEach((row, r) => {
  const lat = ((85 - r * 10) * Math.PI) / 180;
  // Meridians converge toward the poles, so high-latitude rows keep only every
  // second or third column; otherwise the caps draw as dense rings.
  const step = Math.max(1, Math.round(1 / Math.max(0.25, Math.cos(lat))));
  for (let c = 0; c < 36; c++)
    if (row[c] === "#" && c % step === 0) {
      const lon = ((-175 + c * 10) * Math.PI) / 180;
      POINTS.push({ y: Math.sin(lat), ring: Math.cos(lat), lon });
    }
});

/** Theme palette read from the page tokens, so light and dark both look intended. */
function palette() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { ocean: "rgba(23, 34, 48, 0.08)", grid: "rgba(23, 34, 48, 0.10)", land: "31, 95, 214", rim: "rgba(74, 140, 255, 0.55)", pulse: "rgba(31, 95, 214, 0.9)" }
    : { ocean: "rgba(8, 14, 26, 0.92)", grid: "rgba(139, 179, 255, 0.10)", land: "170, 205, 255", rim: "rgba(139, 179, 255, 0.55)", pulse: "rgba(207, 230, 255, 0.95)" };
}

export function mountGlobe(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = canvas.clientWidth || 32;
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  const S = canvas.width, cx = S / 2, cy = S / 2, R = S * 0.46;
  const dot = Math.max(0.6, S * 0.022);
  let colors = palette(), visible = !document.hidden, onScreen = true, last = 0, frames = 0, drawMs = 0;
  // Dots are drawn in eight brightness buckets so the browser parses eight colours per
  // frame instead of one per dot; that is most of a Canvas 2D frame at this size.
  const LEVELS = 8;
  let shades = [];
  const buckets = Array.from({ length: LEVELS }, () => []);
  const reshade = () => (shades = Array.from({ length: LEVELS }, (_, i) => `rgba(${colors.land}, ${((i + 1) / LEVELS).toFixed(3)})`));
  reshade();

  function draw(now) {
    const angle = reduced ? 0.6 : ((now % ROTATION_MS) / ROTATION_MS) * Math.PI * 2;
    const sinT = Math.sin(TILT), cosT = Math.cos(TILT);
    ctx.clearRect(0, 0, S, S);
    // Sphere body and a faint equator to suggest the curve.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = colors.ocean;
    ctx.fill();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = Math.max(0.5, S * 0.012);
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * Math.abs(sinT), 0, 0, Math.PI * 2);
    ctx.stroke();
    // Land dots: rotate about the tilted axis, keep the front hemisphere, light from the
    // upper left and fade toward the limb so the ball reads as round.
    for (const b of buckets) b.length = 0;
    for (const p of POINTS) {
      const lon = p.lon + angle;
      let x = p.ring * Math.sin(lon), z = p.ring * Math.cos(lon), y = p.y;
      const y2 = y * cosT - z * sinT, z2 = y * sinT + z * cosT; // tilt
      if (z2 <= 0.02) continue;
      const light = 0.45 + 0.55 * Math.max(0, -x * 0.5 + y2 * 0.4 + z2 * 0.75);
      const alpha = Math.min(1, z2 * 1.3) * light;
      // A square of one or two device pixels is indistinguishable from a disc at this
      // size and costs a fraction of an arc.
      const d = dot * 2 * (0.7 + 0.3 * z2);
      buckets[Math.min(LEVELS - 1, Math.max(0, Math.round(alpha * LEVELS) - 1))].push(cx + x * R - d / 2, cy - y2 * R - d / 2, d);
    }
    for (let i = 0; i < LEVELS; i++) {
      const b = buckets[i];
      if (!b.length) continue;
      ctx.fillStyle = shades[i];
      for (let j = 0; j < b.length; j += 3) ctx.fillRect(b[j], b[j + 1], b[j + 2], b[j + 2]);
    }
    // Rim: a thin luminous edge, brighter on the lit side.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = colors.rim;
    ctx.lineWidth = Math.max(0.8, S * 0.02);
    ctx.stroke();
    // One orbital path with an occasional pulse travelling along it.
    if (!reduced) {
      const t = (now % ORBIT_MS) / ORBIT_MS;
      const a = t * Math.PI * 2;
      const ox = cx + Math.cos(a) * R * 1.02, oy = cy + Math.sin(a) * R * 0.32 * -1 - R * 0.05;
      // Visible only on the near half of the orbit, easing in and out.
      const near = Math.sin(a) < 0 ? 0 : Math.sin(a);
      if (near > 0.05) {
        ctx.fillStyle = colors.pulse.replace(/[\d.]+\)$/, `${(near * 0.9).toFixed(2)})`);
        ctx.beginPath();
        ctx.arc(ox, oy, dot * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  function frame(now) {
    if (!visible || !onScreen) return;
    if (now - last >= FRAME_MS) {
      const t0 = performance.now();
      draw(now);
      drawMs += performance.now() - t0;
      frames++;
      last = now;
      canvas.dataset.frames = frames; // for tests: proves drawing stops while hidden
      if (frames % 20 === 0) canvas.dataset.frameMs = (drawMs / frames).toFixed(3); // average cost per frame
    }
    requestAnimationFrame(frame);
  }
  const start = () => {
    if (reduced) return draw(0);
    requestAnimationFrame(frame);
  };
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    if (visible) start();
  });
  if ("IntersectionObserver" in window)
    new IntersectionObserver((entries) => {
      const was = onScreen;
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen && !was) start();
    }).observe(canvas);
  // Theme changes re-read the palette (appearance.js flips data-theme).
  new MutationObserver(() => {
    colors = palette();
    reshade();
    if (reduced) draw(0);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  start();
  return { redraw: () => draw(performance.now()) };
}

for (const canvas of document.querySelectorAll("canvas.brand-globe")) mountGlobe(canvas);
