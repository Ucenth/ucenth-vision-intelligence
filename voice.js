/* Hands-free conversation around the unchanged scanner identification flow.
 *
 * This module turns a finished identification into a spoken conversation:
 *
 *   result presented → Charon speaks an introduction → LISTENING
 *     → USER_SPEAKING (speech is transcribed)
 *     → THINKING (question + context → our server → Gemini)
 *     → Charon audio is prepared → answer text revealed + VISION_SPEAKING
 *     → playback ends → echo guard → LISTENING again
 *
 * Three ideas carry the whole file:
 *   - One "conversation" object (c) per identification, with a turn counter. Every
 *     async step checks valid(c, turn) before touching the page, so a reset or a new
 *     question makes older work fall silent instead of racing.
 *   - The microphone is never open while Charon plays. Otherwise the speakers would
 *     feed Charon's voice back into speech recognition (a feedback loop).
 *   - A listening period ends after five seconds without speech. Microphones should
 *     not stay open indefinitely: it wastes resources and surprises users.
 *
 * Two transcription paths give one experience:
 *   native  the browser's SpeechRecognition (Chrome desktop and Android, Safari).
 *           On phones the recogniser must own the microphone alone: holding a second
 *           getUserMedia stream for the particle analyser starves recognition on
 *           Android and breaks it on iOS, so mobile listening opens no stream and the
 *           particles use a restrained listening pulse driven by recognition events.
 *   server  where native recognition is missing or fails (iOS Chrome, some Safari
 *           sessions): the browser records the question with MediaRecorder, sends the
 *           clip to /api/transcribe, and the server transcribes it in memory. Nothing
 *           is stored. Here the microphone stream is ours, so the particles can follow it.
 * The user sees the same LISTENING → USER SPEAKING → THINKING → VISION SPEAKING loop.
 *
 * Honest note on privacy: native recognition may send microphone audio to the
 * browser vendor's speech service; the server path sends a short clip to our server
 * and Google for transcription only. Charon (Cloud Text-to-Speech) runs server-side
 * through /api/speech; the browser only receives WAV audio. */
import { createParticlePresence } from "./lib/particle-presence.js";

// After playback ends, wait a little before listening again so the room's echo of
// Charon's last word is not transcribed as the user's next question. The guard was
// validated in a physical speaker/microphone acceptance test.
export const ECHO_GUARD_MS = 900;
// Speech-START timeout: how long LISTENING waits for a person to begin speaking. It is
// not a maximum utterance length; once speech starts the timer is cancelled.
export const SPEECH_START_TIMEOUT_MS = 5000;
// The recogniser's onspeechstart fires on brief noises too. Requiring speech to persist
// for 200 ms (or a transcript to arrive) filters clicks and coughs.
const SPEECH_DEBOUNCE_MS = 200;
// Native path: Android Chrome delivers a question as several small FINAL fragments
// (no interim text at all), one every few hundred milliseconds while the person is
// still talking. Submitting the first fragment would cut the question off mid-sentence,
// so finals are collected and sent once no new fragment arrives for this long.
// Desktop Chrome sends one final after the person stops, so it costs the same pause.
const FINAL_SETTLE_MS = 800;
// Server path: end the clip after this much silence following speech, and never
// record longer than MAX_CLIP_MS.
const SILENCE_END_MS = 900;
const MAX_CLIP_MS = 15000;

const $ = (id) => document.getElementById(id);
const readVoice = () => {
  try {
    return localStorage.getItem("ucenth-voice") !== "off";
  } catch {
    return true;
  }
};
let voiceEnabled = readVoice(),
  audioContext,
  current = null,
  serial = 0,
  audioUnlock;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Platform facts used for decisions and reported to the diagnostics panel. */
export function capabilities() {
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  return {
    userAgent: ua,
    platform: navigator.platform,
    ios,
    android,
    mobile: ios || android,
    speechRecognition: !!window.SpeechRecognition,
    webkitSpeechRecognition: !!window.webkitSpeechRecognition,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== "undefined",
    recorderMime: recorderMime(),
    audioContext: !!(window.AudioContext || window.webkitAudioContext),
    audioContextState: audioContext?.state || "none",
    // iOS Chrome and Firefox have no native recogniser at all; everything else tries
    // native first and falls back per session if it fails.
    nativeRecognition: !!Recognition,
    preferredPath: Recognition ? "native" : "server",
  };
}
function recorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
}
/** Structured diagnostics (never audio) for the staging diagnostics panel and tests. */
function diag(event, data = {}) {
  document.dispatchEvent(new CustomEvent("ucenth:voice-diag", { detail: { t: Math.round(performance.now()), event, ...data } }));
}
/** Pipeline timing marks, consumed by the diagnostics timeline. */
function mark(name, data = {}) {
  document.dispatchEvent(new CustomEvent("ucenth:timing", { detail: { t: Math.round(performance.now()), name, ...data } }));
}
/**
 * Browsers block audio output until the page has had a user gesture. Creating and
 * resuming the AudioContext inside the first click (camera, upload or reset) unlocks
 * both the chime and later Charon playback.
 */
function unlock() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioUnlock = audioContext.resume();
    audioUnlock.catch(() => {});
  } catch {}
}
for (const id of ["start", "upload", "reset"]) $(id)?.addEventListener("click", unlock, true);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/**
 * Builds the conversation panel with plain DOM calls. Everything user- or model-
 * generated is set through textContent, so transcripts and answers are never parsed
 * as HTML. One primary control changes with the state; typing is always available.
 */
function buildPanel() {
  const panel = element("section", "voice-panel");
  panel.setAttribute("aria-label", "Conversation about this object");
  const stage = element("div", "voice-presence"),
    field = element("div", "voice-field"),
    label = element("p", "voice-state", "READY");
  label.setAttribute("role", "status");
  label.setAttribute("aria-live", "polite");
  stage.append(field, label);
  const heading = element("h3", "voice-heading", "Ask about this object");
  const question = element("p", "voice-question"),
    interim = element("p", "voice-interim"),
    answer = element("p", "voice-answer");
  answer.setAttribute("aria-live", "polite");
  const controls = element("div", "voice-controls"),
    primary = element("button", "voice-primary", "Pause"),
    mute = element("button", "voice-text", "Turn voice off"),
    end = element("button", "voice-text", "End");
  for (const b of [primary, mute, end]) b.type = "button";
  end.setAttribute("aria-label", "End conversation");
  controls.append(primary, mute, end);
  const typed = element("details", "voice-typed"),
    summary = element("summary", "", "Type a question"),
    form = element("form", "voice-form"),
    input = element("input"),
    send = element("button", "voice-send", "Send ↗");
  input.type = "text";
  input.maxLength = 700;
  input.placeholder = "What would you like to know?";
  input.setAttribute("aria-label", "Question about the scanned object");
  send.type = "submit";
  form.append(input, send);
  typed.append(summary, form);
  const notice = element("p", "voice-notice", "");
  notice.setAttribute("role", "status");
  panel.append(stage, heading, question, interim, answer, controls, typed, notice);
  $("results").after(panel);
  return { panel, stage, field, label, heading, question, interim, answer, primary, mute, end, typed, form, input, send, notice };
}
/**
 * The race-condition guard. "current" is the active conversation and c.turn increases
 * with every new question or cancel. Any async continuation (a fetch, a decoded audio
 * buffer, a timer) calls this first; if it is false the work is simply abandoned.
 */
function valid(c, turn = c.turn) {
  return current === c && !c.ended && turn === c.turn;
}
const LABELS = {
  CONVERSATION_PAUSED: "Conversation paused",
  MICROPHONE_PAUSED: "Conversation paused",
  VOICE_OFF: "Voice off",
  VOICE_UNAVAILABLE: "Voice unavailable",
  FOLLOW_UP_UNAVAILABLE: "FOLLOW UP UNAVAILABLE",
  CONVERSATION_ENDED: "Conversation ended",
  OPENING_MICROPHONE: "OPENING MICROPHONE",
  USER_SPEAKING: "USER SPEAKING",
  VISION_SPEAKING: "VISION SPEAKING",
};
// The single primary control per state. States not listed show no primary control.
const PRIMARY = {
  LISTENING: "Pause",
  USER_SPEAKING: "Pause",
  OPENING_MICROPHONE: "Pause",
  CONVERSATION_PAUSED: "Continue",
  MICROPHONE_PAUSED: "Continue",
  VOICE_OFF: "Enable voice",
  VOICE_UNAVAILABLE: "Try voice again",
  VISION_SPEAKING: "Stop speaking",
  CONVERSATION_ENDED: "Resume",
  FOLLOW_UP_UNAVAILABLE: "Continue",
};
/**
 * The only function that changes conversation state. It updates the label, the
 * controls, the particle renderer's mode and dispatches "ucenth:voice-state" (used by
 * tests and available to any page script). One place, one source of truth.
 */
function state(c, value) {
  if (current !== c || c.state === value) return;
  c.state = value;
  c.particles?.setState(value);
  c.ui.label.textContent = LABELS[value] || value.replaceAll("_", " ");
  c.ui.panel.dataset.state = value;
  const primary = PRIMARY[value];
  c.ui.primary.hidden = !primary;
  if (primary) c.ui.primary.textContent = primary;
  c.ui.primary.setAttribute("aria-pressed", String(["LISTENING", "USER_SPEAKING", "OPENING_MICROPHONE"].includes(value)));
  c.ui.mute.hidden = !voiceEnabled || value === "VOICE_OFF";
  c.ui.end.hidden = value === "CONVERSATION_ENDED";
  // Typing is the fallback whenever listening is not active.
  if (["CONVERSATION_PAUSED", "MICROPHONE_PAUSED", "VOICE_OFF", "VOICE_UNAVAILABLE", "FOLLOW_UP_UNAVAILABLE", "CONVERSATION_ENDED"].includes(value)) c.ui.typed.open = true;
  if (["LISTENING", "USER_SPEAKING"].includes(value) && voiceEnabled) c.ui.typed.open = false;
  diag("state", { state: value });
  c.ui.panel.dispatchEvent(new CustomEvent("ucenth:voice-state", { bubbles: true, detail: { state: value } }));
}
function clearSpeechTimer(c) {
  clearTimeout(c.speechTimer);
  clearTimeout(c.speechDebounce);
  clearTimeout(c.silenceTimer);
  clearTimeout(c.clipTimer);
  clearTimeout(c.finalTimer);
  c.speechTimer = c.speechDebounce = c.silenceTimer = c.clipTimer = c.finalTimer = null;
}
/**
 * Releases everything related to listening: pending timers, the recogniser (handlers
 * are detached before abort() so its final events cannot fire back into the state
 * machine), the recorder, the microphone tracks and the analyser feeding the
 * particles. Stopping the tracks is what turns the browser's microphone indicator off.
 */
function stopMic(c) {
  clearSpeechTimer(c);
  c.listeningAttempt = null;
  const recognition = c.recognition;
  c.recognition = null;
  if (recognition) {
    for (const h of ["onend", "onresult", "onerror", "onspeechstart", "onspeechend", "onaudiostart", "onaudioend", "onsoundstart", "onsoundend", "onstart"]) recognition[h] = null;
    try {
      recognition.abort();
    } catch {}
  }
  if (c.recorder) {
    const recorder = c.recorder;
    c.recorder = null;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {}
  }
  c.stream?.getTracks().forEach((t) => t.stop());
  c.stream = null;
  c.micSource?.disconnect();
  c.micSource = null;
  c.micAnalyser?.disconnect();
  c.micAnalyser = null;
  c.particles?.disconnect();
}
/**
 * Five seconds passed without genuine speech: stop listening and wait for the user to
 * choose Continue. Listening deliberately does not restart on its own.
 */
function pauseConversation(c, reason = "speech-start-timeout") {
  diag("pause", { reason });
  c.autoListen = false;
  stopMic(c);
  state(c, "CONVERSATION_PAUSED");
}
/**
 * Invalidates the turn in progress: aborts the follow-up request, stops any Charon
 * playback and clears the microphone. Called before a new question, on pause and on end.
 */
function cancelTurn(c) {
  c.turn++;
  c.request?.abort();
  c.request = null;
  clearTimeout(c.guard);
  c.guard = null;
  stopMic(c);
  if (c.playback) {
    c.playback.onended = null;
    try {
      c.playback.stop();
    } catch {}
    c.playback.disconnect();
    c.playback = null;
  }
  c.outputAnalyser?.disconnect();
  c.outputAnalyser = null;
  c.particles?.disconnect();
  c.ui.interim.textContent = "";
}
/**
 * First activation of the conversation view: folds the long identification details into
 * a disclosure so the answer and particles fit on a phone, and creates the particle
 * renderer lazily (WebGL resources exist only while a conversation is active).
 */
function activate(c) {
  if (c.active) return;
  c.active = true;
  c.ui.panel.classList.add("active");
  $("results").closest(".workspace").classList.add("has-conversation");
  if (!$("results").querySelector(".voice-identification-details")) {
    const details = element("details", "voice-identification-details"),
      summary = element("summary", "", "Identification details");
    details.append(summary);
    for (const node of [...$("results").children])
      if (!node.matches(".result-state,.identity-name,.identity-meta,.keep-visible")) details.append(node);
    if (details.children.length > 1) $("results").append(details);
  }
  c.particles = createParticlePresence(c.ui.field, {
    onActivity: (speaking) => {
      // Only the server path owns a microphone stream; native recognition reports speech
      // itself. The transition is one-way: a breath between words must not flip the
      // panel back to LISTENING while the clip is still being recorded.
      if (speaking && c.stream && c.sttPath === "server" && c.state === "LISTENING") state(c, "USER_SPEAKING");
    },
    onMetrics: (metrics) => c.ui.panel.dispatchEvent(new CustomEvent("ucenth:particles-metrics", { bubbles: true, detail: metrics })),
    onFallback: () => diag("particles", { fallback: true }),
  });
}
function setVoiceControls(c) {
  c.ui.mute.textContent = "Turn voice off";
  c.ui.mute.hidden = !voiceEnabled;
}
function voiceUnavailable(c, message) {
  c.autoListen = false;
  stopMic(c);
  state(c, "VOICE_UNAVAILABLE");
  c.ui.notice.textContent = message;
}
/**
 * Opens one listening period, choosing the transcription path for this session:
 * native SpeechRecognition where it exists (and has not failed this session), otherwise
 * recording plus server transcription. Both arm the five-second speech-start timer.
 */
async function listen(c) {
  if (!valid(c) || !voiceEnabled || !c.autoListen || document.hidden || c.listeningAttempt || c.recognition || c.recorder) return;
  const caps = capabilities();
  if (!c.sttPath) c.sttPath = caps.nativeRecognition ? "native" : caps.mediaRecorder && caps.getUserMedia ? "server" : "none";
  diag("listen", { path: c.sttPath, mobile: caps.mobile });
  if (c.sttPath === "none") return voiceUnavailable(c, "Voice couldn't start on this device. You can continue by typing.");
  stopMic(c);
  const turn = c.turn,
    attempt = {};
  c.listeningAttempt = attempt;
  state(c, "OPENING_MICROPHONE");
  try {
    unlock();
    await audioUnlock;
    if (!valid(c, turn) || c.listeningAttempt !== attempt) return;
    if (c.sttPath === "native") await listenNative(c, turn, attempt, caps);
    else await listenServer(c, turn, attempt, caps);
  } catch (error) {
    if (!valid(c, turn)) return;
    diag("error", { where: "listen", name: error?.name, message: String(error?.message || error).slice(0, 120) });
    voiceUnavailable(c, error?.name === "NotAllowedError" ? "Microphone access was denied. You can continue by typing." : "Voice couldn't start on this device. You can continue by typing.");
  }
}
/**
 * Native path. Order matters:
 *   1. on desktop only, getUserMedia() → AnalyserNode → particles (audio-reactive,
 *      not connected to the speakers, so no feedback); phones skip this so the
 *      recogniser owns the microphone alone,
 *   2. start continuous SpeechRecognition with interim results,
 *   3. arm the five-second speech-start timer.
 * Speech is confirmed by the recogniser's own classifier (onspeechstart held for
 * 200 ms) or by any transcript, never by raw microphone volume. A final transcript
 * submits the question; recognition ending without one pauses the conversation. An
 * error switches this session to the server path (or to typing if that is impossible).
 */
async function listenNative(c, turn, attempt, caps) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!caps.mobile && caps.getUserMedia) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!valid(c, turn) || c.listeningAttempt !== attempt || !c.autoListen || document.hidden) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    attachStream(c, stream);
  }
  // how-to:start speech-recognition
  const recognition = new Recognition();
  c.recognition = recognition;
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;
  // how-to:end speech-recognition
  let speechStarted = false,
    candidateAt = null,
    sawAudio = false,
    finals = "";
  const live = () => valid(c, turn) && c.recognition === recognition;
  // Send everything final so far as one question (see FINAL_SETTLE_MS).
  const submit = (why) => {
    clearTimeout(c.finalTimer);
    c.finalTimer = null;
    const question = finals.trim();
    if (!live() || !question) return;
    diag("recognition.submit", { why, chars: question.length });
    mark("speech-final");
    ask(c, question);
  };
  const confirmSpeech = () => {
    if (!live()) return;
    speechStarted = true;
    clearSpeechTimer(c);
    state(c, "USER_SPEAKING");
    c.particles?.pulse(0.6);
  };
  for (const name of ["start", "audiostart", "soundstart", "soundend", "audioend"])
    recognition[`on${name}`] = () => {
      if (name === "audiostart") sawAudio = true;
      diag(`recognition.${name}`);
    };
  // Use the recogniser's speech classifier, not raw volume spikes from the renderer.
  // A short speech-end cancels the candidate; a transcript is stronger evidence.
  recognition.onspeechstart = () => {
    diag("recognition.speechstart");
    if (!live() || speechStarted || candidateAt !== null) return;
    candidateAt = performance.now();
    c.speechDebounce = setTimeout(confirmSpeech, SPEECH_DEBOUNCE_MS);
  };
  recognition.onspeechend = () => {
    diag("recognition.speechend");
    if (speechStarted) return;
    clearTimeout(c.speechDebounce);
    c.speechDebounce = null;
    candidateAt = null;
  };
  recognition.onresult = (event) => {
    if (!live() || !["LISTENING", "USER_SPEAKING"].includes(c.state)) return;
    let final = "",
      interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += text;
      else interim += text;
    }
    diag("recognition.result", { interimChars: interim.length, finalChars: final.length });
    if ((final + interim).trim()) confirmSpeech();
    c.particles?.pulse(0.5);
    if (final.trim()) {
      finals += (finals && !finals.endsWith(" ") ? " " : "") + final.trim();
      clearTimeout(c.finalTimer);
      c.finalTimer = setTimeout(() => submit("settled"), FINAL_SETTLE_MS);
    }
    // Show the person what has been heard so far: settled finals plus the live guess.
    c.ui.interim.textContent = (finals + " " + interim).trim();
  };
  recognition.onerror = (event) => {
    if (c.recognition !== recognition || !valid(c, turn)) return;
    diag("recognition.error", { error: event.error, sawAudio });
    if (event.error === "no-speech") return;
    // A question already heard is worth more than a retry: send it, then move on.
    if (finals.trim()) return submit("recognition-error");
    if (event.error === "not-allowed" || event.error === "service-not-allowed")
      return voiceUnavailable(c, event.error === "not-allowed" ? "Microphone access was denied. You can continue by typing." : "Voice couldn't start on this device. You can continue by typing.");
    // Anything else (audio-capture, network, aborted by the platform): switch this
    // session to the server path once, then keep listening.
    if (caps.mediaRecorder && caps.getUserMedia && !c.fellBack) {
      c.fellBack = true;
      c.sttPath = "server";
      diag("fallback", { to: "server", because: event.error });
      stopMic(c);
      c.listeningAttempt = null;
      listen(c);
      return;
    }
    voiceUnavailable(c, "Voice couldn't start on this device. You can continue by typing.");
  };
  recognition.onend = () => {
    diag("recognition.end", { speechStarted, sawAudio, pendingChars: finals.trim().length });
    // The recogniser closed on its own: send what it heard rather than waiting.
    if (live() && finals.trim()) return submit("recognition-ended");
    if (live()) pauseConversation(c, speechStarted ? "recognition-ended" : "no-speech");
  };
  recognition.start();
  mark("listening");
  state(c, "LISTENING");
  armSpeechStartTimer(c, turn, () => speechStarted, () => candidateAt);
}
/**
 * Server path: record a short clip and transcribe it on the server. The microphone
 * stream is ours here, so the particles follow the real signal, and speech is
 * detected from the analyser with a noise gate measured in the first 400 ms.
 */
async function listenServer(c, turn, attempt, caps) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  if (!valid(c, turn) || c.listeningAttempt !== attempt || !c.autoListen || document.hidden) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  attachStream(c, stream);
  const mime = caps.recorderMime;
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  c.recorder = recorder;
  const chunks = [];
  let speechStarted = false,
    stopped = false;
  const live = () => valid(c, turn) && c.recorder === recorder;
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    if (!live() && !stopped) return;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
    diag("clip", { bytes: blob.size, type: blob.type, speechStarted });
    stopMic(c);
    if (!valid(c, turn) || !speechStarted || blob.size < 1000) return pauseConversation(c, speechStarted ? "empty-clip" : "no-speech");
    c.ui.interim.textContent = "…";
    mark("transcribe-start", { bytes: blob.size });
    try {
      const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const result = await response.json().catch(() => ({}));
      if (!valid(c, turn)) return;
      mark("transcribe-done", { status: response.status, chars: (result.text || "").length });
      c.ui.interim.textContent = "";
      if (!response.ok) throw Object.assign(Error("transcribe"), { status: response.status, serverMessage: typeof result.error === "string" ? result.error : "" });
      if (result.text?.trim()) {
        mark("speech-final");
        ask(c, result.text.trim());
      } else pauseConversation(c, "empty-transcript");
    } catch (error) {
      if (!valid(c, turn)) return;
      diag("error", { where: "transcribe", status: error?.status, message: String(error?.message || error).slice(0, 120) });
      c.ui.interim.textContent = "";
      pauseConversation(c, "transcribe-failed");
      // Say why, in the server's words when it gave any; the typed field stays open.
      c.ui.notice.textContent = error?.serverMessage || "Your question couldn't be heard clearly. Please try again or type it.";
    }
  };
  // Speech detection from the analyser: quiet room → noise floor, then a clear rise.
  const analyser = c.micAnalyser,
    data = new Float32Array(analyser.fftSize);
  let noise = 0.002,
    started = performance.now(),
    lastLoud = 0;
  const poll = () => {
    if (!live() || stopped) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = Math.sqrt(sum / data.length),
      now = performance.now();
    if (now - started < 400) noise = Math.min(0.01, noise * 0.9 + rms * 0.1);
    else if (rms > Math.max(0.012, noise * 3)) {
      lastLoud = now;
      if (!speechStarted) {
        speechStarted = true;
        clearSpeechTimer(c);
        diag("recorder.speechstart", { rms: +rms.toFixed(4), noise: +noise.toFixed(4) });
        state(c, "USER_SPEAKING");
        c.clipTimer = setTimeout(() => finish("max-clip"), MAX_CLIP_MS);
      }
    } else if (speechStarted && now - lastLoud > SILENCE_END_MS) return finish("silence");
    c.pollFrame = requestAnimationFrame(poll);
  };
  const finish = (why) => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(c.pollFrame);
    diag("recorder.stop", { why });
    try {
      recorder.stop();
    } catch {
      pauseConversation(c, "recorder-failed");
    }
  };
  recorder.start(250);
  mark("listening");
  state(c, "LISTENING");
  poll();
  armSpeechStartTimer(c, turn, () => speechStarted, () => null, () => finish("speech-start-timeout"));
}
function attachStream(c, stream) {
  c.stream = stream;
  const tracks = stream.getAudioTracks();
  diag("microphone", { tracks: tracks.length, readyState: tracks[0]?.readyState, enabled: tracks[0]?.enabled, muted: tracks[0]?.muted, label: tracks[0]?.label ? "present" : "none" });
  c.micAnalyser = audioContext.createAnalyser();
  c.micAnalyser.fftSize = 2048;
  c.micAnalyser.smoothingTimeConstant = 0.65;
  c.micSource = audioContext.createMediaStreamSource(stream);
  c.micSource.connect(c.micAnalyser);
  c.particles?.connect(c.micAnalyser, "microphone");
}
function armSpeechStartTimer(c, turn, started, candidate, onTimeout) {
  c.speechTimer = setTimeout(() => {
    if (!valid(c, turn) || started()) return;
    // Permit only the remainder of one near-deadline debounce, never a renewed window.
    const at = candidate();
    const remaining = at === null ? 0 : Math.max(0, SPEECH_DEBOUNCE_MS - (performance.now() - at));
    const fire = () => {
      if (!valid(c, turn) || started()) return;
      if (onTimeout) onTimeout();
      else pauseConversation(c, "speech-start-timeout");
    };
    if (remaining) c.speechTimer = setTimeout(fire, remaining + 10);
    else fire();
  }, SPEECH_START_TIMEOUT_MS);
}
/**
 * Playback finished. Wait the echo guard, then listen again if the loop is still on.
 */
function returnToListening(c, turn) {
  if (!valid(c, turn)) return;
  state(c, "IDLE");
  if (c.autoListen && voiceEnabled)
    c.guard = setTimeout(() => {
      c.guard = null;
      if (valid(c, turn)) listen(c);
    }, ECHO_GUARD_MS);
}
/**
 * Speaks text with Charon, revealing the written answer only when audio is ready.
 *
 *   fetch /api/speech → WAV bytes → decodeAudioData() → AudioBufferSourceNode
 *
 * The microphone is stopped BEFORE playback starts (stopMic), so speech recognition
 * cannot transcribe Charon. The decoded buffer plays through an AnalyserNode so the
 * particles react to the real output signal. A 25-second budget bounds synthesis; if
 * Charon fails or times out, the text is shown with a voice-unavailable notice instead
 * of hiding the answer forever, and typing keeps working. No other voice is substituted.
 */
async function speak(c, text, turn, chime = Promise.resolve()) {
  if (!valid(c, turn) || !voiceEnabled) return;
  stopMic(c);
  const chimeReady = Promise.resolve(chime).then(() => wait(160));
  const request = new AbortController();
  c.request = request;
  let timeout;
  mark("charon-request", { chars: text.length });
  try {
    const ready = async () => {
      const response = await fetch("/api/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: request.signal });
      if (!response.ok) throw Error("Voice unavailable");
      const bytes = await response.arrayBuffer();
      if (!valid(c, turn)) throw Error("Stale voice");
      unlock();
      await audioUnlock;
      if (!audioContext || audioContext.state !== "running") throw Error("Audio unavailable");
      return audioContext.decodeAudioData(bytes);
    };
    const audio = await Promise.race([
      ready(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          request.abort();
          reject(Error("Voice timeout"));
        }, 25000);
      }),
    ]);
    clearTimeout(timeout);
    mark("charon-ready", { seconds: +audio.duration.toFixed(2) });
    await chimeReady;
    if (!valid(c, turn) || !voiceEnabled) return;
    // how-to:start charon-playback
    activate(c);
    stopMic(c);
    c.outputAnalyser = audioContext.createAnalyser();
    c.outputAnalyser.fftSize = 2048;
    c.outputAnalyser.smoothingTimeConstant = 0.65;
    c.outputAnalyser.connect(audioContext.destination);
    c.playback = audioContext.createBufferSource();
    c.playback.buffer = audio;
    c.playback.connect(c.outputAnalyser);
    c.particles.connect(c.outputAnalyser, "charon");
    c.playback.onended = () => {
      if (!valid(c, turn)) return;
      c.playback.disconnect();
      c.playback = null;
      c.outputAnalyser?.disconnect();
      c.outputAnalyser = null;
      c.particles.disconnect();
      mark("playback-end");
      returnToListening(c, turn);
    };
    c.ui.answer.textContent = text;
    c.pendingAnswer = null;
    state(c, "VISION_SPEAKING");
    c.playback.start();
    mark("playback-start");
    // how-to:end charon-playback
  } catch (error) {
    if (!valid(c, turn)) return;
    diag("error", { where: "speak", message: String(error?.message || error).slice(0, 120), audioContext: audioContext?.state });
    c.ui.answer.textContent = text;
    c.pendingAnswer = null;
    activate(c);
    voiceUnavailable(c, "Voice couldn't play on this device. The written answer is here, and you can continue by typing.");
  } finally {
    clearTimeout(timeout);
    if (c.request === request) c.request = null;
  }
}
/**
 * Sends one question to /api/follow-up with the context Gemini needs: the captured
 * image (or the document context), the identification and up to six recent messages.
 * The page shows THINKING and keeps the answer hidden until speak() has audio ready,
 * so text and voice arrive together. A 30-second AbortController bounds the request.
 * For an unidentified person, a name the user states is stored as user-provided context
 * (identitySource "user_context"), never promoted to a verified identity.
 */
async function ask(c, question) {
  question = question.trim().slice(0, 700);
  if (!question || current !== c) return;
  if (c.ended) resume(c, false);
  cancelTurn(c);
  const turn = c.turn;
  activate(c);
  c.ui.question.textContent = question;
  c.ui.interim.textContent = "";
  c.ui.answer.textContent = "";
  c.ui.input.value = "";
  state(c, "THINKING");
  c.ui.notice.textContent = "";
  c.autoListen = voiceEnabled;
  c.pendingAnswer = null;
  const request = new AbortController();
  c.request = request;
  const timeout = setTimeout(() => request.abort(), 30000);
  mark("follow-up-request");
  try {
    const response = await fetch("/api/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: c.image || undefined, document: c.document || undefined, identification: c.identification, question, history: c.history.slice(-6) }),
      signal: c.request.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!valid(c, turn)) return;
    mark("follow-up-response", { status: response.status, serverMs: result.elapsedMs });
    // The server's own message (allowance used up, capacity paused, retry advice) is
    // written for the person and is shown as is; anything else gets the generic notice.
    if (!response.ok || typeof result.answer !== "string")
      throw Object.assign(Error("Follow-up unavailable"), { status: response.status, serverMessage: typeof result.error === "string" ? result.error : "" });
    c.pendingAnswer = result.answer;
    c.history.push({ role: "user", text: question }, { role: "assistant", text: result.answer });
    c.history = c.history.slice(-6);
    // A name the user states for an unidentified person becomes user-provided context, never verified identity.
    if (typeof result.userSuppliedIdentity === "string" && result.userSuppliedIdentity.trim() && c.identification?.subjectType === "person" && !c.identification.identityEstablished)
      c.identification = { ...c.identification, identityName: result.userSuppliedIdentity.trim().slice(0, 120), identitySource: "user_context" };
    if (voiceEnabled) speak(c, result.answer, turn);
    else {
      c.ui.answer.textContent = result.answer;
      c.pendingAnswer = null;
      state(c, "VOICE_OFF");
    }
  } catch (error) {
    if (!valid(c, turn)) return;
    diag("error", { where: "follow-up", status: error?.status, name: error?.name, message: String(error?.message || error).slice(0, 120) });
    state(c, "FOLLOW_UP_UNAVAILABLE");
    c.ui.notice.textContent = error?.serverMessage || "The answer couldn't be completed. Your captured object is preserved; please ask again.";
    c.ui.input.value = question;
  } finally {
    clearTimeout(timeout);
    if (c.request === request) c.request = null;
  }
}
/**
 * Ends the conversation and frees everything: request, playback, microphone, history
 * and the WebGL renderer. The object result itself stays visible until reset.
 */
function end(c) {
  cancelTurn(c);
  c.ended = true;
  c.autoListen = false;
  c.history = [];
  c.particles?.dispose();
  c.particles = null;
  c.active = false;
  c.ui.panel.classList.remove("active");
  c.ui.panel.classList.add("ended");
  state(c, "CONVERSATION_ENDED");
}
function resume(c, listenNow = true) {
  c.ended = false;
  c.autoListen = voiceEnabled;
  c.ui.panel.classList.remove("ended");
  activate(c);
  if (listenNow) listen(c);
}
/**
 * Called on "ucenth:scan-reset" (Scan another object) and on page hide. Also clears
 * the captured image and document context held for follow-ups.
 */
function reset() {
  if (current) {
    end(current);
    current.ui.panel.remove();
    current.image = "";
    current.identification = null;
    current = null;
  }
  serial++;
  document.querySelector(".workspace")?.classList.remove("has-conversation");
}
document.addEventListener("ucenth:scan-reset", reset);
// A hidden tab should not keep a microphone open or a voice playing.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && current && !current.ended) end(current);
});
addEventListener("pagehide", () => {
  reset();
  audioContext?.close();
});
// Entry point. script.js or document.js dispatches this event with the structured
// identification (and, for documents, the bounded document context). The conversation
// object created here lives until the next reset.
document.addEventListener("ucenth:result-presented", (event) => {
  const detail = event.detail,
    data = detail.identification;
  if (!data?.name) return;
  queueMicrotask(() => {
    reset();
    const ui = buildPanel();
    if (data.subjectType === "person") ui.heading.textContent = "Ask about this person";
    if (data.subjectType === "document") ui.heading.textContent = "Ask about this document";
    const c = (current = {
      id: serial,
      ui,
      identification: data,
      document: detail.document || null,
      image: $("capture").hidden ? "" : $("capture").toDataURL("image/jpeg", 0.88),
      history: [],
      turn: 0,
      ended: false,
      active: false,
      autoListen: voiceEnabled,
      state: "IDLE",
      sttPath: null,
      fellBack: false,
    });
    diag("capabilities", capabilities());
    ui.form.onsubmit = (e) => {
      e.preventDefault();
      unlock();
      ask(c, ui.input.value);
    };
    // The one primary control: its meaning follows the state it was rendered for.
    ui.primary.onclick = () => {
      unlock();
      const s = c.state;
      if (["LISTENING", "USER_SPEAKING", "OPENING_MICROPHONE"].includes(s)) {
        c.autoListen = false;
        cancelTurn(c);
        state(c, "MICROPHONE_PAUSED");
      } else if (s === "VISION_SPEAKING") {
        cancelTurn(c);
        c.autoListen = voiceEnabled;
        returnToListening(c, c.turn);
      } else if (s === "VOICE_OFF") {
        voiceEnabled = true;
        try {
          localStorage.setItem("ucenth-voice", "on");
        } catch {}
        setVoiceControls(c);
        c.autoListen = true;
        cancelTurn(c);
        activate(c);
        listen(c);
      } else {
        // Continue, Try voice again, Resume
        if (c.ended) resume(c, false);
        c.sttPath = s === "VOICE_UNAVAILABLE" ? null : c.sttPath;
        c.ui.notice.textContent = "";
        c.autoListen = true;
        cancelTurn(c);
        activate(c);
        listen(c);
      }
    };
    ui.mute.onclick = () => {
      voiceEnabled = false;
      try {
        localStorage.setItem("ucenth-voice", "off");
      } catch {}
      c.autoListen = false;
      cancelTurn(c);
      setVoiceControls(c);
      state(c, "VOICE_OFF");
    };
    ui.end.onclick = () => end(c);
    setVoiceControls(c);
    if (voiceEnabled) {
      const uncertain = data.needsAnotherView || data.confidence !== "high";
      const intro = data.conversationIntro || (uncertain ? `This appears to be ${data.name}. The exact variant is uncertain. What would you like to know about it?` : `I've identified this as ${data.name}. What would you like to know about it?`);
      ui.answer.textContent = intro;
      speak(c, intro, 0, detail.chimeCompletion || Promise.resolve());
    } else state(c, "VOICE_OFF");
  });
});
