# BackBoard evaluation

`pnpm eval:backboard` calls the real BackBoard API (it costs credits) and measures whether the integration works, per model tier. It needs `BACKBOARD_API_KEY` in `.env.local`. Use `EVAL_TRIALS=3` to change the sample size and `EVAL_TIERS=fast,deep` to limit the tiers.

Each trial runs four tasks: generate the sales dashboard, and three optimization scenarios with a known right answer.

| Scenario | Correct decision |
| --- | --- |
| Date filter buried below the fold and switched repeatedly | Interface friction, with a mutation on `date-range` |
| Export retried while its backend takes about 2.8s | Backend performance, no mutations |
| Same as the first, but memory says the developer undid the segmented-control swap | Does not re-propose that swap |

## What is measured, and the pass thresholds

| Metric | Meaning | Threshold |
| --- | --- | --- |
| First-pass valid rate | Reply parses, matches the Zod contract and passes the runtime validator with no repair | ≥ 80% |
| Valid within one repair | Same, allowing one repair turn in the same thread and no escalation | ≥ 95% |
| Scenario accuracy | Share of scenario trials with the known-correct decision | ≥ 80% |
| p95 latency | Wall time per task, including repairs | < 60s |
| Memory round trip | Time from `remember` until `recall` returns the decision | < 10s |

"Valid" means the same checks the app applies: known capabilities, compatible primitives, full capability coverage, and mutations the engine accepts.

## Results (2026-09-19, 4 trials per task, 16 calls per model)

| Tier | Model | First-pass valid | Valid within one repair | Scenario accuracy | p50 / p95 latency | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- |
| fast | openai/gpt-5.6-luna | 100% | 100% | 100% | 4.9s / 11.6s | 3,302 |
| balanced | openai/gpt-5.6-sol | 100% | 100% | 100% | 7.2s / 12.5s | 3,313 |
| deep | anthropic/claude-sonnet-5 | 87.5% | 100% | 100% | 12.5s / 19.4s | 6,298 |

Memory round trip: 1.2s. The raw numbers are in `reports/backboard-latest.json`.

With 16 calls per model these rates are coarse: one failure moves a rate by about 6 points. Raise `EVAL_TRIALS` before drawing finer conclusions.

## Findings that changed the code

- **`json_output` is JSON mode, not schema enforcement.** Structure is enforced by flow.js: JSON Schema in the system prompt, Zod parse, the runtime validator, one repair turn in the same thread, then escalation to the next tier.
- **claude-opus-5 was dropped as the deep tier.** It omitted the required `mutations` key in about half of optimization replies (3/8 valid with `json_output`, 4/8 without; claude-sonnet-5 was 8/8 in both). Naming the required keys in the prompt did not help, so that change was reverted.
- **Memory search was replaced by listing.** BackBoard's semantic search returned nothing for the runtime's recall query and ranked an unrelated query above a relevant one. Decisions are now listed, filtered by app and sorted newest first.
- **`openrouter/auto` does not report the model it picked** in non-streaming responses (`resolved_model` is null), so rule-based routing is the default and `BACKBOARD_ROUTING=openrouter-auto` is opt-in.

## What is not covered

- OpenAI-direct parity could not be measured: the OpenAI account has no credits. The fast and balanced tiers are OpenAI models served through BackBoard.
- The scenarios use seeded telemetry on the recorded v1 layout, not live user sessions.
