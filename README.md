# flow.js

An adaptive interface runtime. Developers register what their application can do (data, actions, state, context and a theme). flow.js asks OpenAI for a first dashboard, instruments it, watches how it is used alongside Sentry traces, and proposes structured interface mutations. Validated mutations are applied with animation and saved as immutable versions, with history and undo.

> Developers build the functionality once. flow.js continuously improves how users access it.

This repository is the hackathon MVP: a local Next.js app with a fictional sales analytics demo and an optional parallel Tiger Data analytics service.

The pnpm workspace has three packages: the repository root is `@flowjs/core`, which owns the runtime, API client, renderer, studio components, and capability execution; `apps/demo` is `@flowjs/demo`, which owns the Next.js entry points, sales registration and data, recorded responses, and demo tests; `apps/analytics` is `@flowjs/analytics`, which owns Tiger ingestion, SQL analytics, and the daily baseline worker. Both apps import core through workspace package exports.

## Quick start

Requires Node 24 or later (for the built-in `node:sqlite`) and pnpm. If pnpm is not installed, prefix each command with `npx pnpm@12` instead.

```bash
pnpm install
cp apps/demo/.env.example .env.local   # optional: add OpenAI and Sentry credentials at the workspace root
pnpm dev                     # http://localhost:3000
```

Without credentials, explicitly set `FLOW_AI_MODE=recorded` to run the demo. It replays recorded AI responses (labelled **Recorded response** everywhere they appear) and measures latency locally. Live mode requires `OPENAI_API_KEY`.

## Environment variables

| Variable                                            | Purpose                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`                                    | Enables live OpenAI calls for dashboard generation and optimization reasoning. Server-side only.                                                                                                             |
| `OPENAI_MODEL`                                      | Model override. Default `gpt-5.5`.                                                                                                                                                                           |
| `FLOW_AI_MODE`                                      | Fallback switch. `live` (default) calls OpenAI and falls back to recordings if a call fails or returns malformed output. `recorded` always replays recordings, which is useful when presenting on bad Wi-Fi. |
| `NEXT_PUBLIC_SENTRY_DSN`                            | Browser Sentry: Tracing and Session Replay.                                                                                                                                                                  |
| `SENTRY_DSN`                                        | Server Sentry: capability spans and Logs. Falls back to `NEXT_PUBLIC_SENTRY_DSN`.                                                                                                                            |
| `NEXT_PUBLIC_SENTRY_ORG`                            | Optional. Turns trace ids in the evidence panel into links to your Sentry org.                                                                                                                               |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Optional. Source-map upload at build time.                                                                                                                                                                   |
| `FLOW_DB_PATH`                                      | SQLite file. Default `apps/demo/.flow/flow.db` when started from the workspace root.                                                                                                                         |

## Database

flow.js uses Node's built-in SQLite (`node:sqlite`). The schema is created automatically on the first request, so no migration step is needed. To start over:

```bash
pnpm db:reset   # deletes the database; the next page load shows "No dashboard layout was written."
```

Tables follow the spec's data model: `applications`, `capabilities`, `ui_versions`, `version_activations`, `telemetry_events`, `capability_calls`, `optimization_runs`. UI versions are immutable: SQLite triggers reject any `UPDATE` or `DELETE`. Metrics are derived from events when requested, so there is no `telemetry_aggregates` table.

## Daily baseline with Tiger Data

Aggregate behavior generates the **next shared baseline**, not another user-facing view. Telemetry streams continuously; at **00:05 UTC each day**, the analytics worker analyzes the previous complete UTC day and asks the existing Flow.js optimization pipeline for a safe improvement. A stopped worker catches up on the latest completed day when restarted; it does not replay a backlog of daily redesigns.

```text
Browser -> Flow.js telemetry + transactional SQLite outbox
  -> parallel analytics worker -> Tiger hypertables + continuous aggregates
  -> daily evidence -> existing AI / validation / scoring -> next baseline
```

The new baseline is picked up on the next page load. A personal layout's next refresh branches from that baseline while retaining the browser's usage evidence. An open page is not rearranged by the job. The existing baseline/personal controls, history, undo, and mutation-rate threshold remain; there is no additional aggregate view.

### Setup

Create a Tiger Cloud Timescale service and place its PostgreSQL connection URL in the root `.env.local`. The migration needs permission to create the `flow_analytics` schema and the `timescaledb` and `timescaledb_toolkit` extensions. Remote connections verify TLS certificates. Do not put database credentials or the service token in `NEXT_PUBLIC_*` variables.

| Variable                   | Purpose                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `FLOW_ANALYTICS_ENABLED=1` | Enables the app outbox and daily-baseline mode; disables browser-triggered shared optimization. |
| `TIGER_DATABASE_URL`       | PostgreSQL connection URL used only by the analytics service and migration.                     |
| `TIGER_SSL_ROOT_CERT`      | Optional absolute path to a trusted CA file for a service using a private certificate.          |
| `FLOW_ANALYTICS_TOKEN`     | Random secret of at least 32 characters, shared by the app and service.                         |
| `FLOW_APP_URL`             | App origin; defaults to `http://127.0.0.1:3000`.                                                |
| `FLOW_ANALYTICS_PORT`      | Loopback HTTP port; defaults to `4319`.                                                         |
| `FLOW_ANALYTICS_POLL_MS`   | Outbox polling interval; defaults to `1500`. This does not change the daily AI schedule.        |

Generate the token locally with `openssl rand -hex 32` and enter it directly into your environment file. Alternatively, before creating `.env.local`, import a local OpenAI key file and the Tiger credential export:

```bash
node scripts/configure-local.mjs --openai openai.txt --tiger /path/to/tiger-credentials.txt
```

The importer generates the shared token, enables live AI and daily analytics, and creates an owner-only, Git-ignored environment file without printing secrets. It refuses to overwrite an existing file. The demo startup loader reads this environment before Next creates its route workers; restart both services after changing credentials. Browser tests explicitly use recorded AI with cloud analytics disabled.

New Tiger services can temporarily present a bootstrap certificate before their public certificate is ready. Wait for a publicly trusted certificate, or configure a trusted CA file according to [Tiger's TLS guidance](https://www.tigerdata.com/docs/use-timescale/latest/security/strict-ssl/). Certificate verification stays enabled.

Then:

```bash
pnpm analytics:migrate
pnpm dev                 # terminal 1; restart after changing environment variables
pnpm analytics           # terminal 2; reads the root .env.local
```

`GET http://127.0.0.1:4319/health` reports readiness, unavailable migrations, or missing configuration. `POST /v1/events` accepts authenticated batches for server-side integrations. The worker normally pulls `GET /api/flow/analytics`, commits to Tiger, then acknowledges delivery with `POST /api/flow/analytics`. The same authenticated endpoint exposes the current daily job result. No database is mocked when configuration is absent, and no cloud resource is provisioned automatically. **Docker is not required** for the app or Tiger Cloud setup.

### Prepared aggregate demo

The initial screen opens on **Aggregate**. **Yours** generates a personal layout on first use and then switches back to it without another AI call. Reloading starts from Aggregate. The existing menu's **Regenerate layout** action, shadcn components, persistent rationale, history and undo remain available.

For a repeatable multi-user case, use a separate SQLite database and set these non-secret values alongside the existing Tiger/OpenAI credentials:

```dotenv
FLOW_ANALYTICS_SAMPLE_KIND=simulated
FLOW_ANALYTICS_ENABLED=1
FLOW_DB_PATH=/absolute/path/to/separate/aggregate-demo.db
FLOW_APP_URL=http://127.0.0.1:3001
FLOW_ANALYTICS_PORT=4320
```

```bash
pnpm demo:aggregate
pnpm --dir apps/demo dev --hostname 127.0.0.1 --port 3001
# Separate terminal:
pnpm analytics
```

The replay creates **12 simulated browser identities over 24 previous-day sessions** using the existing event generator. The scenario contains repeated date-filter/chart workflows, export completions, synthetic backend timing, foreground-time events, and nested history-menu opens and dismissals. It sends actual HTTP batches to the ingestion handler, calculates evidence in Tiger, and calls the same daily-baseline validator and AI pipeline. The starting layout is a labelled recorded fixture; `FLOW_AI_MODE=live` uses real OpenAI for the next baseline. Demo mutation rate is set to Experimental. Unsafe or unjustified proposals still do not apply.

Re-running the command on the same day reuses the saved result, without a second baseline or model call. A fresh demo database is required for a fresh rehearsal. Do not reset or relabel a live database: SQLite and Tiger both reject changing a source between live and simulated. Tiger's `flow_analytics.sources` table stores provenance; all queries are source-scoped. The original **Add 6 seeded sessions** button remains local-only in live mode.

The UI shows **Simulated cohort**, with its browser/session counts. The existing developer console shows the cohort's Tiger evidence and saved optimization. These are mock people and interactions, not measured real-user adoption or proof of improved usability. A successful rehearsal on 2026-09-20 ingested 998 events/calls, calculated 172 interactions, and generated a live-AI v2 promoting Date range beside Revenue.

Demo sequence:

1. Open the Aggregate view and its simulated-cohort label.
2. In the developer console, show the 12-browser/24-session evidence and the date-filter-to-revenue sequence behind the recommendation.
3. Show the saved optimization and its validated changes; history retains the starting layout.
4. Return to the user screen, interact with a few controls, then choose Yours.
5. Toggle back to Aggregate to demonstrate that one person's layout does not replace the shared baseline.

### Evidence and safety

- Stable event IDs, transactional receipts, and commit-before-ack delivery make retries idempotent. A persistent source ID separates installations, including fresh databases whose version numbering restarts at `v1`.
- Tiger stores live semantic events and backend calls in hypertables. Minute Continuous Aggregates accelerate counts and duration sums; Toolkit percentile sketches are merged for backend latency. Exact session counts and workflow sequences are queried separately. Real-time aggregate reads are explicitly enabled; closed-day rollups are refreshed before analysis to include late arrivals.
- The daily snapshot serializes ingestion for that source while rollups refresh. The worker retries failures with backoff. A persisted daily lease and atomic publication prevent duplicate baselines; failed jobs retry at most three times. Completed days, including insufficient-data days, are not regenerated.
- A proposal requires at least **5 distinct interacting browser identities, 5 sessions, and 20 interactions**. These are pseudonyms, not authenticated people. Personal-layout usage supplies capability preferences; position/discovery metrics remain scoped to the exact baseline version. Synthetic seeded sessions never leave a live installation or satisfy its gates. The separate simulated installation exports them with explicit provenance and reports zero live sessions.
- Active time is foreground time on the engaged component or semantic menu/tab path, capped at a 30-second idle cutoff. Hidden time is excluded. It is not whole-tab dwell: engaging a component replaces the navigation timer rather than also accumulating time for its parent tab. Typed values and arbitrary event metadata are removed before browser transmission; menu paths use fixed semantic identifiers. Long active time alone is not treated as success or friction.
- The existing AI brief, provider, mutation validator, scoring, immutable history, and undo are reused. Sparse evidence, unsafe output, no-change proposals, or a conservative mutation rate preserve the baseline. Stale-version proposals cannot apply. In live mode, a recorded fallback is never automatically published as a daily baseline.
- On reload, the state endpoint offers only personal layouts based on the active daily baseline; older personal history is retained. A pending daily proposal remains available in the developer console for manual approval. Removing seeded data clears local demo telemetry, not already ingested Tiger history; use a fresh isolated demo database for a fresh rehearsal.
- Columnstore policies compress older chunks. Automatic deletion is intentionally **not configured** until retention requirements are decided; raw events and deduplication receipts currently grow. The browser retry queue is bounded and in-memory, so closing a page or a prolonged offline period can still lose events before server acceptance. Once accepted, events and their outbox entry are atomic.

The service currently supports one registered application/source per worker, matching the demo. Multi-tenant authentication, population experiments, and automated rollback are not implemented. Live OpenAI personal generation, certificate-verified Tiger Cloud ingestion, real-time aggregates, and the SQL integration suite were verified on 2026-09-20. The production daily baseline still requires sufficient prior-day usage; integration fixtures do not count toward that gate.

## OpenAI

OpenAI is called server-side through the Responses API with Zod structured outputs (`responses.parse` + `zodTextFormat`) in two places:

1. **Initial UI generation.** Input: application context, capability descriptions and contracts, compatible primitives, dependency graph and theme. Output: a UI schema. Executable code is never sent.
2. **Friction interpretation and mutation proposal.** Input: the current schema, per-component metrics, interaction sequences, backend latency (correlated with Sentry traces) and heuristic findings. Output: finding, UI-or-performance classification, evidence, confidence, expected benefit, explanation and a restricted list of mutations.

Every output is parsed with Zod and then validated independently by the runtime before anything executes. Validation checks capabilities, primitive compatibility, targets, and never removing the only visible control for a required capability.

- **Generation:** if a live output is invalid or the call fails, flow.js replays the recorded response instead. An invalid schema is never persisted.
- **Optimization:** if a live proposal is well formed but unsafe, it is shown as rejected together with the reasons, and nothing changes.

**Recorded responses** live in `apps/demo/src/demo/recordings.ts`. They were hand-authored to the same output contracts and are validated against the demo registry by `apps/demo/src/demo/demo.test.ts`; they were not captured from a live call. The UI labels them as recorded and shows the fallback reason. With an API key configured, verify the live path before relying on it in a demo.

## Sentry

- **Tracing:** every capability call (data fetch or action) runs inside a `flow.data` / `flow.action` span. The span carries the capability, component, UI version, session and replay id.
- **Latency pairing:** the locally measured latency is stored with the span's trace id. Heuristics use it to separate interface friction from backend performance. For example, retries on the slow PDF export are diagnosed as backend performance with no redesign. The evidence panel links trace ids when `NEXT_PUBLIC_SENTRY_ORG` is set.
- **Session Replay:** records sessions, and the replay id is attached to every telemetry event and capability call.
- **Richer interaction telemetry:** generated components record first view, pointer hover, focus, scroll direction, clicks, value changes, completions, errors, and attempts to interact with disabled controls. These signals are persisted as semantic flow events and included in optimization evidence so repeated dead ends can be distinguished from ordinary use.
- **Logs:** capability successes and failures are logged via `Sentry.logger`.

Sentry is optional: with no DSN the dashboard works unchanged and latency is still measured locally. The full path against a configured Sentry project has **not** been verified yet (no DSN was available while building). Set a DSN, run the demo, and confirm spans and replays arrive.

## Demo script

1. **Developer setup:** the start screen shows `apps/demo/src/demo/sales-app.ts`. It lists capabilities, context and theme, and no layout.
2. **Generation:** choose **Generate dashboard** to create v1. The date filter lands below the fold as a dropdown, a plausible inefficiency.
3. **Use:** change the date range a few times and click the revenue chart after each change. Export a CSV. Select a transaction and refund it.
4. **Telemetry:** the Telemetry tab and the chips on each component show usage, discovery time, repeats, sequences and backend latency. **Add 6 seeded sessions** adds synthetic sessions, counted separately and labelled "seeded" everywhere.
5. **Optimize:** choose **Optimize now**. The Optimization tab explains the finding, evidence, sample size, latency, the score against the mutation-rate threshold, and the proposed mutations, all before anything changes.
6. **Mutation:** the proposal applies automatically after a 3-second countdown if it clears the threshold; otherwise choose **Apply change**. The date filter animates above the revenue chart and becomes a segmented control. Changed components are outlined and tagged.
7. **Persistence:** reload the page. v2 remains.
8. **History and undo:** open **History** to see reasons and restore any version, or choose **Undo** to animate back to the parent. A later optimization branches from the active version.
9. **Mutation rate:** move the **Stable ↔ Experimental** slider. At 0 nothing is applied automatically; higher rates accept more marginal proposals (threshold = 0.9 − 0.7 × rate).
10. **Backend vs UI:** click **Export PDF** several times while it is working, then optimize. flow.js diagnoses backend performance and proposes no interface change.

## Architecture

```
src/flow/            the runtime (framework-agnostic, fully unit tested)
  registry.ts        createFlowApp: capabilities, contracts, dependency graph
  primitives.ts      primitive library and capability compatibility
  schema.ts          UI schema validation, grid layout, version diffing
  mutations.ts       MOVE, REORDER, RESIZE, SWAP_VARIANT, SHOW, HIDE with safety checks
  scoring.ts         benefit + confidence + evidence − disruption; mutation-rate threshold
  metrics.ts         telemetry → usage, discovery, repeats, sequences, latency
  friction.ts        heuristics: buried control, separated controls, poor primitive,
                     oversized low-value component, high-retry action (UI vs backend)
  store.ts           node:sqlite persistence with immutable versions
  runtime.ts         generate → analyze → propose → validate → score → apply / undo
  ai/                OpenAI contracts, briefs, live and recorded providers
apps/demo/src/demo/   the developer's code: sales capabilities, fictional data, recordings
apps/demo/src/server/ runtime composition and thin capability adapter
apps/demo/src/app/api/flow/ route handlers
apps/analytics/      separate ingestion service, daily worker, Tiger SQL and integration tests
src/server/          reusable capability execution and API error handling
src/components/      schema-driven renderer (Motion layout animations) and runtime chrome
src/client/          API client and semantic telemetry tracker
```

## Testing

```bash
pnpm test        # core unit tests: registry, schema, mutations, scoring, store, metrics,
                 # heuristics, runtime (AI failure and fallback)
pnpm --dir apps/demo test # demo integration tests
pnpm test:e2e    # Playwright in local Chrome: the full demo loop in recorded mode
pnpm typecheck
pnpm --dir apps/demo typecheck
pnpm test:analytics
pnpm --dir apps/analytics typecheck
pnpm build
```

The real SQL integration suite is opt-in and requires a disposable Timescale database with Toolkit:

```bash
FLOW_ANALYTICS_TEST_DATABASE_URL='postgresql://...' pnpm --dir apps/analytics test:integration
```

It applies the migration and uses random source IDs, deleting only its test rows. It covers concurrent deduplication, daily rollups, late arrivals, cross-layout scoping, and the full outbox-to-next-baseline flow. Only the AI output and HTTP transport are test fixtures; the database and SQL are real. A local Timescale Docker container can provide this test database, but is not used by the deployed application.

## Assumptions and limits

- One shared baseline plus browser-scoped personal layouts, fictional data, and no end-user authentication. The analytics service API requires a server token. Cohort-specific layouts, A/B tests and automatic rollback are out of scope.
- A session is one page load, and discovery time is measured from when the current version was shown.
- The fictional backend has simulated latency; PDF export is deliberately slow.
- Seeded sessions are synthetic and always labelled; remove them from the Telemetry tab.

## Codex's contribution

_To be completed by the team with a concrete, real example of how Codex supported development (for example a specific bug it debugged or tests it generated, with a link to the commit). This MVP was implemented without Codex, so no example is claimed here._
