import { describe, expect, it } from 'vitest';
import { acceptanceThreshold, decideAutoApply, scoreProposal } from './scoring';

describe('acceptanceThreshold', () => {
    it('disables automatic mutation at rate 0', () => {
        expect(acceptanceThreshold(0)).toBeNull();
    });

    it('lowers the threshold as the rate rises', () => {
        expect(acceptanceThreshold(0.2)).toBe(0.76);
        expect(acceptanceThreshold(0.5)).toBe(0.55);
        expect(acceptanceThreshold(0.8)).toBe(0.34);
        expect(acceptanceThreshold(1)).toBe(0.2);
    });

    it('rejects rates outside 0..1', () => {
        expect(() => acceptanceThreshold(-0.01)).toThrow(RangeError);
        expect(() => acceptanceThreshold(1.01)).toThrow(RangeError);
        expect(() => acceptanceThreshold(Number.NaN)).toThrow(RangeError);
    });
});

describe('decideAutoApply', () => {
    it('never auto-applies at rate 0, even for a perfect score', () => {
        expect(decideAutoApply(1, 0)).toEqual({
            autoApply: false,
            threshold: null,
        });
    });

    it('accepts a score exactly at the threshold', () => {
        expect(decideAutoApply(0.55, 0.5).autoApply).toBe(true);
        expect(decideAutoApply(0.549, 0.5).autoApply).toBe(false);
    });

    it('accepts marginal proposals only at high rates', () => {
        expect(decideAutoApply(0.3, 0.2).autoApply).toBe(false);
        expect(decideAutoApply(0.3, 1).autoApply).toBe(true);
    });
});

describe('scoreProposal', () => {
    const base = {
        expectedBenefit: 0.3,
        confidence: 0.8,
        sessions: 3,
        interactions: 30,
        mutations: [
            {
                type: 'MOVE',
                element: 'a',
                target: 'b',
                position: 'before',
            } as const,
        ],
        recentVersions: 0,
    };

    it('combines benefit, confidence and evidence minus disruption', () => {
        expect(scoreProposal(base)).toEqual({
            score: 0.635, // 0.105 + 0.28 + 0.3 - 0.05
            benefit: 0.3,
            confidence: 0.8,
            evidence: 1,
            disruption: 0.05,
        });
    });

    it('discounts thin evidence', () => {
        expect(
            scoreProposal({ ...base, sessions: 1, interactions: 10 }).evidence
        ).toBe(0.333);
    });

    it('penalizes recent instability and caps disruption', () => {
        expect(scoreProposal({ ...base, recentVersions: 2 }).disruption).toBe(
            0.15
        );
        expect(scoreProposal({ ...base, recentVersions: 50 }).disruption).toBe(
            0.5
        );
    });

    it('clamps out-of-range model outputs', () => {
        const score = scoreProposal({
            ...base,
            expectedBenefit: 7,
            confidence: -1,
        });
        expect(score.benefit).toBe(1);
        expect(score.confidence).toBe(0);
    });
});
