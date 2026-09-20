import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureApp } from '@flowjs/core/flow/__fixtures__/app';
import { fixtureSchema } from '@flowjs/core/flow/__fixtures__/schema';
import {
    latestBaselineWindow,
    type AnalyticsRecord,
} from '@flowjs/core/flow/analytics';
import type { FlowAIProvider } from '@flowjs/core/flow/ai/providers';
import { computeMetrics } from '@flowjs/core/flow/metrics';
import { createRuntime, RuntimeError } from '@flowjs/core/flow/runtime';
import { FlowStore, type TelemetryEvent } from '@flowjs/core/flow/store';
import { analyticsRequest } from '@flowjs/core/server/analytics';
import { readConfig } from './config';
import { openDatabase } from './database';
import { migrate } from './migrate';
import { createRepository, type AnalyticsRepository } from './repository';
import { createWorker } from './worker';

const connection = process.env.FLOW_ANALYTICS_TEST_DATABASE_URL;
const clock = Date.UTC(2026, 8, 20, 1);
const window = latestBaselineWindow(clock);
type EventRecord = Extract<AnalyticsRecord, { kind: 'event' }>;

describe.skipIf(!connection)('real Timescale database', () => {
    let pool: Pool;
    let repository: AnalyticsRepository;
    const sources = new Set<string>();

    function source() {
        const id = randomUUID();
        sources.add(id);
        return id;
    }

    function event(
        sourceId: string,
        offset = 0,
        payload: Partial<EventRecord['payload']> = {}
    ): EventRecord {
        return {
            id: randomUUID(),
            sourceId,
            applicationId: 'fixture',
            kind: 'event',
            payload: {
                versionId: 'v1',
                sessionId: 'baseline-session',
                userId: 'baseline-browser',
                componentId: 'date-range',
                capabilityId: 'dateRange',
                eventType: 'component_click',
                occurredAt: window.from + 60_000 + offset,
                sinceLoadMs: offset,
                track: 'average',
                activeMs: 0,
                path: [],
                viewport: 'wide',
                ...payload,
            },
        };
    }

    function request(sourceId: string) {
        return {
            sourceId,
            applicationId: 'fixture',
            versionId: 'v1',
            schema: fixtureSchema(),
            window,
        };
    }

    function raw(record: EventRecord): TelemetryEvent {
        const { occurredAt, ...payload } = record.payload;
        return {
            ...payload,
            applicationId: record.applicationId,
            seeded: false,
            createdAt: occurredAt,
            metadata: {},
        };
    }

    beforeAll(async () => {
        pool = openDatabase(connection!);
        await migrate(pool);
        await migrate(pool);
        repository = createRepository(pool, () => clock);
    }, 30_000);

    afterAll(async () => {
        if (!pool) return;
        for (const table of ['events', 'calls', 'receipts', 'sources'])
            await pool.query(
                `DELETE FROM flow_analytics.${table} WHERE source_id = ANY($1::uuid[])`,
                [[...sources]]
            );
        await pool.end();
    });

    it('uses real hypertables and real-time continuous aggregates', async () => {
        await repository.health();
        const tables = await pool.query(
            "SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema = 'flow_analytics'"
        );
        expect(tables.rows.map((row) => row.hypertable_name)).toEqual(
            expect.arrayContaining(['events', 'calls'])
        );
        const views = await pool.query(
            "SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates WHERE view_schema = 'flow_analytics'"
        );
        expect(views.rows).toEqual(
            expect.arrayContaining([
                { view_name: 'events_minute', materialized_only: false },
                { view_name: 'latency_minute', materialized_only: false },
            ])
        );
    });

    it('deduplicates concurrent retries even if a replay changes its timestamp', async () => {
        const sourceId = source();
        const record = event(sourceId);
        const results = await Promise.all([
            repository.ingest([record]),
            repository.ingest([record]),
        ]);
        expect(results.sort()).toEqual([0, 1]);
        expect(
            await repository.ingest([
                {
                    ...record,
                    payload: {
                        ...record.payload,
                        occurredAt: record.payload.occurredAt + 60_000,
                    },
                },
            ])
        ).toBe(0);
        const count = await pool.query(
            'SELECT count(*)::integer AS count FROM flow_analytics.events WHERE source_id = $1',
            [sourceId]
        );
        expect(count.rows[0].count).toBe(1);
    });

    it('labels simulated cohorts and refuses to relabel them as live evidence', async () => {
        const sourceId = source();
        await repository.ingest([
            { ...event(sourceId), sampleKind: 'simulated' },
        ]);
        const evidence = await repository.evidence({
            ...request(sourceId),
            sampleKind: 'simulated',
        });
        expect(evidence.sampleKind).toBe('simulated');
        expect(evidence.metrics.sessions).toEqual({
            total: 1,
            live: 0,
            seeded: 1,
        });
        await expect(repository.evidence(request(sourceId))).rejects.toThrow(
            'provenance'
        );
        await expect(repository.ingest([event(sourceId, 100)])).rejects.toThrow(
            'provenance'
        );
        const count = await pool.query(
            'SELECT count(*)::integer AS count FROM flow_analytics.events WHERE source_id=$1',
            [sourceId]
        );
        expect(count.rows[0].count).toBe(1);
    });

    it('matches baseline metrics while separating personal preferences and excluding today', async () => {
        const sourceId = source();
        const baseline = [
            event(sourceId, 1000, { eventType: 'component_view' }),
            event(sourceId, 6000),
            event(sourceId, 6500),
            event(sourceId, 7000, {
                componentId: 'revenue-chart',
                capabilityId: 'revenue',
            }),
            event(sourceId, 8000, { eventType: 'active_time', activeMs: 5000 }),
        ];
        const personal = event(sourceId, 9000, {
            versionId: 'p12345678',
            track: 'personal',
            sessionId: 'personal-session',
            userId: 'personal-browser',
        });
        const today = event(sourceId, 0, {
            occurredAt: window.to + 60_000,
            sessionId: 'today',
            userId: 'today',
        });
        const passive = event(sourceId, 500, {
            sessionId: 'passive',
            userId: 'passive',
            eventType: 'component_view',
            versionId: 'p87654321',
            track: 'personal',
        });
        const navigation = event(sourceId, 600, {
            componentId: '__navigation__',
            capabilityId: '__navigation__',
            versionId: 'p12345678',
            track: 'personal',
            eventType: 'active_time',
            activeMs: 1000,
            path: ['controls', 'history'],
            sessionId: 'personal-session',
            userId: 'personal-browser',
        });
        const calls: AnalyticsRecord[] = [1000, 4000].map((latencyMs) => ({
            id: randomUUID(),
            sourceId,
            applicationId: 'fixture',
            kind: 'call',
            payload: {
                versionId: 'v1',
                sessionId: 'baseline-session',
                componentId: 'date-range',
                capabilityId: 'dateRange',
                kind: 'data',
                latencyMs,
                ok: true,
                traceId: null,
                occurredAt: window.from + 68_000,
            },
        }));
        await repository.ingest([
            ...baseline,
            personal,
            today,
            passive,
            navigation,
            ...calls,
        ]);
        const evidence = await repository.evidence(request(sourceId));
        const expected = computeMetrics({
            versionId: 'v1',
            schema: fixtureSchema(),
            events: baseline.map(raw),
            calls: [],
        });
        expect(evidence.window).toEqual(window);
        expect(evidence.metrics.sessions).toEqual(expected.sessions);
        expect(evidence.metrics.totalInteractions).toBe(
            expected.totalInteractions
        );
        expect(
            evidence.metrics.components.map((component) => ({
                ...component,
                retryLatencyMs: null,
            }))
        ).toEqual(expected.components);
        expect(evidence.population).toEqual({
            users: 2,
            sessions: 2,
            interactions: 4,
        });
        expect(
            evidence.capabilityUsage.find(
                (usage) => usage.capabilityId === 'dateRange'
            )?.activeMs
        ).toBe(5000);
        expect(evidence.navigation).toContainEqual({
            path: ['controls', 'history'],
            opens: 0,
            selections: 0,
            dismissals: 0,
            activeMs: 1000,
            users: 1,
            sessions: 1,
        });
        expect(
            evidence.engagement.find(
                (component) => component.componentId === 'date-range'
            )
        ).toMatchObject({ activeMs: 5000, usageAmongExposed: 1 });
        expect(evidence.metrics.latency[0]).toMatchObject({
            calls: 2,
            slowTail: true,
        });
        expect(evidence.metrics.latency[0].p95Ms).toBeGreaterThan(3900);
        expect(evidence.metrics.latency[0].p95Ms).toBeLessThan(4100);
    }, 20_000);

    it('refreshes late deliveries to a completed bucket before taking daily evidence', async () => {
        const sourceId = source();
        await repository.ingest([event(sourceId, 100)]);
        expect(
            (await repository.evidence(request(sourceId))).metrics
                .totalInteractions
        ).toBe(1);
        await repository.ingest([event(sourceId, 200)]);
        expect(
            (await repository.evidence(request(sourceId))).metrics
                .totalInteractions
        ).toBe(2);
    }, 20_000);

    it('delivers the app outbox into Tiger and publishes exactly one next baseline', async () => {
        const app = fixtureApp();
        const store = new FlowStore(':memory:', () => clock, {
            analytics: true,
        });
        sources.add(store.telemetrySourceId);
        const provider: FlowAIProvider = {
            source: 'recorded',
            model: 'integration-test-fixture',
            generateSchema: async () => {
                throw new Error('unused');
            },
            generatePersonalSchema: async () => {
                throw new Error('unused');
            },
            proposeOptimization: async () => ({
                finding: 'Frequently used date filter',
                classification: 'ui',
                evidence: ['Six distinct test browser identities'],
                confidence: 0.95,
                expectedBenefit: 0.8,
                reason: 'Promote date selection',
                explanation:
                    'A one-click date selection saves repeated navigation.',
                mutations: [
                    {
                        type: 'SWAP_VARIANT',
                        element: 'date-range',
                        target: null,
                        position: null,
                        index: null,
                        size: null,
                        variant: 'segmented-control',
                    },
                ],
            }),
        };
        const runtime = createRuntime({
            app,
            store,
            live: null,
            recorded: provider,
            forceRecorded: true,
            dailyBaseline: true,
            now: () => clock,
        });
        store.createVersion({
            applicationId: app.id,
            parentVersionId: null,
            schema: fixtureSchema(),
            mutations: [],
            reason: 'Integration fixture',
            source: 'generated',
            aiSource: 'recorded',
            cause: 'generate',
        });
        runtime.setMutationRate(1);
        for (let browser = 0; browser < 6; browser++) {
            for (let interaction = 0; interaction < 4; interaction++)
                store.insertEvents([
                    raw(
                        event(
                            store.telemetrySourceId,
                            1000 + interaction * 100,
                            {
                                sessionId: `session-${browser}`,
                                userId: `browser-${browser}`,
                            }
                        )
                    ),
                ]);
        }
        const token = 'integration-test-token-with-32-characters';
        const fetcher: typeof fetch = async (input, init) => {
            try {
                return Response.json(
                    await analyticsRequest(
                        new Request(input, init),
                        runtime,
                        token,
                        clock
                    )
                );
            } catch (error) {
                return Response.json(
                    { error: String(error) },
                    {
                        status:
                            error instanceof RuntimeError ? error.status : 500,
                    }
                );
            }
        };
        const worker = createWorker({
            config: readConfig({ FLOW_ANALYTICS_TOKEN: token }),
            repository,
            fetch: fetcher,
            now: () => clock,
            log: () => {},
        });
        try {
            await worker.tick();
            expect(store.listTelemetryOutbox(app.id)).toEqual([]);
            expect(store.getBaselineJob(app.id, window.to)?.status).toBe(
                'applied'
            );
            expect(store.getActiveVersion(app.id)).toMatchObject({
                id: 'v2',
                aiSource: 'recorded',
            });
            await worker.tick();
            expect(store.listVersions(app.id)).toHaveLength(2);
        } finally {
            store.close();
        }
    }, 20_000);
});
