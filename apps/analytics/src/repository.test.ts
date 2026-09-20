import { describe, expect, it } from 'vitest';
import { deriveInsights } from './repository';

describe('aggregate insights', () => {
    it('distinguishes cross-layout preferences from positional evidence and backend delays', () => {
        const insights = deriveInsights({
            population: { users: 6, sessions: 12, interactions: 100 },
            capabilityUsage: [
                {
                    capabilityId: 'exportReport',
                    users: 6,
                    sessions: 12,
                    interactions: 100,
                    activeMs: 0,
                },
            ],
            navigation: [
                {
                    path: ['root', 'history'],
                    opens: 10,
                    selections: 3,
                    dismissals: 7,
                    activeMs: 0,
                    users: 6,
                    sessions: 10,
                },
            ],
            metrics: {
                versionId: 'v1',
                sessions: { total: 0, live: 0, seeded: 0 },
                totalInteractions: 0,
                components: [],
                transitions: [],
                latency: [
                    {
                        capabilityId: 'exportReport',
                        kind: 'action',
                        calls: 12,
                        p50Ms: 1900,
                        p95Ms: 4000,
                        errorRate: 0,
                        slow: true,
                        slowTail: true,
                        traceIds: [],
                        replayIds: [],
                    },
                ],
            },
        });
        expect(insights.map((insight) => insight.kind)).toEqual([
            'performance',
            'engagement',
            'navigation',
        ]);
        expect(insights[1].summary).toContain(
            'not evidence about the current position'
        );
        expect(insights[2].componentIds).toEqual([]);
    });
});
