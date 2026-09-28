/* Hosted-site additions, injected only by the production server:
 *   - a restrained allowance line ("3 of 5 free requests remaining")
 *   - the open-source section with Download Source Code, How To and GitHub
 *   - an honest share call to action
 * The educational pages themselves are unchanged. */
const quotaLine = document.createElement("p");
quotaLine.className = "hosted-quota";
quotaLine.setAttribute("role", "status");
document.querySelector(".actions")?.after(quotaLine);

function formatWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
let quota = null;
function paint() {
  if (!quota) return;
  if (quota.paused) quotaLine.textContent = "UCENTH Vision Intelligence is temporarily at public capacity. Please try again later.";
  else if (quota.remaining === 0 && quota.resetAt)
    quotaLine.textContent = `Free usage limit reached · Available again in ${formatWait(quota.resetAt - Date.now())}`;
  else quotaLine.textContent = `${quota.remaining} of ${quota.limit} free requests remaining · ${quota.windowHours}-hour allowance`;
}
async function refresh() {
  try {
    const r = await fetch("/api/quota", { cache: "no-store" });
    if (r.ok) { quota = await r.json(); paint(); }
  } catch {}
}
refresh();
setInterval(paint, 60000);
// The allowance changes after every identification, document or answer.
document.addEventListener("ucenth:result-presented", () => setTimeout(refresh, 800));
document.addEventListener("ucenth:voice-state", (e) => { if (["VISION_SPEAKING", "FOLLOW_UP_UNAVAILABLE", "VOICE_UNAVAILABLE"].includes(e.detail.state)) setTimeout(refresh, 800); });

// Open-source section, before the footer.
const section = document.createElement("section");
section.className = "hosted-source";
section.setAttribute("aria-labelledby", "hosted-source-title");
section.innerHTML = `
  <p class="eyebrow">OPEN SOURCE</p>
  <h2 id="hosted-source-title">Learn how it works. Build your own.</h2>
  <p>UCENTH Vision Intelligence is open source and built as a learning project for developers exploring AI, browser APIs and multimodal applications. An open-source educational project by UCENTH — Universal Central Host, released under the MIT License.</p>
  <div class="hosted-actions">
    <a class="hosted-button primary" href="/download/ucenth-vision-intelligence-source.zip">Download Source Code</a>
    <a class="hosted-button" href="/how-to.html">How To guide</a>
    <a class="hosted-button" href="https://github.com/Ucenth/ucenth-vision-intelligence" target="_blank" rel="noopener noreferrer">View on GitHub</a>
    <a class="hosted-button" href="https://github.com/Ucenth/ucenth-vision-intelligence/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
  </div>
  <p class="hosted-share-copy">Enjoyed the project? Share the video so another developer can discover it.</p>
  <div class="hosted-actions">
    <button class="hosted-button" type="button" id="hosted-share">Share</button>
    <a class="hosted-button" href="/download/ucenth-vision-intelligence-source.zip">Download Source Code</a>
  </div>
  <p class="hosted-share-status" role="status"></p>`;
document.querySelector("footer.project-footer")?.before(section);
document.getElementById("hosted-share")?.addEventListener("click", async () => {
  const status = section.querySelector(".hosted-share-status");
  const data = { title: "UCENTH Vision Intelligence", text: "Open-source visual intelligence you can run and learn from.", url: location.origin + "/" };
  try {
    if (navigator.share) { await navigator.share(data); status.textContent = "Thanks for sharing."; return; }
    await navigator.clipboard.writeText(data.url);
    status.textContent = "Link copied. Paste it wherever you share.";
  } catch {
    status.textContent = data.url;
  }
});
