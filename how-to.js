/* How To page behaviour: copy buttons, section search and scroll-spy.
 *
 * Plain JavaScript, no framework. The page also works when opened directly from a
 * downloaded ZIP (file://), where some browsers disable the Clipboard API, so copying
 * falls back to selecting the text for a manual Ctrl/Cmd+C. */

// ---------------------------------------------------------------------------
// Copy buttons: one per .command block.
// ---------------------------------------------------------------------------
for (const block of document.querySelectorAll(".command")) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.className = "copy";
  button.setAttribute("aria-label", "Copy code");
  button.addEventListener("click", async () => {
    const code = block.querySelector("code");
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied";
    } catch {
      // Fallback for file:// and restricted contexts: select the code so the user
      // can copy it with the keyboard.
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected — press Ctrl/Cmd+C";
    }
    document.getElementById("copy-status").textContent = button.textContent;
    setTimeout(() => {
      button.textContent = "Copy";
    }, 2500);
  });
  block.append(button);
}

// ---------------------------------------------------------------------------
// Section search: filters sections and their contents links by plain text.
// Nothing is indexed ahead of time; the page is small enough to scan on each
// keystroke, which keeps the implementation honest and dependency-free.
// ---------------------------------------------------------------------------
const search = document.getElementById("search");
const status = document.getElementById("search-status");
const sections = [...document.querySelectorAll(".guide section")];
const links = new Map(
  [...document.querySelectorAll(".contents a[href^='#']")].map((a) => [
    a.getAttribute("href").slice(1),
    a,
  ]),
);
const groups = [...document.querySelectorAll(".contents h2")];
function filter() {
  const query = search.value.trim().toLowerCase();
  let shown = 0;
  for (const section of sections) {
    const match = !query || section.textContent.toLowerCase().includes(query);
    section.hidden = !match;
    const link = links.get(section.id);
    if (link) link.hidden = !match;
    if (match) shown++;
  }
  // Hide a group heading when none of its links remain visible.
  for (const heading of groups) {
    let node = heading.nextElementSibling,
      visible = false;
    while (node && node.tagName === "A") {
      if (!node.hidden) visible = true;
      node = node.nextElementSibling;
    }
    heading.hidden = !visible;
  }
  status.textContent = query
    ? `${shown} of ${sections.length} sections match “${search.value.trim()}”.`
    : "";
}
search?.addEventListener("input", filter);

// ---------------------------------------------------------------------------
// Scroll-spy: highlight the contents link of the section currently in view.
// IntersectionObserver reports visibility changes without scroll-event polling.
// ---------------------------------------------------------------------------
if ("IntersectionObserver" in window) {
  let active = null;
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      const link = links.get(visible.target.id);
      if (!link || link === active) return;
      active?.classList.remove("active");
      active?.removeAttribute("aria-current");
      link.classList.add("active");
      link.setAttribute("aria-current", "true");
      active = link;
    },
    { rootMargin: "-10% 0px -70% 0px" },
  );
  for (const section of sections) observer.observe(section);
}
