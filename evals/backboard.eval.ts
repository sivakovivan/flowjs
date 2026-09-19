import { existsSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { salesRecording } from "@/demo/recordings";
import { salesApp } from "@/demo/sales-app";
import { assistantName, createBackboardClient, createBackboardMemory, createBackboardProvider } from "@/flow/ai/backboard";
import { generationBrief, optimizationBrief } from "@/flow/ai/briefs";
import { GeneratedSchemaOutput, OptimizationOutput, toMutation, toUISchema } from "@/flow/ai/contracts";
import { ProviderOutput, type CallMeta } from "@/flow/ai/providers";
import { TIERS, tierModelsFromEnv, type ModelRef } from "@/flow/ai/routing";
import { findFriction } from "@/flow/friction";
import { computeMetrics } from "@/flow/metrics";
import { applyMutations } from "@/flow/mutations";
import { validateSchema } from "@/flow/schema";
import { seedSessions } from "@/flow/seed";
import type { CapabilityCall, TelemetryEvent } from "@/flow/store";

/*
 * Live evaluation of the BackBoard integration. For each model tier it runs
 * repeated trials and measures:
 *   - structured-output reliability (valid on the first reply / within one repair),
 *   - decision accuracy on scenarios with a known right answer,
 *   - latency and token use,
 * then asserts thresholds and writes evals/reports/backboard-latest.json.
 */

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const apiKey = process.env.BACKBOARD_API_KEY;
const TRIALS = Number(process.env.EVAL_TRIALS ?? 5);
const CONCURRENCY = 3;

export const THRESHOLDS = {
  firstPassValidRate: 0.8,
  validWithinOneRepairRate: 0.95,
  scenarioAccuracy: 0.8,
  p95LatencyMs: 60_000,
  memoryRoundTripMs: 10_000,
};

const schema = toUISchema(salesRecording.generation);
const NOW = 1_800_000_000_000;

function briefFor(events: TelemetryEvent[], calls: CapabilityCall[], pastDecisions: string[] = []) {
  const metrics = computeMetrics({ versionId: "v1", schema, events, calls });
  const findings = findFriction({ app: salesApp, schema, metrics });
  return optimizationBrief({ app: salesApp, schema, metrics, findings, pastDecisions });
}

const seeded = seedSessions({ app: salesApp, schema, versionId: "v1", count: 6, now: NOW, seed: 7 });

function exportRetrySessions(): { events: TelemetryEvent[]; calls: CapabilityCall[] } {
  const events: TelemetryEvent[] = [];
  const calls: CapabilityCall[] = [];
  for (let s = 0; s < 4; s++) {
    const sessionId = `retry-${s}`;
    const start = NOW + s * 600_000;
    const event = (eventType: TelemetryEvent["eventType"], at: number): TelemetryEvent => ({
      applicationId: salesApp.id, versionId: "v1", sessionId, userId: null, componentId: "export",
      capabilityId: "exportReport", eventType, sinceLoadMs: at, metadata: {}, seeded: false, createdAt: start + at,
    });
    events.push(event("component_view", 0), event("component_click", 1_500), event("component_click", 3_000), event("component_click", 5_000), event("interaction_complete", 6_000));
    for (let c = 0; c < 3; c++) {
      calls.push({
        applicationId: salesApp.id, versionId: "v1", sessionId, componentId: "export", capabilityId: "exportReport",
        kind: "action", latencyMs: 2_700 + c * 150, ok: true, error: null, traceId: null, replayId: null, seeded: false,
        createdAt: start + 1_500 + c * 1_500,
      });
    }
  }
  return { events, calls };
}

const UNDONE = `[${salesApp.id}] The developer undid v2 "Date range exposed as segmented control" (SWAP_VARIANT date-range to segmented-control) and returned to v1. Do not re-propose these mutations unless the evidence is materially stronger.`;

interface Scenario {
  name: string;
  brief: ReturnType<typeof briefFor>;
  /** Whether the decision is the known-correct one. */
  correct: (output: OptimizationOutput) => boolean;
}

const retry = exportRetrySessions();
const scenarios: Scenario[] = [
  {
    name: "buried date filter → interface change on date-range",
    brief: briefFor(seeded.events, seeded.calls),
    correct: (o) => o.classification === "ui" && o.mutations.some((m) => m.element === "date-range"),
  },
  {
    name: "retries on a slow export → performance, no redesign",
    brief: briefFor(retry.events, retry.calls),
    correct: (o) => o.classification === "performance" && o.mutations.length === 0,
  },
  {
    name: "remembered undo → does not re-propose the undone mutation",
    brief: briefFor(seeded.events, seeded.calls, [UNDONE]),
    correct: (o) =>
      !o.mutations.some((m) => m.type === "SWAP_VARIANT" && m.element === "date-range" && m.variant === "segmented-control"),
  },
];

interface Trial {
  task: string;
  meta: CallMeta | null;
  validFirstPass: boolean;
  validWithinOneRepair: boolean;
  correct: boolean | null;
  error: string | null;
}

async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const index = next++;
        results[index] = await jobs[index]();
      }
    }),
  );
  return results;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0;
};
const rate = (trials: Trial[], pick: (t: Trial) => boolean | null) => {
  const scored = trials.filter((t) => pick(t) !== null);
  return scored.length ? scored.filter((t) => pick(t)).length / scored.length : 0;
};

const report: Record<string, unknown> = { trialsPerTask: TRIALS, thresholds: THRESHOLDS, models: {} };
const evalAppId = `eval-${Date.now().toString(36)}`;

describe.skipIf(!apiKey)("BackBoard live evaluation", () => {
  const client = createBackboardClient({ apiKey: apiKey! });
  const models = tierModelsFromEnv(process.env);

  afterAll(async () => {
    for (const appId of [evalAppId, `${evalAppId}-other`]) {
      const id = await client.assistantId(assistantName(appId), "eval").catch(() => null);
      if (id) await client.deleteAssistant(id).catch(() => undefined);
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync("evals/reports/backboard-latest.json", `${JSON.stringify(report, null, 2)}\n`);
  });

  const onlyTiers = process.env.EVAL_TIERS?.split(",");
  for (const tier of TIERS.filter((t) => !onlyTiers || onlyTiers.includes(t))) {
    const model: ModelRef = models[tier];
    const label = `${model.provider}/${model.model}`;

    describe(`${tier}: ${label}`, () => {
      let trials: Trial[] = [];

      beforeAll(async () => {
        // Every tier is the same model, so the numbers describe this model alone.
        const provider = createBackboardProvider({ client, appId: evalAppId, models: { fast: model, balanced: model, deep: model } });

        const run = (task: string, call: () => Promise<unknown>, correct: ((o: unknown) => boolean) | null) => async (): Promise<Trial> => {
          try {
            const result = await call();
            const meta = result instanceof ProviderOutput ? result.meta : null;
            const output = result instanceof ProviderOutput ? result.output : result;
            const settled = meta !== null && !meta.escalated;
            return {
              task,
              meta,
              validFirstPass: settled && meta.attempts === 1,
              validWithinOneRepair: settled && meta.attempts <= 2,
              correct: correct ? correct(output) : null,
              error: null,
            };
          } catch (error) {
            return { task, meta: null, validFirstPass: false, validWithinOneRepair: false, correct: correct ? false : null, error: String(error) };
          }
        };

        const schemaCheck = (output: unknown) => {
          const parsed = GeneratedSchemaOutput.safeParse(output);
          if (!parsed.success) return parsed.error.issues.map((i) => i.message);
          const validated = validateSchema(toUISchema(parsed.data), salesApp);
          return validated.ok ? [] : validated.errors;
        };
        const mutationCheck = (output: unknown) => {
          const parsed = OptimizationOutput.safeParse(output);
          if (!parsed.success) return parsed.error.issues.map((i) => i.message);
          if (parsed.data.mutations.length === 0) return [];
          const applied = applyMutations(schema, parsed.data.mutations.map(toMutation), salesApp);
          return applied.ok ? [] : applied.errors;
        };

        const jobs = Array.from({ length: TRIALS }, () => [
          run("generate", () => provider.generateSchema(generationBrief(salesApp), schemaCheck), null),
          ...scenarios.map((s) =>
            run(`optimize: ${s.name}`, () => provider.proposeOptimization(s.brief, mutationCheck), (o) => s.correct(o as OptimizationOutput)),
          ),
        ]).flat();
        trials = await pool(jobs, CONCURRENCY);

        const latencies = trials.flatMap((t) => (t.meta ? [t.meta.latencyMs] : []));
        const tokens = trials.flatMap((t) => (t.meta ? [t.meta.inputTokens + t.meta.outputTokens] : []));
        const summary = {
          calls: trials.length,
          firstPassValidRate: rate(trials, (t) => t.validFirstPass),
          validWithinOneRepairRate: rate(trials, (t) => t.validWithinOneRepair),
          scenarioAccuracy: rate(trials, (t) => t.correct),
          byScenario: Object.fromEntries(scenarios.map((s) => [s.name, rate(trials.filter((t) => t.task.endsWith(s.name)), (t) => t.correct)])),
          p50LatencyMs: percentile(latencies, 0.5),
          p95LatencyMs: percentile(latencies, 0.95),
          meanTokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0,
          errors: trials.flatMap((t) => (t.error ? [t.error.slice(0, 200)] : [])),
          rejections: trials.flatMap((t) => (t.meta?.rejections ?? []).map((r) => `${t.task.split(":")[0]}: ${r.slice(0, 240)}`)),
        };
        (report.models as Record<string, unknown>)[label] = { tier, ...summary };
        console.log(`\n${tier} ${label}\n`, summary);
      });

      it(`returns schema-valid output on the first reply in ≥ ${THRESHOLDS.firstPassValidRate * 100}% of calls`, () => {
        expect(rate(trials, (t) => t.validFirstPass)).toBeGreaterThanOrEqual(THRESHOLDS.firstPassValidRate);
      });
      it(`returns schema-valid output within one repair in ≥ ${THRESHOLDS.validWithinOneRepairRate * 100}% of calls`, () => {
        expect(rate(trials, (t) => t.validWithinOneRepair)).toBeGreaterThanOrEqual(THRESHOLDS.validWithinOneRepairRate);
      });
      it(`makes the known-correct decision in ≥ ${THRESHOLDS.scenarioAccuracy * 100}% of scenario trials`, () => {
        expect(rate(trials, (t) => t.correct)).toBeGreaterThanOrEqual(THRESHOLDS.scenarioAccuracy);
      });
      it(`answers within ${THRESHOLDS.p95LatencyMs / 1000}s at p95`, () => {
        expect(percentile(trials.flatMap((t) => (t.meta ? [t.meta.latencyMs] : [])), 0.95)).toBeLessThan(THRESHOLDS.p95LatencyMs);
      });
    });
  }

  it("remembers a decision and recalls it for the same app only", async () => {
    const memory = createBackboardMemory({ client, appId: evalAppId });
    const marker = `[${evalAppId}] The developer undid v9 (eval marker ${Date.now()}).`;
    const started = performance.now();
    await memory.remember(marker, { kind: "undone", version: "v9" });
    let recalled = await memory.recall(6);
    while (!recalled.some((m) => m.content === marker) && performance.now() - started < THRESHOLDS.memoryRoundTripMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      recalled = await memory.recall(6);
    }
    const roundTripMs = Math.round(performance.now() - started);
    report.memory = { roundTripMs, recalled: recalled.some((m) => m.content === marker) };
    expect(recalled.map((m) => m.content)).toContain(marker);
    expect(roundTripMs).toBeLessThan(THRESHOLDS.memoryRoundTripMs);

    const other = createBackboardMemory({ client, appId: `${evalAppId}-other` });
    // Each app has its own assistant, so another app never sees these decisions.
    expect((await other.recall(6)).map((m) => m.content)).not.toContain(marker);
  });
});
