/* Hands-free conversation around the unchanged scanner identification flow.
 *
 * This module turns a finished identification into a spoken conversation:
 *
 *   result presented → Charon speaks an introduction → LISTENING
 *     → USER_SPEAKING (Chrome speech recognition transcribes)
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
 * Honest note on privacy: Chrome's SpeechRecognition may send microphone audio to
 * Google's speech service. It is not local. Charon (Cloud Text-to-Speech) runs
 * server-side through our /api/speech route; the browser only receives WAV audio. */
import { createParticlePresence } from "./lib/particle-presence.js";

// The echo guard was validated in a physical speaker/microphone acceptance test.
// After playback ends, wait a little before listening again so the room's echo of
// Charon's last word is not transcribed as the user's next question.
export const ECHO_GUARD_MS = 900;
// Speech-START timeout: how long LISTENING waits for a person to begin speaking. It is
// not a maximum utterance length; once speech starts the timer is cancelled.
export const SPEECH_START_TIMEOUT_MS = 5000;
// The recognizer's onspeechstart fires on brief noises too. Requiring speech to persist
// for 200 ms (or a transcript to arrive) filters clicks and coughs.
const SPEECH_DEBOUNCE_MS = 200;
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
for (const id of ["start", "upload", "reset"])
  $(id)?.addEventListener("click", unlock, true);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/**
 * Builds the conversation panel with plain DOM calls. Everything user- or model-
 * generated is set through textContent, so transcripts and answers are never parsed
 * as HTML. The panel is created per identification and removed on reset.
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
    mic = element("button", "voice-button", "Start listening"),
    mute = element("button", "voice-button", "Voice on"),
    end = element("button", "voice-button", "End conversation");
  for (const b of [mic, mute, end]) b.type = "button";
  controls.append(mic, mute, end);
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
  const notice = element(
    "p",
    "voice-notice",
    "Voice uses Google Cloud. Browser speech recognition may send microphone audio to its provider. No microphone recording is saved by UCENTH Vision Intelligence.",
  );
  notice.setAttribute("role", "status");
  panel.append(
    stage,
    heading,
    question,
    interim,
    answer,
    controls,
    typed,
    notice,
  );
  $("results").after(panel);
  return {
    panel,
    stage,
    field,
    label,
    heading,
    question,
    interim,
    answer,
    mic,
    mute,
    end,
    typed,
    form,
    input,
    send,
    notice,
  };
}
/**
 * The race-condition guard. "current" is the active conversation and c.turn increases
 * with every new question or cancel. Any async continuation (a fetch, a decoded audio
 * buffer, a timer) calls this first; if it is false the work is simply abandoned.
 */
function valid(c, turn = c.turn) {
  return current === c && !c.ended && turn === c.turn;
}
/**
 * The only function that changes conversation state. It updates the label, the button
 * text, the particle renderer's mode and dispatches "ucenth:voice-state" (used by tests
 * and available to any page script). Keeping this in one place makes the state machine
 * easy to reason about and impossible to update half-way.
 */
function state(c, value) {
  if (current !== c || c.state === value) return;
  c.state = value;
  c.particles?.setState(value === "CONVERSATION_PAUSED" ? "IDLE" : value);
  c.ui.label.textContent =
    value === "CONVERSATION_PAUSED"
      ? "Conversation paused"
      : value.replaceAll("_", " ");
  c.ui.panel.dataset.state = value;
  c.ui.mic.textContent =
    value === "CONVERSATION_PAUSED"
      ? "Continue conversation"
      : ["LISTENING", "USER_SPEAKING"].includes(value)
        ? "Pause microphone"
        : "Start listening";
  c.ui.mic.disabled = value === "OPENING_MICROPHONE";
  c.ui.mic.setAttribute(
    "aria-pressed",
    String(["LISTENING", "USER_SPEAKING"].includes(value)),
  );
  c.ui.panel.dispatchEvent(
    new CustomEvent("ucenth:voice-state", {
      bubbles: true,
      detail: { state: value },
    }),
  );
}
function clearSpeechTimer(c) {
  clearTimeout(c.speechTimer);
  clearTimeout(c.speechDebounce);
  c.speechTimer = null;
  c.speechDebounce = null;
}
/**
 * Releases everything related to listening: pending timers, the recognizer (handlers
 * are detached before abort() so its final events cannot fire back into the state
 * machine), the microphone tracks and the analyser feeding the particles. Stopping the
 * tracks is what turns the browser's microphone indicator off.
 */
function stopMic(c) {
  clearSpeechTimer(c);
  c.listeningAttempt = null;
  clearTimeout(c.restart);
  c.restart = null;
  const recognition = c.recognition;
  c.recognition = null;
  if (recognition) {
    recognition.onend = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onspeechstart = null;
    recognition.onspeechend = null;
    try {
      recognition.abort();
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
 * choose Continue conversation. Listening deliberately does not restart on its own.
 */
function pauseConversation(c) {
  c.autoListen = false;
  stopMic(c);
  state(c, "CONVERSATION_PAUSED");
  c.ui.notice.textContent =
    "No speech detected. Continue conversation when you’re ready, or type a question.";
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
    const nodes = [...$("results").children];
    for (const node of nodes)
      if (
        !node.matches(
          ".result-state,.identity-name,.identity-meta,.keep-visible",
        )
      )
        details.append(node);
    if (details.children.length > 1) $("results").append(details);
  }
  c.particles = createParticlePresence(c.ui.field, {
    onActivity: (speaking) => {
      if (c.stream && ["LISTENING", "USER_SPEAKING"].includes(c.state))
        state(c, speaking ? "USER_SPEAKING" : "LISTENING");
    },
    onMetrics: (metrics) =>
      c.ui.panel.dispatchEvent(
        new CustomEvent("ucenth:particles-metrics", {
          bubbles: true,
          detail: metrics,
        }),
      ),
    onFallback: () => {
      c.ui.notice.textContent =
        "A simpler live-audio particle view is active. Voice remains available.";
    },
  });
}
function setVoiceControls(c) {
  c.ui.mute.textContent = voiceEnabled ? "Voice on" : "Voice off";
  c.ui.mute.setAttribute("aria-pressed", String(voiceEnabled));
  c.ui.mute.setAttribute(
    "aria-label",
    voiceEnabled ? "Turn voice responses off" : "Turn voice responses on",
  );
  if (!voiceEnabled) c.ui.typed.open = true;
}
/**
 * Opens one listening period. Order matters:
 *   1. resume the AudioContext (user gesture already happened),
 *   2. getUserMedia() for the microphone → AnalyserNode → particles (audio-reactive,
 *      not connected to the speakers, so no feedback),
 *   3. start Chrome's continuous SpeechRecognition with interim results,
 *   4. arm the five-second speech-start timer.
 *
 * Speech is confirmed by the recognizer's own classifier (onspeechstart held for
 * 200 ms) or by any transcript, never by raw microphone volume: a loud room should not
 * look like a question. A final transcript submits the question; recognition ending
 * without one pauses the conversation. Permission or recognizer errors switch to the
 * typed fallback rather than retrying silently.
 */
async function listen(c) {
  if (
    !valid(c) ||
    !voiceEnabled ||
    !c.autoListen ||
    document.hidden ||
    c.listeningAttempt ||
    c.recognition
  )
    return;
  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    c.autoListen = false;
    state(c, "VOICE_UNAVAILABLE");
    c.ui.notice.textContent =
      "Speech recognition is unavailable in this browser. Type your question below.";
    c.ui.typed.open = true;
    return;
  }
  stopMic(c);
  const turn = c.turn,
    attempt = {};
  c.listeningAttempt = attempt;
  state(c, "OPENING_MICROPHONE");
  try {
    unlock();
    await audioUnlock;
    if (!valid(c, turn) || c.listeningAttempt !== attempt) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (
      !valid(c, turn) ||
      c.listeningAttempt !== attempt ||
      !c.autoListen ||
      document.hidden
    ) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    c.stream = stream;
    c.micAnalyser = audioContext.createAnalyser();
    c.micAnalyser.fftSize = 2048;
    c.micAnalyser.smoothingTimeConstant = 0.65;
    c.micSource = audioContext.createMediaStreamSource(stream);
    c.micSource.connect(c.micAnalyser);
    c.particles?.connect(c.micAnalyser, "microphone");
    // how-to:start speech-recognition
    const recognition = new Recognition();
    c.recognition = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    // how-to:end speech-recognition
    let speechStarted = false,
      candidateAt = null;
    const live = () => valid(c, turn) && c.recognition === recognition;
    const confirmSpeech = () => {
      if (!live()) return;
      speechStarted = true;
      clearSpeechTimer(c);
      state(c, "USER_SPEAKING");
    };
    // Use the recognizer's speech classifier, not raw volume spikes from the renderer.
    // A short speech-end cancels the candidate; a transcript is stronger evidence.
    recognition.onspeechstart = () => {
      if (!live() || speechStarted || candidateAt !== null) return;
      candidateAt = performance.now();
      c.speechDebounce = setTimeout(confirmSpeech, SPEECH_DEBOUNCE_MS);
    };
    recognition.onspeechend = () => {
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
      if ((final + interim).trim()) confirmSpeech();
      c.ui.interim.textContent = interim;
      if (final.trim()) ask(c, final.trim());
    };
    recognition.onerror = (event) => {
      if (c.recognition !== recognition || !valid(c, turn)) return;
      if (event.error === "no-speech") return;
      c.autoListen = false;
      stopMic(c);
      state(c, "VOICE_UNAVAILABLE");
      c.ui.notice.textContent =
        event.error === "not-allowed"
          ? "Microphone access was denied. Type a question or use Start listening to try permission again."
          : "Speech recognition could not continue. Type a question or use Start listening to retry.";
      c.ui.typed.open = true;
    };
    recognition.onend = () => {
      if (live()) pauseConversation(c);
    };
    recognition.start();
    state(c, "LISTENING");
    c.speechTimer = setTimeout(() => {
      if (!live() || speechStarted) return;
      // Permit only the remainder of one near-deadline debounce, never a renewed window.
      const remaining =
        candidateAt === null
          ? 0
          : Math.max(0, SPEECH_DEBOUNCE_MS - (performance.now() - candidateAt));
      if (remaining)
        c.speechTimer = setTimeout(() => {
          if (live() && !speechStarted) pauseConversation(c);
        }, remaining + 10);
      else pauseConversation(c);
    }, SPEECH_START_TIMEOUT_MS);
    c.ui.notice.textContent =
      "Microphone active · Begin speaking within five seconds. Browser speech recognition may process audio remotely.";
  } catch {
    if (!valid(c, turn)) return;
    c.autoListen = false;
    stopMic(c);
    state(c, "VOICE_UNAVAILABLE");
    c.ui.notice.textContent =
      "Microphone access is unavailable or was denied. You can continue by typing.";
    c.ui.typed.open = true;
  }
}
/**
 * Playback finished. Wait the echo guard, then listen again if the loop is still on.
 */
function returnToListening(c, turn) {
  if (!valid(c, turn)) return;
  state(c, "IDLE");
  if (c.autoListen && voiceEnabled) {
    c.ui.notice.textContent = "Preparing to listen…";
    c.guard = setTimeout(() => {
      c.guard = null;
      if (valid(c, turn)) listen(c);
    }, ECHO_GUARD_MS);
  }
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
  try {
    const ready = async () => {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: request.signal,
      });
      if (!response.ok) throw Error("Voice unavailable");
      const bytes = await response.arrayBuffer();
      if (!valid(c, turn)) throw Error("Stale voice");
      unlock();
      await audioUnlock;
      if (!audioContext || audioContext.state !== "running")
        throw Error("Audio unavailable");
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
      returnToListening(c, turn);
    };
    c.ui.answer.textContent = text;
    c.pendingAnswer = null;
    state(c, "VISION_SPEAKING");
    c.ui.notice.textContent =
      "Charon speaking · Microphone and speech recognition are stopped.";
    c.playback.start();
    // how-to:end charon-playback
  } catch (error) {
    if (!valid(c, turn)) return;
    c.ui.answer.textContent = text;
    c.pendingAnswer = null;
    activate(c);
    state(c, "VOICE_UNAVAILABLE");
    c.ui.notice.textContent =
      "Voice unavailable. Continue with the written answer or type another question.";
    c.ui.typed.open = true;
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
  c.ui.notice.textContent =
    "Considering your question about this captured object…";
  c.autoListen = voiceEnabled;
  c.pendingAnswer = null;
  const request = new AbortController();
  c.request = request;
  const timeout = setTimeout(() => request.abort(), 30000);
  try {
    const response = await fetch("/api/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: c.image || undefined,
        document: c.document || undefined,
        identification: c.identification,
        question,
        history: c.history.slice(-6),
      }),
      signal: c.request.signal,
    });
    const result = await response.json();
    if (!valid(c, turn)) return;
    if (!response.ok || typeof result.answer !== "string")
      throw Error("Follow-up unavailable");
    c.pendingAnswer = result.answer;
    c.history.push(
      { role: "user", text: question },
      { role: "assistant", text: result.answer },
    );
    c.history = c.history.slice(-6);
    // A name the user states for an unidentified person becomes user-provided context, never verified identity.
    if (
      typeof result.userSuppliedIdentity === "string" &&
      result.userSuppliedIdentity.trim() &&
      c.identification?.subjectType === "person" &&
      !c.identification.identityEstablished
    )
      c.identification = {
        ...c.identification,
        identityName: result.userSuppliedIdentity.trim().slice(0, 120),
        identitySource: "user_context",
      };
    if (voiceEnabled) {
      speak(c, result.answer, turn);
    } else {
      c.ui.answer.textContent = result.answer;
      c.pendingAnswer = null;
      state(c, "VOICE_OFF");
      c.ui.notice.textContent = "Voice is off. Continue by typing.";
    }
  } catch (error) {
    if (!valid(c, turn)) return;
    state(c, "FOLLOW_UP_UNAVAILABLE");
    c.ui.notice.textContent =
      "The follow-up could not complete. Your captured object is preserved. Please retry your question.";
    c.ui.input.value = question;
    c.ui.typed.open = true;
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
  c.ui.end.textContent = "Resume conversation";
  c.ui.notice.textContent =
    "Microphone, playback and particles stopped. Resume or type to continue with this object.";
  c.ui.typed.open = true;
}
function resume(c, listenNow = true) {
  c.ended = false;
  c.autoListen = voiceEnabled;
  c.ui.panel.classList.remove("ended");
  c.ui.end.textContent = "End conversation";
  if (voiceEnabled) c.ui.typed.open = false;
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
    if (data.subjectType === "person")
      ui.heading.textContent = "Ask about this person";
    if (data.subjectType === "document")
      ui.heading.textContent = "Ask about this document";
    const c = (current = {
      id: serial,
      ui,
      identification: data,
      document: detail.document || null,
      image: $("capture").hidden
        ? ""
        : $("capture").toDataURL("image/jpeg", 0.88),
      history: [],
      turn: 0,
      ended: false,
      active: false,
      autoListen: voiceEnabled,
      state: "IDLE",
    });
    ui.form.onsubmit = (e) => {
      e.preventDefault();
      unlock();
      ask(c, ui.input.value);
    };
    ui.mic.onclick = () => {
      if (c.listeningAttempt && !c.stream) return;
      unlock();
      if (c.stream) {
        c.autoListen = false;
        cancelTurn(c);
        state(c, "MICROPHONE_PAUSED");
        ui.notice.textContent =
          "Microphone paused. Type, or select Start listening to resume.";
      } else {
        if (c.ended) resume(c, false);
        voiceEnabled = true;
        setVoiceControls(c);
        c.autoListen = true;
        cancelTurn(c);
        activate(c);
        listen(c);
      }
    };
    ui.mute.onclick = () => {
      voiceEnabled = !voiceEnabled;
      try {
        localStorage.setItem("ucenth-voice", voiceEnabled ? "on" : "off");
      } catch {}
      setVoiceControls(c);
      cancelTurn(c);
      if (!voiceEnabled) {
        c.autoListen = false;
        state(c, "VOICE_OFF");
        ui.notice.textContent =
          "Voice and automatic listening are off. Continue by typing.";
      } else {
        unlock();
        if (c.ended) resume(c, false);
        activate(c);
        c.autoListen = true;
        listen(c);
      }
    };
    ui.end.onclick = () => (c.ended ? resume(c) : end(c));
    setVoiceControls(c);
    if (voiceEnabled) {
      const uncertain = data.needsAnotherView || data.confidence !== "high";
      const intro =
        data.conversationIntro ||
        (uncertain
          ? `This appears to be ${data.name}. The exact variant is uncertain. What would you like to know about it?`
          : `I've identified this as ${data.name}. What would you like to know about it?`);
      ui.answer.textContent = intro;
      ui.notice.textContent = "Preparing your spoken introduction…";
      speak(c, intro, 0, detail.chimeCompletion || Promise.resolve());
    } else state(c, "VOICE_OFF");
  });
});
