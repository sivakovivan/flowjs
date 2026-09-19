import { beforeEach, describe, expect, it } from "vitest";
import { fixtureApp } from "./__fixtures__/app";
import { fixtureSchema } from "./__fixtures__/schema";
import { dateRangeFriction } from "./__fixtures__/telemetry";
import type { GeneratedSchemaOutput, OptimizationOutput } from "./ai/contracts";
import { createRecordedProvider, ProviderOutput, type CallMeta, type FlowAIProvider, type Recording } from "./ai/providers";
import type { FlowMemory } from "./memory";
import { createRuntime, RuntimeError, type OptimizationAnalysis } from "./runtime";
import { FlowStore } from "./store";

const app = fixtureApp();

const generation: GeneratedSchemaOutput = {
  reasoning: "Chart first, table below, controls after.",
  components: fixtureSchema().components.map((c) => ({ ...c, rationale: "fixture" })),
};

const promoteDateRange: OptimizationOutput = {
  finding: "Date range is used every session but found late.",
  classification: "ui",
  evidence: ["used in 100% of sessions", "6.5s discovery"],
  confidence: 0.84,
  expectedBenefit: 0.4,
  reason: "Date control promoted beside Revenue",
  explanation: "Move the date range beside the chart it filters and make every option one click.",
  mutations: [
    { type: "MOVE", element: "date-range", target: "revenue-chart", position: "before", index: null, size: null, variant: null },
    { type: "SWAP_VARIANT", element: "date-range", target: null, position: null, index: null, size: null, variant: "segmented-control" },
  ],
};

const recording: Recording = { provenance: "test", generation, optimizations: [promoteDateRange] };

function stub(overrides: Partial<FlowAIProvider>): FlowAIProvider {
  return {
    source: "live",
    model: "stub-model",
    generateSchema: async () => structuredClone(generation),
    proposeOptimization: async () => structuredClone(promoteDateRange),
    ...overrides,
  };
}

let store: FlowStore;
let clock: number;

function runtime(live: FlowAIProvider | null, options: { forceRecorded?: boolean; memory?: FlowMemory } = {}) {
  return createRuntime({
    app,
    store,
    live,
    recorded: createRecordedProvider(app, recording),
    now: () => clock,
    ...options,
  });
}

function recordFriction() {
  store.insertEvents(dateRangeFriction());
}

beforeEach(() => {
  store = new FlowStore(":memory:", () => clock);
  clock = 10_000_000;
});

describe("generate", () => {
  it("creates v1 from a live structured output", async () => {
    const { version, provenance } = await runtime(stub({})).generate();
    expect(version).toMatchObject({ id: "v1", parentVersionId: null, source: "generated", aiSource: "live" });
    expect(provenance).toEqual({ source: "live", model: "stub-model", fallbackReason: null, call: null });
  });

  it("is idempotent once a dashboard exists", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    const second = await rt.generate();
    expect(second.version.id).toBe("v1");
    expect(store.listVersions(app.id)).toHaveLength(1);
  });

  it("replays the recorded response when the live call fails", async () => {
    const failing = stub({ generateSchema: async () => Promise.reject(new Error("503 upstream")) });
    const { version, provenance } = await runtime(failing).generate();
    expect(version.aiSource).toBe("recorded");
    expect(provenance?.fallbackReason).toMatch(/Live call failed: 503 upstream/);
  });

  it("never persists an invalid live schema", async () => {
    const invalid = structuredClone(generation);
    invalid.components[0].capability = "launchMissiles";
    const { version, provenance } = await runtime(stub({ generateSchema: async () => invalid })).generate();
    expect(provenance?.source).toBe("recorded");
    expect(provenance?.fallbackReason).toMatch(/failed validation.*launchMissiles/);
    expect(version.schema.components.every((c) => app.capability(c.capability))).toBe(true);
    expect(store.listVersions(app.id)).toHaveLength(1);
  });

  it("falls back when the live output is malformed", async () => {
    const { provenance } = await runtime(stub({ generateSchema: async () => ({ nope: true }) })).generate();
    expect(provenance?.source).toBe("recorded");
  });

  it("uses recordings without an API key or when recorded mode is forced", async () => {
    expect((await runtime(null).generate()).provenance?.fallbackReason).toMatch(/No AI key is configured/);
    store = new FlowStore(":memory:");
    let liveCalled = false;
    const live = stub({ generateSchema: async () => ((liveCalled = true), structuredClone(generation)) });
    const forced = await runtime(live, { forceRecorded: true }).generate();
    expect(forced.provenance).toMatchObject({ source: "recorded", fallbackReason: expect.stringMatching(/Recorded mode/) });
    expect(liveCalled).toBe(false);
  });

  it("creates no version when both live and recorded outputs are unusable", async () => {
    const rt = createRuntime({
      app,
      store,
      live: stub({ generateSchema: async () => Promise.reject(new Error("down")) }),
      recorded: createRecordedProvider(app, undefined),
    });
    await expect(rt.generate()).rejects.toThrow(/No recorded responses/);
    expect(store.listVersions(app.id)).toEqual([]);
  });
});

describe("optimize and apply", () => {
  it("requires telemetry before optimizing", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    await expect(rt.optimize()).rejects.toThrow(/No interactions/);
  });

  it("proposes, scores and awaits approval below the threshold", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    rt.setMutationRate(0.2); // threshold 0.76
    recordFriction();
    const run = await rt.optimize();
    const analysis = run.analysis as OptimizationAnalysis;
    expect(run.status).toBe("pending");
    expect(analysis.sampleSize).toEqual({ sessions: 3, liveSessions: 3, seededSessions: 0, interactions: 21 });
    expect(analysis.findings.map((f) => f.kind)).toContain("buried-control");
    expect(analysis.decision).toEqual({ autoApply: false, threshold: 0.76 });
    // Nothing changed yet.
    expect(store.getActiveVersion(app.id)?.id).toBe("v1");
    expect(() => rt.apply(run.id, "auto")).toThrow(/threshold/);
  });

  it("applies an approved proposal as a new active version with evidence", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    const { version } = rt.apply(run.id, "manual");
    expect(version).toMatchObject({ id: "v2", parentVersionId: "v1", reason: "Date control promoted beside Revenue" });
    expect(version.schema.components[0]).toMatchObject({ id: "date-range", primitive: "segmented-control" });
    expect(version.evidence).toMatchObject({ appliedBy: "manual" });
    expect(store.getRun(run.id)).toMatchObject({ status: "applied", appliedVersionId: "v2" });
    expect(() => rt.apply(run.id, "manual")).toThrow(/status: applied/);
  });

  it("auto-applies when the score clears the mutation-rate threshold", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    rt.setMutationRate(1);
    recordFriction();
    const run = await rt.optimize();
    expect(run.status).toBe("auto");
    expect(rt.apply(run.id, "auto").version.id).toBe("v2");
  });

  it("never auto-applies at mutation rate 0", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    rt.setMutationRate(0);
    recordFriction();
    const run = await rt.optimize();
    expect(run.status).toBe("pending");
    expect(() => rt.apply(run.id, "auto")).toThrow(/threshold/);
  });

  it("rejects an unsafe live proposal without creating a version", async () => {
    const unsafe = structuredClone(promoteDateRange);
    unsafe.mutations = [
      { type: "HIDE", element: "export", target: null, position: null, index: null, size: null, variant: null },
    ];
    const rt = runtime(stub({ proposeOptimization: async () => unsafe }));
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    expect(run.status).toBe("rejected");
    expect(run.errors.join()).toMatch(/only usable control/);
    expect(() => rt.apply(run.id, "manual")).toThrow(/status: rejected/);
    expect(store.listVersions(app.id)).toHaveLength(1);
  });

  it("rejects proposals referencing unknown components or incompatible variants", async () => {
    const bad = structuredClone(promoteDateRange);
    bad.mutations[0].element = "ghost";
    bad.mutations[1].variant = "table";
    const rt = runtime(stub({ proposeOptimization: async () => bad }));
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    expect(run.status).toBe("rejected");
    expect(run.errors.join("\n")).toMatch(/unknown component "ghost"/);
    expect(run.errors.join("\n")).toMatch(/not a compatible variant/);
  });

  it("records performance findings as no-change diagnostics", async () => {
    const performance = { ...structuredClone(promoteDateRange), classification: "performance" as const, mutations: [] };
    const rt = runtime(stub({ proposeOptimization: async () => performance }));
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    expect(run.status).toBe("no-change");
    expect(store.listVersions(app.id)).toHaveLength(1);
  });

  it("replays a recorded proposal when the live optimization call fails", async () => {
    const rt = runtime(stub({ proposeOptimization: async () => Promise.reject(new Error("timeout")) }));
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    expect(run.aiSource).toBe("recorded");
    expect((run.analysis as OptimizationAnalysis).ai.fallbackReason).toMatch(/timeout/);
    expect(run.status).not.toBe("rejected");
  });

  it("marks a proposal stale when the dashboard changed underneath it", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    recordFriction();
    const first = await rt.optimize();
    const second = await rt.optimize();
    rt.apply(first.id, "manual");
    expect(() => rt.apply(second.id, "manual")).toThrow(RuntimeError);
    expect(store.getRun(second.id)?.status).toBe("stale");
  });
});

describe("history", () => {
  it("undoes to the parent and branches later optimizations from the active version", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    recordFriction();
    rt.apply((await rt.optimize()).id, "manual");
    expect(rt.undo().id).toBe("v1");
    const run = await rt.optimize(); // telemetry for v1 still exists
    const v3 = rt.apply(run.id, "manual").version;
    expect(v3).toMatchObject({ id: "v3", parentVersionId: "v1" });
    expect(rt.restore("v2").id).toBe("v2");
    expect(store.listVersions(app.id).map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
  });

  it("refuses to undo the generated root", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    expect(() => rt.undo()).toThrow(/no parent/);
  });

  it("increases disruption after recent version churn", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    recordFriction();
    const calm = (await rt.optimize()).score as { disruption: number };
    rt.apply((await rt.optimize()).id, "manual");
    rt.undo();
    const churned = (await rt.optimize()).score as { disruption: number };
    expect(churned.disruption).toBeGreaterThan(calm.disruption);
  });
});

describe("telemetry ingestion", () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    versionId: "v1",
    sessionId: "s1",
    componentId: "date-range",
    eventType: "value_change",
    sinceLoadMs: 5_000,
    timestamp: clock,
    ...overrides,
  });

  it("accepts events for real components and derives the capability from the schema", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    const result = rt.recordTelemetry([
      event(),
      event({ componentId: "ghost" }),
      event({ versionId: "v9" }),
      event({ eventType: "keylogger" }),
      event({ capabilityId: "refundTransaction" }),
    ]);
    expect(result).toEqual({ accepted: 2, rejected: 3 });
    expect(store.listEvents(app.id, "v1").map((e) => e.capabilityId)).toEqual(["dateRange", "dateRange"]);
  });

  it("replaces implausible client timestamps with the server clock", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    rt.recordTelemetry([event({ timestamp: 42 })]);
    expect(store.listEvents(app.id, "v1")[0].createdAt).toBe(clock);
  });

  it("seeds flagged sessions that can be cleared without touching live data", async () => {
    const rt = runtime(stub({}));
    await rt.generate();
    rt.recordTelemetry([event()]);
    rt.seedDemoSessions(4);
    expect(rt.analyze().metrics.sessions).toMatchObject({ live: 1, seeded: 4 });
    rt.clearSeeded();
    expect(rt.analyze().metrics.sessions).toMatchObject({ live: 1, seeded: 0 });
  });
});

describe("provider call metadata and repair", () => {
  const meta: CallMeta = {
    vendor: "backboard",
    model: "openai/gpt-5.6-sol",
    tier: "balanced",
    routeReason: "test",
    attempts: 2,
    repairs: 1,
    rejections: ["stub: bad"],
    escalated: false,
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 1,
    threadId: "t",
  };

  it("records the routed model and call details in provenance", async () => {
    const live = stub({ generateSchema: async () => new ProviderOutput(structuredClone(generation), meta) });
    const { provenance } = await runtime(live).generate();
    expect(provenance).toMatchObject({ source: "live", model: "openai/gpt-5.6-sol", call: { repairs: 1 } });
  });

  it("hands providers a check that includes the registry and the mutation validator", async () => {
    const seen: string[][] = [];
    const invalid = structuredClone(generation);
    invalid.components[0].capability = "launchMissiles";
    const unsafe = structuredClone(promoteDateRange);
    unsafe.mutations[0].element = "ghost";
    const live = stub({
      generateSchema: async (_brief, check) => (seen.push(check!(invalid)), structuredClone(generation)),
      proposeOptimization: async (_brief, check) => (seen.push(check!(unsafe)), structuredClone(promoteDateRange)),
    });
    const rt = runtime(live);
    await rt.generate();
    recordFriction();
    await rt.optimize();
    expect(seen[0].join()).toMatch(/launchMissiles/);
    expect(seen[1].join()).toMatch(/unknown component "ghost"/);
  });
});

describe("decision memory", () => {
  function fakeMemory(overrides: Partial<FlowMemory> = {}) {
    const remembered: Array<{ content: string; metadata: Record<string, unknown> }> = [];
    const memory: FlowMemory = {
      remember: async (content, metadata) => void remembered.push({ content, metadata }),
      recall: async () => remembered.map((m) => ({ content: m.content, createdAt: null })),
      reset: async () => void remembered.splice(0),
      ...overrides,
    };
    return { memory, remembered };
  }

  it("remembers applied, undone and restored versions after they commit", async () => {
    const { memory, remembered } = fakeMemory();
    const rt = runtime(stub({}), { memory });
    await rt.generate();
    recordFriction();
    rt.apply((await rt.optimize()).id, "manual");
    rt.undo();
    rt.restore("v2");
    await rt.flushMemory();
    expect(remembered.map((m) => m.metadata.kind)).toEqual(["applied", "undone", "restored"]);
    expect(remembered[0].content).toMatch(/applied v2 "Date control promoted beside Revenue" \(MOVE date-range before revenue-chart; SWAP_VARIANT date-range to segmented-control\).*approved by the developer.*3 sessions/);
    expect(remembered[1].content).toMatch(/developer undid v2 .*returned to v1\. Do not re-propose/);
  });

  it("does not remember a proposal that failed to apply", async () => {
    const { memory, remembered } = fakeMemory();
    const rt = runtime(stub({}), { memory });
    await rt.generate();
    rt.setMutationRate(0);
    recordFriction();
    const run = await rt.optimize();
    expect(() => rt.apply(run.id, "auto")).toThrow();
    await rt.flushMemory();
    expect(remembered).toEqual([]);
  });

  it("recalls past decisions into the brief and the evidence", async () => {
    const { memory } = fakeMemory();
    let pastDecisions: string[] = [];
    const live = stub({
      proposeOptimization: async (brief) => ((pastDecisions = brief.pastDecisions), structuredClone(promoteDateRange)),
    });
    const rt = runtime(live, { memory });
    await rt.generate();
    recordFriction();
    rt.apply((await rt.optimize()).id, "manual");
    rt.undo();
    await rt.flushMemory();
    const run = await rt.optimize();
    expect(pastDecisions.join("\n")).toMatch(/developer undid v2/);
    expect((run.analysis as OptimizationAnalysis).memories).toHaveLength(2);
  });

  it("keeps optimizing, applying and undoing when memory is down", async () => {
    const down = async () => Promise.reject(new Error("memory service down"));
    const { memory } = fakeMemory({ remember: down, recall: down });
    const rt = runtime(stub({}), { memory });
    await rt.generate();
    recordFriction();
    const run = await rt.optimize();
    expect((run.analysis as OptimizationAnalysis).memories).toEqual([]);
    expect(rt.apply(run.id, "manual").version.id).toBe("v2");
    expect(rt.undo().id).toBe("v1");
    await rt.flushMemory();
  });
});
