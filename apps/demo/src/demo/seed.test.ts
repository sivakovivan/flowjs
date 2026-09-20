import { describe, expect, it } from 'vitest';
import { toUISchema } from '@flowjs/core/flow/ai/contracts';
import { salesRecording } from '@/demo/recordings';
import { salesApp } from '@/demo/sales-app';
import { findFriction } from '@flowjs/core/flow/friction';
import { computeMetrics } from '@flowjs/core/flow/metrics';
import { seedAggregateCohort, seedSessions } from '@flowjs/core/flow/seed';

describe('seedSessions', () => {
    const schema = toUISchema(salesRecording.generation);
    const seeded = seedSessions({
        app: salesApp,
        schema,
        versionId: 'v1',
        count: 6,
        now: 1_000_000_000,
        seed: 42,
    });

    it('flags every seeded event and call', () => {
        expect(seeded.events.length).toBeGreaterThan(0);
        expect(
            seeded.events.every(
                (e) => e.seeded && e.sessionId.startsWith('seeded-')
            )
        ).toBe(true);
        expect(seeded.calls.every((c) => c.seeded)).toBe(true);
    });

    it('only references components in the schema', () => {
        const ids = new Set(schema.components.map((c) => c.id));
        expect(seeded.events.every((e) => ids.has(e.componentId))).toBe(true);
    });

    it('produces the buried date-range friction on the recorded v1', () => {
        const metrics = computeMetrics({
            versionId: 'v1',
            schema,
            events: seeded.events,
            calls: seeded.calls,
        });
        expect(metrics.sessions).toMatchObject({
            total: 6,
            seeded: 6,
            live: 0,
        });
        const findings = findFriction({ app: salesApp, schema, metrics });
        expect(
            findings.some(
                (f) =>
                    f.kind === 'buried-control' &&
                    f.componentIds[0] === 'date-range'
            )
        ).toBe(true);
    });
});

describe('aggregate demo cohort', () => {
    const schema = toUISchema(salesRecording.generation);
    const window = { from: Date.UTC(2026, 8, 19), to: Date.UTC(2026, 8, 20) };
    const cohort = seedAggregateCohort({
        app: salesApp,
        schema,
        versionId: 'v1',
        window,
    });

    it('represents twelve simulated browsers across twenty-four sessions within yesterday', () => {
        expect(new Set(cohort.events.map((event) => event.userId)).size).toBe(
            12
        );
        expect(
            new Set(cohort.events.map((event) => event.sessionId)).size
        ).toBe(24);
        expect(
            cohort.events.every(
                (event) =>
                    event.seeded &&
                    event.createdAt >= window.from &&
                    event.createdAt < window.to
            )
        ).toBe(true);
        expect(
            cohort.calls.every(
                (call) =>
                    call.seeded &&
                    call.createdAt >= window.from &&
                    call.createdAt < window.to
            )
        ).toBe(true);
    });

    it('uses real semantic signals and produces aggregate friction without inventing computed metrics', () => {
        const metrics = computeMetrics({
            schema,
            versionId: 'v1',
            events: cohort.events,
            calls: cohort.calls,
        });
        expect(metrics.totalInteractions).toBeGreaterThan(100);
        expect(metrics.sessions).toEqual({ total: 24, live: 0, seeded: 24 });
        expect(
            cohort.events.some(
                (event) =>
                    event.eventType === 'active_time' &&
                    event.metadata.activeMs === 2500
            )
        ).toBe(true);
        expect(
            cohort.events.some(
                (event) =>
                    event.eventType === 'menu_close' &&
                    event.metadata.path?.toString() === 'controls,history'
            )
        ).toBe(true);
        expect(
            findFriction({ app: salesApp, schema, metrics }).some(
                (finding) => finding.kind === 'buried-control'
            )
        ).toBe(true);
        expect(
            seedAggregateCohort({
                app: salesApp,
                schema,
                versionId: 'v1',
                window,
            })
        ).toEqual(cohort);
    });
});
