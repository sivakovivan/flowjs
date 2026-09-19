import type { CapabilityCall, TelemetryEvent, TelemetryEventType } from "../store";

const CAPABILITY_BY_COMPONENT: Record<string, string> = {
  "revenue-chart": "revenue",
  export: "exportReport",
  "transactions-table": "transactions",
  "date-range": "dateRange",
  "customer-search": "customerQuery",
  refund: "refundTransaction",
};

/** Build a session's events from `[componentId, eventType, secondsSinceLoad]` steps. */
export function session(
  sessionId: string,
  steps: Array<[string, TelemetryEventType, number]>,
  options: { start?: number; seeded?: boolean; versionId?: string } = {},
): TelemetryEvent[] {
  const start = options.start ?? 1_000_000;
  return steps.map(([componentId, eventType, seconds]) => ({
    applicationId: "fixture",
    versionId: options.versionId ?? "v1",
    sessionId,
    userId: null,
    componentId,
    capabilityId: CAPABILITY_BY_COMPONENT[componentId] ?? componentId,
    eventType,
    sinceLoadMs: seconds * 1000,
    metadata: {},
    seeded: options.seeded ?? false,
    createdAt: start + seconds * 1000,
  }));
}

export function call(capabilityId: string, latencyMs: number, extra: Partial<CapabilityCall> = {}): CapabilityCall {
  return {
    applicationId: "fixture",
    versionId: "v1",
    sessionId: null,
    componentId: null,
    capabilityId,
    kind: capabilityId === "exportReport" || capabilityId === "refundTransaction" ? "action" : "data",
    latencyMs,
    ok: true,
    error: null,
    traceId: null,
    replayId: null,
    seeded: false,
    createdAt: 1,
    ...extra,
  };
}

/**
 * The demo story: date range is used every session, found late (it sits below
 * the table), changed repeatedly and almost always followed by the chart.
 */
export function dateRangeFriction(): TelemetryEvent[] {
  return [0, 1, 2].flatMap((n) =>
    session(
      `s${n}`,
      [
        ["revenue-chart", "component_view", 0],
        ["transactions-table", "component_view", 0],
        ["date-range", "component_view", 4],
        ["date-range", "interaction_start", 6.5],
        ["date-range", "value_change", 7],
        ["revenue-chart", "component_click", 9],
        ["date-range", "value_change", 14],
        ["revenue-chart", "component_click", 16],
        ["date-range", "value_change", 21],
        ["revenue-chart", "component_click", 23],
        ["export", "component_click", 30],
        ["export", "interaction_complete", 30.3],
      ],
      { start: n * 1_000_000 },
    ),
  );
}
