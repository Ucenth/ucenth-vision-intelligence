/* Hosted-site additions, injected only by the production server:
 *   - a compact allowance component in the masthead with a live countdown to the
 *     next credit (server-authoritative timestamps, animated locally)
 *   - the open-source section: source download card, How To feature, GitHub, license
 *     and an honest share control
 * The educational pages themselves are unchanged. */

// ---------------------------------------------------------------------------
// Allowance in the masthead.
// ---------------------------------------------------------------------------
const usage = document.createElement("a");
usage.className = "hosted-usage";
usage.href = "#hosted-source";
usage.setAttribute("aria-live", "polite");
usage.innerHTML = `<span class="hosted-usage-count"></span><span class="hosted-usage-detail"></span>`;
document.querySelector(".masthead .appearance-controls")?.before(usage);
const countEl = usage.querySelector(".hosted-usage-count"),
  detailEl = usage.querySelector(".hosted-usage-detail");

let quota = null,
  skew = 0;
const two = (n) => String(n).padStart(2, "0");
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
function spoken(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} hours ${m % 60} minutes` : `${m} minutes`;
}
function paint() {
  if (!quota) return;
  const now = Date.now() + skew;
  if (quota.paused) {
    countEl.textContent = "Paused";
    detailEl.textContent = "at public capacity";
    usage.setAttribute("aria-label", "UCENTH Vision Intelligence is temporarily at public capacity.");
    usage.dataset.state = "paused";
    return;
  }
  const remaining = quota.remaining,
    limit = quota.limit,
    next = quota.nextAt ? quota.nextAt - now : null;
  countEl.textContent = `${remaining} / ${limit}`;
  if (remaining === limit || next === null) {
    detailEl.textContent = "free requests";
    usage.setAttribute("aria-label", `${remaining} of ${limit} free requests available.`);
  } else {
    // Rolling window: one credit returns at a time, when its use expires.
    detailEl.textContent = `next in ${clock(next)}`;
    usage.setAttribute("aria-label", `${remaining} of ${limit} requests remaining. Next request available in ${spoken(next)}.`);
  }
  usage.dataset.state = remaining === 0 ? "exhausted" : "ok";
  if (next !== null && next <= 0) refresh();
}
async function refresh() {
  try {
    const r = await fetch("/api/quota", { cache: "no-store" });
    if (!r.ok) return;
    quota = await r.json();
    if (quota.serverTime) skew = quota.serverTime - Date.now();
    paint();
  } catch {}
}
refresh();
setInterval(paint, 1000);
setInterval(refresh, 5 * 60 * 1000);
// The allowance changes after every identification, document or answer.
document.addEventListener("ucenth:result-presented", () => setTimeout(refresh, 600));
document.addEventListener("ucenth:voice-state", (e) => {
  if (["VISION_SPEAKING", "FOLLOW_UP_UNAVAILABLE", "VOICE_UNAVAILABLE", "VOICE_OFF"].includes(e.detail.state)) setTimeout(refresh, 600);
});
document.addEventListener("ucenth:timing", (e) => {
  if (e.detail.name === "response-received") setTimeout(refresh, 300);
});

// ---------------------------------------------------------------------------
// Open source / education section, before the footer.
// ---------------------------------------------------------------------------
const section = document.createElement("section");
section.className = "hosted-source";
section.id = "hosted-source";
section.setAttribute("aria-labelledby", "hosted-source-title");
section.innerHTML = `
  <div class="hosted-source-intro">
    <p class="eyebrow">OPEN SOURCE / EDUCATION</p>
    <h2 id="hosted-source-title">Learn how it works.<br>Build your own.</h2>
    <p>UCENTH Vision Intelligence is an open-source learning project for developers exploring AI, browser APIs and multimodal applications. An open-source educational project by UCENTH — Universal Central Host.</p>
  </div>
  <div class="hosted-source-grid">
    <a class="hosted-card hosted-download" href="/download/ucenth-vision-intelligence-source.zip" download>
      <span class="hosted-card-label">SOURCE CODE</span>
      <span class="hosted-card-title">UCENTH Vision Intelligence</span>
      <dl class="hosted-card-meta">
        <div><dt>Edition</dt><dd class="hosted-meta-version">Source Edition</dd></div>
        <div><dt>Files</dt><dd class="hosted-meta-files">educational source files</dd></div>
        <div><dt>License</dt><dd>MIT License</dd></div>
        <div><dt>Size</dt><dd class="hosted-meta-size">ZIP</dd></div>
      </dl>
      <span class="hosted-card-action">Download Source Code <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3.5-3.5M8 10 4.5 6.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="hosted-card-status" role="status"></span>
    </a>
    <div class="hosted-card hosted-howto">
      <span class="hosted-card-label">HOW TO</span>
      <span class="hosted-card-title">Learn from the complete build</span>
      <p>Camera capture, Gemini integration, structured AI output, contextual person intelligence, PDF and Word processing, translation, hands-free voice, Web Audio and WebGL, explained with the real code.</p>
      <a class="hosted-link" href="/how-to.html">Explore the How To <span aria-hidden="true">→</span></a>
    </div>
  </div>
  <div class="hosted-source-footer">
    <a href="https://github.com/Ucenth/ucenth-vision-intelligence" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://github.com/Ucenth/ucenth-vision-intelligence/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
    <span class="hosted-share"><span>Help another developer discover it.</span><button type="button" id="hosted-share">Share Project</button><span class="hosted-share-status" role="status"></span></span>
  </div>`;
document.querySelector("footer.project-footer")?.before(section);
fetch("/api/source", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((meta) => {
    if (!meta) return;
    section.querySelector(".hosted-meta-version").textContent = `Source Edition · v${meta.version}`;
    section.querySelector(".hosted-meta-files").textContent = `${meta.files} educational source files`;
    section.querySelector(".hosted-meta-size").textContent = `ZIP · ${Math.round(meta.bytes / 1024)} KB`;
  })
  .catch(() => {});
section.querySelector(".hosted-download").addEventListener("click", () => {
  const status = section.querySelector(".hosted-card-status");
  status.textContent = "Downloading…";
  setTimeout(() => (status.textContent = ""), 4000);
});
// Honest share: acknowledge only a completed native share; a dismissed sheet says nothing.
document.getElementById("hosted-share")?.addEventListener("click", async () => {
  const status = section.querySelector(".hosted-share-status");
  const data = { title: "UCENTH Vision Intelligence", text: "Open-source visual intelligence you can run and learn from.", url: location.origin + "/" };
  try {
    if (navigator.share) {
      await navigator.share(data);
      status.textContent = "Shared. Thank you.";
    } else {
      await navigator.clipboard.writeText(data.url);
      status.textContent = "Link copied.";
    }
  } catch (error) {
    if (error?.name === "AbortError") return; // the person closed the share sheet
    status.textContent = data.url;
  }
  setTimeout(() => (status.textContent = ""), 5000);
});
