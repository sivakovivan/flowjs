import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AnalyticsBatch,
    DailyBaselineWindow,
    exportTelemetry,
    latestBaselineWindow,
} from './analytics';
import { FlowStore } from './store';

describe('daily baseline window', () => {
    it('uses the previous complete UTC day after the five-minute ingestion grace period', () => {
        const expected = {
            from: Date.UTC(2026, 8, 19),
            to: Date.UTC(2026, 8, 20),
        };
        expect(latestBaselineWindow(Date.UTC(2026, 8, 20, 0, 5))).toEqual(
            expected
        );
        expect(latestBaselineWindow(Date.UTC(2026, 8, 20, 23, 59))).toEqual(
            expected
        );
        expect(DailyBaselineWindow.safeParse(expected).success).toBe(true);
    });

    it('does not include today or advance before the ingestion grace period', () => {
        expect(latestBaselineWindow(Date.UTC(2026, 8, 20, 0, 4, 59))).toEqual({
            from: Date.UTC(2026, 8, 18),
            to: Date.UTC(2026, 8, 19),
        });
        expect(
            DailyBaselineWindow.safeParse({ from: 1, to: 86_400_001 }).success
        ).toBe(false);
        expect(
            DailyBaselineWindow.safeParse({ from: 0, to: 172_800_000 }).success
        ).toBe(false);
    });
});

describe('analytics export', () => {
    it('exports seeded records only from an explicitly simulated installation and labels them', () => {
        const store = new FlowStore(':memory:', () => 100, {
            analytics: true,
            analyticsSampleKind: 'simulated',
        });
        store.insertEvents([
            {
                applicationId: 'app',
                versionId: 'v1',
                sessionId: 'sim-session',
                userId: 'sim-browser',
                componentId: 'date',
                capabilityId: 'dateRange',
                eventType: 'value_change',
                sinceLoadMs: 5000,
                createdAt: 100,
                seeded: true,
                metadata: {},
            },
        ]);
        const record = store.listTelemetryOutbox('app')[0];
        expect(record.payload.seeded).toBe(true);
        expect(() => exportTelemetry(store.telemetrySourceId, record)).toThrow(
            'Synthetic'
        );
        expect(
            exportTelemetry(
                store.telemetrySourceId,
                record,
                store.analyticsSampleKind
            )
        ).toMatchObject({ sampleKind: 'simulated', kind: 'event' });
        store.close();
    });

    it('refuses to relabel an existing live installation as simulated', () => {
        const directory = mkdtempSync(join(tmpdir(), 'flowjs-source-kind-'));
        const path = join(directory, 'flow.db');
        try {
            new FlowStore(path).close();
            expect(
                () =>
                    new FlowStore(path, Date.now, {
                        analytics: true,
                        analyticsSampleKind: 'simulated',
                    })
            ).toThrow('separate SQLite databases');
            const reopened = new FlowStore(path);
            expect(reopened.analyticsSampleKind).toBe('live');
            reopened.close();
        } finally {
            rmSync(directory, { recursive: true });
        }
    });

    it('exports only bounded semantic fields, never text values or arbitrary metadata', () => {
        const store = new FlowStore(':memory:', () => 100, { analytics: true });
        store.insertEvents([
            {
                applicationId: 'app',
                versionId: 'v1',
                sessionId: 'session',
                userId: 'browser',
                componentId: 'search',
                capabilityId: 'query',
                eventType: 'active_time',
                sinceLoadMs: 2000,
                seeded: false,
                createdAt: 100,
                metadata: {
                    value: 'private@example.com',
                    input: { password: 'secret' },
                    activeMs: 1500,
                    viewport: 'compact',
                    path: ['root', 'history'],
                },
            },
        ]);
        const exported = exportTelemetry(
            store.telemetrySourceId,
            store.listTelemetryOutbox('app')[0]
        );
        expect(exported.payload).toMatchObject({
            activeMs: 1500,
            path: ['root', 'history'],
            track: 'average',
        });
        expect(JSON.stringify(exported)).not.toMatch(
            /private|password|secret|metadata/
        );
        expect(AnalyticsBatch.safeParse({ records: [exported] }).success).toBe(
            true
        );
        store.close();
    });

    it('isolates installations and distinguishes personal layouts', () => {
        const store = new FlowStore(':memory:', () => 100, { analytics: true });
        const other = new FlowStore(':memory:');
        expect(store.telemetrySourceId).not.toBe(other.telemetrySourceId);
        store.insertEvents([
            {
                applicationId: 'app',
                versionId: 'p12345678',
                sessionId: 'session',
                userId: 'browser',
                componentId: 'chart',
                capabilityId: 'revenue',
                eventType: 'component_click',
                sinceLoadMs: 0,
                seeded: false,
                createdAt: 100,
                metadata: { activeMs: 100000, path: ['private search text'] },
            },
        ]);
        const exported = exportTelemetry(
            store.telemetrySourceId,
            store.listTelemetryOutbox('app')[0]
        );
        expect(exported.payload).toMatchObject({
            track: 'personal',
            activeMs: 0,
            path: [],
        });
        expect(() =>
            exportTelemetry(store.telemetrySourceId, {
                ...store.listTelemetryOutbox('app')[0],
                kind: 'event',
                payload: {
                    ...store.listEvents('app', 'p12345678')[0],
                    seeded: true,
                },
            })
        ).toThrow('Synthetic');
        store.close();
        other.close();
    });
});
