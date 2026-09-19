/*
 * Model routing for BackBoard. flow.js picks the cheapest model tier that fits
 * the task, and escalates to stronger tiers when a model's output cannot be
 * repaired. Routing is a pure function so every decision is testable.
 */

export const TIERS = ["fast", "balanced", "deep"] as const;
export type Tier = (typeof TIERS)[number];

export interface ModelRef {
  provider: string;
  model: string;
  /** Extra send-message fields, e.g. OpenRouter options. */
  options?: Record<string, unknown>;
}

export type TierModels = Record<Tier, ModelRef>;

/** Defaults chosen with `pnpm eval:backboard`; override with BACKBOARD_MODEL_<TIER>=provider/model. */
export const DEFAULT_TIER_MODELS: TierModels = {
  fast: { provider: "openai", model: "gpt-5.6-luna" },
  balanced: { provider: "openai", model: "gpt-5.6-sol" },
  // A different vendor on the last tier, so escalation also survives a provider outage.
  // Not claude-opus-5: measured live it omitted required keys in about half of replies (see evals/README.md).
  deep: { provider: "anthropic", model: "claude-sonnet-5" },
};

/** `rules`: flow.js picks the tier. `openrouter-auto`: OpenRouter picks the model inside a cost tier. */
export type RoutingMode = "rules" | "openrouter-auto";

export type RoutingSignals =
  | { task: "generate"; capabilities: number }
  | {
      task: "optimize";
      components: number;
      findings: Array<{ classification: "ui" | "performance" }>;
      pastDecisions: string[];
    };

export interface RouteStep extends ModelRef {
  tier: Tier;
}

export interface Route {
  tier: Tier;
  reason: string;
  /** Models to try in order; later entries are escalations. */
  chain: RouteStep[];
}

export const LARGE_APP_CAPABILITIES = 12;
export const SIMPLE_MAX_FINDINGS = 1;
export const SIMPLE_MAX_COMPONENTS = 12;

function chooseTier(signals: RoutingSignals): { tier: Tier; reason: string } {
  if (signals.task === "generate") {
    return signals.capabilities > LARGE_APP_CAPABILITIES
      ? { tier: "deep", reason: `large application (${signals.capabilities} capabilities)` }
      : { tier: "balanced", reason: `layout design for ${signals.capabilities} capabilities` };
  }

  const kinds = new Set(signals.findings.map((f) => f.classification));
  if (kinds.has("ui") && kinds.has("performance")) {
    return { tier: "deep", reason: "interface and backend-performance findings conflict" };
  }
  if (signals.pastDecisions.some((d) => /\bundid\b/i.test(d))) {
    return { tier: "balanced", reason: "must weigh a change the developer undid" };
  }
  if (signals.findings.length <= SIMPLE_MAX_FINDINGS && signals.components <= SIMPLE_MAX_COMPONENTS) {
    return { tier: "fast", reason: `${signals.findings.length} heuristic finding(s) on a small dashboard` };
  }
  return { tier: "balanced", reason: `${signals.findings.length} heuristic findings to reconcile` };
}

const OPENROUTER_COST_TIER: Record<Tier, string> = { fast: "low", balanced: "medium", deep: "high" };

export function routeTask(
  signals: RoutingSignals,
  models: TierModels = DEFAULT_TIER_MODELS,
  mode: RoutingMode = "rules",
): Route {
  const { tier, reason } = chooseTier(signals);
  const escalation = TIERS.slice(TIERS.indexOf(tier));
  if (mode === "openrouter-auto") {
    const auto: RouteStep = {
      tier,
      provider: "openrouter",
      model: "openrouter/auto",
      options: { openrouter: { cost_tier: OPENROUTER_COST_TIER[tier] } },
    };
    // Escalate to a known model: the auto router does not report what it picked.
    return { tier, reason: `${reason}; OpenRouter picks within the ${OPENROUTER_COST_TIER[tier]} cost tier`, chain: [auto, { tier: "deep", ...models.deep }] };
  }
  return { tier, reason, chain: escalation.map((t) => ({ tier: t, ...models[t] })) };
}

/** Parse "provider/model" (the model part may itself contain slashes). */
export function parseModelRef(value: string | undefined): ModelRef | null {
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function tierModelsFromEnv(env: Record<string, string | undefined>): TierModels {
  return {
    fast: parseModelRef(env.BACKBOARD_MODEL_FAST) ?? DEFAULT_TIER_MODELS.fast,
    balanced: parseModelRef(env.BACKBOARD_MODEL_BALANCED) ?? DEFAULT_TIER_MODELS.balanced,
    deep: parseModelRef(env.BACKBOARD_MODEL_DEEP) ?? DEFAULT_TIER_MODELS.deep,
  };
}
