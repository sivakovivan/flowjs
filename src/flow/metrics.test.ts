import { describe, expect, it } from "vitest";
import { fixtureSchema } from "./__fixtures__/schema";
import { call, dateRangeFriction, session } from "./__fixtures__/telemetry";
import { computeLatency, computeMetrics } from "./metrics";

function metricsFor(events = dateRangeFriction(), calls = [call("revenue", 120)]) {
  return computeMetrics({ versionId: "v1", schema: fixtureSchema(), events, calls });
}

describe("computeMetrics", () => {
  it("counts live and seeded sessions separately", () => {
    const seeded = session("seeded", [["export", "component_click", 1]], { seeded: true });
    expect(metricsFor([...dateRangeFriction(), ...seeded]).sessions).toEqual({ total: 4, live: 3, seeded: 1 });
  });

  it("derives usage, discovery time, repeat rate and value changes", () => {
    const dateRange = metricsFor().components.find((c) => c.componentId === "date-range")!;
    expect(dateRange).toMatchObject({
      interactions: 9,
      sessionsUsed: 3,
      usageRate: 1,
      avgDiscoveryMs: 6500, // interaction_start counts as discovery
      avgFirstViewMs: 4000, // scrolled into view after load
      valueChangesPerUsingSession: 3,
      views: 3,
    });
    // 2 of 3 changes per session happen within 30s of the previous one.
    expect(dateRange.repeatRate).toBe(0.667);
  });

  it("records interaction sequences and follow-ups", () => {
    const metrics = metricsFor();
    expect(metrics.transitions[0]).toEqual({ from: "date-range", to: "revenue-chart", count: 9 });
    const dateRange = metrics.components.find((c) => c.componentId === "date-range")!;
    expect(dateRange.followedBy).toEqual([{ componentId: "revenue-chart", count: 9, share: 1 }]);
  });

  it("computes error rate from completions and errors", () => {
    const events = session("s", [
      ["export", "component_click", 1],
      ["export", "interaction_complete", 2],
      ["export", "component_click", 3],
      ["export", "interaction_error", 4],
    ]);
    const exportMetrics = metricsFor(events).components.find((c) => c.componentId === "export")!;
    expect(exportMetrics.errorRate).toBe(0.5);
  });

  it("reports untouched components with zero usage", () => {
    const refund = metricsFor().components.find((c) => c.componentId === "refund")!;
    expect(refund).toMatchObject({ interactions: 0, usageRate: 0, avgDiscoveryMs: null, errorRate: null });
  });
});

describe("retry latency", () => {
  it("measures backend latency only in sessions where the component was retried", () => {
    const retried = session("slow", [
      ["export", "component_click", 1],
      ["export", "component_click", 3],
      ["export", "component_click", 5],
    ]);
    const once = session("fast", [["export", "component_click", 1]], { start: 5_000_000 });
    const calls = [
      call("exportReport", 2800, { sessionId: "slow", componentId: "export" }),
      call("exportReport", 90, { sessionId: "fast", componentId: "export" }),
      call("exportReport", 110, { sessionId: "fast", componentId: "export" }),
      call("exportReport", 95, { sessionId: "other", componentId: "export" }),
    ];
    const exportMetrics = metricsFor([...retried, ...once], calls).components.find((c) => c.componentId === "export")!;
    expect(exportMetrics.retryLatencyMs).toBe(2800);
    // Across all calls the backend looks fast.
    expect(computeLatency(calls).find((l) => l.capabilityId === "exportReport")?.slow).toBe(false);
  });

  it("is null when nothing was retried", () => {
    const exportMetrics = metricsFor(session("s", [["export", "component_click", 1]])).components.find(
      (c) => c.componentId === "export",
    )!;
    expect(exportMetrics.retryLatencyMs).toBeNull();
  });
});

describe("computeLatency", () => {
  it("summarizes backend latency and flags slow capabilities", () => {
    const latency = computeLatency([
      call("exportReport", 2900, { traceId: "t1", createdAt: 3 }),
      call("exportReport", 2700, { traceId: "t2", createdAt: 2, ok: false }),
      call("exportReport", 3100, { createdAt: 1 }),
      call("revenue", 80),
    ]);
    const exportLatency = latency.find((l) => l.capabilityId === "exportReport")!;
    expect(exportLatency).toMatchObject({ calls: 3, p50Ms: 2900, p95Ms: 3100, slow: true, errorRate: 0.333 });
    expect(exportLatency.traceIds).toEqual(["t1", "t2"]);
    expect(latency.find((l) => l.capabilityId === "revenue")?.slow).toBe(false);
  });
});
