# flow.js

An adaptive interface runtime. Developers register what their application can do (data, actions, state, context and a theme). flow.js asks OpenAI for a first dashboard, instruments it, watches how it is used alongside Sentry traces, and proposes structured interface mutations. Validated mutations are applied with animation and saved as immutable versions, with history and undo.

> Developers build the functionality once. flow.js continuously improves how users access it.

This repository is the hackathon MVP: one local Next.js app with a fictional sales analytics demo.

The pnpm workspace has two packages: the repository root is `@flowjs/core`, which owns the runtime, API client, renderer, studio components, and capability execution; `apps/demo` is `@flowjs/demo`, which owns the Next.js entry points, sales registration and data, recorded responses, and demo tests. The demo imports core through the workspace package exports.

## Quick start

Requires Node 24 or later (for the built-in `node:sqlite`) and pnpm. If pnpm is not installed, prefix each command with `npx pnpm@12` instead.

```bash
pnpm install
cp apps/demo/.env.example .env.local   # optional: add OpenAI and Sentry credentials at the workspace root
pnpm dev                     # http://localhost:3000
```

Without any credentials the app still runs end to end. It replays recorded AI responses (labelled **Recorded response** everywhere they appear) and measures latency locally.

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
pnpm build
```

## Assumptions and limits

- One global dashboard configuration, fictional data, no authentication. Cohorts, personalization, A/B tests and automatic rollback are out of scope.
- A session is one page load, and discovery time is measured from when the current version was shown.
- The fictional backend has simulated latency; PDF export is deliberately slow.
- Seeded sessions are synthetic and always labelled; remove them from the Telemetry tab.

## Codex's contribution

_To be completed by the team with a concrete, real example of how Codex supported development (for example a specific bug it debugged or tests it generated, with a link to the commit). This MVP was implemented without Codex, so no example is claimed here._
