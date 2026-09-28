/* Canonical transcript assembly for SpeechRecognition results.
 *
 * Browsers disagree about what a "final" result means. Desktop Chrome sends one final
 * per utterance. Android Chrome sends no interim text at all and instead re-emits the
 * SAME result index several times with a growing, revised hypothesis, each marked
 * final ("what is this", "what is this how much", "what is this how much is it sold
 * in Nigeria"), and sometimes opens a new index for a later phrase. Concatenating every
 * final string therefore repeats the question several times over. This module keeps
 * one canonical transcript keyed by result index, so:
 *
 *   - a revision at the same index REPLACES the earlier text (never appends);
 *   - the same index with the same text again is a DUPLICATE and changes nothing;
 *   - a new index is a NEW SEGMENT, appended after the earlier ones;
 *   - when a new segment begins with the whole earlier transcript it is a revision of
 *     it (some recognisers restart the index), and when it begins with the last two or
 *     more words of the earlier text that overlap is dropped once; a single repeated
 *     word ("very very expensive") is left exactly as spoken;
 *   - interim (non-final) text is kept separately as the live view and never sent.
 * The recogniser's index semantics decide; word matching is only the fallback for
 * segment boundaries. Pure functions: no DOM, so the fixtures below run in node. */
const MIN_OVERLAP_WORDS = 2;
const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/** Appends `next` to `base` once, dropping an overlap of two or more boundary words. */
export function join(base, next) {
  base = base.trim();
  next = next.trim();
  if (!base) return next;
  if (!next) return base;
  const a = words(base),
    b = words(next);
  // The new segment restates everything so far: it is a revision, not an addition.
  if (a.length >= MIN_OVERLAP_WORDS && b.length >= a.length && a.every((w, i) => w === b[i])) return next;
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
  const finals = new Map(); // index → final text
  const interims = new Map(); // index → interim text
  let generation = 0,
    seen = 0,
    lastFinalIndex = -1;
  const key = (i) => `${generation}:${String(i).padStart(4, "0")}`;
  const ordered = (map) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, t]) => t);
  const compose = (list) => list.reduce((acc, part) => join(acc, part), "");
  return {
    /** Returns what happened: "revision", "duplicate", "segment", "interim" or "empty". */
    update(event) {
      const results = event.results,
        length = results.length;
      // A shorter list than before means the recogniser restarted its numbering.
      if (length < seen) {
        generation++;
        lastFinalIndex = -1;
      }
      seen = length;
      let outcome = "empty";
      for (let i = event.resultIndex; i < length; i++) {
        const result = results[i],
          text = (result[0]?.transcript || "").trim();
        if (result.isFinal) {
          interims.delete(key(i));
          if (!text) continue;
          const previous = finals.get(key(i));
          if (previous === text) outcome = outcome === "empty" ? "duplicate" : outcome;
          else {
            finals.set(key(i), text);
            outcome = previous !== undefined || i <= lastFinalIndex ? "revision" : "segment";
            lastFinalIndex = Math.max(lastFinalIndex, i);
          }
        } else if (text) {
          interims.set(key(i), text);
          if (outcome === "empty") outcome = "interim";
        }
      }
      return outcome;
    },
    text() {
      return compose(ordered(finals));
    },
    live() {
      return compose([...ordered(finals), ...ordered(interims)]);
    },
    hasFinal() {
      return finals.size > 0;
    },
  };
}
