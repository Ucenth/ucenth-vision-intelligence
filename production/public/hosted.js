/* Hosted-site additions, injected only by the production server:
 *   - the allowance in the main header: "3 / 5 requests" with a live countdown to the
 *     next credit ("Next available in 02:41:18"), from server-authoritative timestamps
 *     of the rolling window, animated locally with clock-skew correction
 *   - the Open Source / Education section: the Source Edition card with the download,
 *     the How To feature, and restrained GitHub, license and share actions
 * The educational pages themselves are unchanged. */

// ---------------------------------------------------------------------------
// Allowance in the header.
// ---------------------------------------------------------------------------
const usage = document.createElement("a");
usage.className = "hosted-usage";
usage.href = "#hosted-source";
usage.setAttribute("aria-live", "polite");
// Two renderings of the same detail: the full sentence, and a short clock for phones
// (CSS shows one or the other by width; the aria-label always carries the sentence).
usage.innerHTML = `<span class="hosted-usage-count"></span><span class="hosted-usage-detail"></span><span class="hosted-usage-short" aria-hidden="true"></span>`;
document.querySelector(".masthead .appearance-controls")?.before(usage);
const countEl = usage.querySelector(".hosted-usage-count"),
  detailEl = usage.querySelector(".hosted-usage-detail"),
  shortEl = usage.querySelector(".hosted-usage-short");

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
    detailEl.textContent = "At public capacity";
    shortEl.textContent = "paused";
    usage.setAttribute("aria-label", "UCENTH Vision Intelligence is temporarily at public capacity.");
    usage.dataset.state = "paused";
    return;
  }
  const remaining = quota.remaining,
    limit = quota.limit,
    next = quota.nextAt ? quota.nextAt - now : null;
  countEl.textContent = `${remaining} / ${limit}`;
  countEl.append(Object.assign(document.createElement("span"), { className: "hosted-usage-unit", textContent: " requests" }));
  if (remaining === limit || next === null) {
    detailEl.textContent = "Free · rolling 5 hours";
    shortEl.textContent = "free";
    usage.setAttribute("aria-label", `${remaining} of ${limit} free requests available.`);
  } else {
    // Rolling window: one credit returns at a time, when its own use expires.
    detailEl.textContent = `Next available in ${clock(next)}`;
    shortEl.textContent = `in ${clock(next)}`;
    usage.setAttribute("aria-label", `${remaining} of ${limit} requests remaining. Next request available in ${spoken(next)}.`);
  }
  usage.dataset.state = remaining === 0 ? "exhausted" : "ok";
  // The limit notification shows the same authoritative countdown as the header.
  if (limitDialog.open) limitClock.textContent = next === null ? "00:00:00" : clock(next);
  if (next !== null && next <= 0) refresh();
}
async function refresh() {
  try {
    const r = await fetch("/api/quota", { cache: "no-store" });
    if (!r.ok) return;
    const previous = quota;
    quota = await r.json();
    if (quota.serverTime) skew = quota.serverTime - Date.now();
    paint();
    // Exactly the moment a successful request takes the last credit: the header went
    // from one remaining to none. A page that loads already exhausted says nothing
    // here (the header carries it), and a closed notification stays closed until a
    // genuinely new exhaustion happens.
    if (previous && previous.remaining > 0 && quota.remaining === 0 && !quota.paused) openLimit();
  } catch {}
}

// ---------------------------------------------------------------------------
// Free-limit notification: a native dialog, opened once per exhaustion event.
// ---------------------------------------------------------------------------
const limitDialog = document.createElement("dialog");
limitDialog.className = "hosted-limit";
limitDialog.setAttribute("aria-labelledby", "hosted-limit-title");
limitDialog.setAttribute("aria-describedby", "hosted-limit-text");
limitDialog.innerHTML = `
  <form method="dialog" class="hosted-limit-body">
    <p class="eyebrow" id="hosted-limit-title">FREE LIMIT REACHED</p>
    <p class="hosted-limit-text" id="hosted-limit-text">You've used your <span class="hosted-limit-count"></span> free requests.</p>
    <p class="hosted-limit-clock" aria-live="off"><time class="hosted-limit-time">00:00:00</time><span>until your next request becomes available</span></p>
    <p class="hosted-limit-note">In the meantime, you can explore the <a href="/how-to.html">How To guide</a> or <a href="/download/ucenth-vision-intelligence-source.zip" download>download the source code</a>.</p>
    <button type="submit" class="hosted-limit-close" autofocus>Got it</button>
  </form>`;
document.body.append(limitDialog);
const limitClock = limitDialog.querySelector(".hosted-limit-time");
function openLimit() {
  if (limitDialog.open || typeof limitDialog.showModal !== "function") return;
  limitDialog.querySelector(".hosted-limit-count").textContent = String(quota.limit);
  paint(); // sets the clock before the first frame is shown
  limitDialog.showModal();
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
// Open Source / Education section, before the footer.
// ---------------------------------------------------------------------------
const section = document.createElement("section");
section.className = "hosted-source";
section.id = "hosted-source";
section.setAttribute("aria-labelledby", "hosted-source-title");
section.innerHTML = `
  <div class="hosted-source-head">
    <p class="eyebrow">OPEN SOURCE / EDUCATION</p>
    <h2 id="hosted-source-title">Learn how it works.<br>Build your own.</h2>
    <p class="hosted-source-lede">Everything on this page is open source: the camera pipeline, the structured Gemini identification, the document reader, the hands-free conversation with Charon, and the audio-reactive presence. The source is written to be read, with the reasoning next to the code, so a developer can run it locally in minutes and change any part of it.</p>
  </div>
  <div class="hosted-source-body">
    <article class="hosted-edition" aria-labelledby="hosted-edition-title">
      <p class="hosted-edition-label">SOURCE EDITION</p>
      <h3 id="hosted-edition-title">UCENTH Vision Intelligence</h3>
      <dl class="hosted-edition-meta">
        <div><dt>Version</dt><dd class="hosted-meta-version">Source Edition</dd></div>
        <div><dt>License</dt><dd>MIT License</dd></div>
        <div><dt>Contents</dt><dd class="hosted-meta-files">educational source files</dd></div>
        <div><dt>Archive</dt><dd class="hosted-meta-size">ZIP</dd></div>
      </dl>
      <a class="hosted-download" href="/download/ucenth-vision-intelligence-source.zip" download>
        <span>Download Source Code</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0 3.5-3.5M8 10 4.5 6.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
      <p class="hosted-edition-note">Runs on your own machine with your own Google Cloud project. No account, no key in the browser, nothing sent anywhere but Google's APIs from your server.</p>
      <span class="hosted-card-status" role="status"></span>
    </article>
    <aside class="hosted-howto" aria-labelledby="hosted-howto-title">
      <p class="hosted-edition-label">HOW TO</p>
      <h3 id="hosted-howto-title">Thirty lessons, taken from the real code.</h3>
      <ul class="hosted-howto-list">
        <li>Camera capture, stability detection and the countdown</li>
        <li>Structured identification with Gemini, and why the schema is strict</li>
        <li>Contextual person intelligence without face recognition</li>
        <li>PDF and Word reading, page transcription and translation</li>
        <li>Hands-free conversation: recognition, Charon and the state machine</li>
        <li>Web Audio analysis and the WebGL particle presence</li>
      </ul>
      <a class="hosted-link" href="/how-to.html">Open the How To <span aria-hidden="true">→</span></a>
    </aside>
  </div>
  <div class="hosted-source-footer">
    <a href="https://github.com/Ucenth/ucenth-vision-intelligence" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://github.com/Ucenth/ucenth-vision-intelligence/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
    <span class="hosted-share"><button type="button" id="hosted-share">Share Project</button><span class="hosted-share-status" role="status"></span></span>
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
