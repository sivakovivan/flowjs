import type { Mutation, MutationType } from "./mutations";

/*
 * Conceptual mutation score: benefit + confidence + evidence − disruption.
 * The application's mutation rate moves the acceptance threshold.
 */

/** How disruptive each mutation type is for someone who already knows the layout. */
export const DISRUPTION: Record<MutationType, number> = {
  RESIZE: 0.03,
  REORDER: 0.04,
  MOVE: 0.05,
  SHOW: 0.02,
  SWAP_VARIANT: 0.06,
  HIDE: 0.1,
};

/** Each version created recently adds instability. */
export const RECENT_VERSION_PENALTY = 0.05;
export const MAX_DISRUPTION = 0.5;

/** Evidence saturates at this many sessions / interactions. */
export const EVIDENCE_SESSIONS = 3;
export const EVIDENCE_INTERACTIONS = 30;

export const WEIGHTS = { benefit: 0.35, confidence: 0.35, evidence: 0.3 } as const;

export interface ScoreInput {
  expectedBenefit: number;
  confidence: number;
  sessions: number;
  interactions: number;
  mutations: Mutation[];
  /** Versions activated during the recent-instability window. */
  recentVersions: number;
}

export interface MutationScore {
  score: number;
  benefit: number;
  confidence: number;
  evidence: number;
  disruption: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const round = (value: number) => Math.round(value * 1000) / 1000;

export function scoreProposal(input: ScoreInput): MutationScore {
  const benefit = clamp01(input.expectedBenefit);
  const confidence = clamp01(input.confidence);
  const evidence =
    0.5 * clamp01(input.sessions / EVIDENCE_SESSIONS) + 0.5 * clamp01(input.interactions / EVIDENCE_INTERACTIONS);
  const disruption = Math.min(
    MAX_DISRUPTION,
    input.mutations.reduce((sum, m) => sum + DISRUPTION[m.type], 0) +
      RECENT_VERSION_PENALTY * Math.max(0, input.recentVersions),
  );
  const score =
    WEIGHTS.benefit * benefit + WEIGHTS.confidence * confidence + WEIGHTS.evidence * evidence - disruption;
  return {
    score: round(score),
    benefit: round(benefit),
    confidence: round(confidence),
    evidence: round(evidence),
    disruption: round(disruption),
  };
}

export function assertMutationRate(rate: number): void {
  if (!(typeof rate === "number" && rate >= 0 && rate <= 1)) {
    throw new RangeError(`mutationRate must be between 0 and 1 (received ${rate}).`);
  }
}

/**
 * Minimum score for automatic application. `null` means automatic mutation is
 * disabled (rate 0). Rate 1 accepts anything scoring at least 0.2.
 */
export function acceptanceThreshold(rate: number): number | null {
  assertMutationRate(rate);
  if (rate === 0) return null;
  return round(0.9 - 0.7 * rate);
}

export interface AutoDecision {
  autoApply: boolean;
  threshold: number | null;
}

export function decideAutoApply(score: number, rate: number): AutoDecision {
  const threshold = acceptanceThreshold(rate);
  return { autoApply: threshold !== null && score >= threshold, threshold };
}
