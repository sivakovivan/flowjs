import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_MODELS, parseModelRef, routeTask, tierModelsFromEnv } from "./routing";

const ui = { classification: "ui" as const };
const performance = { classification: "performance" as const };
const optimize = (overrides: Partial<Extract<Parameters<typeof routeTask>[0], { task: "optimize" }>> = {}) =>
  routeTask({ task: "optimize", components: 10, findings: [ui], pastDecisions: [], ...overrides });

describe("routeTask", () => {
  it("routes generation to the balanced tier and escalates to deep", () => {
    const route = routeTask({ task: "generate", capabilities: 8 });
    expect(route.tier).toBe("balanced");
    expect(route.chain.map((s) => s.tier)).toEqual(["balanced", "deep"]);
  });

  it("routes large applications straight to the deep tier", () => {
    expect(routeTask({ task: "generate", capabilities: 13 }).chain.map((s) => s.tier)).toEqual(["deep"]);
  });

  it("uses the fast tier for a single finding on a small dashboard", () => {
    const route = optimize();
    expect(route.tier).toBe("fast");
    expect(route.chain.map((s) => s.tier)).toEqual(["fast", "balanced", "deep"]);
    expect(route.chain[0]).toMatchObject(DEFAULT_TIER_MODELS.fast);
  });

  it("uses the balanced tier when several findings must be reconciled", () => {
    expect(optimize({ findings: [ui, ui, ui] }).tier).toBe("balanced");
    expect(optimize({ components: 13 }).tier).toBe("balanced");
  });

  it("uses the deep tier when interface and performance findings conflict", () => {
    const route = optimize({ findings: [ui, performance] });
    expect(route.tier).toBe("deep");
    expect(route.reason).toMatch(/conflict/);
  });

  it("never uses the fast tier when the developer undid an earlier change", () => {
    const route = optimize({ pastDecisions: ["[app] The developer undid v2 (Date control promoted)."] });
    expect(route.tier).toBe("balanced");
    expect(route.reason).toMatch(/undid/);
  });

  it("lets OpenRouter pick within a cost tier, escalating to a known deep model", () => {
    const route = routeTask({ task: "generate", capabilities: 8 }, DEFAULT_TIER_MODELS, "openrouter-auto");
    expect(route.chain[0]).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
      options: { openrouter: { cost_tier: "medium" } },
    });
    expect(route.chain[1]).toMatchObject(DEFAULT_TIER_MODELS.deep);
  });
});

describe("model configuration", () => {
  it("parses provider/model, keeping slashes in the model name", () => {
    expect(parseModelRef("openrouter/moonshotai/kimi-k3")).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k3" });
    expect(parseModelRef("gpt-5")).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });

  it("overrides tiers from the environment", () => {
    const models = tierModelsFromEnv({ BACKBOARD_MODEL_FAST: "google/gemini-3.1-flash-lite", BACKBOARD_MODEL_DEEP: "nonsense" });
    expect(models.fast).toEqual({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(models.deep).toEqual(DEFAULT_TIER_MODELS.deep);
  });
});
