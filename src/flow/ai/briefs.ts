import type { Finding } from "../friction";
import type { Metrics } from "../metrics";
import { compatiblePrimitives, SIZE_SPAN } from "../primitives";
import type { FlowApp } from "../registry";
import { layoutRows, type UISchema } from "../schema";

/*
 * What OpenAI sees: capability descriptions and contracts, never executable
 * code. Kept compact and deterministic so recorded responses stay meaningful.
 */

export interface GenerationBrief {
  application: { id: string; name: string; context: string };
  capabilities: Array<Record<string, unknown>>;
  dependencies: Array<{ from: string; to: string }>;
  theme: FlowApp["theme"];
  grid: { columns: 12; sizes: typeof SIZE_SPAN };
}

export interface OptimizationBrief extends GenerationBrief {
  currentSchema: Array<UISchema["components"][number] & { row: number | null }>;
  sampleSize: { sessions: number; liveSessions: number; seededSessions: number; interactions: number };
  componentMetrics: Array<Record<string, unknown>>;
  topSequences: Metrics["transitions"];
  backendLatency: Array<Record<string, unknown>>;
  heuristicFindings: Finding[];
  /** Earlier interface decisions recalled from memory (applied, undone, restored). */
  pastDecisions: string[];
}

export function generationBrief(app: FlowApp): GenerationBrief {
  return {
    application: { id: app.id, name: app.name, context: app.context },
    capabilities: app.capabilities.map((capability) => ({
      ...capability,
      compatiblePrimitives: compatiblePrimitives(capability),
    })),
    dependencies: app.graph.edges,
    theme: app.theme,
    grid: { columns: 12, sizes: SIZE_SPAN },
  };
}

export function optimizationBrief(input: {
  app: FlowApp;
  schema: UISchema;
  metrics: Metrics;
  findings: Finding[];
  pastDecisions?: string[];
}): OptimizationBrief {
  const rows = layoutRows(input.schema);
  return {
    ...generationBrief(input.app),
    currentSchema: input.schema.components.map((c) => ({ ...c, row: rows.get(c.id) ?? null })),
    sampleSize: {
      sessions: input.metrics.sessions.total,
      liveSessions: input.metrics.sessions.live,
      seededSessions: input.metrics.sessions.seeded,
      interactions: input.metrics.totalInteractions,
    },
    componentMetrics: input.metrics.components.map((m) => ({
      componentId: m.componentId,
      capabilityId: m.capabilityId,
      usageRate: m.usageRate,
      interactions: m.interactions,
      avgDiscoveryMs: m.avgDiscoveryMs,
      avgFirstViewMs: m.avgFirstViewMs,
      repeatRate: m.repeatRate,
      retryLatencyMs: m.retryLatencyMs,
      valueChangesPerUsingSession: m.valueChangesPerUsingSession,
      errorRate: m.errorRate,
      followedBy: m.followedBy.slice(0, 3),
    })),
    topSequences: input.metrics.transitions.slice(0, 8),
    backendLatency: input.metrics.latency.map((l) => ({
      capabilityId: l.capabilityId,
      kind: l.kind,
      calls: l.calls,
      p50Ms: l.p50Ms,
      p95Ms: l.p95Ms,
      errorRate: l.errorRate,
      slow: l.slow,
    })),
    heuristicFindings: input.findings,
    pastDecisions: input.pastDecisions ?? [],
  };
}

export const GENERATION_INSTRUCTIONS = `You are flow.js, an adaptive interface runtime. A developer registered application capabilities (data, actions, state) instead of designing a dashboard. Produce the first dashboard as a UI schema.

Rules:
- Create at least one component for every capability. Bind each component to exactly one registered capability id.
- Only use a primitive listed in that capability's compatiblePrimitives.
- Component ids are short, stable, kebab-case and unique (for example "revenue-chart", "date-range").
- Sizes span a 12-column grid: small=3, medium=6, large=9, full=12. Order is reading order starting at 0.
- Every required capability must have a visible component.
- The dashboard must be functional, reasonable, coherent and safe. It does not need to be optimal: it will improve from real usage.
- You may render a timeseries twice (for example a metric-card summary and a line-chart) when useful.`;

export const OPTIMIZATION_INSTRUCTIONS = `You are flow.js, an adaptive interface runtime. You receive the current UI schema, aggregated usage telemetry, interaction sequences, backend latency measured alongside Sentry traces, and deterministic heuristic findings.

Identify the single most important friction and propose a small, safe change.

Rules:
- Separate interface friction from system-performance friction. If users retry an action because its backend is slow, classify it as "performance" and return no mutations: redesigning the control would not help.
- Only use these mutations: MOVE (element beside target, before/after), REORDER (index), RESIZE (size), SWAP_VARIANT (variant must be in that capability's compatiblePrimitives), SHOW, HIDE.
- Reference only component ids that exist in currentSchema. Never hide the only visible component of a required capability.
- Prefer 1-3 mutations. Every mutation must change something.
- Base evidence on the numbers provided and mention the sample size honestly. Keep confidence modest when the sample is small.
- pastDecisions lists earlier interface changes and whether the developer undid them. Do not re-propose a change the developer undid unless the evidence is materially stronger now, and say so in the explanation.
- Set fields that do not apply to a mutation type to null.`;
