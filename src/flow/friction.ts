import type { ComponentMetrics, LatencyMetrics, Metrics } from "./metrics";
import type { FlowApp } from "./registry";
import { layoutRows, type UISchema } from "./schema";

/*
 * Understandable friction heuristics. They do not change the interface; they
 * produce evidence that OpenAI interprets and that the evidence panel shows.
 */

export const HEURISTICS = {
  /** "Buried" also needs the control to be hard to see: below the fold or in the lower half. */
  buried: { minUsageRate: 0.5, minDiscoveryMs: 4_000, belowFoldMs: 1_000 },
  separated: { minTransitions: 3, minShare: 0.3, minRowDistance: 2 },
  poorPrimitive: { minInteractions: 3, minChangesPerSession: 2, minRepeatRate: 0.25 },
  oversized: { minTotalInteractions: 15, maxShare: 0.05 },
  retry: { minInteractions: 3, minRepeatRate: 0.3 },
} as const;

export type FrictionKind =
  | "buried-control"
  | "separated-related"
  | "poor-primitive"
  | "oversized-low-value"
  | "high-retry-action";

export interface Finding {
  kind: FrictionKind;
  componentIds: string[];
  /** Whether the friction is in the interface or in backend performance. */
  classification: "ui" | "performance";
  severity: number;
  title: string;
  evidence: string[];
  suggestion: string;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const round = (value: number) => Math.round(value * 100) / 100;

export function describeLatency(latency: LatencyMetrics | undefined): string {
  if (!latency) return "no backend calls recorded";
  return `backend p50 ${Math.round(latency.p50Ms)}ms, p95 ${Math.round(latency.p95Ms)}ms over ${latency.calls} calls (${latency.slow ? "slow" : "normal"})`;
}

export function findFriction(input: { app: FlowApp; schema: UISchema; metrics: Metrics }): Finding[] {
  const { app, schema, metrics } = input;
  const rows = layoutRows(schema);
  const lastRow = Math.max(0, ...rows.values());
  const byId = new Map(metrics.components.map((c) => [c.componentId, c]));
  const latencyOf = (capabilityId: string) => metrics.latency.find((l) => l.capabilityId === capabilityId);
  const label = (m: ComponentMetrics) => `${app.capability(m.capabilityId)?.label ?? m.capabilityId} (${m.componentId})`;
  const findings: Finding[] = [];

  for (const m of metrics.components) {
    const capability = app.capability(m.capabilityId);
    if (!capability || !m.visible) continue;
    const size = schema.components.find((c) => c.id === m.componentId)?.size;
    const row = rows.get(m.componentId) ?? 0;
    const latency = latencyOf(m.capabilityId);

    // 22.1 Buried important control: high usage + high discovery time.
    const hardToSee =
      row > 0 && ((m.avgFirstViewMs ?? 0) >= HEURISTICS.buried.belowFoldMs || row >= lastRow / 2);
    if (
      capability.kind !== "data" &&
      hardToSee &&
      m.usageRate >= HEURISTICS.buried.minUsageRate &&
      m.avgDiscoveryMs !== null &&
      m.avgDiscoveryMs >= HEURISTICS.buried.minDiscoveryMs
    ) {
      findings.push({
        kind: "buried-control",
        componentIds: [m.componentId],
        classification: "ui",
        severity: round(m.usageRate * Math.min(1, m.avgDiscoveryMs / 10_000)),
        title: `${label(m)} is heavily used but slow to find`,
        evidence: [
          `used in ${pct(m.usageRate)} of sessions (${m.sessionsUsed}/${metrics.sessions.total})`,
          `avg discovery time ${secs(m.avgDiscoveryMs)}`,
          `rendered in row ${row + 1} of ${lastRow + 1}` +
            (m.avgFirstViewMs !== null ? `, scrolled into view after ${secs(m.avgFirstViewMs)}` : ""),
          describeLatency(latency),
        ],
        suggestion: "Move it closer to the top or beside the content it controls.",
      });
    }

    // 22.3 Poor interaction primitive: repeated selection through a dropdown.
    if (
      m.primitive === "dropdown" &&
      capability.kind === "state" &&
      capability.options.length <= 6 &&
      m.interactions >= HEURISTICS.poorPrimitive.minInteractions &&
      ((m.valueChangesPerUsingSession ?? 0) >= HEURISTICS.poorPrimitive.minChangesPerSession ||
        m.repeatRate >= HEURISTICS.poorPrimitive.minRepeatRate)
    ) {
      findings.push({
        kind: "poor-primitive",
        componentIds: [m.componentId],
        classification: "ui",
        severity: round(Math.min(1, m.repeatRate + (m.valueChangesPerUsingSession ?? 0) / 10)),
        title: `${label(m)} is switched repeatedly through a dropdown`,
        evidence: [
          `${m.valueChangesPerUsingSession} value changes per session`,
          `repeated within 30s: ${pct(m.repeatRate)}`,
          `${capability.options.length} options fit inline`,
        ],
        suggestion: "Swap the dropdown for a segmented control so every option is one click away.",
      });
    }

    // 22.4 Oversized low-value component.
    if (
      (size === "large" || size === "full") &&
      !capability.required &&
      metrics.totalInteractions >= HEURISTICS.oversized.minTotalInteractions &&
      m.interactionShare < HEURISTICS.oversized.maxShare
    ) {
      findings.push({
        kind: "oversized-low-value",
        componentIds: [m.componentId],
        classification: "ui",
        severity: round(0.5 * (1 - m.interactionShare / HEURISTICS.oversized.maxShare)),
        title: `${label(m)} takes a large footprint but gets little use`,
        evidence: [
          `${pct(m.interactionShare)} of ${metrics.totalInteractions} interactions`,
          `viewed ${m.views} times`,
        ],
        suggestion: "Resize it smaller or move it lower to free space for high-use components.",
      });
    }

    // 22.5 High-retry action: split UI confusion from backend latency.
    if (
      capability.kind === "action" &&
      m.interactions >= HEURISTICS.retry.minInteractions &&
      m.repeatRate >= HEURISTICS.retry.minRepeatRate
    ) {
      const slow = latency?.slow ?? false;
      findings.push({
        kind: "high-retry-action",
        componentIds: [m.componentId],
        classification: slow ? "performance" : "ui",
        severity: round(Math.min(1, m.repeatRate + (slow ? 0.2 : 0))),
        title: slow
          ? `${label(m)} is retried because the backend is slow`
          : `${label(m)} is retried although the backend is fast`,
        evidence: [
          `${m.interactions} clicks, repeated within 30s: ${pct(m.repeatRate)}`,
          describeLatency(latency),
          ...(latency?.traceIds.length ? [`Sentry traces: ${latency.traceIds.join(", ")}`] : []),
        ],
        suggestion: slow
          ? "Do not redesign this control first; surface the backend-performance issue."
          : "The action may be confusing; clarify its feedback or placement.",
      });
    }
  }

  // 22.2 Related controls separated: common A → B sequence, far apart in the layout.
  for (const transition of metrics.transitions) {
    const from = byId.get(transition.from);
    const to = byId.get(transition.to);
    if (!from || !to || !from.visible || !to.visible) continue;
    const share = from.followedBy.find((f) => f.componentId === to.componentId)?.share ?? 0;
    const distance = Math.abs((rows.get(from.componentId) ?? 0) - (rows.get(to.componentId) ?? 0));
    if (
      transition.count < HEURISTICS.separated.minTransitions ||
      share < HEURISTICS.separated.minShare ||
      distance < HEURISTICS.separated.minRowDistance
    ) {
      continue;
    }
    const related = app.graph.related(from.capabilityId, to.capabilityId);
    findings.push({
      kind: "separated-related",
      componentIds: [from.componentId, to.componentId],
      classification: "ui",
      severity: round(share * Math.min(1, distance / 3) * (related ? 1 : 0.7)),
      title: `${label(from)} is usually followed by ${label(to)}, ${distance} rows away`,
      evidence: [
        `${from.componentId} → ${to.componentId} ${transition.count} times (${pct(share)} of its follow-ups)`,
        `${distance} rows apart in the current layout`,
        related
          ? `related in the capability graph (${from.capabilityId} ↔ ${to.capabilityId})`
          : "not related in the capability graph",
      ],
      suggestion: `Place ${from.componentId} beside ${to.componentId}.`,
    });
  }

  return findings.sort((a, b) => b.severity - a.severity);
}
