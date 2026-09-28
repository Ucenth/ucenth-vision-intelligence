/* UCENTH Vision Intelligence — UCENTH, Universal Central Host. */
import { StabilityTracker } from "./lib/stability.js";
const $ = (id) => document.getElementById(id);
const video = $("camera"),
  capture = $("capture"),
  edges = $("edges"),
  stage = $("stage");
const tracker = new StabilityTracker();
const sample = document.createElement("canvas");
sample.width = 48;
sample.height = 48;
const sampleContext = sample.getContext("2d", { willReadFrequently: true });
// Module state. "generation" is a counter bumped on every reset: async work captures
// the current value and checks it later, so a late camera permission, a slow Gemini
// answer or an old upload can never overwrite a newer scan. "phase" drives the CSS
// hooks on the stage (idle → live → locking → scanning → results | error).
let stream = null,
  timer = null,
  phase = "idle",
  generation = 0,
  controller = null;
/**
 * Updates the status line only when the text changes. The element has role="status",
 * so avoiding redundant writes keeps screen readers from repeating the same phrase.
 */
function status(text) {
  if ($("state-label").textContent !== text)
    $("state-label").textContent = text;
}
/**
 * Keeps the square capture guide the same size as the region crop() will cut out.
 * The guide is presentation only; crop() is what decides which pixels are sent.
 */
function alignGuide() {
  if (!video.videoWidth || !["live", "locking"].includes(phase)) return;
  const scale = Math.min(
    stage.clientWidth / video.videoWidth,
    stage.clientHeight / video.videoHeight,
  );
  const size = Math.min(video.videoWidth, video.videoHeight) * 0.84 * scale;
  const target = stage.querySelector(".target");
  target.style.width = `${size}px`;
  target.style.height = `${size}px`;
}
new ResizeObserver(alignGuide).observe(stage);
// Releasing tracks switches off the physical webcam, not just the video element.
function stopStream() {
  clearInterval(timer);
  timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $("stop").hidden = true;
  $("status-dot").classList.remove("active");
}
/**
 * Single place that changes the scanner phase. CSS reacts to the .locking and .scanning
 * classes (target corners, scan line); JavaScript reads "phase" to ignore stale events.
 */
function setPhase(value) {
  phase = value;
  stage.classList.toggle("locking", value === "locking");
  stage.classList.toggle("scanning", value === "scanning");
  if (value === "idle") {
    const target = stage.querySelector(".target");
    target.style.removeProperty("width");
    target.style.removeProperty("height");
  }
}
/**
 * Returns [x, y, width, height] of the centered square that is 84% of the shorter side.
 * Using the same rule for the guide, the stability sample and the capture means the user
 * sees exactly what Gemini will receive.
 */
function crop(source) {
  const w = source.videoWidth || source.naturalWidth || source.width,
    h = source.videoHeight || source.naturalHeight || source.height;
  const side = Math.min(w, h) * 0.84;
  return [(w - side) / 2, (h - side) / 2, side, side];
}
/**
 * Every failure path ends here with a readable message and a way forward (Scan another
 * object). Raw provider errors never reach the page; the server already sanitized them.
 */
function showError(message) {
  setPhase("error");
  edges.hidden = true;
  $("countdown").hidden = true;
  $("instructions").hidden = true;
  $("results").hidden = false;
  $("results").replaceChildren();
  addText("p", "SEARCH PAUSED", "result-state");
  addText("h2", message, "error-title");
  $("reset").hidden = false;
  $("start").hidden = true;
  $("upload-label").hidden = true;
  status("SCAN PAUSED");
}
/**
 * Small DOM helper. textContent (never innerHTML) is used everywhere results are rendered,
 * so text that came from a model or a document cannot inject markup or scripts.
 */
function addText(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  $("results").append(el);
  return el;
}

// A generation token prevents a late permission response from restarting a stopped camera.
/**
 * Opens the webcam. Browsers only allow getUserMedia() from a secure context (localhost
 * or HTTPS) and prompt the user for permission, so this must run from a click.
 * facingMode "environment" prefers a rear camera on phones; laptops fall back to the
 * single webcam. The stream stays inside the browser: no frame leaves until capture.
 */
async function startCamera() {
  const token = ++generation;
  $("start").disabled = true;
  $("upload-label").hidden = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Camera access requires localhost or HTTPS.");
    // how-to:start camera-access
    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 960 },
        facingMode: "environment",
      },
    });
    if (token !== generation) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = media;
    video.srcObject = media;
    await video.play();
    // how-to:end camera-access
    if (token !== generation) {
      stopStream();
      return;
    }
    video.hidden = false;
    $("empty-state").hidden = true;
    $("start").hidden = true;
    $("stop").hidden = false;
    $("status-dot").classList.add("active");
    $("camera-label").textContent = "CAMERA LIVE";
    $("hint").textContent =
      "Keep the frame empty briefly, then bring your object into the center. Hold the front label toward the camera.";
    tracker.reset();
    setPhase("live");
    alignGuide();
    status("KEEP FRAME EMPTY · CALIBRATING");
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (["live", "locking"].includes(phase)) {
        stopStream();
        showError("The camera disconnected. Reconnect it and try again.");
      }
    });
    timer = setInterval(analyzeFrame, 100);
  } catch (error) {
    stopStream();
    const messages = {
      NotAllowedError:
        "Camera access was denied. Allow camera access in Chrome, then try again.",
      NotFoundError:
        "No camera was found. Connect a webcam or upload an image.",
      NotReadableError:
        "The camera is busy. Close other apps using it and try again.",
    };
    showError(
      messages[error.name] ||
        "The camera could not start. Check its connection and browser permissions.",
    );
    $("upload-label").hidden = false;
  } finally {
    $("start").disabled = false;
  }
}
/**
 * Runs ten times a second while the camera is live. It draws the center crop into a
 * 48×48 canvas, converts it to grayscale and hands that tiny frame to StabilityTracker.
 * Working at 48×48 is deliberate: it is cheap enough for any laptop, tolerant of sensor
 * noise, and needs no machine-learning model. Motion, not meaning, decides when to capture.
 */
function analyzeFrame() {
  if (!["live", "locking"].includes(phase) || !video.videoWidth) return;
  sampleContext.drawImage(video, ...crop(video), 0, 0, 48, 48);
  const pixels = sampleContext.getImageData(0, 0, 48, 48).data;
  const gray = new Uint8Array(48 * 48);
  for (let i = 0; i < gray.length; i++)
    gray[i] =
      pixels[i * 4] * 0.299 +
      pixels[i * 4 + 1] * 0.587 +
      pixels[i * 4 + 2] * 0.114;
  const result = tracker.update(gray, performance.now());
  $("countdown").hidden = result.state !== "locking";
  setPhase(result.state === "locking" ? "locking" : "live");
  const labels = {
    calibrating: "KEEP FRAME EMPTY · CALIBRATING",
    waiting: "SHOW ME AN OBJECT",
    moving: "HOLD THE OBJECT STEADY",
    found: "OBJECT FOUND",
    steady: "HOLD STEADY",
    locking: "LOCKING",
  };
  status(labels[result.state] || "CAPTURING");
  if (result.remaining) $("countdown").textContent = result.remaining;
  if (result.state === "capture") captureSource(video);
}
// Draw the visual scan on a separate canvas. The photograph stays untouched.
/**
 * Sobel edge detection drawn on a second canvas for the "scan" treatment. It is purely
 * visual: the untouched capture canvas is what was already sent to the server.
 */
function makeEdges() {
  edges.width = capture.width;
  edges.height = capture.height;
  const ctx = edges.getContext("2d"),
    source = capture
      .getContext("2d")
      .getImageData(0, 0, capture.width, capture.height);
  const output = ctx.createImageData(source.width, source.height),
    w = source.width;
  const gray = new Uint8Array(w * source.height);
  for (let i = 0; i < gray.length; i++)
    gray[i] =
      (source.data[i * 4] + source.data[i * 4 + 1] + source.data[i * 4 + 2]) /
      3;
  for (let y = 1; y < source.height - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x,
        gx =
          -gray[i - w - 1] +
          gray[i - w + 1] -
          2 * gray[i - 1] +
          2 * gray[i + 1] -
          gray[i + w - 1] +
          gray[i + w + 1],
        gy =
          -gray[i - w - 1] -
          2 * gray[i - w] -
          gray[i - w + 1] +
          gray[i + w - 1] +
          2 * gray[i + w] +
          gray[i + w + 1];
      const strength = Math.min(255, Math.hypot(gx, gy));
      output.data[i * 4] = strength * 0.43;
      output.data[i * 4 + 1] = strength * 0.7;
      output.data[i * 4 + 2] = strength;
      output.data[i * 4 + 3] = 255;
    }
  ctx.putImageData(output, 0, 0);
}
// Grab one clean frame before stopping the camera. The user can remove the
// physical subject while this canvas stays visible during cloud identification.
/**
 * Captures exactly one frame and starts identification.
 *
 * 1. drawImage() copies the video (or an uploaded image) onto the capture canvas.
 * 2. toDataURL("image/jpeg", 0.88) turns those pixels into a JPEG the server can decode.
 * 3. fetch() posts it to /api/identify BEFORE any visual effect is drawn, so the
 *    request is never delayed by animation and the effect can never alter the pixels.
 * 4. The camera tracks are stopped right after capture (privacy and battery).
 *
 * An AbortController plus a 30 s timer bounds the request, and the generation token
 * captured at the start makes a late response harmless if the user reset meanwhile.
 */
async function captureSource(source) {
  if (["scanning", "results"].includes(phase)) return;
  setPhase("scanning");
  clearInterval(timer);
  $("countdown").hidden = true;
  $("upload-label").hidden = true;
  $("start").hidden = true;
  $("reset").hidden = true;
  let timeout;
  try {
    const region =
      source === video
        ? crop(source)
        : [0, 0, source.naturalWidth, source.naturalHeight];
    if (!region[2]) throw new Error("Empty frame");
    const scale = Math.min(900 / region[2], 900 / region[3], 1);
    capture.width = Math.round(region[2] * scale);
    capture.height = Math.round(region[3] * scale);
    // how-to:start camera-capture
    capture
      .getContext("2d")
      .drawImage(source, ...region, 0, 0, capture.width, capture.height);
    const image = capture.toDataURL("image/jpeg", 0.88);
    capture.hidden = false;
    video.hidden = true;
    $("empty-state").hidden = true;
    // Send the untouched captured frame before scan effects or optional visual work.
    const token = generation;
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), 30000);
    const pendingResponse = fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      signal: controller.signal,
    });
    pendingResponse.catch(() => {}); // Still awaited below; avoid an unhandled rejection if an effect throws.
    stopStream();
    // how-to:end camera-capture
    $("camera-label").textContent = "CAPTURE PRESERVED";
    $("frame-label").textContent = "STILL IMAGE";
    $("capture-label").textContent = "02 / IDENTIFY";
    makeEdges();
    edges.hidden = false;
    status("SCANNING OBJECT");
    $("instructions").hidden = true;
    $("results").hidden = false;
    $("results").replaceChildren();
    addText("p", "INVESTIGATING", "result-state");
    addText("h2", "Looking beyond the surface.");
    addText(
      "p",
      "Reading visible features and identifying details. Your captured object stays here.",
      "description",
    );
    $("hint").textContent =
      "You can remove the object now. The scan is a visual treatment of your saved frame.";
    const searching = setTimeout(() => {
      if (token === generation && phase === "scanning")
        status("IDENTIFYING OBJECT…");
    }, 2200);
    try {
      const response = await pendingResponse;
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(
          "The scanner backend is unavailable. Start the local server and try again.",
        );
      }
      if (!response.ok)
        throw new Error(data.error || "The search could not be completed.");
      if (token === generation) await displayResult(data, token);
    } catch (error) {
      if (token === generation)
        showError(
          error.name === "AbortError"
            ? "The search timed out. Check your connection and try again."
            : error instanceof TypeError
              ? "Cannot reach the scanner server. Check your connection and restart the local server."
              : error.message,
        );
    } finally {
      clearTimeout(timeout);
      clearTimeout(searching);
      controller = null;
    }
  } catch {
    controller?.abort();
    stopStream();
    showError("This frame could not be captured. Please try again.");
  } finally {
    clearTimeout(timeout);
  }
}
/**
 * Routes the structured result by subjectType. Objects and people render here; a
 * photographed document is handed to document.js with the same clean capture so the
 * document pipeline can extract text, language and translation.
 */
async function displayResult(data, token) {
  // Routing: a photographed document continues in Document Intelligence with the same
  // clean capture; objects and people keep their existing presentations.
  if (data.subjectType === "document") {
    setPhase("results");
    edges.hidden = true;
    document.dispatchEvent(
      new CustomEvent("ucenth:document-image", {
        detail: {
          image: capture.toDataURL("image/jpeg", 0.88),
          identification: data,
        },
      }),
    );
    return;
  }
  return displayIdentity(data, token);
}
/**
 * Renders the identification report from structured JSON. Because the server validated
 * the shape, this function can be simple: it never parses prose. Two presentations
 * share the layout: objects (brand/category) and people (role and the contextual basis
 * line, never a face-based guess). It finishes by dispatching "ucenth:result-presented"
 * so voice.js can start the conversation without the two files importing each other.
 */
async function displayIdentity(data, token) {
  setPhase("results");
  edges.hidden = true;
  $("results").replaceChildren();
  $("results").closest(".workspace").classList.add("has-result");
  // Contextual person intelligence: identity comes from supplied context, never from a face.
  const person = data.subjectType === "person";
  const personState = data.identityEstablished
    ? "PERSON IDENTIFIED"
    : "PERSON DETECTED";
  status(
    person
      ? personState
      : data.needsAnotherView
        ? "MORE DETAIL NEEDED"
        : "LIKELY IDENTITY",
  );
  $("capture-label").textContent = "03 / IDENTITY";
  addText(
    "p",
    person
      ? personState
      : data.needsAnotherView
        ? "MORE DETAIL NEEDED"
        : "LIKELY IDENTIFICATION",
    "result-state",
  );
  addText("h2", data.name, "identity-name");
  if (person) {
    if (data.identityEstablished && data.roleOrTitle)
      addText("p", data.roleOrTitle, "identity-meta identity-role");
    addText(
      "p",
      data.identityEstablished
        ? identitySourceLabel(data.identitySource)
        : "Identity not established from the available context.",
      "identity-meta identity-basis",
    );
  } else {
    const list = document.createElement("dl");
    list.className = "identity-meta";
    for (const [label, value] of [
      ["Brand", data.brand || "Not determined"],
      ["Category", data.category || "Not determined"],
    ]) {
      const pair = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      pair.append(dt, dd);
      list.append(pair);
    }
    $("results").append(list);
  }
  addText(
    "p",
    person
      ? data.identityEstablished
        ? "Identified from contextual information supplied with the image, not from facial appearance."
        : "The person is the primary subject; the surrounding objects provide scene context."
      : data.category === "Human"
        ? "The person is the primary subject; the surrounding objects provide scene context."
        : data.needsAnotherView
          ? "Visible details suggest this identity. Another view is needed to confirm the model or variant."
          : "A likely match based on visible shape, markings and label details.",
    "identity-explanation",
  );
  const observations = selectObservations(data.observations || []);
  if (observations.length) {
    addText("h3", "What I can see", "analysis-heading");
    const ol = document.createElement("ol");
    ol.className = "observations";
    for (const detail of observations.slice(0, 4)) {
      const li = document.createElement("li");
      li.textContent = compactObservation(detail);
      ol.append(li);
    }
    $("results").append(ol);
  }
  if (data.needsAnotherView) {
    const next = document.createElement("section");
    next.className = "next-view";
    next.setAttribute("aria-labelledby", "next-view-title");
    const heading = document.createElement("h3");
    heading.id = "next-view-title";
    heading.textContent = "Next view";
    const instruction = document.createElement("p");
    instruction.textContent = data.requestedView;
    next.append(heading, instruction);
    $("results").append(next);
  }
  const details = document.createElement("details");
  details.className = "identification-notes";
  const summary = document.createElement("summary");
  summary.textContent = "View full analysis";
  const note = document.createElement("p");
  note.textContent = data.description;
  let evidence = null;
  if (person && data.identityEstablished && data.identityEvidence) {
    evidence = document.createElement("p");
    evidence.className = "identity-evidence";
    evidence.textContent = `Contextual evidence: ${data.identityEvidence}`;
  }
  const basis = document.createElement("p");
  basis.textContent = person
    ? "Names come only from context supplied with the image, such as captions or page text; UCENTH Vision Intelligence does not recognize faces."
    : "A visual assessment of your original photograph, not an independently verified web match.";
  details.append(summary);
  if (observations.length) {
    const heading = document.createElement("h3");
    heading.textContent = "All visible details";
    const fullList = document.createElement("ol");
    fullList.className = "full-observations";
    for (const observation of observations) {
      const item = document.createElement("li");
      item.textContent = observation;
      fullList.append(item);
    }
    details.append(heading, fullList);
  }
  details.append(note, ...(evidence ? [evidence] : []), basis);
  $("results").append(details);
  if (token !== generation) return;
  $("reset").hidden = false;
  $("hint").textContent = "";
  document.dispatchEvent(
    new CustomEvent("ucenth:result-presented", {
      detail: {
        status: data.status,
        confidence: data.confidence,
        needsAnotherView: data.needsAnotherView,
        identification: data,
      },
    }),
  );
}
// Presentation only: keep original wording, remove duplicates, prefer identifying
// marks and distinctive construction over generic finish/color descriptions.
/**
 * Presentation ranking only: prefer observations that mention marks, labels or
 * distinctive parts, and drop duplicates. The complete list stays in the disclosure.
 */
function selectObservations(items) {
  const unique = [
    ...new Map(
      items
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => [x.toLowerCase().replace(/[^a-z0-9]/g, ""), x.trim()]),
    ).values(),
  ];
  const score = (text) =>
    (/logo|brand|label|printed|model|title|author|marking/i.test(text)
      ? 3
      : 0) +
    (/lens|camera|notch|key|layout|pump|lever|display|port|shape|cap|spine/i.test(
      text,
    )
      ? 2
      : 0);
  return unique
    .map((text, index) => ({ text, index, score: score(text) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.text);
}
// Only shorten known descriptive constructions; preserve quoted markings verbatim.
// The complete original observations remain in the full-analysis disclosure.
/**
 * Maps the machine-readable evidence source to the restrained line shown under a
 * contextually identified person ("Identified from page context").
 */
function identitySourceLabel(source) {
  return {
    caption: "Identified from a caption",
    visible_text: "Identified from visible text",
    page_context: "Identified from page context",
  }[source] || "Identified from supplied context";
}
function compactObservation(text) {
  return text
    .replace(/^Prominent /, "")
    .replace(
      /\brectangular (label (?:band|section)|banner|block) (?:with|reading|labeled) (['"])(.+?)\2(?: text)?/i,
      "“$3” label",
    )
    .replace(
      /\b(?:label (?:block|banner)) reading (['"])(.+?)\1/i,
      "“$2” label",
    )
    .replace(/\b(?:badge|marking) reading (['"])(.+?)\1/i, "“$2” marking")
    .replace(/\blogo header\b/, "logo");
}
// Invalidate pending work before resetting UI so a late result cannot replace a new scan.
/**
 * Full reset in a careful order: tell the other modules first ("ucenth:scan-reset"),
 * bump the generation so in-flight work is ignored, abort the request, release the
 * camera, then restore the idle interface. Session data such as the document context
 * and conversation history is cleared by the listeners in voice.js and document.js.
 */
function clear() {
  document.dispatchEvent(new Event("ucenth:scan-reset"));
  $("results").closest(".workspace").classList.remove("has-result");
  generation++;
  controller?.abort();
  controller = null;
  stopStream();
  setPhase("idle");
  tracker.reset();
  video.hidden = true;
  capture.hidden = true;
  edges.hidden = true;
  $("countdown").hidden = true;
  $("empty-state").hidden = false;
  $("instructions").hidden = false;
  $("results").hidden = true;
  $("results").replaceChildren();
  $("reset").hidden = true;
  $("start").hidden = false;
  $("start").disabled = false;
  $("upload-label").hidden = false;
  $("upload").value = "";
  $("camera-label").textContent = "CAMERA OFF";
  $("frame-label").textContent = "CENTER FRAME";
  $("capture-label").textContent = "01 / LIVE INPUT";
  status("READY WHEN YOU ARE");
  $("hint").textContent =
    "Camera frames stay on your device until capture. One captured image is sent to Google for identification.";
}
$("start").addEventListener("click", startCamera);
$("stop").addEventListener("click", clear);
$("reset").addEventListener("click", () => {
  clear();
  startCamera();
});
// One upload control, two destinations. PDF and Word files bypass the camera pipeline
// and go straight to document intelligence; images take the same capture path as the
// webcam so the identification step can decide whether they show an object, a person
// or a document. The checks here are for a friendly message only: the server validates
// every byte again by its real content, never by name or declared type.
$("upload").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  // PDF and Word files skip the camera pipeline and go straight to Document Intelligence.
  const documentFile =
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ].includes(file.type) || /\.(pdf|docx)$/i.test(file.name);
  if (documentFile) {
    clear();
    $("upload-label").hidden = true;
    $("start").hidden = true;
    document.dispatchEvent(
      new CustomEvent("ucenth:document-file", { detail: { file } }),
    );
    return;
  }
  if (
    !["image/jpeg", "image/png"].includes(file.type) ||
    file.size > 2 * 1024 * 1024
  ) {
    showError(
      "Choose a JPEG or PNG smaller than 2 MB, or a PDF or Word (.docx) file.",
    );
    return;
  }
  clear();
  $("upload-label").hidden = true;
  const token = generation,
    url = URL.createObjectURL(file),
    img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (token === generation) await captureSource(img);
  } catch {
    showError("This image could not be opened. Choose another JPEG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
  }
});
// Leaving the page must release the camera and cancel network work immediately.
window.addEventListener("pagehide", () => {
  generation++;
  controller?.abort();
  stopStream();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && ["live", "locking"].includes(phase)) {
    clear();
    $("hint").textContent =
      "Camera paused while the page was hidden. Start again when you’re ready.";
  }
});
