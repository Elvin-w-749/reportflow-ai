# Development Milestones and Architecture Decision Record

This document traces the evolution, the architectural decisions, and the engineering problems that shaped the code, as a durable engineering record.

- Project: Report Analysis Workbench (`reportflow`) — a full-stack system for credit-report parsing and deterministic scoring. Frontend: Vue 3 + Vite. Backend: Express + SQLite.
- Development window: 2026-08-03 to 2026-08-21.
- Scope note: all phases, date ranges and constraints below are grounded in the design documents and implementation retained in the repository. Identifiers of individual commits, branches, release artifacts, hosts and accounts have been replaced with descriptions.

---

## Timeline

| # | Phase | Window |
|---|---|---|
| 1 | Full-stack monorepo baseline and repository safety gate | 2026-08-03 (week 1) |
| 2 | Resumable pipeline for long reports; stable deployment path | 2026-08-04 (week 1) |
| 3 | Frontend reduced to browser-only; evidence-first analysis on the main path | 2026-08-06 (week 1) |
| 4 | Release identity isolation; evidence record bundles v2/v3 | 2026-08-13 to 08-14 (week 2) |
| 5 | Cache binding, task scope, recovery and access control hardening | 2026-08-17 (week 3) |
| 6 | Phase 0 contract freeze: dual-model architecture as a machine-readable contract | 2026-08-17 (week 3) |
| 7 | Frontend truth preservation: report identity binding and missing values | 2026-08-17 (week 3) |
| 8 | OCR HTTP client and ordered Phase 0–3 integration governance | 2026-08-18 to 08-19 (week 3) |
| 9 | Post-merge content baseline gate: protected blob anchoring | 2026-08-20 (week 3) |
| 10 | Deterministic OCR structured adapter and production fail-closed feedback | 2026-08-20 to 08-21 (week 3) |

---

## Milestones

### 1. Full-stack monorepo baseline and repository safety gate

**Window**: 2026-08-03 (week 1)

**What happened**: Frontend sources, backend sources, release tooling and local operational scripts that had lived in separate places were consolidated into one monorepo in a single baseline commit of roughly 85,000 lines. The same batch introduced a repository verifier: a tracked-file inventory, denylists for directories and extensions (dependency folders, build output, database files, logs, archives, installers, symlinks and submodules), credential-shape scanning over every tracked text file, and a byte-identical assertion between the two copies of the shared product catalogue. The CI runner image was bumped, and release-preparation scripts were fixed to run cleanly under non-POSIX shells.

**Why**: Duplicate source trees mean duplicate build truth — the same frontend produced different behaviour on different machines, and release provenance could not be reproduced. Once consolidated, "source → build → release proof" had to share a single chain.

**Constraint left behind**: The repository verifier is a standing gate, not a one-time cleanup. Every added file passes the denylists and the credential scan, and the two shared data files fail the build on any byte drift. Running on both Windows and POSIX became a default requirement rather than an option.

### 2. Resumable pipeline for long reports; stable deployment path

**Window**: 2026-08-04 (week 1)

**What happened**: A resumable, chunked analysis pipeline was built for long reports (tens to hundreds of pages, requiring many model calls): task state persisted to disk, per-chunk artifacts spooled, and a failed run resuming from the chunks already completed. A task protocol was introduced with the same terminal semantics on both sides of the wire. Upload failures were collapsed into a closed set of categories instead of one generic message. The TLS gateway was pinned to a runtime path independent of the release version, and analysis identity switched to being derived from content hashes of the implementation files.

**Why**: Re-running everything from scratch was unaffordable on long reports — a page refresh discarded all progress. And a hand-maintained version number silently serves stale results the moment someone forgets to bump it. Binding identity to source bytes means editing code changes the key, with no human remembering required.

**Constraint left behind**: Analysis identity rotates whenever any relevant source file or the dependency lock changes. That is the feature and the price: any design that "reuses an earlier cached identity" must be rejected structurally. Deployment paths must stay stable across versions, or a rollback points at a directory that no longer exists.

### 3. Frontend reduced to browser-only; evidence-first analysis on the main path

**Window**: 2026-08-06 (week 1)

**What happened**: One cleanup commit removed multi-platform residue — installer baselines, the native runtime compatibility layer, push channels, platform selectors — fixing the client surface to the browser, with a boundary test asserting that no platform directories or installers exist in the tree. In the same week a large commit (about 110 files, 16,000 lines) put evidence-first credit analysis on the main path: an evidence ledger, an analysis coordinator, a PDF vision layer, a matching core and deterministic scoring. The frontend gained decision metrics, an evidence gate and debt-execution policy, and report detail sections were changed to render independently of one another.

**Why**: The real cost of multi-platform residue was not that it went unused; it was that build scripts and release entry points acquired two conflicting truths. On the analysis side, the old order — produce a score, then look for support — could not explain any published number. The order had to be inverted: build facts that bind to page evidence first, then compute metrics from them.

**Constraint left behind**: The product boundary is locked by tests; browser-only is a non-reversible acceptance criterion. Every published credit figure must trace to in-report evidence, a normalised fact and a deterministic formula. Where evidence is insufficient or relationships conflict, the system stops instead of interpolating.

### 4. Release identity isolation; evidence record bundles v2/v3

**Window**: 2026-08-13 to 08-14 (week 2)

**What happened**: Release proof became a hard gate. Build output embeds a provenance file recording git status before and after the build, the commit, the dependency-lock hash and the injected API base. Packaging requires a fully clean worktree as a precondition, and fails when the recorded commit differs from the current `HEAD`, when the lock hash differs, or when the API-base proof does not match. Deployment scenarios that ship only the API were decoupled from frontend tests by relocating the cross-layer parity test to a location that does not require a frontend install. On the analysis side, evidence record bundle v3 bound multi-account tables row by row into separate record bundles, separated card outstanding totals from account attribution, made query-window scoring semantics explicit, and put a safety boundary around diagnostic output. Over the following days the ledger closed equivalence-class gaps one at a time — accounts split across line wraps, explicit credit facilities, parenthetical home-currency amounts — and institution sorting was made locale-stable after it was shown to differ by host.

**Why**: Release proof is only worth having when it can falsify; a proof that can be skipped is not a proof. And a cross-layer test sitting inside the backend test directory makes a legitimate API-only deploy impossible to install — so the location of a test is itself a deployment constraint. Record bundles appeared because handing a whole table to a model and asking it to choose attribution cannot prove which row belongs to which account.

**Constraint left behind**: A clean worktree before build is a hard precondition; results measured on a dirty tree cannot be registered as passing. API-only and full deployment have separate test entry points, and neither substitutes for the other. Sorting, comparison and formatting must specify locale and order explicitly rather than inherit host defaults.

### 5. Cache binding, task scope, recovery and access control hardening

**Window**: 2026-08-17 (week 3)

**What happened**: A single hardening commit spanning about 48 files and 6,600 lines split the storage layer into three mutually isolated AES-256-GCM domains — authoritative cache, task scope and task spool — with each cache entry keyed by a derived secret over tenant, document and analysis identity, so a cross-tenant, cross-document or cross-version hit is not merely unlikely but unconstructible. Institution isolation fails closed when evidence is missing. Teacher-side detail authorisation was completed. Fixed test accounts are rejected by an explicit production gate. Release preflight runs in an isolated environment so it cannot read live data. The evidence ledger gained robustness fixes, and failure diagnostics were reduced to a closed set of fields.

**Why**: Under a single shared key domain, a predictable cache key admits the possibility of serving one user's result to another — a class of defect that functional tests never surface. Recovery is the second entry point: if a replayed task does not re-check its identity binding, a previously rejected conclusion resurfaces.

**Constraint left behind**: Each of the three domain identifiers is pinned by a mirrored assertion; renaming one without the matching test turns the deterministic suite red. Renaming a domain unbinds any data already cached under the old one, which is safe only where no pre-existing data has to be preserved. Any proposal to loosen binding for a higher hit rate must first produce a constructive proof that cross-tenant hits remain impossible.

### 6. Phase 0 contract freeze: dual-model architecture as a machine-readable contract

**Window**: 2026-08-17 (week 3)

**What happened**: A documentation-led commit froze the target architecture: an architecture decision record (ADR-0001), a product delta, a machine-readable contract in JSON, a JSON Schema for that contract, the structured-OCR evidence contract, and a provider security gate document. Four follow-up commits made the contract executable — a Draft 2020-12 schema validator, roughly 450 lines of schema definitions, negative fixtures (deliberately non-compliant contract samples that must be rejected), the diff-scope check narrowed to protected paths, and the verification step wired into CI. The same batch tightened how the scanner tolerates OCR normalisation fields.

**Why**: The genuine risk in a dual-model chain is not model accuracy but ambiguous permission boundaries. If OCR output can pass as a fact, or model confidence can stand in for evidence, every later test will still pass. Prose architecture documents cannot prevent that drift; the boundary has to be written in a form a machine can reject on.

**Constraint left behind**: Contract constant versions (`/1.0`, `/2.0`) are not renamable and not casually bumpable — a version change is fail-closed by design. A validator cannot attest its own bytes, so the external trust root is fixed as clean commit plus independent full-diff review plus CI on that same commit. Phase 0 changes no production behaviour, so the documents explicitly deny any claim that a capability is live.

### 7. Frontend truth preservation: report identity binding and missing values

**Window**: 2026-08-17 (week 3)

**What happened**: Eight consecutive fix commits on two themes. On missing values: the state "field is absent" was separated from anything coercible to `0` or an empty string, and the mapping layer, aggregation layer and presentation layer were rewritten at scale to preserve it; a strict numeric utility and a closed-set credit-status classifier were introduced, backed by hundreds-of-lines regression suites. On report identity: identifiers are validated before local persistence, stored reports must bind to the identity the request asked for, local identifiers survive cloud hydration, alias collisions within a storage slot are guarded explicitly, and invalid identities fail closed rather than degrading to a partial render.

**Why**: A missing value coerced to zero silently shifts debt, utilisation and score, and nothing in the output says the number was invented. A mis-resolved report identity is worse: rendering one person's report to another makes every plausible figure wrong.

**Constraint left behind**: `unknown` never equals `0`, `absent` or `not_applicable`; conversion between those four states is a red line with dedicated tests. Cloud hydration must never overwrite local identifiers. Any change that supplies a default "so the page renders" is an instance of this defect class and must be caught by contract tests, not by eyeballing the UI.

### 8. OCR HTTP client and ordered Phase 0–3 integration governance

**Window**: 2026-08-18 to 08-19 (week 3)

**What happened**: A strictly budgeted OCR HTTP client was built from scratch across five incremental commits: the client core (fixed endpoint and model, closed-set request body, five-field safe error envelope); rejection of proxied inputs (unconditional `Proxy` rejection at every object, array, signal and transport-response boundary); bounded HTTPS transport (an internal strict recursive-descent JSON parser with closed limits on depth, node count, key length and array items; separate caps on encoded and decoded size; controlled decompression; a connect timeout that clears only on a fresh TLS `secureConnect` or a reused socket); retry with a whole-batch stage deadline (exactly two total attempts per page, automatic retry only on network failures and 408/429/500/502/503/504, `Retry-After` honoured on 429 only and kept private, monotonic and wall clocks separated, a 420-second stage deadline that cancels all pages in flight); and a shared FIFO page-concurrency pool (fixed at 3 for default and production with a hard code cap of 4, permit released before backoff and reacquired in FIFO order, at most `min(pool limit, page count)` workers per batch, peer cancellation inside a batch and full isolation between batches). Alongside it, a 34-file, 4,700-line change landed the trusted analysis support-reference chain: a support reference authorises subsequent actions only when server-signed, diagnostics on a successful terminal must be null, and release identity became explicit. The phase closed with a governance commit that merged Phases 0–3 into one integration branch through four ordered `--no-ff` merges, with per-path semantic union checks for the five files touched by more than one phase — exactly one empty credential placeholder, both CI workflow additions retained, both root manifest changes retained, both assertion groups in the frontend contract test kept.

**Why**: Model invocation is the layer most easily written as "just make it work", and its failure modes — retry amplification, concurrency starvation, clock rollback, cancellation leaks, partial results — are all production incidents. The ordered merge exists so that each phase's verifiability does not depend on a later one, and so any phase can be rolled back alone.

**Constraint left behind**: Concurrency, timeouts and attempt counts are contract values, not tuning parameters; the production gate must pin them back to 3. Automatic retry may only retry the same page on the same provider — never a different model, never a different OCR provider. The integration overlay is a closed set; matching the path set is not the same as proving the content did not drift. Real HTTPS calls must total zero across all tests, asserted by a process-wide tripwire.

### 9. Post-merge content baseline gate: protected blob anchoring

**Window**: 2026-08-20 (week 3)

**What happened**: A squash merge severed the "required ancestor" premise, and the verifier — which only recognised a standalone commit and a pre-merge integration tree — correctly failed closed on its own repository. Three commits rebuilt it as a content baseline gate: an anchor set of six required ancestors, 21 protected entries, two candidate overlays and the verifier's external trust root; explicit checks for clean and non-shallow state; all Git reads forced through `--no-replace-objects` (replacement refs may exist but must be ignored and must not alter ancestry or blob verdicts); and mode selection that depends on none of branch name, environment switch or a fixed `HEAD`. Two further rounds hardened it. The main verifier keeps only built-in modules at top level, completes every bootstrap anchor through safe Git reads, and only then dynamically imports the locked policy, schema validator and local modules — with the whole step moved earlier in CI, ahead of the repository and operations verifiers. The temporary-repository dependency bridge moved to a common parent of all scenario repos, with an `lstat` assertion after each clone that no dependency directory exists at the repo root — no `.gitignore` change, no `.git/info/exclude`, no relaxation of the clean contract. Harness failure diagnostics became a single-line code from a fixed closed set, parsed by a whole-line regex and cross-checked against the main verifier's own allowlist; anything unknown normalises to an internal error and raw stderr is never forwarded. Finally, feeding a bare cumulative tree object as one side of `merge-tree --write-tree` worked on newer Git and failed on older Git, so each round now writes a deterministic commit — fixed parent, neutral identity, fixed timestamp — into the object database and passes that commit instead, leaving index, worktree, refs and config untouched and producing the same locked tree on every Git version. A governance handoff commit recorded the whole conflict ledger in the repository.

**Why**: One squash was enough to invalidate "reachable from history", which proves that choosing a verification mode by branch name or environment flag was never trustworthy. What must be anchored is content, not shape. For the same reason, a verifier that imports the executables it is meant to check has inverted the order of trust: a protected file committed as "exit 0 immediately", or with side effects, could alter or end the process before any anchor ran.

**Constraint left behind**: The protected list is frozen at the post-merge baseline commit. Legitimate evolution of protected content requires a separate reviewed baseline transition — move the baseline constant, replace the sixth required ancestor, re-lock the harness blob — never a bypass or a weakened literal check. Merges into the mainline must be ordinary merges; a squash cuts the new baseline's ancestry. Neither the verifier's own bytes nor the CI workflow's can be self-attested; both depend on the external trust root. Cross-platform gates must retain both focused Windows evidence and real POSIX Git evidence.

### 10. Deterministic OCR structured adapter and production fail-closed feedback

**Window**: 2026-08-20 to 08-21 (week 3)

**What happened**: Early in the window, overview consistency was bound to its source: a text-fallback account overview may be used only when exactly one complete four-row table follows a recognised official four-column header, in fixed row order, with unique cardinality — zero candidates stay unknown and invent no zero, more than one candidate fails closed as an overview mismatch; active counts reuse the authoritative cancelled/closed status predicates rather than raw bucket lengths, while raw totals and the historical-overdue exclusion are unchanged. Later in the window the deterministic OCR structured adapter shipped in four slices. First, a hand-written full-stream JPEG structural preflight: SOF0 and SOF2 only, closed caps on pixels, bytes, markers and dimensions that callers may only tighten, validation of DQT/DHT/DRI/SOS, entropy stuffing accepted only as an exact `FF 00`, non-empty restart intervals on a strict `D0..D7` cycle, per-component coefficient history for progressive scans with DC coverage required by end-of-image. Second, the adapter core: synchronous snapshot of own-data input before crossing any async boundary, canonical JPEG data URIs only, provider region order never re-sorted, pairwise reading-order enforcement, paragraph and formula blocks deliberately marked `non-record`, every non-whitespace UTF-16 code unit covered exactly once, linear fail-early resource caps rejecting at block 5001 and character 1,000,001, and canonical JSON with recursive NFC, key sorting and a bare SHA-256 over a deep-frozen result. Third, exact verified blank: only a page whose single region array is empty is decoded, then requires three channels, a byte length exactly `width × height × 3`, and every byte equal to 255, with the decoder set to fail on warnings — no whiteness threshold, no trim heuristic, pages decoded serially so peak work stays at one page. Fourth, table row-membership proof: HTML accepting only one lowercase `table` with `thead` then `tbody`, one header row of `th`, data rows of `td`, and cell attributes limited to `rowspan`/`colspan` whose value is exactly 1; Markdown accepting only first-and-last-pipe rows, a separator of at least three hyphens per column and an exact column count, with a conservative meta-character denylist; headers unique after NFC normalisation; unsafe markup classified as response-invalid while safe-but-unproven structure is classified as record-membership-unproven. A separate manifest commit declared the schema validator as an explicit backend development dependency: it had been declared only at the repository root, and a composite local checkout had resolved it through an ancestor `node_modules` hoist, masking the fact that a backend-only install failed module resolution before its focused tests even registered. The window closed by turning production fail-closed observations back into code: the multi-chunk overview mismatch was remapped from HTTP 502 to HTTP 422, keeping its permanent classification and a frozen diagnostic of exactly version, expected count and actual count, with no repair call added; binder coverage was completed in three places — negation-aware status classifiers so a negated phrase is no longer read as settled, not-activated cards modelled as a supported closed-set target whose monetary fields emit `NOT_APPLICABLE` and are never backfilled to zero (counted in account totals, excluded from utilisation and debt), and an unbounded query section judged complete only when it extends to document end with rows satisfying the same controlled-vocabulary proof and the tail fully consumed — with binder and query-strategy version anchors synchronised into the release verification script. Two last fixes covered boot and deployment: persisted terminal events are now validated against a closed set of "current plus every string a shipped release has actually written" while the write path is unchanged, and PM2 restarts now source the current environment file inside a subshell before `--update-env`, because the operator shell's new-release exports were being injected into the process and dotenv does not override pre-existing environment values, which had crash-looped a rollback on the release identity gate.

**Why**: The overview table is the only self-checking entry point; picking the first table that looks right is equivalent to giving up the check. On the OCR side the difficulty is that provider output is coarse and untrustworthy: a region cannot prove which record a cell belongs to, so the honest outcome is failure rather than letting the model testify for itself. The status-code change from 502 to 422 exists so a caller can distinguish "this evidence is permanently invalid" from "upstream infrastructure is down", and stop retrying the former.

**Constraint left behind**: The JPEG preflight is the only byte-structure parser; no later layer may duplicate or weaken it, and resource caps may only be tightened. Record-membership-unproven and response-invalid are two distinct error classes and must not be merged. HTTP 422 must never be described as recovered analysis; it is a safe stop. Binder and query-strategy identifiers are version anchors, so changing them requires updating the literal assertions in the release verification script in the same step. Evolution of protected content still requires its own baseline transition. The scanned-document OCR path is still not wired to a route, database or frontend: a complete adapter boundary is not a production capability.

---

## Architecture decisions

The decisions below are distilled from ADR-0001 and the contract and security documents kept in the repository, with two additions that were never written up as an ADR but were implemented repeatedly and are load-bearing. Format: Context / Decision / What was given up / Why it stands now.

### D1. A fixed pair of models as the only production chain, with authority split by component

**Context**: Evidence-first analysis could already build a document manifest, evidence graph, fact ledger and deterministic metrics for complete native-text PDFs, but scanned PDFs and images had no bindable structured evidence. The repository already contained a local OCR engine, a lightweight OCR identity-repair path and another vendor's vision model, all of which looked like a convenient fallback.

**Decision**: The production OCR provider is fixed to a single `layout_parsing` endpoint and model; fact extraction is fixed to a single DeepSeek model. Authority is split by component. OCR returns layout regions, candidate text and region bounding boxes — nothing more. The structured adapter only validates, orders, cleans and splits logical rows and cells. The fact-extraction model proposes candidate facts from normalised text. Only the evidence binder may promote a candidate to one of five states: `accepted`, `unknown`, `absent`, `not_applicable`, `conflict`. Only deterministic rules may compute metrics and scores, and they may not call a model. No model's standalone output may enter accepted facts, authoritative derived results or the authoritative cache. When the native text layer satisfies the completeness gate, the OCR call count must be zero.

**What was given up**: Automatic multi-OCR fallback — the same file would acquire a different evidence identity depending on provider order, configuration or a transient error, making cache, errors, privacy and rollback unauditable. Adopting the provider's region JSON or its concatenated text directly — it couples the internal evidence contract to a vendor schema, region granularity cannot prove cell or account attribution, and plain text discards page, span and bounding box. Allowing a model to certify its own candidates — a self-attestation loop that proves neither input coverage nor amount attribution. Zero temperature, JSON mode, disabled thinking and repeated consistency grant no component additional authority.

**Why it stands now**: The chain's trustworthiness comes not from model accuracy but from the fact that no link can vouch for the next. Fallback and self-attestation both hide uncertainty inside the result, and once a score is published there is no way to tell a real conclusion from a silent fill. Rolling back the scan capability returns an explicit unavailable error rather than restoring the old OCR fallback — which is why the legacy code may remain in the tree but is never routed to.

### D2. Three business terminal states, with a non-degradable document-level hard gate

**Context**: The publication gate originally produced only "complete success" or "failure". Allowing users to check verified fields locally required defining a third terminal state first, and guaranteeing that document-level distrust could not leak numbers through a "partial result" or bypass the evidence gate.

**Decision**: Three fixed terminal states. `succeeded` requires the document hard gate to pass, execution and evidence artifacts to be complete, and all fact, metric and decision dependencies closed; only the complete result may enter the authoritative cache. `review_required` requires the document hard gate to have passed, execution to have completed, evidence and review artifact integrity to be intact, and only field- or metric-level `unknown` or `conflict` to remain; it emits only the contract-defined standalone accepted-fact projection, with total score, overall risk, product matching, advisor recommendations and debt-execution advice prohibited, and it must use a separate review-only namespace with its own version and read permissions that can never cross-hit the authoritative cache. `failed` covers both an unmet or unevaluable document hard gate and the case where execution completed but document identity, coverage, hash or hash-chain gates were only then found to have failed; no analysis number is displayed and nothing is cached. Tenant and document identity, page count and page order, full-text coverage, hashes, hash chains and replay protection form the non-degradable document hard gate.

**What was given up**: Relaxing the document hard gate to emit partial results — when identity, page count or hash is untrustworthy, any local figure may belong to the wrong person or the wrong document. Also abandoned: the convenient but unnecessary requirement that `review_required` contain at least one accepted fact. `queued` and `processing` are explicitly non-terminal, so an intermediate state can never be cached as a result.

**Why it stands now**: Phase 0 accepted this target contract only. Production had no `review_required` at the time, and the third state cannot be claimed available until the task protocol, persistence, caching, recovery and UI have each landed in their own phase. That order — freeze semantics first, implement in stages later — is precisely what makes every subsequent phase independently rollbackable.

### D3. The structured evidence contract stores no provider envelope, and a region bounding box may not impersonate cell attribution

**Context**: Storing the OCR provider's response verbatim inside the evidence object is the least work, but that response mixes in request identifiers, usage counters, visualisation images and crop links — while the provider's region granularity is far coarser than a table cell.

**Decision**: The internal `ocr-structured-v1` contract keeps only pages, blocks, spans and region-level bounding boxes. The provider's `id`, `request_id`, `usage`, visualisation output, crop URLs and raw body never enter evidence or canonical bytes. Every normalised block carries a half-open character range within the page text, a normalised bounding box inside its region, a stable reading order and a source ordinal, and states `geometryGranularity: region` plus `recordMembership` as one of `single-record`, `logical-table-row`, `non-record`. HTML and Markdown tables must be split into logical rows and cells by a deterministic parser with no network and no script execution; when multi-account record attribution cannot be proven the adapter returns record-membership-unproven rather than handing the whole table to a model. Rendered JPEG bytes and page identity are request-local validation state and stay out of evidence. Passing structural schema validation is not evidence acceptance.

**What was given up**: Fabricating character-level or polygon-level coordinates for coarse regions; using "close enough" heuristics to fill missing rows; keeping provider fields in the evidence object for debugging — debug data stays outside the contract; and marking generic text blocks as single-record to spare downstream code an error path.

**Why it stands now**: A region bounding box can only assert "this came from this layout region". The moment a cell inherits a polygon that never existed, every later claim of "I verified the position" is false. Making unproven attribution an explicit state costs more visible failures and more review-required outputs, and buys the guarantee that no pseudo-precise authoritative result is produced — the same trade D2 makes.

### D4. Analysis identity derived from hashes of the implementation files, with caching bound across three isolated encryption domains

**Context**: Long-report analysis is expensive, so cache hit rate matters to users; but hand-maintained version numbers get forgotten, and a shared cache key space makes cross-user reuse a live risk.

**Decision**: Analysis identity is derived from content hashes of the files that actually implement the chain — the prompt and schema-bearing service files, the rule engine sources, the OCR-related modules, the dependency lock and the evidence ledger implementation. Editing any implementation rotates the identity; no one has to remember to bump a version. Authoritative cache, task scope and task spool are three mutually isolated AES-256-GCM domains, and each cache entry's key is derived from tenant, document and analysis identity together, which makes a cross-tenant, cross-document or cross-version hit unconstructible rather than merely improbable. Only complete `succeeded` results enter the authoritative cache; `failed` caches nothing; raw provider responses and any model's standalone candidates are never cached across requests or runs. A future analysis identity must additionally include the OCR provider, model and endpoint identity plus the adapter, render, reading-order, table-parser and schema versions.

**What was given up**: Predictable global cache keys and a single key domain — simpler to implement, but cross-tenant hits would then be "hasn't happened yet" rather than "cannot happen". Hand-maintained version numbers as the sole identity source. And every compromise that loosens binding to raise the hit rate.

**Why it stands now**: This choice moves the correctness cost into the runtime, and pays for it by rotating caches on code edits and by pinning each domain identifier with a mirrored assertion. That price was acceptable only because no existing data had to be preserved. What it buys back is the structural exclusion of a defect class — cache bleed between tenants — that functional testing cannot find.

### D5. Contracts and gates before implementation, and no verifier may attest its own bytes

**Context**: A prose architecture document cannot stop drift: a protected file can lose a byte, the CI workflow can delete the line that calls the gate, a temporary repository's clean state can be papered over with an ignore rule — and the verifier can still print PASS.

**Decision**: Freeze a machine-readable contract and its JSON Schema first, make it executable with a schema validator plus negative fixtures (deliberately non-compliant samples that must be rejected), then wire it into CI. Anchor content, not shape: required ancestry plus a protected blob set plus an explicit overlay set, with mode selection depending on no branch name, no environment switch and no fixed `HEAD`. Make the order of trust explicit — the main verifier keeps only built-in modules at top level and dynamically imports the checked executables only after every bootstrap anchor passes. No verifier can prove its own bytes, so the external trust root is fixed as a clean commit plus an independent full-diff review plus CI on that same commit. Legitimate evolution of protected content goes through a separate reviewed baseline transition rather than a weakened literal check.

**What was given up**: Selecting verification mode by branch name or environment flag — easy, forgeable. Embedding a verifier's self-hash inside itself — circular trust. Treating "the workflow literal anchor exists" as a substitute for server-side branch protection — if the workflow deletes the call, the verifier never starts. Adding ignore rules to silence a polluted temporary directory — silencing is the same as invalidating.

**Why it stands now**: This is the part of the history most easily underestimated by outside readers: it treats "who can prove a pass" as a design object rather than a side effect. Once the repository is public, this layer stands on its own as a reference for CI integrity gating.

### D6. Staged delivery with a one-way rollback boundary

**Context**: Introducing new model access, new terminal-state semantics and new business scoring rules at once makes any failure unlocatable, and makes single-layer rollback impossible.

**Decision**: Split into Phase 0 (contracts and safety gates), Phase 1 (frontend truth), Phase 2 (trusted support events), Phase 3 (OCR HTTP client) and Phase 4 (structured adapter), each with its own PR, release and rollback, and each begun only after the previous one was accepted. Files touched by more than one phase get explicit semantic union checks. Rollback may only disable the capability the current phase added: it must not silently switch back to a legacy OCR fallback, and must not let review artifacts enter the authoritative cache. Business scoring questions — for example whether inactive or not-activated accounts should count — belong to a different phase from model access and are never decided alongside it.

**What was given up**: The one-shot verifiability of a single large commit. This chain deliberately gives up "one big PR is less work" in exchange for every step being independently falsifiable. It also gives up the convenience of deciding things in passing: bundling the inactive-account scoring decision with the OCR launch was explicitly rejected, because it would leave model integration and business semantics unverifiable and unrollbackable separately.

**Why it stands now**: The two longest debugging threads in the history — the post-merge baseline failing, and the rollback crash loop — both sat exactly at a boundary where identifiers from several phases were evolving at once. Staging does not reduce the number of defects; it determines whether you can undo one layer when they appear.

---

## Problems solved along the way

Taken from the fix commits and the conflict ledgers in the handoff documents; only entries with general engineering value are kept.

**1. A validation failure was reported as a retriable infrastructure error.** In multi-chunk analysis, a single catch converted every merge rejection into a 5xx, so clients kept retrying a conclusion that was permanently invalid. The fix maps that one exact code to 422 on its own, keeps its existing permanent classification, freezes the diagnostic to version, expected count and actual count, and explicitly forbids adding a hidden repair call; all other chunk failures keep their previous status. The point is to separate "permanently invalid" from "temporarily unavailable" before discussing diagnostics.

**2. Tightening version validation made historical data block startup.** The storage layer re-validated every persisted terminal event against the current version identifier only, so rows legitimately written by the previous release parsed as corrupt and the process failed closed at boot. The fix changes the validation set from "the current value" to a closed set of "current plus every string a shipped release actually wrote", preserving the original string, while the write path stays unchanged and still normalises any non-current value to null. Read side tolerates history; write side continues to permit only the present.

**3. A rollback injected new release variables into the process and crash-looped.** The deployment restart used `--update-env`, which injects the calling shell's environment, and dotenv never overrides values already present in the process environment. The rolled-back code therefore booted with a mixed identity — the restored release id from the env file plus the new commit id from the operator's shell — and killed itself on the release gate repeatedly. The fix sources the current environment file inside a subshell before the restart, so the process environment matches the file exactly and is decoupled from whatever the operator's shell exports.

**4. "Take the first table that looks right" plus divergent status semantics.** The text fallback matched row labels across the whole document, so a complete decoy table placed before the official header would win; meanwhile the overview's active counts used raw bucket lengths while the authoritative downstream computation already filtered cancelled and closed statuses, so the two never agreed. The fix enumerates header-bounded, fixed-order, complete candidate tables and requires unique cardinality — zero candidates remain unknown and invent no zero, multiple candidates fail closed — and reuses the authoritative status predicates only for active counts, leaving raw totals and the historical exclusion untouched. Zero candidates and multiple candidates are different semantics; conflating them produces both false passes and false failures.

**5. Negated phrases read as settled, and not-activated accounts filled with zero.** Status regexes matched negated forms, zeroing active balances and triggering record-row mismatches; separately, a not-activated card had no representable state, so implementations reached for 0. The fix introduces negation-aware closed-set classifiers and makes activation state a supported closed-set binder target with source-row proof, emitting `NOT_APPLICABLE` for monetary fields — counted in account totals, excluded from utilisation and debt. Both cases share one root cause: when a closed set is missing a state, the code borrows a state that already exists.

**6. An unbounded section treated as fully read.** A query-detail section has no explicit end marker, so stopping at the first unrecognised line silently dropped data. The fix makes completeness a provable condition: the section must extend to document end, every row must satisfy the same strict controlled-vocabulary proof, and the tail — headers, page footers, anchored closing notes — must be fully consumed; anything unrecognised stays fail-closed. Recurring production failures of this kind were archived under a closed-set code rather than attributed to a guess.

**7. Dependency hoisting masked an undeclared test dependency.** A schema validator declared only in the root manifest resolved through an ancestor `node_modules` in a composite local checkout, so the tests passed everywhere locally; a job that installed only that package's own lock failed module resolution before the tests registered. The fix declares the exact version as a development dependency of that package and re-verifies install and resolution inside detached worktrees with no `node_modules` at any ancestor. The same batch asserts that the runtime file still loads with development dependencies omitted, confirming the dependency really is development-only.

**8. A POSIX symlink polluted the clean state of a temporary Git repository.** The verifier's scenario repos built a dependency bridge at the repository root. A Windows directory junction is treated as a directory by the ignore rule, but a POSIX directory symlink is not itself a directory, so under the same rule a strict untracked check reported it exactly — and the clean gate correctly rejected on Linux. The fix creates the bridge once at a common parent of all scenario repos, relying on module resolution walking upward, and asserts with `lstat` after each clone that no such directory exists at the repo root. The important discipline: refusing to "fix" the assertion by adding an ignore rule.

**9. A newer-Git-only construct was not portable to older Git.** Passing each round's cumulative bare tree object directly as one side of `merge-tree --write-tree` worked on one Git build and failed on an older one. The fix writes a deterministic commit per round — cumulative tree, fixed parent, fixed neutral identity and timestamp — into the object database and passes that commit instead, leaving index, worktree, refs and config untouched. Both Git versions then produce the identical locked tree, without pinning a minimum Git version.

**10. The checking code depended on the thing being checked, inverting the order of trust.** The first content-baseline verifier statically imported the schema validator, the secret policy and the fixtures at top level, while CI ran another repository check first: a protected executable committed as "exit 0 immediately", or with side effects, could alter or end the process before any content anchor ran. The fix keeps only built-in modules at top level, completes every bootstrap anchor through safe Git reads with immediate non-zero exit on any failure, and only then dynamically imports the locked modules — with the whole step moved earlier in CI.

---

## Provenance of this document

This repository does not include commit history from the early development process. Dates, phases and constraints are grounded solely in the design documents and implementation retained in this repository.
