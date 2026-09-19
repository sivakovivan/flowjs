import { describe, expect, it } from "vitest";
import { fixtureApp } from "./__fixtures__/app";
import { fixtureSchema } from "./__fixtures__/schema";
import { call, dateRangeFriction, session } from "./__fixtures__/telemetry";
import { findFriction } from "./friction";
import { computeMetrics } from "./metrics";
import type { CapabilityCall, TelemetryEvent } from "./store";

const app = fixtureApp();

function findingsFor(events: TelemetryEvent[], calls: CapabilityCall[] = [], schema = fixtureSchema()) {
  const metrics = computeMetrics({ versionId: "v1", schema, events, calls });
  return findFriction({ app, schema, metrics });
}

function exportRetries(): TelemetryEvent[] {
  return session("s", [
    ["export", "component_click", 1],
    ["export", "component_click", 3],
    ["export", "component_click", 5],
    ["export", "component_click", 8],
  ]);
}

describe("findFriction", () => {
  it("detects the buried, dropdown-driven date range and its separation from revenue", () => {
    const findings = findingsFor(dateRangeFriction(), [call("revenue", 90)]);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("buried-control");
    expect(kinds).toContain("poor-primitive");
    expect(kinds).toContain("separated-related");
    const buried = findings.find((f) => f.kind === "buried-control")!;
    expect(buried.componentIds).toEqual(["date-range"]);
    expect(buried.evidence).toContain("used in 100% of sessions (3/3)");
    expect(buried.evidence).toContain("avg discovery time 6.5s");
    const separated = findings.find((f) => f.kind === "separated-related")!;
    expect(separated.componentIds).toEqual(["date-range", "revenue-chart"]);
    expect(separated.evidence.join()).toMatch(/related in the capability graph/);
  });

  it("does not call a visible, top-row control buried just because it is used late", () => {
    const buried = findingsFor(dateRangeFriction()).filter((f) => f.kind === "buried-control");
    expect(buried.map((f) => f.componentIds[0])).toEqual(["date-range"]); // not export
  });

  it("classifies retries on a slow action as backend performance", () => {
    const slow = [call("exportReport", 2900, { traceId: "abc" }), call("exportReport", 3100)];
    const finding = findingsFor(exportRetries(), slow).find((f) => f.kind === "high-retry-action")!;
    expect(finding.classification).toBe("performance");
    expect(finding.suggestion).toMatch(/Do not redesign/);
    expect(finding.evidence.join()).toMatch(/Sentry traces: abc/);
  });

  it("classifies retries on a fast action as interface friction", () => {
    const fast = [call("exportReport", 120), call("exportReport", 140)];
    const finding = findingsFor(exportRetries(), fast).find((f) => f.kind === "high-retry-action")!;
    expect(finding.classification).toBe("ui");
  });

  it("flags large components that get almost no interaction", () => {
    const schema = fixtureSchema();
    const events = Array.from({ length: 16 }, (_, i) =>
      session(`s${i}`, [["date-range", "value_change", 1]], { start: i * 100_000 }),
    ).flat();
    const findings = findingsFor(events, [], schema);
    const oversized = findings.filter((f) => f.kind === "oversized-low-value").map((f) => f.componentIds[0]);
    expect(oversized).toEqual(expect.arrayContaining(["revenue-chart", "transactions-table"]));
  });

  it("stays quiet without enough evidence", () => {
    expect(findingsFor(session("s", [["date-range", "value_change", 1]]))).toEqual([]);
  });

  it("sorts findings by severity", () => {
    const severities = findingsFor(dateRangeFriction()).map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => b - a));
  });
});
