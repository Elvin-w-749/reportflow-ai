English | [Simplified Chinese](README.zh-CN.md)

# reportflow-ai · Analysis Report Workbench

An offline-first full-stack workspace that turns uploaded certificates and document
packets into structured, evidence-backed analysis reports. Documents are OCR'd locally,
analyzed by pluggable LLM providers, matched against a product library, and exported as
shareable reports.

> ⚠️ **All business data in this repository is fictional.**
> Institution names, product names, limits and rates, test accounts and sample report
> texts are all **fictional examples**, for technical demonstration and automated testing
> only — **no real institution products, real customer data or real risk-control models**.
> Do not use this project's output for any actual credit granting, financing or credit
> decision.

---

## Table of contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Testing and verification](#testing-and-verification)
- [Domain model notes](#domain-model-notes)
- [Security posture](#security-posture)
- [Documentation](#documentation)
- [License](#license)

---

## What it does

1. **Upload** — ID documents, credit reports and supplementary materials arrive as
   PDF, image or multipart upload. The browser keeps a local draft store so a refresh
   never loses in-progress work.
2. **Parse** — Native-text PDF text is extracted directly; scanned pages go through
   a local OCR chain. Structured OCR output is validated against a frozen JSON Schema
   contract before it can be used as evidence.
3. **Analyze** — The parsed facts are sent to one or more LLM providers and
   normalized into a canonical evidence model. Every published number must be traceable
   to in-document evidence; when evidence is missing or conflicting the pipeline returns
   `review_required` instead of inventing a score.
4. **Match** — A deterministic scoring engine (`matchCore`) ranks entries from a
   local product library against the analyzed profile. The same engine runs in the
   browser (instant preview) and on the server (post-login result), so both agree.
5. **Report** — Results render into multi-section report pages and export to
   PDF / image. Client, advisor, service and admin views are permission-scoped renderings
   of the same web app — there is no native or mini-program client.

### Non-goals

- No mobile app, mini-program, or native packaging. The browser is the only client: one
  responsive build serves desktop and phone browsers, and the WeChat in-app browser keeps
  its compatibility path (real-device regression is still required before a release).
- No bundled customer data, production config, model weights or release binaries.
- No real financial product catalogue — the shipped library is synthetic demo data.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Vue 3 + Vite, Vue Router (hash routing), Vant + Naive UI, html2canvas + jsPDF for export |
| Backend | Node.js Express API, JWT auth, multer uploads, pino logging, express-rate-limit |
| Storage | SQLite via `better-sqlite3` (single file, WAL); local JSON/asset directories |
| Parsing | `mupdf` / `pdf-parse` for native text, pluggable OCR backends (tesseract CLI, local RapidOCR worker, remote OCR API) |
| Models | Provider-agnostic LLM clients (`DEEPSEEK_*`, remote OCR `ZHIPU_GLM_OCR_*`, optional vision providers) |
| Contracts | JSON Schema draft-2020-12 + Ajv 8, verified by CI |
| Tests | Node's built-in `node:test` runner on both sides; no browser runner required |
| Runtime | **Node.js >= 20.9** (22 recommended), multi-package layout without npm workspaces |

---

## Repository layout

```text
frontend/          Vue 3 + Vite web app (desktop + mobile browser)
  src/             pages, services, shared data
  scripts/         build / package / gate scripts for the web bundle
  tests/           node:test contract and unit suites
backend/           Express + SQLite API (default http://127.0.0.1:3200)
  backend/         routes, services, db layer
  src/shared/      product library, mirrored byte-for-byte into the frontend
  ocr/             optional Python RapidOCR runtime (models are never committed)
  tests/           API, contract and determinism tests
docs/              PRD, ADRs, machine contracts, security notes
scripts/           repository-level safety and contract verification
ops/               local runtime helpers and read-only log analysis tools
tests/             cross-layer parity tests
```

---

## Quick start

Requirements: Node.js `>= 20.9`, npm, and enough disk for a local SQLite file. **No domain
name, TLS certificate, cloud account or public IP is needed** — everything below runs on
`localhost`.

```bash
# 1. install dependencies for both apps
npm run install:all

# 2. create local env files (both are git-ignored)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
#    backend/.env must carry real local values: JWT_SECRET and ANALYSIS_CACHE_SECRET
#    have no usable defaults; frontend/.env.local can stay as shipped

# 3. start the API first (default http://127.0.0.1:3200)
npm run dev:backend

# 4. in another shell, start the frontend (default http://127.0.0.1:5173)
npm run dev:frontend
```

Open <http://127.0.0.1:5173>. The Vite dev server proxies `/api` to the backend, so the
browser never needs an absolute production base URL. Real `.env` files, secrets, customer
reports, databases, uploads and OCR models must never be committed.

Override the local endpoints when the defaults collide with something on your machine
(the backend already binds `127.0.0.1:3200` and the dev proxy already targets it):

```bash
# backend
HOST=127.0.0.1 PORT=3200 npm run dev:backend

# frontend dev proxy target (localhost / 127.0.0.1 / ::1 only)
RPT_LOCAL_API_ORIGIN=http://127.0.0.1:3200 npm run dev:frontend
```

`RPT_*` and `VITE_*` inputs are read from **both** the shell environment and `.env` files
(`.env`, `.env.local`, `.env.<mode>`), because `vite.config.js` loads them through Vite's
`loadEnv` with the `VITE_`/`RPT_` prefixes. A shell variable of the same name wins over the
`.env` entry.

### Production build (still local)

```bash
npm run build:frontend     # emits frontend/dist
npm run verify:repository  # byte-level consistency gates
```

The frontend build reads its API base from `RPT_PROXY_BASE`, which takes a full origin
(shell environment or `.env*` file). When it is unset, the built bundle defaults to the
local API at `http://127.0.0.1:3200/legacy-api` and the build prints a one-shot warning —
that address only resolves on the build machine, so set your own origin before publishing
behind a reverse proxy. No public host is baked into the repository.

### Optional integrations

Everything that touches the outside world is opt-in:

- **LLM analysis** — set `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_CHAT_URL` /
  `DEEPSEEK_TEXT_MODEL`). Without a key, upload and parsing still work; the analysis
  step reports a configuration error instead of a fake result.
- **OCR** — `OCR_PROVIDER` selects the backend. Local tesseract needs the `tesseract`
  binary; the RapidOCR path expects your own model files (never committed, validated by
  checksum only inside the isolated deployment environment — CI never downloads models).
- **SMS login codes** — `SMS_PROVIDER=dev` prints the verification code to the server
  console. That mode is **for local development only and must never be used in
  production**; configure a real provider instead.

---

## Environment variables

Values below marked **required** have **no default**: the process refuses to start (or the
feature stays disabled) until you supply them. Never commit a filled `.env`.

### Backend

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the fail-closed security gates |
| `HOST` / `PORT` | `127.0.0.1` / `3200` | local bind address |
| `JWT_SECRET` | **required** | no implicit fallback; production startup fails without a non-default value |
| `ANALYSIS_CACHE_SECRET` | **required** | >= 32 UTF-8 bytes; HMACs scope/content identities and encrypts canonical results |
| `ANALYSIS_KEY_SECRET` | optional | alternative key material for content identities, used instead of `ANALYSIS_CACHE_SECRET` |
| `ANALYSIS_STATIC_TENANT_ID` | `local-legacy-api` | non-secret tenant label for the cache namespace |
| `DATA_DIR` / `LOG_DIR` | `./data-local` / built-in | keep them outside the checkout at runtime |
| `ALLOWED_ORIGINS` | localhost origins only | comma-separated exact-match CORS allowlist; add your own origin when you deploy |
| `DEV_ANALYZE_BEARER` | **required** for the dev bearer path | local-only token used by the analysis endpoint |
| `SMS_PROVIDER` | `dev` | `dev` prints codes to the console and warns loudly; any other value selects a configured provider via its own `SMS_*` keys |
| `DEEPSEEK_API_KEY` | empty | model access, server-side only |
| `DEEPSEEK_CHAT_URL`, `DEEPSEEK_TEXT_MODEL`, `DEEPSEEK_INPUT_MAX_CHARS`, `DEEPSEEK_OUTPUT_MAX_TOKENS`, `REQUEST_TIMEOUT_MS` | see `backend/.env.example` | chunking/timeout tuning for long reports |
| `ZHIPU_GLM_OCR_API_KEY` | empty | remote OCR option; server-side only |
| `OCR_PROVIDER`, `TESSERACT_BIN`, `TESSERACT_LANG`, `RAPIDOCR_*`, `SCANNED_PDF_*` | see `backend/.env.example` | parsed/scan pipeline options |
| `CREDIT_ANALYSIS_PIPELINE_VERSION`, `CREDIT_PROMPT_VERSION`, `CREDIT_SCHEMA_VERSION`, `CREDIT_RULE_VERSION`, `CREDIT_OCR_VERSION` | pinned in `backend/.env.example` | bump intentionally — each version change invalidates cached answers |
| `ENABLE_FIXED_TEST_ACCOUNTS` | off in production | gate for the synthetic demo accounts |
| `ALLOW_EMPTY_STORE_BOOTSTRAP` | unset | one-shot escape hatch to create a brand-new empty store; remove it immediately afterwards |
| `PRODUCT_LIBRARY_PATH` | shared file | point elsewhere to swap in your own demo catalogue |
| `JSON_BODY_LIMIT`, `PDF_UPLOAD_MAX_MB`, `IMAGE_UPLOAD_MAX_MB` | conservative defaults | request-size limits |
| `AI_RATE_LIMIT_PER_HOUR`, `AUTH_RATE_LIMIT_PER_15MIN`, `GLOBAL_RATE_LIMIT_PER_MIN`, `MATCH_RATE_LIMIT_PER_MIN`, `LOG_RATE_LIMIT_PER_MIN` | conservative defaults | per-route rate limits |
| `RPT_RELEASE_ID`, `RPT_GIT_COMMIT` | unset | **backend** deployment identity (read by `backend/server.js` and the signed analysis-event log); required together only when `NODE_ENV=production` |

### Frontend (`RPT_*` build inputs and `VITE_*` values reach the browser — never put secrets here)

Both prefixes are read from the shell environment **and** from `.env` / `.env.local` /
`.env.<mode>` through Vite's `loadEnv`; an existing shell variable wins.

| Variable | Default | Notes |
|---|---|---|
| `RPT_LOCAL_API_ORIGIN` | `http://127.0.0.1:3200` | dev proxy target; must be a credential-free localhost http(s) origin |
| `RPT_PROXY_BASE` | unset | build-time API origin; unset means the bundle defaults to the local API above and the production build prints a one-shot warning |
| `LEGACY_RELEASE_ID` | unset | release label consumed by `frontend/scripts/package-legacy-web-release.mjs` (packaging only, not a Vite input) |
| `VITE_ENABLE_LOCAL_DEV_AUTH` | `false` | enables the local-only test login helper, allowed only on loopback in Vite dev mode |
| `VITE_LOCAL_DEV_TEST_PASSWORD`, `VITE_LOCAL_DEV_SMS_CODE` | empty | must stay empty unless you are debugging locally; never reuse real credentials |

---

## Testing and verification

```bash
npm test                     # full gate: repository verify + contracts + frontend + backend
npm run verify:repository    # safety scan, tracked-file budget, product-library hash parity
npm run verify:phase0-contracts  # machine-contract blob verification
npm run test:frontend        # route check + node:test contract/unit suites
npm run test:backend:deterministic  # determinism, cache, isolation, security-blocker tests
npm run test:backend:legacy  # OCR / ownership / service-identity subset
npm run test:backend:full    # everything under backend/tests (slowest)
npm run build:frontend       # production bundle + build-contract checks
```

Notes for contributors:

- The deterministic suites need **no network** and **no API keys**; they use in-memory
  profiles and the synthetic product library.
- Test fixtures use obviously invalid phone numbers and `示例…` / `example.com` identifiers.
  If a test needs an institution or product name, add a fictional one — never a real one.
- Release notes must quote the test counts actually measured on that commit; never carry
  a historical failure baseline forward.
- `scripts/verify-repository.mjs` fails when the frontend and backend copies of
  `shared/productLibrary.json` drift apart (see the next section).

---

## Domain model notes

- **Product library** (`backend/src/shared/productLibrary.json`, mirrored byte-identically
  at `frontend/src/shared/productLibrary.json`): an array of 56 entries across 23 fictional
  institutions. Each entry carries `id`, `name`, `institution`, `institutionType`,
  `serviceArea`, `category`, `rateText`, `amountText`, `termText`, three `tags`,
  `sourceUrl`, `sourceNote` and a `rules` object (`minScore`, `maxDebtRatio`,
  `maxQueryCount`, `maxNonBankRatio`, `maxInstitutions`, `allowLianSan`, `allowOverdue`
  plus optional preference/requirement flags). Newer entries additionally carry
  `parentInstitution`, `eligibilityText` and `requiredMaterials`.
  All rate/amount/term strings are deliberately uniform placeholders (`示例…（虚构演示值）`)
  and every `sourceUrl` points at `https://example.com/...`.
  Product codes look like `rf_bank_001`, `rf_cf_003`, `rf_card_001`, `rf_bank_s01_001`.
  `matchEngine.js` looks default recommendations up by code, so if you re-code entries,
  update those literals in the same commit.
- **Evidence-first analysis**: numbers reach the UI only through the canonical evidence
  chain. Missing or conflicting evidence produces `unknown` / `review_required`, not a
  silently interpolated value.
- **Roles**: `user`, `advisor`, `service`, `publisher` and `admin` (with a `super`
  admin level) are permission views of one web app, not separate clients.

---

## Security posture

- Secrets are read from the process environment only; nothing is baked into the bundle.
- Startup fails closed in `NODE_ENV=production` when `JWT_SECRET`,
  `ANALYSIS_CACHE_SECRET`, fixed-test-account gating, or an empty database bootstrap look
  wrong. See `backend/tests/deploymentSecurityBlockers.test.js`.
- Raw report text, identity numbers, phone numbers, file names and provider responses are
  never written to logs, error envelopes or cache keys.
- Uploads and generated reports live outside the source tree and are git-ignored.
- Please read `docs/security/` before wiring this into any real workflow, and run your own
  legal/compliance review for the domain you deploy it in.

---

## Documentation

- `docs/PRD.md` — product requirements and acceptance criteria
- `docs/architecture/` — ADR-0001, the dual-model credit analysis decision
- `docs/MILESTONES.md` — project milestones and architecture decision record
- `docs/MILESTONES.en.md` — English version of the milestones record
- `docs/contracts/` — machine-readable phase-0 and OCR contracts plus their schemas
- `docs/product/` — PRD deltas
- `docs/security/` — provider security gate and data-export review checklist
- `frontend/docs/` — user-facing agreement text and the web API boundary
- `ops/` — local runtime helpers and the read-only log analysis tools

---

## License

MIT — see `LICENSE`.
