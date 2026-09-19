import { generationBrief, optimizationBrief } from "./ai/briefs";
import { GeneratedSchemaOutput, OptimizationOutput, toMutation, toUISchema } from "./ai/contracts";
import { ProviderOutput, type CallMeta, type FlowAIProvider, type OutputCheck } from "./ai/providers";
import { findFriction, type Finding } from "./friction";
import { computeMetrics, type Metrics } from "./metrics";
import { decisionMemory, RECALL_LIMIT, type FlowMemory, type RecalledMemory } from "./memory";
import { applyMutations, type Mutation } from "./mutations";
import { seedSessions } from "./seed";
import type { FlowApp } from "./registry";
import { validateSchema, type UISchema } from "./schema";
import { decideAutoApply, scoreProposal, type MutationScore } from "./scoring";
import {
  FlowStore,
  TELEMETRY_EVENT_TYPES,
  VersionError,
  type AISource,
  type OptimizationRun,
  type TelemetryEvent,
  type VersionRecord,
} from "./store";
import { z } from "zod";

/*
 * The adaptive loop: generate → observe → analyze → propose → validate →
 * score → apply → version. OpenAI proposes; this runtime validates and executes.
 */

export const INSTABILITY_WINDOW_MS = 15 * 60_000;

export interface AIProvenance {
  source: AISource;
  model: string;
  /** Why the live call was not used, when it was not. */
  fallbackReason: string | null;
  /** Routing, repair and usage details when the provider reports them. */
  call: CallMeta | null;
}

export interface OptimizationAnalysis {
  ai: AIProvenance & Omit<OptimizationOutput, "mutations">;
  findings: Finding[];
  sampleSize: { sessions: number; liveSessions: number; seededSessions: number; interactions: number };
  latency: Metrics["latency"];
  /** Earlier decisions recalled from memory and given to the model. */
  memories: RecalledMemory[];
  score: MutationScore | null;
  decision: { autoApply: boolean; threshold: number | null };
}

export const IncomingEvent = z.object({
  versionId: z.string().max(16),
  sessionId: z.string().min(1).max(64),
  userId: z.string().max(64).nullable().default(null),
  componentId: z.string().max(64),
  eventType: z.enum(TELEMETRY_EVENT_TYPES),
  sinceLoadMs: z.number().min(0).max(86_400_000),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type IncomingEvent = z.input<typeof IncomingEvent>;

/** Client clocks are trusted only within this skew. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

export class RuntimeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RuntimeError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Check<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function createRuntime(deps: {
  app: FlowApp;
  store: FlowStore;
  /** Null when no API key is configured. */
  live: FlowAIProvider | null;
  recorded: FlowAIProvider;
  /** Skip live calls and replay recordings (the presentation fallback switch). */
  forceRecorded?: boolean;
  /** Optional decision memory, recalled into optimizations. Failures never block the loop. */
  memory?: FlowMemory;
  now?: () => number;
}) {
  const { app, store, live, recorded, memory } = deps;
  const now = deps.now ?? Date.now;
  store.syncApplication(app);

  /** Try the live provider, falling back to recordings on failure or malformed output. */
  async function withFallback<T>(
    call: (provider: FlowAIProvider, repairCheck: OutputCheck) => Promise<unknown | ProviderOutput>,
    check: (output: unknown) => Check<T>,
    /** Stricter check a provider may use to repair its output; defaults to `check`. */
    repairCheck: OutputCheck = (output) => {
      const result = check(output);
      return result.ok ? [] : result.errors;
    },
  ): Promise<{ value: T; provenance: AIProvenance }> {
    const unwrap = (raw: unknown | ProviderOutput) =>
      raw instanceof ProviderOutput ? { output: raw.output, meta: raw.meta } : { output: raw, meta: null };
    let fallbackReason: string | null = null;
    if (deps.forceRecorded) fallbackReason = "Recorded mode is enabled (FLOW_AI_MODE=recorded).";
    else if (!live) fallbackReason = "No AI key is configured (BACKBOARD_API_KEY or OPENAI_API_KEY).";
    else {
      try {
        const { output, meta } = unwrap(await call(live, repairCheck));
        const result = check(output);
        if (result.ok) {
          return {
            value: result.value,
            provenance: { source: "live", model: meta?.model ?? live.model, fallbackReason: null, call: meta },
          };
        }
        fallbackReason = `Live output failed validation: ${result.errors.slice(0, 3).join(" ")}`;
      } catch (error) {
        fallbackReason = `Live call failed: ${errorMessage(error)}`;
      }
    }
    const result = check(unwrap(await call(recorded, repairCheck)).output);
    if (!result.ok) {
      throw new RuntimeError(`Recorded response is invalid: ${result.errors.join(" ")}`, 500);
    }
    return { value: result.value, provenance: { source: "recorded", model: recorded.model, fallbackReason, call: null } };
  }

  // Memory is best-effort: a slow or failing memory service must never block the loop.
  const pendingMemory = new Set<Promise<void>>();
  function remember(content: string, metadata: Record<string, unknown>) {
    if (!memory) return;
    const write = memory.remember(content, metadata).catch(() => undefined);
    pendingMemory.add(write);
    void write.finally(() => pendingMemory.delete(write));
  }
  async function recall(): Promise<RecalledMemory[]> {
    if (!memory) return [];
    try {
      return await memory.recall(RECALL_LIMIT);
    } catch {
      return [];
    }
  }

  function activeVersion(): VersionRecord {
    const version = store.getActiveVersion(app.id);
    if (!version) throw new RuntimeError("No dashboard has been generated yet.", 409);
    return version;
  }

  function analyze(version: VersionRecord = activeVersion()) {
    const metrics = computeMetrics({
      versionId: version.id,
      schema: version.schema,
      events: store.listEvents(app.id, version.id),
      calls: store.listCalls(app.id),
    });
    const findings = findFriction({ app, schema: version.schema, metrics });
    return { version, metrics, findings };
  }

  return {
    app,
    store,

    state() {
      const application = store.getApplication(app.id)!;
      return {
        application,
        active: store.getActiveVersion(app.id),
        versions: store.listVersions(app.id),
      };
    },

    /** Generate v1 from capabilities. Idempotent once a dashboard exists. */
    async generate(): Promise<{ version: VersionRecord; provenance: AIProvenance | null }> {
      const existing = store.getActiveVersion(app.id);
      if (existing) return { version: existing, provenance: null };

      const { value, provenance } = await withFallback<{ schema: UISchema; reasoning: string }>(
        (provider, repairCheck) => provider.generateSchema(generationBrief(app), repairCheck),
        (output) => {
          const parsed = GeneratedSchemaOutput.safeParse(output);
          if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
          const validated = validateSchema(toUISchema(parsed.data), app);
          return validated.ok
            ? { ok: true, value: { schema: validated.schema, reasoning: parsed.data.reasoning } }
            : validated;
        },
      );

      const version = store.createVersion({
        applicationId: app.id,
        parentVersionId: null,
        schema: value.schema,
        mutations: [],
        reason: "Generated dashboard",
        evidence: { reasoning: value.reasoning, ai: provenance },
        source: "generated",
        aiSource: provenance.source,
        cause: "generate",
      });
      return { version, provenance };
    },

    analyze,

    /** Ask OpenAI for a finding and proposal, validate and score it. Never changes the UI. */
    async optimize(): Promise<OptimizationRun> {
      const { version, metrics, findings } = analyze();
      if (metrics.totalInteractions === 0) {
        throw new RuntimeError("No interactions recorded for this version yet. Use the dashboard first.", 409);
      }
      const memories = await recall();
      const brief = optimizationBrief({
        app,
        schema: version.schema,
        metrics,
        findings,
        pastDecisions: memories.map((m) => m.content),
      });
      const parseOutput = (raw: unknown): Check<OptimizationOutput> => {
        const parsed = OptimizationOutput.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      };
      const { value: output, provenance } = await withFallback<OptimizationOutput>(
        (provider, repairCheck) => provider.proposeOptimization(brief, repairCheck),
        parseOutput,
        // A provider that can repair gets the mutation validator's verdict too.
        (raw) => {
          const parsed = parseOutput(raw);
          if (!parsed.ok) return parsed.errors;
          if (parsed.value.mutations.length === 0) return [];
          const applied = applyMutations(version.schema, parsed.value.mutations.map(toMutation), app);
          return applied.ok ? [] : applied.errors;
        },
      );

      const { mutations: proposed, ...aiAnalysis } = output;
      const candidate = proposed.map(toMutation);
      const sampleSize = {
        sessions: metrics.sessions.total,
        liveSessions: metrics.sessions.live,
        seededSessions: metrics.sessions.seeded,
        interactions: metrics.totalInteractions,
      };
      const rate = store.getApplication(app.id)!.mutationRate;
      const base = {
        applicationId: app.id,
        sourceVersionId: version.id,
        mutationRate: rate,
        aiSource: provenance.source,
      };
      const analysis = (score: MutationScore | null, decision: OptimizationAnalysis["decision"]): OptimizationAnalysis => ({
        ai: { ...provenance, ...aiAnalysis },
        findings,
        sampleSize,
        latency: metrics.latency,
        memories,
        score,
        decision,
      });

      if (candidate.length === 0) {
        return store.createRun({
          ...base,
          status: "no-change",
          analysis: analysis(null, { autoApply: false, threshold: null }),
          proposedMutations: [],
          score: null,
          threshold: null,
          errors: [],
        });
      }

      const result = applyMutations(version.schema, candidate, app);
      if (!result.ok) {
        return store.createRun({
          ...base,
          status: "rejected",
          analysis: analysis(null, { autoApply: false, threshold: null }),
          proposedMutations: candidate as Mutation[],
          score: null,
          threshold: null,
          errors: result.errors,
        });
      }

      const score = scoreProposal({
        expectedBenefit: output.expectedBenefit,
        confidence: output.confidence,
        sessions: metrics.sessions.total,
        interactions: metrics.totalInteractions,
        mutations: candidate as Mutation[],
        recentVersions: store.countRecentActivations(app.id, now() - INSTABILITY_WINDOW_MS),
      });
      const decision = decideAutoApply(score.score, rate);
      return store.createRun({
        ...base,
        status: decision.autoApply ? "auto" : "pending",
        analysis: analysis(score, decision),
        proposedMutations: candidate as Mutation[],
        score,
        threshold: decision.threshold,
        errors: [],
      });
    },

    /**
     * Apply a validated proposal as a new immutable version. `auto` requires the
     * score to clear the current mutation-rate threshold; `manual` is an explicit
     * approval of the proposal shown in the evidence panel.
     */
    apply(runId: string, mode: "auto" | "manual"): { version: VersionRecord; run: OptimizationRun } {
      const run = store.getRun(runId);
      if (!run || run.applicationId !== app.id) throw new RuntimeError("Unknown optimization run.", 404);
      if (run.status !== "pending" && run.status !== "auto") {
        throw new RuntimeError(`This proposal cannot be applied (status: ${run.status}).`, 409);
      }
      const current = activeVersion();
      if (current.id !== run.sourceVersionId) {
        store.setRunStatus(run.id, "stale");
        throw new RuntimeError(
          `The dashboard changed since this proposal (${run.sourceVersionId} → ${current.id}). Optimize again.`,
          409,
        );
      }

      const result = store.transaction(() => {
        const active = activeVersion();
        if (active.id !== run.sourceVersionId) throw new RuntimeError("The dashboard changed. Optimize again.", 409);
        if (mode === "auto") {
          const rate = store.getApplication(app.id)!.mutationRate;
          const score = (run.score as MutationScore | null)?.score ?? 0;
          if (!decideAutoApply(score, rate).autoApply) {
            throw new RuntimeError("The proposal does not clear the current mutation-rate threshold.", 409);
          }
        }
        const result = applyMutations(active.schema, run.proposedMutations, app);
        if (!result.ok) throw new RuntimeError(`Proposal is no longer valid: ${result.errors.join(" ")}`, 409);

        const analysis = run.analysis as OptimizationAnalysis;
        const metrics = analyze(active).metrics;
        const version = store.createVersion({
          applicationId: app.id,
          parentVersionId: active.id,
          schema: result.schema,
          mutations: run.proposedMutations,
          reason: analysis.ai.reason,
          evidence: { ...analysis, appliedBy: mode },
          telemetrySnapshot: metrics,
          source: "optimization",
          aiSource: run.aiSource,
          optimizationRunId: run.id,
          cause: "optimize",
        });
        store.setRunStatus(run.id, "applied", version.id);
        return { version, run: store.getRun(run.id)! };
      });
      // Only remember what was actually committed.
      const sessions = (run.analysis as OptimizationAnalysis).sampleSize.sessions;
      remember(decisionMemory.applied(app.id, result.version, mode, sessions), {
        kind: "applied",
        version: result.version.id,
      });
      return result;
    },

    undo(): VersionRecord {
      try {
        const undone = store.getActiveVersion(app.id);
        const active = store.undo(app.id);
        if (undone) remember(decisionMemory.undone(app.id, undone, active), { kind: "undone", version: undone.id });
        return active;
      } catch (error) {
        if (error instanceof VersionError) throw new RuntimeError(error.message, 409);
        throw error;
      }
    },

    restore(versionId: string): VersionRecord {
      try {
        const version = store.activateVersion(app.id, versionId, "restore");
        remember(decisionMemory.restored(app.id, version), { kind: "restored", version: version.id });
        return version;
      } catch (error) {
        if (error instanceof VersionError) throw new RuntimeError(error.message, 404);
        throw error;
      }
    },

    /**
     * Ingest client telemetry. Events must reference a real version and a
     * component in that version; the capability is taken from the schema.
     */
    recordTelemetry(raw: unknown[]): { accepted: number; rejected: number } {
      const schemas = new Map<string, Map<string, string>>();
      const accepted: TelemetryEvent[] = [];
      for (const item of raw) {
        const parsed = IncomingEvent.safeParse(item);
        if (!parsed.success) continue;
        const event = parsed.data;
        if (!schemas.has(event.versionId)) {
          const version = store.getVersion(app.id, event.versionId);
          schemas.set(event.versionId, new Map(version?.schema.components.map((c) => [c.id, c.capability]) ?? []));
        }
        const capabilityId = schemas.get(event.versionId)!.get(event.componentId);
        if (!capabilityId) continue;
        const received = now();
        accepted.push({
          applicationId: app.id,
          versionId: event.versionId,
          sessionId: event.sessionId,
          userId: event.userId,
          componentId: event.componentId,
          capabilityId,
          eventType: event.eventType,
          sinceLoadMs: event.sinceLoadMs,
          metadata: event.metadata,
          seeded: false,
          createdAt: Math.abs(event.timestamp - received) <= MAX_CLOCK_SKEW_MS ? event.timestamp : received,
        });
      }
      store.insertEvents(accepted);
      return { accepted: accepted.length, rejected: raw.length - accepted.length };
    },

    /** Add clearly flagged synthetic sessions for the active version. */
    seedDemoSessions(count: number) {
      const version = activeVersion();
      const { events, calls } = seedSessions({ app, schema: version.schema, versionId: version.id, count, now: now() });
      store.transaction(() => {
        store.insertEvents(events);
        for (const call of calls) store.insertCall(call);
      });
      return { sessions: count, events: events.length, calls: calls.length };
    },

    clearSeeded() {
      store.clearSeeded(app.id);
    },

    /** Wait for queued memory writes (used by tests and graceful shutdown). */
    async flushMemory() {
      await Promise.all(pendingMemory);
    },

    setMutationRate(rate: number) {
      if (!(typeof rate === "number" && rate >= 0 && rate <= 1)) {
        throw new RuntimeError("mutationRate must be between 0 and 1.");
      }
      store.setMutationRate(app.id, rate);
      return store.getApplication(app.id)!;
    },
  };
}

export type FlowRuntime = ReturnType<typeof createRuntime>;
