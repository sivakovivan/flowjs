import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fixtureSchema } from '@flowjs/core/flow/__fixtures__/schema';
import {
    latestBaselineWindow,
    type AnalyticsFeed,
    type AggregateEvidence,
} from '@flowjs/core/flow/analytics';
import { readConfig } from './config';
import type { AnalyticsRepository } from './repository';
import { createWorker } from './worker';

const now = Date.UTC(2026, 8, 20, 1);
const config = readConfig({
    FLOW_ANALYTICS_TOKEN: 'test-analytics-token-with-32-characters',
});
function feed(): AnalyticsFeed {
    const sourceId = randomUUID();
    return {
        records: [
            {
                id: randomUUID(),
                sourceId,
                applicationId: 'fixture',
                kind: 'event',
                payload: {
                    versionId: 'v1',
                    sessionId: 'session',
                    userId: 'browser',
                    componentId: 'date-range',
                    capabilityId: 'dateRange',
                    eventType: 'component_click',
                    occurredAt: now - 86_400_000,
                    sinceLoadMs: 100,
                    track: 'average',
                    activeMs: 0,
                    path: [],
                    viewport: 'wide',
                },
            },
        ],
        request: {
            sourceId,
            applicationId: 'fixture',
            versionId: 'v1',
            schema: fixtureSchema(),
            window: latestBaselineWindow(now),
        },
        job: null,
    };
}

describe('delivery and daily worker', () => {
    it('never acknowledges or generates a baseline when Tiger ingestion fails', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json(feed()));
        const repository = {
            health: vi.fn(),
            ingest: vi.fn().mockRejectedValue(new Error('offline')),
            evidence: vi.fn(),
        } satisfies AnalyticsRepository;
        const worker = createWorker({
            config,
            repository,
            fetch: fetcher,
            now: () => now,
            log: vi.fn(),
        });
        await expect(worker.tick()).rejects.toThrow('offline');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(repository.evidence).not.toHaveBeenCalled();
    });

    it('acknowledges committed deliveries before asking for the closed-day baseline', async () => {
        const input = feed();
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(input))
            .mockResolvedValueOnce(Response.json({ acknowledged: 1 }))
            .mockResolvedValueOnce(
                Response.json({ status: 'applied', attempts: 1, leaseUntil: 0 })
            );
        const evidence = {
            population: { users: 6, interactions: 30 },
        } as AggregateEvidence;
        const repository = {
            health: vi.fn(),
            ingest: vi.fn().mockResolvedValue(1),
            evidence: vi.fn().mockResolvedValue(evidence),
        } satisfies AnalyticsRepository;
        await createWorker({
            config,
            repository,
            fetch: fetcher,
            now: () => now,
            log: vi.fn(),
        }).tick();
        expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).action).toBe(
            'ack'
        );
        expect(repository.evidence).toHaveBeenCalledWith(input.request);
        expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).action).toBe(
            'baseline'
        );
    });

    it('re-fetches the current baseline and recomputes evidence after a failed publication', async () => {
        const original = feed();
        original.records = [];
        const updated = structuredClone(original);
        updated.request!.versionId = 'v2';
        updated.job = { status: 'failed', attempts: 1, leaseUntil: now - 1 };
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(original))
            .mockResolvedValueOnce(new Response(null, { status: 409 }))
            .mockResolvedValueOnce(Response.json(updated))
            .mockResolvedValueOnce(
                Response.json({
                    status: 'unchanged',
                    attempts: 2,
                    leaseUntil: 0,
                })
            );
        const repository = {
            health: vi.fn(),
            ingest: vi.fn(),
            evidence: vi.fn().mockResolvedValue({
                population: { users: 6, interactions: 30 },
            }),
        } satisfies AnalyticsRepository;
        const worker = createWorker({
            config,
            repository,
            fetch: fetcher,
            now: () => now,
            log: vi.fn(),
        });
        await expect(worker.tick()).rejects.toThrow('409');
        await worker.tick();
        expect(
            repository.evidence.mock.calls.map(([request]) => request.versionId)
        ).toEqual(['v1', 'v2']);
    });

    it.each([
        'applied',
        'unchanged',
        'insufficient-data',
        'pending',
        'rejected',
    ] as const)(
        'keeps ingesting but does not regenerate a day marked %s',
        async (status) => {
            const input = feed();
            input.job = { status, attempts: 1, leaseUntil: 0 };
            const fetcher = vi
                .fn<typeof fetch>()
                .mockResolvedValueOnce(Response.json(input))
                .mockResolvedValueOnce(Response.json({ acknowledged: 1 }));
            const repository = {
                health: vi.fn(),
                ingest: vi.fn().mockResolvedValue(1),
                evidence: vi.fn(),
            } satisfies AnalyticsRepository;
            await createWorker({
                config,
                repository,
                fetch: fetcher,
                now: () => now,
            }).tick();
            expect(repository.ingest).toHaveBeenCalledOnce();
            expect(repository.evidence).not.toHaveBeenCalled();
        }
    );
});
