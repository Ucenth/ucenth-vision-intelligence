# UCENTH Vision Intelligence — hosted production layer

This directory is UCENTH's operational layer for `vision.ucenth.com`. It is **not** part of the educational source ZIP (the release allowlist in `scripts/release-files.js` never lists `production/`, `Procfile` or `test/production.test.js`, and `test/production.test.js` enforces that). Students run the educational edition with their own Google Cloud project and no public quota.

```
vision.ucenth.com → Cloud Run → production/server.js
                                  ├── server.js (the educational core, unchanged behaviour)
                                  └── production/ middleware: quota · abuse signals ·
                                      circuit breaker · health · source download · SEO
                                → Gemini · Cloud Text-to-Speech · Firestore (quota)
```

## What the layer does

| Concern | Where | Behaviour |
|---|---|---|
| Public allowance | `quota/policy.js` | 5 intelligence requests (scans) per rolling 5 hours per visitor. Exact sliding window of timestamps; a slot is reserved before the Google call and refunded if the request fails before or during upstream work. The conversation after a scan draws on a separate follow-up allowance (30 per window, only after one accepted scan); Charon speech and clip transcription share a further bound (90 per window). None of these cost a credit. |
| Intelligence request | `middleware.js` | `POST /api/identify` or `/api/document` with a 2xx result. `POST /api/follow-up` continues a scan and is gated by the follow-up allowance instead (a visitor with no scan in the window gets "Scan something first"). Page loads, static files, quota reads, rejected uploads and failed upstream calls do not count. |
| Visitor identity | `abuse/visitor.js` | Random 128-bit id in a signed, HttpOnly, Secure, SameSite=Strict first-party cookie. The signature uses `VISITOR_COOKIE_SECRET`; the browser cannot edit its count because the record lives in the store. |
| Network signals | `abuse/network.js` | Salted hash of the source address with hourly-bucket counters (atomic increments, no contention) of new visitor ids (>150/h) and accepted requests (>400/h). Crossing a threshold flags the source. IP is never the identity; the thresholds are generous on purpose so a carrier or campus network is never punished. |
| Challenge | `abuse/challenge.js` | Cloudflare Turnstile verification, off until `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` are set. Flagged sources are refused politely while it is off. |
| Concurrency | `quota/policy.js` | One in-flight intelligence request per visitor (150 s safety expiry), on top of the core's one-active-request-per-route guard. |
| Circuit breaker | `cloud/circuit.js` | `INTELLIGENCE_PAUSED=1` (new revision, no build) or Firestore document `control/circuit` `{ paused: true }` (no revision, picked up within 30 s). Static pages, How To and the download stay up. |
| Quota store | `quota/firestore-store.js` | Firestore via REST with optimistic preconditions; see below. |
| Public limits | `limits.js` | Images 2 MB; PDF 5 MB and 10 pages, 5 scanned; DOCX 3 MB; 60k characters of text; 9k characters translated in the first pass. Larger files get "This … is larger than UCENTH Vision Intelligence currently supports …" with the limit. |
| Health | `middleware.js` | `GET /health` → `{ "status": "ok" }`. Process liveness only; never calls Google. |
| Download | `middleware.js` | `GET /download/ucenth-vision-intelligence-source.zip` serves the educational ZIP built once at start-up from the allowlist. |
| Hosted UI | `public/hosted.js`, `public/hosted.css` | Allowance line, open-source section (Download Source Code, How To, GitHub, MIT License) and an honest share button. Injected into `index.html` at serve time; the educational files are not forked. |
| SEO | `middleware.js` | Canonical and `og:url` from `PUBLIC_ORIGIN`, `robots.txt`, `sitemap.xml`. |
| Logging | `cloud/logging.js` | One JSON line per request: path, type, status, latency, quota decision, error category. No content, prompts, transcripts, cookies or tokens. |
| Timeouts | `server.js` | Request 125 s, headers 15 s, keep-alive 65 s. Set the Cloud Run request timeout to 120 s. |

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | set by Cloud Run | Listening port (defaults to 8080). The process binds 0.0.0.0. |
| `GOOGLE_CLOUD_PROJECT` | yes | Project for Gemini, Text-to-Speech and Firestore. |
| `PUBLIC_ORIGIN` | yes | `https://vision.ucenth.com` (staging: the `*.run.app` URL). Used for canonical URLs, sitemap and the Secure cookie flag. |
| `VISITOR_COOKIE_SECRET` | yes (production) | At least 32 random characters. Store it in Secret Manager and mount as an env var. Rotating it resets everyone's allowance. |
| `NODE_ENV` | `production` | Enables the Firestore store by default and refuses to start without the secret. |
| `QUOTA_STORE` | optional | `firestore` (default in production) or `memory` (single local process only). |
| `FIRESTORE_DATABASE` | optional | Defaults to `(default)`. |
| `INTELLIGENCE_PAUSED` | optional | `1` pauses intelligence requests. |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | optional | Enables challenge escalation (see below). |

No credential is read from a file. Locally, `node production/server.js` uses your ADC like the educational server; on Cloud Run the service identity is used.

## Quota store: why Firestore

| Option | Verdict |
|---|---|
| In-process memory | Rejected: instances scale and restart, counts would diverge. |
| Memorystore (Redis) | Correct and fast, but needs a VPC connector and an always-on instance (tens of dollars a month) for a workload of a few operations per request. |
| **Firestore (Native mode)** | Chosen: serverless, free tier 50k reads / 20k writes per day, per-document TTL, atomic updates through preconditions, reachable from Cloud Run with one IAM role, no SDK beyond the existing `google-auth-library`. |

Each visitor record is one document (`quota/<sha256(visitor id)>`) holding the serialized record and `expireAt`. `update(key, fn)` reads, applies, and commits with `currentDocument.updateTime` (or `exists: false`), retrying on contention, so two instances can never both grant the last credit. Records contain only timestamps, request ids and an in-flight map; network records contain timestamps only. Nothing from documents, questions, speech or images is ever attached.

**One-time setup.** Create the database and the TTL policy:

```sh
gcloud services enable firestore.googleapis.com --project=YOUR_PROJECT_ID
gcloud firestore databases create --location=europe-west2 --type=firestore-native --project=YOUR_PROJECT_ID
gcloud firestore fields ttls update expireAt --collection-group=quota --enable-ttl --project=YOUR_PROJECT_ID
```

## IAM: least privilege for the Cloud Run service identity

Create a dedicated service account and grant only:

| Role | Why |
|---|---|
| `roles/aiplatform.user` | Gemini requests through the Agent Platform API |
| `roles/datastore.user` | Read/write quota and control documents in Firestore |
| `roles/serviceusage.serviceUsageConsumer` | Bill Text-to-Speech calls to the project (`x-goog-user-project`) |
| `roles/secretmanager.secretAccessor` | Read `VISITOR_COOKIE_SECRET` (on that secret only) |

```sh
gcloud iam service-accounts create vision-intelligence --display-name="UCENTH Vision Intelligence (Cloud Run)" --project=YOUR_PROJECT_ID
SA=vision-intelligence@YOUR_PROJECT_ID.iam.gserviceaccount.com
for role in roles/aiplatform.user roles/datastore.user roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member=serviceAccount:$SA --role=$role
done
printf '%s' "$(openssl rand -base64 48)" | gcloud secrets create visitor-cookie-secret --data-file=- --project=YOUR_PROJECT_ID
gcloud secrets add-iam-policy-binding visitor-cookie-secret --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor --project=YOUR_PROJECT_ID
```

No service-account JSON is ever created or downloaded.

## Deploy (staging first, source deployment, no Docker)

`Procfile` tells the Cloud Run buildpack to start `node production/server.js`; the Node version comes from `engines` in `package.json`.

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project=YOUR_PROJECT_ID
gcloud run deploy vision-intelligence-staging --source . --region=europe-west2 --project=YOUR_PROJECT_ID \
  --service-account=$SA --allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=8 --timeout=120 \
  --min-instances=0 --max-instances=3 \
  --set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,QUOTA_STORE=firestore,PUBLIC_ORIGIN=https://vision-intelligence-staging-XXXX.a.run.app \
  --set-secrets=VISITOR_COOKIE_SECRET=visitor-cookie-secret:latest
```

Deploy once to learn the service URL, then update `PUBLIC_ORIGIN` to it. Test everything over that HTTPS URL before any domain work. `--max-instances` is a hard ceiling on Cloud Run cost while the service is new.

Resource guidance (from the benchmark section in the phase report): 1 vCPU / 1 GiB with concurrency 8 is the recommended starting point because PDF parsing and image decoding are CPU- and memory-heavy compared with static requests; 512 MiB is workable for images only. Start with `min-instances=0`; a cold start is a few seconds and only the first visitor after an idle period pays it.

## Circuit breaker, budget alerts and API quotas

- **Circuit breaker** (this layer) stops UCENTH's own spending on new intelligence requests immediately: set `INTELLIGENCE_PAUSED=1` or edit `control/circuit`. It is the only control that reacts in seconds.
- **Google Cloud budget alerts** send e-mail (or Pub/Sub) when spend crosses thresholds. They do **not** stop spending by themselves. Create one at $20–$30/month with alerts at 50 %, 90 % and 100 %; optionally wire the Pub/Sub notification to a small function that writes `control/circuit { paused: true }` if you want automatic pausing.
- **API quotas** (Vertex AI, Text-to-Speech) are Google-enforced request-rate caps on the project. They protect against runaway traffic but reset per minute/day and are not a spend cap either.

```sh
gcloud billing budgets create --billing-account=BILLING_ACCOUNT_ID --display-name="UCENTH Vision Intelligence" \
  --budget-amount=25USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

## Challenge escalation (recommended, after baseline)

Cloudflare Turnstile is recommended: privacy-conscious, free at this scale, invisible to most people. It is deliberately not part of the first deployment. To enable it later: create a Turnstile site for `vision.ucenth.com`, set `TURNSTILE_SECRET` (Secret Manager) and `TURNSTILE_SITE_KEY`, add `https://challenges.cloudflare.com` to `script-src` and `frame-src` in the Content-Security-Policy, render the widget when `/api/quota` returns a `challenge` site key or an API call returns `challenge`, and send the token in `X-Challenge-Token`. Only flagged sources are ever challenged.

## Custom domain

Do not change DNS until staging has passed acceptance over HTTPS. Google's current recommended path for a production custom domain on Cloud Run is a global external Application Load Balancer with a serverless NEG (a managed certificate, HTTP→HTTPS redirect and one stable IP); Cloud Run domain mappings are the simpler alternative but are in preview in some regions. Steps once approved:

1. Reserve a global static IP and create the load balancer with a serverless NEG pointing at the service, a Google-managed certificate for `vision.ucenth.com`, and a redirect from HTTP.
2. Google prints the IP; only then create the DNS `A` record for `vision.ucenth.com` at the registrar. Do not invent records before the balancer exists.
3. After the certificate becomes ACTIVE (up to an hour after DNS propagates), set `PUBLIC_ORIGIN=https://vision.ucenth.com`, redeploy, and re-run the HTTPS acceptance list.
4. Keep the `*.run.app` URL unpublished; the `allowedHosts` pattern accepts both.

## Mobile voice: what changed and why

Physical tests on the first staging build showed "Voice unavailable" on iPhone and a microphone that opened but never produced a question on Android, while desktop worked. Two platform facts explain both, and both are now handled in `voice.js` (educational core, because students on phones need it too):

1. **Microphone ownership.** Desktop Chrome tolerates a live `getUserMedia()` stream (for the particle analyser) alongside `SpeechRecognition`. Android Chrome and iOS Safari do not: the recogniser starves or errors (`audio-capture`, `not-allowed`, silent `end`). On phones the native path now opens no stream; the recogniser owns the microphone and the particles show a restrained listening pulse driven by recognition events. This is documented honestly as a pulse, not audio analysis.
2. **No native recogniser at all** on iOS Chrome/Firefox (WebKit does not expose it to third-party browsers), and occasional Safari sessions where it errors. Those sessions use the server path: MediaRecorder records the question (`audio/mp4` on iOS, `audio/webm;codecs=opus` elsewhere), the clip goes to `/api/transcribe`, and Gemini transcribes it in memory (about 32 audio tokens per second, no extra API or credential). Speech start and end are detected from the microphone analyser with a noise gate; the same five-second speech-start timeout applies. Clips are never written or logged; the hosted layer bounds transcriptions with the speech budget and never charges a request credit.

Option considered and not chosen for now: Cloud Speech-to-Text v2. It would add an API, an IAM role and per-15-second billing for the same result; Gemini already reaches the project through the service identity and handles the containers MediaRecorder produces. If transcription quality on real iPhone recordings proves insufficient, `createTranscriber()` in `lib/conversation.js` is the single place to swap the engine.

**Diagnostics (staging only).** `DIAGNOSTICS=1` injects `production/public/diag.js`, opened with `?diag=1` or the DIAG button: device capabilities (user agent, platform, `SpeechRecognition`/`webkitSpeechRecognition`, `getUserMedia`, MediaRecorder and its container, AudioContext state, microphone permission), microphone tracks (count, readyState, enabled, muted), every recognition event (`start`, `audiostart`, `soundstart`, `speechstart`, interim/final result sizes, `speechend`, `soundend`, `audioend`, `end`, `error`), fallback decisions, pause reasons, the capture → upload → response → render and question → answer → Charon → playback timeline with server timings, and particle fps. "Copy report" produces a plain-text report. No audio and no images are ever included. Never set `DIAGNOSTICS=1` on the public service.

**Physical acceptance still required** (it cannot be automated from a desktop): five consecutive spoken turns on Android Chrome and five on an iPhone against the staging URL with `?diag=1`, checking Charon finishes, listening begins, speech is detected, the transcript is right enough, Gemini answers, Charon replies, nothing self-triggers, the next cycle works, five seconds of silence pauses, and the microphone indicator goes off. Paste the copied diagnostics report if anything fails.

## Second physical round (28 September 2026): what the phones showed and what changed

Both phones completed five spoken turns against staging with `?diag=1`, and the diagnostics plus the Cloud Run log explain every failure seen.

**Android Chrome (native recogniser).** Recognition itself worked on every turn: `audiostart`, `speechstart`, results. But Android returns no interim text at all and delivers a question as several small *final* fragments (4 to 8 characters each, one every few hundred milliseconds) while the person is still talking. The client submitted the first fragment, so the microphone "suddenly stopped" mid-question. `voice.js` now collects finals and submits once no new fragment arrives for 800 ms (`FINAL_SETTLE_MS`), or immediately when the recogniser ends or errors with text in hand. Desktop Chrome, which sends one final after the pause, pays the same 800 ms.

**iPhone (iOS 26 Safari).** `webkitSpeechRecognition` exists, errored within two seconds, and the session fell back to the server path as designed; the diagnostics buffer had already dropped the first events, so the panel now keeps the first 40 lines as well as the latest 120 to capture the exact error next time. On the server path, transcription worked for clips of 79 KB to 457 KB (3.5 to 6.3 s), including a 15-second clip that hit the maximum length while the person was still talking (211 characters transcribed, so the cap was right). The panel flapped between USER SPEAKING and LISTENING between words because the particle activity signal could move the state backwards; that transition is now one-way.

**"Server failed" on both phones.** The Cloud Run log for the sessions shows, per failed turn: two follow-ups and two identifications failed upstream at 22–23 s, two transcriptions failed upstream at 16–18 s, one follow-up got a Gemini 429 after 6 s, and two requests were refused by the 5-per-5-hours allowance (`quota: exhausted`) because an identification plus five follow-ups is six requests. A laptop probe against the same endpoint (16 transcriptions, 19 follow-ups, 4 identifications, real clips converted to `audio/webm;codecs=opus` in Chrome from Charon speech) reproduced the provider behaviour: one `500 Internal error encountered` after 3.5 s, and follow-up latency swinging between 2.3 s and 19 s for the same 80-token answer, all with finish reason STOP. Gemini 3.8 Flash is served only from the `global` endpoint (`europe-west1` and `europe-west4` return 404), and the model rejects `thinkingLevel: MINIMAL`, so the endpoint and thinking level stay as they were. Changes made: (1) one server-side retry after 800 ms for a 429 or 5xx that arrives within 8 s (`withOneRetry` in `lib/gemini.js`, used by identification, follow-up, transcription and document analysis; slow failures are not retried, so nobody waits for two timeouts); (2) the server log now records a safe reason (`HTTP 500`, `AbortError`, `Incomplete transcription (MAX_TOKENS)`) instead of only "upstream"; (3) the client shows the server's own message for a failed follow-up or transcription ("Free usage limit reached…", "Scan something first…") instead of the generic notice; (4) follow-up questions no longer consume request credits (see the allowance row above), so a five-turn spoken test after one scan is within the free allowance.

**Still open for the next physical round:** the exact iOS Safari recogniser error (now captured), whether the 22-second upstream failures recur with the retry in place (the log will show `HTTP 5xx` or `AbortError`), and Charon playback of long answers (4–18 s per answer dominates each turn; answers are already capped at about 90 words by the prompt).

## Staging results (28 September 2026)

Staging service: `vision-intelligence-staging` in `europe-west2`, source-deployed with buildpacks (no Docker), 1 vCPU / 1 GiB, concurrency 8, timeout 120 s, min 0 / max 3 instances, Firestore quota store, cookie secret from Secret Manager. Not connected to any domain.

**HTTPS acceptance** (real Chrome with fake camera/microphone devices, real Gemini and Charon): page load, camera permission and live stream, microphone permission, object identification, Charon introduction, five-second speech-start timeout (5008 ms), typed follow-up answered by Charon, particles reacting to Charon output and microphone, allowance line decreasing, light and dark themes, phone layout, PDF and DOCX analysis, contextual person identification from page context, French receipt translated with Original / English tabs, sixth request refused with the wait time, allowance consistent on a fresh read. Live speech recognition needs a real microphone and a person; the loop was driven by a stub, so a two-minute manual spoken check on the staging URL is the one remaining HTTPS item.

**Measured latency** (server side, from Cloud Run request logs and the app's own timings):

| Request | Typical |
|---|---|
| Health / static (warm) | 20–80 ms server; 0.7–0.9 s from a laptop on a corporate network |
| Cold start (new revision, first request) | startup p99 1.9–3.3 s; first request 1.1–1.3 s |
| Identification (Gemini) | 3.4–4.7 s |
| Follow-up answer (Gemini) | 3.7 s |
| Charon synthesis | 1.6–4.2 s |
| PDF (one page, text) / DOCX | 4.1 s / 3.2 s |
| Photographed French receipt with translation | 5.2 s |

**Resources.** Real work at 1 GiB peaked at 17 % memory (about 175 MiB) and 8 % CPU (p99). The stubbed-AI load service at 512 MiB peaked at 28 % memory and 9 % CPU. Recommendation: start at **1 vCPU / 512 MiB, concurrency 8** for the first public release (2.9× headroom over the measured peak); move to 1 GiB if 10-page scanned PDFs push memory above 60 %. `min-instances=0`: a cold start costs the first visitor about one to three seconds after an idle period, which is acceptable for a link opened from a video; keep 0 until traffic shows sustained gaps.

**Load** (separate stubbed-AI service, no Gemini traffic; 20 fresh visitors each firing 7 identification requests at once, twice, at 512 MiB and 1 GiB): every visitor ended with exactly 5 accepted and 2 refused, no over-charging and no inconsistency between the response headers and a fresh allowance read; health checks never failed; server-side p50 76 ms for accepted requests and 19 ms for refusals; one instance absorbed 140 concurrent requests without scaling. The earlier iteration of this test found and fixed two real problems: the educational core's six-per-minute instance guard (now injectable) and a hot per-address document (now atomic hourly counters). A single laptop reaches the per-address thresholds quickly; real users behind one carrier address do not, because each can only spend five credits per five hours.

**Cost estimate** (assumptions labelled; verify against current price lists before launch):

| Item | Assumption |
|---|---|
| Session mix | 1 identification (1.9k in / 0.5k out tokens), 2 follow-ups (2k in / 0.15k out each), 0.3 document analyses (2.5k in / 0.7k out), 3 Charon syntheses (≈1,050 characters) |
| Gemini 3.8 Flash | $0.30 per 1M input tokens, $2.50 per 1M output tokens |
| Cloud Text-to-Speech HD voice | $30 per 1M characters |
| Cloud Run | request-based billing, 1 vCPU / 512 MiB, about 24 vCPU-seconds per session while waiting on Google; free tier ignored |
| Firestore, Secret Manager, egress | within free tiers at these volumes |

| Sessions / month | Gemini | Charon | Cloud Run | Total |
|---|---|---|---|---|
| 100 | $0.45 | $3.15 | $0.06 | ≈ $3.70 |
| 1,000 | $4.50 | $31.50 | $0.60 | ≈ $37 |
| 10,000 | $45 | $315 | $6 | ≈ $370 |

Charon is the cost lever, not Gemini: spoken text is billed per character. The $20–30 budget alert corresponds to roughly 600–800 sessions a month at this mix; shortening introductions or capping speech characters per answer changes the picture more than anything else. Turnstile is free at this scale.

## Operations

- **Logs:** filter by `jsonPayload.type` (identify, document, follow-up, speech, transcribe) and `jsonPayload.quota` (charged, refunded, exhausted, busy, flagged, paused, follow-up, follow-up-failed, follow-up-no-scan, follow-up-exhausted, speech-denied). Upstream failures print `… failed (upstream; HTTP 500)` with the status or error class only.
- **Errors users see** are the same safe messages as the educational edition plus the quota messages above. Raw Google or Node errors never leave the process.
- **Download count** (optional, first-party): count log lines with `type: "download"`; no tracker is added.
- **Rotating the cookie secret** resets every visitor's allowance. Do it deliberately.
