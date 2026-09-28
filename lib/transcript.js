/* Canonical transcript assembly for SpeechRecognition results.
 *
 * Browsers disagree about what a result index and a "final" flag mean, and the physical
 * diagnostics on Android Chrome (28 September 2026) showed this exact sequence for one
 * spoken question, with no interim text at all:
 *
 *   resultIndex 0  results 1  final ""            (empty placeholders first)
 *   resultIndex 4  results 5  final "w"
 *   resultIndex 5  results 6  final "what i"      (a NEW index, the WHOLE hypothesis so far)
 *   resultIndex 6  results 7  final "what is th"
 *   resultIndex 7  results 8  final "what is this ho"
 *   resultIndex 8  results 9  final "what is this ho"   (exact repeat: still listening)
 *   …                                                   (~90 events for one sentence)
 *   speechend → end                                     (the recogniser ends the turn)
 *
 * So on Android each new index REVISES the previous one rather than adding a phrase,
 * while desktop Chrome uses a new index for a genuinely new phrase. Concatenating
 * every final therefore repeats the question dozens of times. This module keeps one
 * canonical transcript as a list of CHAINS and classifies every final result:
 *
 *   - same index, changed text        → revision of that chain (replace);
 *   - same index or new index, same text as the latest chain → duplicate (ignore);
 *   - new index whose words continue or re-spell the latest chain's words (the last
 *     word may still be growing, one earlier word may have been revised) → revision;
 *   - new index that is only a shorter prefix of the latest chain → stale, ignored;
 *   - anything else → a genuine new segment, appended once; an overlap of two or more
 *     boundary words is dropped, a single repeated word ("very very expensive") is
 *     kept exactly as spoken;
 *   - interim (non-final) text is a live view that revises in place and is never sent.
 * Pure functions: no DOM, so the fixtures in test/transcript.test.js run in node. */
const MIN_OVERLAP_WORDS = 2;
const words = (text) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/** True when `next` continues or re-spells `previous`: the same words in the same order
 * (the last one possibly still growing), allowing one revised word once the phrase is
 * three or more words long. Short phrases must match exactly. */
export function continues(previous, next) {
  const p = words(previous),
    n = words(next);
  if (!p.length || n.length < p.length) return false;
  let matches = 0;
  for (let i = 0; i < p.length; i++) {
    const last = i === p.length - 1;
    if (n[i] === p[i] || (last && n[i].startsWith(p[i]))) matches++;
  }
  if (matches >= (p.length >= 3 ? p.length - 1 : p.length)) return true;
  // A revision can re-spell words so that positions shift ("what is" → "what's"). For
  // phrases of three or more words, compare the characters of the earlier hypothesis
  // with the same-length start of the new one; a close match is still a revision.
  if (p.length < 3) return false;
  const a = p.join(" "),
    b = n.join(" ").slice(0, a.length);
  return 1 - editDistance(a, b) / Math.max(a.length, b.length) >= 0.75;
}
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = temp;
    }
  }
  return row[b.length];
}
/** Appends `next` to `base` once, dropping an overlap of two or more boundary words. */
export function join(base, next) {
  base = base.trim();
  next = next.trim();
  if (!base) return next;
  if (!next) return base;
  const a = words(base),
    b = words(next);
  const max = Math.min(a.length, b.length);
  for (let n = max; n >= MIN_OVERLAP_WORDS; n--) {
    if (a.slice(a.length - n).every((w, i) => w === b[i])) {
      // Drop the first n words of `next` while keeping its original spelling and casing.
      const rest = next.split(/\s+/).slice(n).join(" ");
      return rest ? `${base} ${rest}` : base;
    }
  }
  return `${base} ${next}`;
}

/**
 * One transcript per listening session. Feed every SpeechRecognition result event;
 * read `text()` for the canonical final question and `live()` for what to show.
 */
export function createTranscript() {
  const chains = []; // ordered final phrases; each { text }
  const chainByIndex = new Map(); // "generation:index" → chain
  const interims = new Map(); // "generation:index" → interim text
  let generation = 0,
    seen = 0;
  const key = (i) => `${generation}:${String(i).padStart(4, "0")}`;
  const latest = () => chains[chains.length - 1];
  const compose = (list) => list.reduce((acc, part) => join(acc, part), "");
  const orderedInterims = () =>
    [...interims.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, t]) => t);
  function classify(i, text) {
    const k = key(i),
      own = chainByIndex.get(k);
    if (own) {
      if (own.text === text) return "duplicate";
      own.text = text;
      return "revision";
    }
    const last = latest();
    if (!last) {
      chains.push({ text });
      chainByIndex.set(k, latest());
      return "segment";
    }
    chainByIndex.set(k, last);
    if (last.text === text) return "duplicate";
    if (continues(last.text, text)) {
      last.text = text;
      return "revision";
    }
    if (continues(text, last.text)) return "duplicate"; // a stale, shorter hypothesis
    const chain = { text };
    chains.push(chain);
    chainByIndex.set(k, chain);
    return "segment";
  }
  return {
    /** Returns what happened: "revision", "duplicate", "segment", "interim" or "empty". */
    update(event) {
      const results = event.results,
        length = results.length;
      // A shorter list than before means the recogniser restarted its numbering.
      if (length < seen) generation++;
      seen = length;
      let outcome = "empty";
      for (let i = event.resultIndex; i < length; i++) {
        const result = results[i],
          text = (result[0]?.transcript || "").trim();
        if (result.isFinal) {
          interims.delete(key(i));
          if (!text) continue;
          const what = classify(i, text);
          outcome = outcome === "empty" || outcome === "duplicate" || outcome === "interim" ? what : outcome;
        } else if (text) {
          interims.set(key(i), text);
          if (outcome === "empty") outcome = "interim";
        }
      }
      return outcome;
    },
    text() {
      return compose(chains.map((c) => c.text));
    },
    live() {
      return compose([...chains.map((c) => c.text), ...orderedInterims()]);
    },
    hasFinal() {
      return chains.length > 0;
    },
  };
}
