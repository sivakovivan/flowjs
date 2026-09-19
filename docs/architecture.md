# Infrastructure and architecture

This document describes the implemented hackathon MVP. flow.js runs as one Next.js application with a fictional sales dashboard. The application owns both the browser UI and the server API; SQLite is its local persistent store. OpenAI and Sentry are optional external services. There is no separate worker, queue, cache service, or deployment configuration in this repository.

The pnpm workspace separates `@flowjs/core` at the repository root from the `@flowjs/demo` Next.js app in `apps/demo`. The demo imports runtime modules, browser components, the API client, and capability execution from `@flowjs/core`. It owns the sales capability registration, fictional data, recordings, Next.js routes, and server bootstrap that wires those pieces together.

## System map

```text
Browser: FlowStudio + schema-driven Dashboard
  |  REST requests and semantic telemetry
  v
Next.js App Router: /api/flow/*
  |  getRuntime(): one runtime per Node process
  +-- capability registry + demo sales functions
  +-- generation / metrics / optimization / mutation validation
  +-- FlowStore --> local SQLite (.flow/flow.db)
  +-- OpenAI Responses API (optional; recorded responses available)
  +-- Sentry tracing and logs (optional)

Browser Sentry SDK --> Sentry tracing and Session Replay (optional)
```

## Runtime boundaries

| Layer            | Location                                                            | Responsibility                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| App and API      | `apps/demo/src/app/page.tsx`, `apps/demo/src/app/api/flow/`         | Render the studio and expose route handlers for state, generation, telemetry, metrics, optimization, settings, history, data, and actions.       |
| Browser          | `src/components/studio/`, `src/components/renderer/`, `src/client/` | Render the active UI schema, call the API, animate layout changes, and collect semantic interaction events.                                      |
| Server adapter   | `src/server/`, `apps/demo/src/server/`                              | Reusable capability execution and API error handling, plus demo-specific runtime composition.                                                    |
| Core runtime     | `src/flow/`                                                         | Register capabilities, validate schemas, derive metrics and friction findings, score and validate mutations, manage versions, and persist state. |
| Demo application | `apps/demo/src/demo/`                                               | Define sales capabilities, fictional data, and recorded AI responses.                                                                            |

The browser receives capability descriptions and UI schemas, then renders known primitives. The executable data and action functions stay on the server. Requests to `/api/flow/data/[capability]` and `/api/flow/actions/[capability]` execute only registered capabilities; input and output contracts are checked at that boundary.

## Request and adaptation flow

1. `GET /api/flow/state` loads application metadata, capability descriptions, the active version, and version history. On the first runtime access, `getRuntime()` opens SQLite, creates its schema, and synchronizes the demo capability registry.
2. `POST /api/flow/generate` builds a brief from the registry and asks the AI provider for an initial UI schema. The runtime parses and validates the schema before persisting v1. Once an active version exists, generation returns it.
3. The dashboard requests data and runs actions through capability routes. The server measures each call's latency and saves its outcome, component, version, session, and available Sentry trace/replay IDs.
4. The browser batches semantic events to `POST /api/flow/telemetry` about every 1.5 seconds and on page hide. The server accepts only events tied to a real version and component. `GET /api/flow/metrics` derives metrics and heuristic findings from stored events and capability calls for the active version.
5. `POST /api/flow/optimize` builds an evidence brief, obtains a structured proposal, validates candidate mutations, scores them, and saves an optimization run. This request does not alter the active UI. A proposal may be pending, eligible for automatic apply, rejected, or a no-change performance diagnosis.
6. `POST /api/flow/optimize/[runId]/apply` rechecks that the source version is still active and that mutations remain valid. Automatic apply also checks the current mutation-rate threshold. It creates a new immutable version in a transaction and activates it. The UI animates to the returned schema.
7. Undo and restore activate an existing version through `/api/flow/versions/undo` and `/api/flow/versions/[versionId]/restore`; they do not edit historical schemas.

OpenAI uses the server-side Responses API with structured Zod outputs. If no API key is set, recorded mode is forced, or a live call fails validation, the runtime can use the recorded demo response. The response source and fallback reason are exposed in the UI. AI outputs propose schemas or mutations; the runtime validates them before persistence or execution.

## Persistence

`FlowStore` uses Node 24's built-in `node:sqlite` with WAL mode and foreign keys enabled. The default database is `apps/demo/.flow/flow.db` when started from the workspace root; `FLOW_DB_PATH` overrides it. Tables are created automatically when the runtime first opens the database:

| Table                                  | Data                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applications`, `capabilities`         | Registered app metadata, theme, mutation rate, and capability descriptors.                                                                                          |
| `ui_versions`, `version_activations`   | Immutable UI schemas with parent links, plus an activation log for generation, optimization, undo, and restore. SQLite triggers reject version updates and deletes. |
| `telemetry_events`, `capability_calls` | Browser interactions and server capability outcomes, including seeded-demo flags and observability IDs.                                                             |
| `optimization_runs`                    | Proposal, evidence, score, threshold, status, validation errors, and applied version.                                                                               |

Metrics are computed on request rather than stored as aggregates. The app currently has one global dashboard configuration, shared by all sessions. The SQLite file must live on persistent, writable local storage if state should survive process restarts; the repository does not configure hosting, backups, or multi-instance coordination.

## Observability and configuration

`apps/demo/src/instrumentation.ts` initializes server Sentry tracing and logs when a DSN exists. `apps/demo/src/instrumentation-client.ts` initializes browser tracing and Session Replay. Capability spans carry capability, component, version, session, and replay IDs; measured latency and trace ID are also saved locally so friction analysis can distinguish a slow backend call from a hard-to-use interface. Without Sentry credentials, local latency measurement and the dashboard still work.

Node 24 or later and pnpm are required. Run `pnpm install` and `pnpm dev` for local development, then open `http://localhost:3000`. Configuration is documented in `apps/demo/.env.example`: `OPENAI_API_KEY`, `OPENAI_MODEL`, and `FLOW_AI_MODE` control AI behavior; `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, and related Sentry variables control observability; `FLOW_DB_PATH` selects the database file. `pnpm db:reset` deletes the local database. `pnpm test`, `pnpm --dir apps/demo test`, `pnpm test:e2e`, both package typechecks, and `pnpm build` are the available verification commands.

## Current scope

This is a local demo with fictional backend data, simulated latency, synthetic seed sessions, and no authentication or per-user UI versions. The repository contains no production infrastructure definition. Hosting it beyond a single process would require decisions about shared persistence, coordination, access control, and operational backups.
