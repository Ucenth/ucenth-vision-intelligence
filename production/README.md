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
| Public allowance | `quota/policy.js` | 5 intelligence requests per rolling 5 hours per visitor. Exact sliding window of timestamps; a slot is reserved before the Google call and refunded if the request fails before or during upstream work. Charon speech is bounded separately (15 per window, only after one accepted request) and never counts. |
| Intelligence request | `middleware.js` | `POST /api/identify`, `/api/document`, `/api/follow-up` with a 2xx result. Page loads, static files, quota reads, rejected uploads and failed upstream calls do not count. |
| Visitor identity | `abuse/visitor.js` | Random 128-bit id in a signed, HttpOnly, Secure, SameSite=Strict first-party cookie. The signature uses `VISITOR_COOKIE_SECRET`; the browser cannot edit its count because the record lives in the store. |
| Network signals | `abuse/network.js` | Salted hash of the source address with a one-hour rolling record of new visitor ids (>30/h) and accepted requests (>60/h). Crossing a threshold flags the source. IP is never the identity. |
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

## Operations

- **Logs:** filter by `jsonPayload.type` (identify, document, follow-up, speech) and `jsonPayload.quota` (charged, refunded, exhausted, busy, flagged, paused).
- **Errors users see** are the same safe messages as the educational edition plus the quota messages above. Raw Google or Node errors never leave the process.
- **Download count** (optional, first-party): count log lines with `type: "download"`; no tracker is added.
- **Rotating the cookie secret** resets every visitor's allowance. Do it deliberately.
