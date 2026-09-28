/* Staging-only diagnostics panel for mobile voice and latency investigation.
 * Injected by the production server only when DIAGNOSTICS=1. It reports capability
 * facts, microphone/track states, recognition events, timing marks and particle
 * metrics that voice.js, script.js and the renderer already emit as DOM events.
 * It never has access to audio samples or images. Open with ?diag=1 or the DIAG
 * button; Copy report puts a plain-text summary on the clipboard for support. */
const open = new URLSearchParams(location.search).has("diag");
const panel = document.createElement("section");
panel.className = "diag-panel";
panel.hidden = !open;
panel.setAttribute("aria-label", "Voice diagnostics");
panel.innerHTML = `<style>
.diag-toggle{position:fixed;right:12px;bottom:12px;z-index:60;font:11px/1 ui-monospace,monospace;letter-spacing:1px;padding:8px 10px;border:1px solid #649bff;background:#101112;color:#649bff;cursor:pointer}
.diag-panel{position:fixed;left:8px;right:8px;bottom:48px;max-height:55vh;z-index:59;overflow:auto;background:#0c0d0f;color:#d8dde3;border:1px solid #303235;font:11px/1.5 ui-monospace,monospace;padding:10px 12px}
.diag-panel h4{margin:8px 0 4px;font-size:11px;color:#8bb3ff;letter-spacing:1px}
.diag-panel pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.diag-panel button{font:inherit;padding:6px 10px;border:1px solid #303235;background:transparent;color:#d8dde3;cursor:pointer;margin:0 6px 6px 0}
</style>
<div><button type="button" data-copy>Copy report</button><button type="button" data-clear>Clear</button><button type="button" data-close>Close</button></div>
<h4>DEVICE</h4><pre data-caps>waiting for a conversation…</pre>
<h4>TIMELINE (ms since page load)</h4><pre data-timing></pre>
<h4>VOICE EVENTS</h4><pre data-events></pre>
<h4>PARTICLES</h4><pre data-particles></pre>`;
const toggle = document.createElement("button");
toggle.type = "button";
toggle.className = "diag-toggle";
toggle.textContent = "DIAG";
toggle.onclick = () => (panel.hidden = !panel.hidden);
document.body.append(toggle, panel);
const caps = panel.querySelector("[data-caps]"),
  timing = panel.querySelector("[data-timing]"),
  events = panel.querySelector("[data-events]"),
  particles = panel.querySelector("[data-particles]");
const lines = { timing: [], events: [] };
// The first events (path choice, a recogniser error, the fallback) matter as much as
// the latest ones, so the buffer keeps the first 40 lines and the most recent 120.
const push = (target, list, line) => {
  list.push(line);
  if (list.length > 160) list.splice(40, 1);
  target.textContent = list.join("\n");
  target.scrollTop = target.scrollHeight;
};
let lastTiming = null;
document.addEventListener("ucenth:voice-diag", (e) => {
  const { t, event, ...data } = e.detail;
  if (event === "capabilities") {
    caps.textContent = Object.entries(data).map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v}`).join("\n");
    return;
  }
  push(events, lines.events, `${String(t).padStart(6)}  ${event}${Object.keys(data).length ? "  " + JSON.stringify(data) : ""}`);
});
document.addEventListener("ucenth:timing", (e) => {
  const { t, name, ...data } = e.detail;
  const delta = lastTiming === null ? "" : `  (+${t - lastTiming} ms)`;
  lastTiming = t;
  push(timing, lines.timing, `${String(t).padStart(6)}  ${name}${Object.keys(data).length ? "  " + JSON.stringify(data) : ""}${delta}`);
});
document.addEventListener("ucenth:particles-metrics", (e) => {
  const m = e.detail;
  particles.textContent = `${m.renderer} ${m.quality} ${m.particles} particles · ${m.fps?.toFixed(0)} fps · cpu p95 ${m.cpuP95?.toFixed(1)} ms · gpu p95 ${m.gpuP95?.toFixed(1)} ms · source ${m.source} · peak rms ${m.maxRms?.toFixed(3)}`;
});
document.addEventListener("ucenth:voice-state", (e) => push(events, lines.events, `${String(Math.round(performance.now())).padStart(6)}  state → ${e.detail.state}`));
navigator.permissions?.query?.({ name: "microphone" }).then((p) => push(events, lines.events, `     0  microphone permission: ${p.state}`)).catch(() => {});
panel.querySelector("[data-copy]").onclick = async () => {
  const report = `UCENTH Vision Intelligence diagnostics\n${new Date().toISOString()}\n${location.href}\n\nDEVICE\n${caps.textContent}\n\nTIMELINE\n${timing.textContent}\n\nVOICE EVENTS\n${events.textContent}\n\nPARTICLES\n${particles.textContent}\n`;
  try {
    await navigator.clipboard.writeText(report);
    panel.querySelector("[data-copy]").textContent = "Copied";
  } catch {
    const ta = document.createElement("textarea");
    ta.value = report;
    panel.append(ta);
    ta.select();
  }
};
panel.querySelector("[data-clear]").onclick = () => {
  lines.timing.length = lines.events.length = 0;
  timing.textContent = events.textContent = "";
};
panel.querySelector("[data-close]").onclick = () => (panel.hidden = true);
