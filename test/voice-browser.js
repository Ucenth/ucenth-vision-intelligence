// Lifecycle verification with explicit mock recognition/cloud responses.
// This does not replace the physical microphone/speaker acceptance test.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const artifact = "artifacts/voice";
await mkdir(artifact, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const image = await sharp({ create: { width: 400, height: 500, channels: 3,
  background: "#6688aa" } }).jpeg().toBuffer();
const wav = Buffer.alloc(44 + 24000 * .4 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < (wav.length - 44) / 2; i++)
  wav.writeInt16LE(Math.round(Math.sin(i * 440 / 24000 * Math.PI * 2) * 8000), 44 + i * 2);
const identity = { provider: "gemini", status: "hypothesis", confidence: "high",
  name: "Blue notebook", brand: "Not determined", category: "Notebook",
  description: "A synthetic UI fixture.", observations: ["Blue cover", "Portrait format"],
  needsAnotherView: false, requestedView: "" };

try {
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [], calls = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("ucenth-voice", "on");
    window.voiceProbe = { starts: 0, recognition: false, overlaps: [], tracks: [], states: [] };
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await native(options); voiceProbe.tracks.push(...stream.getTracks()); return stream;
    };
    window.SpeechRecognition = class {
      start() {
        window.currentRecognition = this;
        voiceProbe.recognition = true; voiceProbe.starts++;
        const final = (transcript) => Object.assign([{ transcript }], { isFinal: true });
        // Turn 3 is the Android Chrome pattern from the physical diagnostics: no interim
        // text; every event opens a NEW result index whose text is the whole hypothesis
        // so far (empty placeholders first, exact repeats while still listening).
        if (voiceProbe.starts === 3) {
          const list = [];
          const emit = (text) => { list.push(final(text)); this.onresult?.({ resultIndex: list.length - 1, results: [...list] }); };
          this.timer = setTimeout(() => {
            emit(""); emit(""); emit("Wh"); emit("What ca");
            this.timer = setTimeout(() => {
              emit("What can yo"); emit("What can yo");
              this.timer = setTimeout(() => { emit("What can you see?"); emit("What can you see?"); }, 250);
            }, 250);
          }, 180);
        }
        // Turn 4: a late second segment arrives after the settle timer has already started.
        else if (voiceProbe.starts === 4) this.timer = setTimeout(() => {
          this.onresult?.({ resultIndex: 0, results: [final("What can")] });
          this.timer = setTimeout(() => this.onresult?.({ resultIndex: 1, results: [final("What can"), final("you see?")] }), 500);
        }, 180);
        // Turn 5: the recogniser ends on its own right after accumulated fragments.
        else if (voiceProbe.starts === 5) this.timer = setTimeout(() => {
          this.onresult?.({ resultIndex: 0, results: [final("What can")] });
          this.onresult?.({ resultIndex: 1, results: [final("What can"), final("you see?")] });
          this.onend?.();
        }, 180);
        else if (voiceProbe.starts <= 5) this.timer = setTimeout(() => {
          this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "What can you see?" }], { isFinal: false })] });
          this.timer = setTimeout(() => this.onresult?.({ resultIndex: 0,
            results: [Object.assign([{ transcript: "What can you see?" }], { isFinal: true })] }), 150);
        }, 180);
      }
      abort() { clearTimeout(this.timer); voiceProbe.recognition = false; this.onend?.(); }
    };
    const Native = AudioContext;
    window.AudioContext = class extends Native {
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source);
        source.start = (...args) => {
          voiceProbe.overlaps.push(voiceProbe.recognition || voiceProbe.tracks.some(t => t.kind === "audio" && t.readyState === "live"));
          return start(...args);
        }; return source;
      }
    };
    document.addEventListener("ucenth:voice-state", e => voiceProbe.states.push(e.detail.state));
  });
  let original, speechFails = false, followUpFails = false;
  await page.route("**/api/identify", async route => {
    original = route.request().postDataJSON().image; await route.fulfill({ json: identity });
  });
  await page.route("**/api/follow-up", async route => {
    const body = route.request().postDataJSON(); assert.equal(body.image, original);
    calls.push(body); await route.fulfill({ status: followUpFails ? 503 : 200,
      json: followUpFails ? { error: "Unavailable" } : { answer: "The image shows a blue rectangular cover." } });
  });
  await page.route("**/api/speech", route => route.fulfill(speechFails ?
    { status: 503, json: { error: "Unavailable" } } : { contentType: "audio/wav", body: wav }));
  await page.goto(base);
  await page.locator("#upload").setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: image });
  await page.waitForFunction(() => voiceProbe.starts >= 6, null, { timeout: 40000 });
  assert.equal(calls.length, 5); assert.deepEqual(calls.map(c => c.history.length), [0, 2, 4, 6, 6]);
  // Android-style fragments were joined and sent as one question, not cut off at "What can".
  assert.deepEqual(calls.map(c => c.question), Array(5).fill("What can you see?"));
  assert.ok(await page.evaluate(() => voiceProbe.overlaps.length === 6 && voiceProbe.overlaps.every(x => !x)));
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // A resumed session with no speech must close its tracks and stay paused.
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "LISTENING");
  // A short noise candidate must not cancel the five-second deadline.
  await page.evaluate(() => { currentRecognition.onspeechstart?.(); currentRecognition.onspeechend?.(); });
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "Conversation paused", null, { timeout: 8000 });
  const startsAfterPause = await page.evaluate(() => voiceProbe.starts);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => voiceProbe.starts), startsAfterPause);
  assert.ok(await page.evaluate(() => !voiceProbe.recognition && voiceProbe.tracks.every(t => t.readyState === "ended")));
  await page.getByRole("button", { name: "Continue", exact: true }).evaluate(button => { button.click(); button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "LISTENING");
  assert.equal(await page.evaluate(() => voiceProbe.starts), startsAfterPause + 1);
  await page.waitForTimeout(4700);
  await page.evaluate(() => currentRecognition.onspeechstart?.());
  await page.waitForTimeout(650);
  assert.notEqual(await page.locator(".voice-state").textContent(), "Conversation paused");
  // Finalization clears the speech-start timer; the utterance may outlast five seconds.
  await page.evaluate(() => currentRecognition.onresult({ resultIndex: 0,
    results: [Object.assign([{ transcript: "Describe its shape." }], { isFinal: true })] }));
  await page.waitForFunction(() => voiceProbe.starts >= 9);
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  assert.ok(await page.evaluate(() => !voiceProbe.recognition && voiceProbe.tracks.every(t => t.readyState === "ended")));
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "LISTENING");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.screenshot({ path: `${artifact}/${width}-${theme}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  const type = async text => {
    await page.locator(".voice-typed").evaluate(node => node.open = true);
    await page.getByRole("textbox", { name: "Question about the scanned object" }).fill(text);
    await page.getByRole("button", { name: "Send" }).click();
  };
  // Hold a successful TTS response after Gemini has returned: no early answer reveal.
  let releaseSpeech;
  await page.route("**/api/speech", async route => {
    await new Promise(resolve => { releaseSpeech = resolve; });
    await route.fulfill({ contentType: "audio/wav", body: wav }).catch(() => {});
  });
  await type("Tell me about the cover.");
  while (!releaseSpeech) await page.waitForTimeout(25);
  assert.equal(await page.locator(".voice-state").textContent(), "THINKING");
  assert.equal(await page.locator(".voice-answer").textContent(), "");
  releaseSpeech();
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "VISION SPEAKING");
  assert.match(await page.locator(".voice-answer").textContent(), /blue rectangular/);
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "LISTENING");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.unroute("**/api/speech");
  await page.route("**/api/speech", route => route.fulfill(speechFails ?
    { status: 503, json: { error: "Unavailable" } } : { contentType: "audio/wav", body: wav }));
  speechFails = true; await type("Describe the cover.");
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "Voice unavailable");
  assert.match(await page.locator(".voice-answer").textContent(), /blue rectangular/);
  assert.ok(await page.evaluate(() => voiceProbe.tracks.every(t => t.readyState === "ended")));
  followUpFails = true; await type("What is its size?");
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "FOLLOW UP UNAVAILABLE");
  assert.equal(await page.locator(".voice-form input").inputValue(), "What is its size?");
  // A hung synthesis also releases the successful text within the 25-second budget.
  followUpFails = false;
  let releaseHung;
  await page.route("**/api/speech", async route => {
    await new Promise(resolve => { releaseHung = resolve; });
    await route.abort().catch(() => {});
  });
  await type("Describe the notebook.");
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "Voice unavailable", null, { timeout: 28000 });
  assert.match(await page.locator(".voice-answer").textContent(), /blue rectangular/);
  releaseHung();
  // A late successful synthesis must not resurrect a reset object's answer/audio.
  followUpFails = false;
  let releaseStale;
  await page.route("**/api/speech", async route => {
    await new Promise(resolve => { releaseStale = resolve; });
    await route.fulfill({ contentType: "audio/wav", body: wav }).catch(() => {});
  });
  await type("Describe the object again.");
  while (!releaseStale) await page.waitForTimeout(25);
  assert.equal(await page.locator(".voice-state").textContent(), "THINKING");
  const playbacksBeforeReset = await page.evaluate(() => voiceProbe.overlaps.length);
  await page.locator("#reset").click(); releaseStale();
  await page.waitForTimeout(700);
  assert.equal(await page.locator(".voice-panel").count(), 0);
  assert.equal(await page.evaluate(() => voiceProbe.overlaps.length), playbacksBeforeReset);
  await page.unroute("**/api/speech");
  await page.route("**/api/speech", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.locator("#upload").setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: image });
  await page.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "Voice unavailable");
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  assert.equal(await page.locator(".voice-field canvas").count(), 0);
  await page.locator("#reset").click();
  assert.equal(await page.locator(".voice-panel").count(), 0);
  assert.deepEqual(errors, []);
  // iOS Safari lifecycle: the native recogniser aborts a few milliseconds after start.
  // The session must fall back to recorded clips once, remember that for the page, and
  // start the NEXT conversation directly on the server path without a native attempt.
  // An iPhone user agent so the mobile rules apply (no desktop analyser stream on the
  // native path, iOS keepalive on the recorded-clip path).
  const iosContext = await browser.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
  const ios = await iosContext.newPage(); const iosErrors = [];
  ios.on("pageerror", e => iosErrors.push(e.message));
  await ios.addInitScript(() => {
    localStorage.setItem("ucenth-voice", "on");
    window.diagLog = []; window.nativeStarts = 0; window.silentNext = false; window.micCalls = 0;
    document.addEventListener("ucenth:voice-diag", e => window.diagLog.push(e.detail));
    // After an idle period iOS can hand back a live, unmuted track that carries only
    // digital zeros. One call can be made to behave that way from the test.
    const realMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      window.micCalls++;
      if (window.silentNext) { window.silentNext = false; return new AudioContext().createMediaStreamDestination().stream; }
      return realMic(options);
    };
    window.SpeechRecognition = class {
      start() { window.nativeStarts++; setTimeout(() => this.onstart?.(), 0); setTimeout(() => this.onaudiostart?.(), 2); setTimeout(() => this.onerror?.({ error: "aborted" }), 7); }
      abort() {}
    };
  });
  await ios.route("**/api/identify", route => route.fulfill({ json: identity }));
  await ios.route("**/api/speech", route => route.fulfill({ contentType: "audio/wav", body: wav }));
  await ios.route("**/api/transcribe", route => route.fulfill({ json: { text: "Can you still hear me clearly?" } }));
  await ios.route("**/api/follow-up", route => route.fulfill({ json: { answer: "Yes.", userSuppliedIdentity: "" } }));
  await ios.goto(base);
  await ios.locator("#upload").setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: image });
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "fallback" && d.because === "aborted" && d.remembered === true), null, { timeout: 20000 });
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "listen" && d.path === "server"), null, { timeout: 10000 });
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "audio-context"), null, { timeout: 10000 });
  assert.equal(await ios.evaluate(() => window.nativeStarts), 1);
  // Second conversation on the same page: straight to the server path, no native start.
  await ios.locator("#reset").click();
  await ios.locator("#upload").setInputFiles({ name: "fixture-2.jpg", mimeType: "image/jpeg", buffer: image });
  await ios.waitForFunction(() => window.diagLog.filter(d => d.event === "listen").length >= 3, null, { timeout: 20000 });
  const listens = await ios.evaluate(() => window.diagLog.filter(d => d.event === "listen").map(d => `${d.path}:${d.nativeUnusable}`));
  assert.deepEqual(listens.slice(-1), ["server:true"], `second conversation skipped the native recogniser (${listens.join(", ")})`);
  assert.equal(await ios.evaluate(() => window.nativeStarts), 1, "no second native attempt on this page");
  await ios.waitForFunction(() => window.diagLog.filter(d => d.event === "audio-context").length >= 2, null, { timeout: 10000 });
  assert.ok(await ios.evaluate(() => window.diagLog.filter(d => d.event === "audio-context").every(d => ["before", "after", "resumed"].every(k => k in d))), "audio-context diagnostics carry before/after/resumed");
  // Resume after idle with a stale microphone: the probe sees digital silence, the audio
  // graph is rebuilt, a fresh stream is requested, and samples flow on the second try.
  await ios.waitForFunction(() => document.querySelector(".voice-state")?.textContent === "LISTENING", null, { timeout: 10000 });
  // The iOS keepalive tone runs only while the recorded-clip path holds a microphone.
  assert.ok(await ios.evaluate(() => window.diagLog.some(d => d.event === "keepalive" && d.on === true)), "keepalive started before the microphone was requested");
  await ios.getByRole("button", { name: "End conversation", exact: true }).click();
  await ios.waitForFunction(() => document.querySelector(".voice-panel")?.dataset.state === "CONVERSATION_ENDED");
  assert.equal(await ios.evaluate(() => window.diagLog.filter(d => d.event === "keepalive").at(-1).on), false, "keepalive released with the microphone");
  const micCallsBefore = await ios.evaluate(() => window.micCalls);
  await ios.evaluate(() => { window.silentNext = true; });
  await ios.getByRole("button", { name: "Resume", exact: true }).click();
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "microphone.silent"), null, { timeout: 10000 });
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "audio-context.recreated"), null, { timeout: 10000 });
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "microphone.signal"), null, { timeout: 10000 });
  const recovery = await ios.evaluate(() => window.diagLog.filter(d => ["microphone.silent", "audio-context.recreated", "microphone.signal"].includes(d.event)).map(d => d.event));
  assert.deepEqual(recovery, ["microphone.silent", "audio-context.recreated", "microphone.signal"], "one silent probe, one rebuild, then a live signal");
  assert.equal(await ios.evaluate(() => window.micCalls), micCallsBefore + 2, "a fresh stream was requested after the stale one");
  assert.ok(await ios.evaluate(() => window.diagLog.find(d => d.event === "microphone.signal").peak > 0));
  assert.ok(["LISTENING", "USER SPEAKING"].includes(await ios.locator(".voice-state").textContent()), "listening continues on the recovered microphone");
  // Stalled output after idle (seen physically on iOS 18.6): the context says running
  // but renders zeros. The next answer's first playback is made silent; the probe must
  // rebuild the graph and replay the same audio exactly once, ending once.
  await ios.evaluate(() => {
    window.silentPlaybacks = 1; // the next buffer source plays a zero buffer
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this);
      const descriptor = Object.getOwnPropertyDescriptor(AudioBufferSourceNode.prototype, "buffer");
      Object.defineProperty(source, "buffer", { set(buffer) {
        if (window.silentPlaybacks > 0) { window.silentPlaybacks--; buffer = this.context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate); }
        descriptor.set.call(this, buffer);
      }, get() { return descriptor.get.call(this); } });
      return source;
    };
  });
  const playbackEndsBefore = await ios.evaluate(() => window.diagLog.filter(d => d.event === "playback-restart").length);
  await ios.locator(".voice-typed").evaluate(node => node.open = true);
  await ios.getByRole("textbox", { name: "Question about the scanned object" }).fill("Say that again.");
  await ios.getByRole("button", { name: "Send" }).click();
  await ios.waitForFunction(() => window.diagLog.some(d => d.event === "playback.silent"), null, { timeout: 15000 });
  await ios.waitForFunction(() => document.querySelector(".voice-panel")?.dataset.state === "IDLE" || ["LISTENING", "USER SPEAKING", "OPENING MICROPHONE"].includes(document.querySelector(".voice-state")?.textContent), null, { timeout: 15000 });
  const outputRecovery = await ios.evaluate(() => window.diagLog.filter(d => ["playback.silent", "audio-context.recreated"].includes(d.event)).map(d => d.event));
  assert.deepEqual(outputRecovery.slice(-2), ["playback.silent", "audio-context.recreated"], "silent first playback rebuilt the graph once");
  assert.equal(await ios.evaluate(() => window.diagLog.filter(d => d.event === "playback.silent").length), 1, "no recovery loop");
  assert.ok((await ios.evaluate(() => window.diagLog.filter(d => d.event === "playback").length)) >= 2, "the replay was probed too");
  assert.ok((await ios.evaluate(() => window.diagLog.filter(d => d.event === "playback").at(-1).rms)) > 0, `the replay carried signal (${await ios.evaluate(() => JSON.stringify(window.diagLog.filter(d => ["playback", "playback.silent", "audio-context.recreated", "error", "state"].includes(d.event)).slice(-12)))})`);
  assert.equal(playbackEndsBefore, 0);
  assert.deepEqual(iosErrors, []);
  console.log("Voice Chrome checks passed: five mock turns, original image, bounded history, no mic/playback overlap, themes/layout, failure/reset cleanup, iOS fallback memory and stale-microphone recovery.");
} finally { await browser.close(); }
