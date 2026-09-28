# UCENTH Vision Intelligence architecture

## Scanner and conversation

The existing scanner owns camera permission, stability, countdown, capture, the visual scan treatment and identification. Its original unmodified JPEG is sent to `/api/identify`. The identification prompt and parser remain in `lib/identity-prompt.js` and `lib/gemini.js`.

`script.js` emits `ucenth:result-presented` with the identification and `ucenth:scan-reset` on reset. `voice.js` uses those events and a read-only copy of the preserved capture to attach conversation.

`lib/viewport-guide.js` moves the viewport on the single-column (phone) layout for exactly two transitions: a live camera after Open Camera, and a rendered result. A transition is armed by the person's action and fulfilled only when the destination exists; a manual scroll while it is pending cancels it, a focused text field suppresses it, reduced motion makes it instant, the layout is read from the workspace grid, and the header offset is a CSS `scroll-margin-top`. Focus is never moved. Decisions are announced as `ucenth:viewport-guide`. The original confirmation chime exposes a completion promise so Charon's introduction follows it without changing the chime.

Conversation states are LISTENING → USER_SPEAKING → THINKING → VISION_SPEAKING → IDLE → LISTENING. User controls and failures have explicit states. Interim browser transcripts appear near the particle field. A final transcript submits one question. THINKING includes both Gemini generation and Charon preparation. The answer is held internally until decoded audio is ready, then revealed immediately before playback. A speech failure or 25-second preparation timeout reveals the successful text answer instead.

Each listening period has a five-second speech-start deadline. The browser recognizer's speech-start classification is debounced for 200 ms; an interim or final transcript also confirms speech. A short speech-end cancels a pending candidate. Raw amplitude from the particle analyser does not reset the deadline. A candidate arriving near the deadline may finish only its existing debounce window. Confirmed speech cancels the deadline, without imposing a five-second utterance limit. Silence or recognition ending without a final result stops tracks and recognition and enters CONVERSATION_PAUSED. Only deliberate Continue conversation or a new typed question resumes the loop. Speech recognition is probabilistic; physical noise/echo acceptance remains required.

## Contextual person intelligence

The identification schema carries `subject_type`, `person_identity_established`, `person_identity_name`, `person_identity_source` (visible_text, caption, page_context or none), `person_identity_evidence`, `person_role_or_title` and `scene_description`. The prompt forbids identification from facial appearance and allows a name only when context inside the image is clearly associated with the pictured person. `summarizeIdentity` keeps a name only when the model also reports an explicit source and evidence; otherwise the result is a detected person with an empty name, so a stray or hallucinated name cannot reach the interface. The server-built `conversationIntro` is deterministic for both outcomes. The result panel shows PERSON IDENTIFIED with the role and a short basis line, or PERSON DETECTED with a not-established line; evidence sits inside the details disclosure. Follow-up requests carry the flags; the follow-up model may use an established name, must not guess otherwise, and reports a name the user explicitly supplies in `user_supplied_person_name`, which the client then sends back as `identitySource: "user_context"`, never as established identity. No face library, embeddings or biometric data are involved.

## Document intelligence

Routing: PDF and Word uploads go straight to `/api/document`; camera and image inputs run the existing identification first, and a `subject_type` of `document` hands the same clean capture to `/api/document`. The identification prompt treats a resume or form with a portrait as a document, while a webpage whose pictured person is the subject stays a person and packaging or a book cover stays an object.

`lib/document.js` validates every upload by magic bytes (`%PDF-`, JPEG and PNG signatures, or a ZIP whose central directory names `word/document.xml`) and rejects declared-type or extension mismatches, so a renamed file cannot choose its parser. Files are buffered in memory only; no temporary files exist and the display name is never used as a path. PDF.js runs with `isEvalSupported: false` and no rendering, fonts or scripting sandbox: it only counts pages and extracts text. A page with fewer than 20 non-space characters is treated as scanned. Text pages travel to Gemini as extracted text (cheaper and chunkable, benchmarked at roughly 30% fewer input tokens than the native PDF path for the same file); when scanned pages exist the PDF itself is attached so Gemini reads those pages, and the two are merged by page number. mammoth converts DOCX XML to HTML, which is reduced to plain text that keeps headings, list items and table rows; macros, OLE objects and embedded images are never executed or analyzed.

Limits, chosen after benchmarking request size, output-token cost and latency: PDF 15 MB and 60 pages, at most 25 scanned pages, DOCX 10 MB, 200,000 characters of extracted text, and 20,000 characters translated in the first pass. Larger files receive an explicit message rather than silent truncation, and untranslated pages are labelled in the interface and can be translated on request in conversation. The analysis asks Gemini only for what the file cannot provide: classification, language, summary, grounded fields, warnings, transcription of scanned pages and translation of the selected pages. Locally extracted text always wins over model transcription, English documents get no translation, and a value the model did not print in a field is not shown.

The result renders type, language, pages, summary and key details first, then the Original / English tabs (one page at a time, bounded height, `dir` and `lang` following the text shown) and a details disclosure. Follow-up requests carry the bounded document context (text, translation, summary, fields) instead of an image, so the file is not re-analyzed per question; the context lives only in browser memory for the session and is cleared on reset.

## Separate cloud requests

- `/api/follow-up`: original image, current identity, question (up to 700 characters) and at most six recent messages. A separate Gemini 3.8 Flash instruction scopes answers to the captured subject and preserves uncertainty. It does not alter the identification pipeline.
- `/api/speech`: up to 1,800 characters of answer text. Server-side ADC calls Cloud Text-to-Speech using `en-US-Chirp3-HD-Charon`, `en-US`, `LINEAR16`. The browser receives WAV audio, never credentials. No alternate voice is substituted.
- Browser SpeechRecognition: the browser provider handles transcription and may process microphone audio remotely. The application has no microphone-upload endpoint and does not use MediaRecorder.

New routes independently validate inputs, enforce origin, body limits, concurrency and request rates, and return sanitized errors. Images are decoded for validation but their original bytes are passed to Gemini. No captured image, transcript or audio file is intentionally persisted during normal use.

## Audio and renderer lifecycle

An AudioContext is unlocked by camera/upload interaction. Microphone audio connects to an AnalyserNode without connecting to the speakers. Charon's decoded buffer connects through a separate AnalyserNode to the output. Before playback, recognition is aborted and microphone tracks stop. Only the buffer's actual `ended` event starts the echo-guard timer before listening resumes.

The reviewed WebGL2 renderer preserves immutable point geometry and GPU shader deformation. RMS controls overall response; low, mid and high bands produce different surface motion. Attack/release smoothing and a noise gate allow relaxation in silence. IDLE/THINKING motion is procedural and does not pretend to be speech. Quality caps bound device pixel ratio, particle count and frame rate; reduced-motion and Canvas fallback paths remain available.

One renderer exists per active conversation. End/reset disposes animation callbacks, observers and GPU resources. Pending requests use cancellation and turn identifiers to prevent stale answers or playback after reset. Recent history is bounded and cleared when the conversation ends; the captured object remains available until the scanner resets.

## Verification boundaries

Automated browser tests can verify state ordering, lifecycle, data preservation and failure handling using explicit mocked recognition and cloud responses. They do not prove physical echo safety or speech-recognition reliability. A release also requires a real camera scan and five consecutive microphone/speaker turns with actual cloud responses. Private transcripts, captures and benchmark evidence belong outside the public release.
