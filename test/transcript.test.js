// Transcript assembly fixtures, including the exact Android Chrome event sequence from
// the physical diagnostics of 28 September 2026: every event opens a NEW result index
// whose text is the whole hypothesis so far, with exact repeats while still listening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscript, join, continues } from "../lib/transcript.js";

// Builds a SpeechRecognition-style event: finals/interims by index, from resultIndex on.
const event = (resultIndex, ...rows) => ({
  resultIndex,
  results: rows.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
});
// Android's shape: the list grows by one entry per event and the new entry is final.
function android(hypotheses) {
  const t = createTranscript(),
    list = [],
    outcomes = [];
  for (const h of hypotheses) {
    list.push([h, true]);
    outcomes.push(t.update(event(list.length - 1, ...list)));
  }
  return { t, outcomes };
}

test("Android physical pattern: empty placeholders, then a growing hypothesis at a new index each time, with repeats", () => {
  const { t, outcomes } = android(["", "", "", "", "w", "what i", "what is th", "what is this ho", "what is this ho", "what is this how mu", "what is this how mu", "what is this how much is it", "what is this how much is it sold in", "what is this how much is it sold in Nigeria", "what is this how much is it sold in Nigeria"]);
  assert.deepEqual(outcomes.slice(0, 4), ["empty", "empty", "empty", "empty"]);
  assert.equal(outcomes[4], "segment");
  assert.deepEqual(outcomes.slice(5), ["revision", "revision", "revision", "duplicate", "revision", "duplicate", "revision", "revision", "revision", "duplicate"]);
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
  assert.equal(t.live(), t.text());
});

test("Android second turn from the report: short phrase, repeats, then growth", () => {
  const { t } = android(["", "what", "what", "what", "what", "what", "what is thi", "what is this ma", "what is this made", "what is this made of", "what is this made of"]);
  assert.equal(t.text(), "what is this made of");
});

test("a revised earlier word in a later hypothesis replaces, it does not append", () => {
  const { t } = android(["what is", "what is this", "what's this how much", "what's this how much is it"]);
  assert.equal(t.text(), "what's this how much is it");
});

test("cumulative finals at ONE index (same-index revision) also collapse to a single question", () => {
  const t = createTranscript();
  const hypotheses = ["what is this", "what is this how much", "what is this how much is it sold", "what is this how much is it sold in Nigeria"];
  const outcomes = hypotheses.map((h) => t.update(event(0, [h, true])));
  assert.deepEqual(outcomes, ["segment", "revision", "revision", "revision"]);
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
});

test("genuine separate segments (desktop continuous mode) are appended in order without duplication", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this", true]));
  t.update(event(1, ["what is this", true], ["how much is it sold", true]));
  t.update(event(2, ["what is this", true], ["how much is it sold", true], ["in Nigeria", true]));
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
});

test("overlapping finals: a new segment that repeats the last words of the previous one is joined once", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this how much", true]));
  t.update(event(1, ["what is this how much", true], ["how much is it sold", true]));
  assert.equal(t.text(), "what is this how much is it sold");
});

test("duplicate final events change nothing, at the same index or a new one", () => {
  const t = createTranscript();
  assert.equal(t.update(event(0, ["what is this", true])), "segment");
  assert.equal(t.update(event(0, ["what is this", true])), "duplicate");
  assert.equal(t.update(event(1, ["what is this", true], ["what is this", true])), "duplicate");
  assert.equal(t.text(), "what is this");
});

test("a stale shorter hypothesis after a longer one is ignored", () => {
  const { t } = android(["what is this how much", "what is this"]);
  assert.equal(t.text(), "what is this how much");
});

test("words the person really repeated are kept: a one-word boundary overlap is not an overlap", () => {
  const t = createTranscript();
  t.update(event(0, ["it is very", true]));
  t.update(event(1, ["it is very", true], ["very expensive", true]));
  assert.equal(t.text(), "it is very very expensive");
  assert.equal(join("very", "very very expensive"), "very very very expensive");
  assert.equal(join("this is", "is it real"), "this is is it real", "single-word overlap kept as spoken");
  assert.equal(join("tell me the price", "the price in Lagos"), "tell me the price in Lagos", "two-word overlap dropped once");
  // Repeats inside one Android hypothesis survive the revision path too.
  const { t: r } = android(["it is", "it is very", "it is very very", "it is very very expensive"]);
  assert.equal(r.text(), "it is very very expensive");
});

test("continues(): growth, a growing last word, one revised word in a long phrase; not a different short phrase", () => {
  assert.equal(continues("w", "what"), true);
  assert.equal(continues("what i", "what is th"), true);
  assert.equal(continues("what is this how", "what's is this how much"), true);
  assert.equal(continues("how much", "how many is it"), false, "two-word phrases must match exactly");
  assert.equal(continues("what is this", "how much is it sold"), false);
  assert.equal(continues("what is this how much", "what is this"), false, "shorter is never a continuation");
});

test("interim text is a live view that revises in place and is never part of the final text", () => {
  const t = createTranscript();
  assert.equal(t.update(event(0, ["what", false])), "interim");
  assert.equal(t.update(event(0, ["what is", false])), "interim");
  assert.equal(t.live(), "what is");
  assert.equal(t.text(), "");
  assert.equal(t.hasFinal(), false);
  assert.equal(t.update(event(0, ["what is this", true])), "segment");
  assert.equal(t.update(event(1, ["what is this", true], ["how", false])), "interim");
  assert.equal(t.live(), "what is this how");
  assert.equal(t.text(), "what is this");
});

test("a recogniser that restarts its numbering starts a new generation instead of overwriting", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this", true]));
  t.update(event(1, ["what is this", true], ["how much", true]));
  // The list shrinks back to one entry: a fresh numbering for the next phrase.
  t.update(event(0, ["in Nigeria", true]));
  assert.equal(t.text(), "what is this how much in Nigeria");
});
