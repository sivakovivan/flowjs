# flow.js Hackathon MVP

## Summary

Build a local, single-application demo in the empty repository. A developer registers sales analytics capabilities; OpenAI generates the first dashboard schema; real interactions produce evidence; an approved optimization changes the interface visibly; the new version survives a reload and can be restored or undone. The attached specification supplies product requirements, while the choices below define this implementation.

## Implementation

- Use Next.js App Router, TypeScript, pnpm, React, Motion, Zod, Recharts, and a local SQLite database. Keep capability functions in a server-side registry; expose their descriptions and schemas to OpenAI and the renderer, never executable code. Use Node 24’s `node:sqlite` for the local database. Next.js [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers) provide the server API.
- Define `createFlowApp({ context, data, actions, state, theme, mutationRate })`. Data and action entries have stable IDs, descriptions, declared inputs or output shapes, and server functions. State declares defaults and dependencies. The demo registry provides revenue, orders, customers, transactions, date range, customer search, export, and refund.
- Store immutable UI versions containing component ID, capability ID, compatible primitive, size, order, visibility, and optional group. Build at least six functional primitives: metric card, line chart, table, button, dropdown, segmented control, and search field. The renderer dispatches by primitive, binds registered capabilities, and animates layout and variant changes with Motion’s [layout APIs](https://motion.dev/docs/react-layout-animations).
- Use the server-side OpenAI Responses API for initial schema generation and for a structured friction finding plus mutation proposal. Parse outputs against Zod schemas, then independently validate capability references, primitive compatibility, and mutations before execution. The [official OpenAI documentation](https://developers.openai.com/api/docs/guides/structured-outputs) supports structured Responses outputs. Ship recorded, previously validated responses as a clearly indicated fallback when a live call fails.
- Instrument generated controls for view, click, value change, start, completion, and error events. Persist events with session and UI version IDs; derive discovery time, repeat use, interaction sequences, error rate, and component usage. Record local action latency alongside Sentry spans, and attach Sentry trace and replay references when available. Use those correlated measurements to distinguish slow backend actions from UI discovery friction. Configure Sentry Session Replay and Tracing for the demo.
- Implement understandable friction heuristics, then send their metrics, current schema, capability descriptions, and latency context to OpenAI. Show the evidence, sample size, reasoning, and proposed change before applying it. Support `MOVE`, `REORDER`, `RESIZE`, `SWAP_VARIANT`, `SHOW`, and `HIDE`; reject unknown IDs, incompatible variants, invalid targets, and changes that remove the only usable control for a required capability.
- Make **Optimize Now** the reliable demo trigger. Apply a proposal only after validation and a mutation-rate threshold check; `0` disables automatic application. Commit the new schema and evidence as an immutable version, activate it in one database transaction, and animate the client update. History shows reason and restore controls. Undo activates the parent version without deleting any history; a later optimization branches from the active version.

## Verification and demo

- Test registration and schema validation, every supported mutation, mutation-rate boundaries, version branching and undo, and rejection of unsafe proposals. Exercise AI failure and replay fallback without creating an invalid version.
- Run an end-to-end local demo: generate v1 from capabilities, interact with the date filter and revenue chart, inspect actual telemetry and latency evidence, optimize, observe the animated change, refresh to confirm persistence, then inspect history and undo. Label recorded AI responses and any seeded demo data so they cannot be mistaken for live results.
- Document pnpm setup, environment variables, database initialization, OpenAI and Sentry credentials, the fallback switch, and one concrete example of Codex’s contribution to development. Verify the full Sentry path with a configured project; the local dashboard remains usable when Sentry is unavailable.

## Assumptions

- This is a local hackathon demo with one global dashboard configuration, fictional sales data, and no authentication or deployment requirement.
- OpenAI calls are live by default, with recorded valid outputs for presentation resilience. Sentry performance evidence uses locally measured latency correlated with emitted traces, rather than querying Sentry’s API.
- Use pnpm because it is available on this machine and the current `npm` command is broken. Cohorts, individual personalization, A/B testing, and automatic rollback remain outside this MVP.
