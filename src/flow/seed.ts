import type { FlowApp } from "./registry";
import { layoutRows, type UISchema } from "./schema";
import type { CapabilityCall, TelemetryEvent, TelemetryEventType } from "./store";

/*
 * Seeded demo sessions: synthetic, clearly flagged telemetry for presenting
 * with a thin live sample. Behaviour follows the capability graph (people
 * change a filter, then read what it drives), and discovery time grows with
 * how far down the layout a control sits.
 */

export const SEEDED_SESSION_PREFIX = "seeded-";

const DATA_LATENCY_MS = 110;

function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function seedSessions(input: {
  app: FlowApp;
  schema: UISchema;
  versionId: string;
  count: number;
  now: number;
  seed?: number;
}): { events: TelemetryEvent[]; calls: CapabilityCall[] } {
  const { app, schema, versionId } = input;
  const random = prng(input.seed ?? input.now);
  const rows = layoutRows(schema);
  const visible = schema.components.filter((c) => c.visible);
  const events: TelemetryEvent[] = [];
  const calls: CapabilityCall[] = [];

  for (let s = 0; s < input.count; s++) {
    const sessionId = `${SEEDED_SESSION_PREFIX}${input.now.toString(36)}-${s}`;
    const start = input.now - (input.count - s) * 120_000;
    const push = (componentId: string, capabilityId: string, eventType: TelemetryEventType, at: number) =>
      events.push({
        applicationId: app.id,
        versionId,
        sessionId,
        userId: null,
        componentId,
        capabilityId,
        eventType,
        sinceLoadMs: Math.round(at),
        metadata: { seeded: true },
        seeded: true,
        createdAt: Math.round(start + at),
      });

    // Components scroll into view roughly one second per row past the fold.
    for (const component of visible) {
      const row = rows.get(component.id) ?? 0;
      push(component.id, component.capability, "component_view", Math.max(0, row - 1) * 1_100 + random() * 300);
    }

    let t = 1_500;
    for (const control of visible) {
      const capability = app.capability(control.capability);
      if (capability?.kind !== "state" || capability.stateType === "text") continue;
      if (random() > 0.85) continue; // most, not all, sessions filter

      const row = rows.get(control.id) ?? 0;
      const discovery = 1_200 + row * 1_500 + random() * 1_200;
      push(control.id, control.capability, "interaction_start", discovery - 400);
      t = Math.max(t, discovery);

      const driven = visible.filter(
        (c) => app.capability(c.capability)?.kind === "data" && app.capability(c.capability)?.dependsOn.includes(capability.id),
      );
      const target = driven.find((c) => c.primitive === "line-chart" || c.primitive === "bar-chart") ?? driven[0];
      const changes = 2 + Math.floor(random() * 3);
      for (let i = 0; i < changes; i++) {
        push(control.id, control.capability, "value_change", t);
        for (const data of driven) {
          calls.push(seededCall(app.id, versionId, sessionId, data.id, data.capability, "data", DATA_LATENCY_MS * (0.6 + random()), start + t));
        }
        t += 1_500 + random() * 2_000;
        if (target) push(target.id, target.capability, "component_click", t);
        t += 3_000 + random() * 4_000;
      }
    }

    // Search, then read the collection it drives.
    for (const search of visible.filter((c) => c.primitive === "search-field")) {
      if (random() > 0.6) continue;
      push(search.id, search.capability, "value_change", t);
      const table = visible.find((c) => app.capability(c.capability)?.dependsOn.includes(search.capability));
      t += 2_000 + random() * 1_500;
      if (table) push(table.id, table.capability, "component_click", t);
      t += 2_000;
    }

    // Finish the workflow with an action.
    const action = visible.find((c) => app.capability(c.capability)?.kind === "action" && c.id.includes("export"));
    if (action) {
      push(action.id, action.capability, "component_click", t);
      push(action.id, action.capability, "interaction_start", t + 10);
      const latency = 90 + random() * 120;
      calls.push(seededCall(app.id, versionId, sessionId, action.id, action.capability, "action", latency, start + t));
      push(action.id, action.capability, "interaction_complete", t + latency);
    }
  }
  return { events, calls };
}

function seededCall(
  applicationId: string,
  versionId: string,
  sessionId: string,
  componentId: string,
  capabilityId: string,
  kind: "data" | "action",
  latencyMs: number,
  createdAt: number,
): CapabilityCall {
  return {
    applicationId,
    versionId,
    sessionId,
    componentId,
    capabilityId,
    kind,
    latencyMs: Math.round(latencyMs),
    ok: true,
    error: null,
    traceId: null,
    replayId: null,
    seeded: true,
    createdAt: Math.round(createdAt),
  };
}
