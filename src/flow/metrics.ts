import type { UISchema } from "./schema";
import type { CapabilityCall, TelemetryEvent, TelemetryEventType } from "./store";

/*
 * Aggregate raw semantic telemetry into interpretable UX metrics, and backend
 * calls into latency context, for one UI version.
 */

/** Events that represent a deliberate interaction with a component. */
export const INTERACTION_EVENTS: TelemetryEventType[] = ["component_click", "value_change"];
/** Events that show the user found the component (discovery). */
const DISCOVERY_EVENTS: TelemetryEventType[] = [...INTERACTION_EVENTS, "interaction_start"];

export const REPEAT_WINDOW_MS = 30_000;
/** Median backend latency above this is treated as system-performance friction. */
export const SLOW_LATENCY_MS = 1_500;

export interface FollowUp {
  componentId: string;
  count: number;
  share: number;
}

export interface ComponentMetrics {
  componentId: string;
  capabilityId: string;
  primitive: string;
  visible: boolean;
  views: number;
  interactions: number;
  interactionShare: number;
  sessionsUsed: number;
  usageRate: number;
  avgDiscoveryMs: number | null;
  repeatRate: number;
  valueChangesPerUsingSession: number | null;
  completions: number;
  errors: number;
  errorRate: number | null;
  followedBy: FollowUp[];
}

export interface LatencyMetrics {
  capabilityId: string;
  kind: "data" | "action";
  calls: number;
  p50Ms: number;
  p95Ms: number;
  errorRate: number;
  slow: boolean;
  traceIds: string[];
  replayIds: string[];
}

export interface Transition {
  from: string;
  to: string;
  count: number;
}

export interface Metrics {
  versionId: string | null;
  sessions: { total: number; live: number; seeded: number };
  totalInteractions: number;
  components: ComponentMetrics[];
  transitions: Transition[];
  latency: LatencyMetrics[];
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function computeLatency(calls: CapabilityCall[]): LatencyMetrics[] {
  const byCapability = new Map<string, CapabilityCall[]>();
  for (const call of calls) {
    const list = byCapability.get(call.capabilityId) ?? [];
    list.push(call);
    byCapability.set(call.capabilityId, list);
  }
  return [...byCapability.entries()].map(([capabilityId, list]) => {
    const latencies = list.map((c) => c.latencyMs).sort((a, b) => a - b);
    const recent = [...list].sort((a, b) => b.createdAt - a.createdAt);
    const p50Ms = round(percentile(latencies, 0.5), 1);
    return {
      capabilityId,
      kind: list[0].kind,
      calls: list.length,
      p50Ms,
      p95Ms: round(percentile(latencies, 0.95), 1),
      errorRate: round(list.filter((c) => !c.ok).length / list.length),
      slow: p50Ms >= SLOW_LATENCY_MS,
      traceIds: [...new Set(recent.flatMap((c) => (c.traceId ? [c.traceId] : [])))].slice(0, 3),
      replayIds: [...new Set(recent.flatMap((c) => (c.replayId ? [c.replayId] : [])))].slice(0, 3),
    };
  });
}

export function computeMetrics(input: {
  versionId: string | null;
  schema: UISchema;
  events: TelemetryEvent[];
  calls: CapabilityCall[];
}): Metrics {
  const events = [...input.events].sort((a, b) => a.createdAt - b.createdAt);
  const sessions = new Map<string, boolean>();
  for (const event of events) sessions.set(event.sessionId, event.seeded);
  const totalSessions = sessions.size;
  const seededSessions = [...sessions.values()].filter(Boolean).length;

  const interactions = events.filter((e) => INTERACTION_EVENTS.includes(e.eventType));

  // Sequences: per session, consecutive interactions on different components.
  const transitionCounts = new Map<string, number>();
  const bySession = new Map<string, TelemetryEvent[]>();
  for (const event of interactions) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  for (const list of bySession.values()) {
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1].componentId;
      const to = list[i].componentId;
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
    }
  }
  const transitions: Transition[] = [...transitionCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  const components = input.schema.components.map((component): ComponentMetrics => {
    const own = events.filter((e) => e.componentId === component.id);
    const ownInteractions = own.filter((e) => INTERACTION_EVENTS.includes(e.eventType));
    const usingSessions = new Set(ownInteractions.map((e) => e.sessionId));

    const discovery = new Map<string, number>();
    for (const event of own) {
      if (!DISCOVERY_EVENTS.includes(event.eventType)) continue;
      const previous = discovery.get(event.sessionId);
      if (previous === undefined || event.sinceLoadMs < previous) discovery.set(event.sessionId, event.sinceLoadMs);
    }
    const discoveryTimes = [...discovery.values()];

    let repeats = 0;
    const lastInteraction = new Map<string, number>();
    for (const event of ownInteractions) {
      const last = lastInteraction.get(event.sessionId);
      if (last !== undefined && event.createdAt - last <= REPEAT_WINDOW_MS) repeats += 1;
      lastInteraction.set(event.sessionId, event.createdAt);
    }

    const valueChanges = ownInteractions.filter((e) => e.eventType === "value_change").length;
    const completions = own.filter((e) => e.eventType === "interaction_complete").length;
    const errors = own.filter((e) => e.eventType === "interaction_error").length;

    const outgoing = transitions.filter((t) => t.from === component.id);
    const outgoingTotal = outgoing.reduce((sum, t) => sum + t.count, 0);

    return {
      componentId: component.id,
      capabilityId: component.capability,
      primitive: component.primitive,
      visible: component.visible,
      views: own.filter((e) => e.eventType === "component_view").length,
      interactions: ownInteractions.length,
      interactionShare: interactions.length ? round(ownInteractions.length / interactions.length) : 0,
      sessionsUsed: usingSessions.size,
      usageRate: totalSessions ? round(usingSessions.size / totalSessions) : 0,
      avgDiscoveryMs: discoveryTimes.length
        ? Math.round(discoveryTimes.reduce((a, b) => a + b, 0) / discoveryTimes.length)
        : null,
      repeatRate: ownInteractions.length ? round(repeats / ownInteractions.length) : 0,
      valueChangesPerUsingSession: usingSessions.size ? round(valueChanges / usingSessions.size, 2) : null,
      completions,
      errors,
      errorRate: completions + errors ? round(errors / (completions + errors)) : null,
      followedBy: outgoing.map((t) => ({
        componentId: t.to,
        count: t.count,
        share: round(t.count / outgoingTotal),
      })),
    };
  });

  return {
    versionId: input.versionId,
    sessions: { total: totalSessions, live: totalSessions - seededSessions, seeded: seededSessions },
    totalInteractions: interactions.length,
    components,
    transitions,
    latency: computeLatency(input.calls),
  };
}
