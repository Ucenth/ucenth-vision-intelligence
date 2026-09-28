// Transcript assembly fixtures, including the exact Android Chrome pattern seen in the
// physical diagnostics: the same result index re-emitted as a growing final hypothesis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscript, join } from "../lib/transcript.js";

// Builds a SpeechRecognition-style event: finals/interims by index, from resultIndex on.
const event = (resultIndex, ...rows) => ({
  resultIndex,
  results: rows.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
});

test("Android cumulative finals at one index: revisions replace, the question is sent once", () => {
  const t = createTranscript();
  const hypotheses = ["what is this", "what is this how much", "what is this how much is it sold", "what is this how much is it sold in Nigeria"];
  const outcomes = hypotheses.map((h) => t.update(event(0, [h, true])));
  assert.deepEqual(outcomes, ["segment", "revision", "revision", "revision"]);
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
  assert.equal(t.live(), t.text());
});

test("Android pattern from the physical report: empty finals first, then a growing hypothesis, then a new index", () => {
  const t = createTranscript();
  assert.equal(t.update(event(0, ["", true])), "empty");
  assert.equal(t.update(event(0, ["", true])), "empty");
  assert.equal(t.update(event(0, ["what is", true])), "segment");
  assert.equal(t.update(event(0, ["what is this", true])), "revision");
  assert.equal(t.update(event(1, ["what is this", true], ["how much is it", true])), "segment");
  assert.equal(t.update(event(1, ["what is this", true], ["how much is it sold in Nigeria", true])), "revision");
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
});

test("overlapping finals: a new segment that repeats the last words of the previous one is joined once", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this how much", true]));
  t.update(event(1, ["what is this how much", true], ["how much is it sold", true]));
  t.update(event(2, ["what is this how much", true], ["how much is it sold", true], ["in Nigeria", true]));
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
});

test("genuine separate segments are appended in index order without duplication", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this", true]));
  t.update(event(1, ["what is this", true], ["how much is it sold", true]));
  t.update(event(2, ["what is this", true], ["how much is it sold", true], ["in Nigeria", true]));
  assert.equal(t.text(), "what is this how much is it sold in Nigeria");
});

test("duplicate final events change nothing", () => {
  const t = createTranscript();
  assert.equal(t.update(event(0, ["what is this", true])), "segment");
  assert.equal(t.update(event(0, ["what is this", true])), "duplicate");
  assert.equal(t.update(event(0, ["what is this", true])), "duplicate");
  assert.equal(t.text(), "what is this");
});

test("words the person really repeated are kept: a one-word boundary overlap is not an overlap", () => {
  const t = createTranscript();
  t.update(event(0, ["it is very", true]));
  t.update(event(1, ["it is very", true], ["very expensive", true]));
  assert.equal(t.text(), "it is very very expensive");
  assert.equal(join("very", "very very expensive"), "very very very expensive");
  assert.equal(join("this is", "is it real"), "this is is it real", "single-word overlap kept as spoken");
  assert.equal(join("tell me the price", "the price in Lagos"), "tell me the price in Lagos", "two-word overlap dropped once");
});

test("a new index that restates everything so far is a revision, not an addition", () => {
  const t = createTranscript();
  t.update(event(0, ["what is this", true]));
  t.update(event(1, ["what is this", true], ["what is this how much is it", true]));
  assert.equal(t.text(), "what is this how much is it");
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
