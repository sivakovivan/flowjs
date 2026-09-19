import { describe, expect, it } from 'vitest';
import { toUISchema } from '@flowjs/core/flow/ai/contracts';
import { salesRecording } from '@/demo/recordings';
import { salesApp } from '@/demo/sales-app';
import { findFriction } from '@flowjs/core/flow/friction';
import { computeMetrics } from '@flowjs/core/flow/metrics';
import { seedSessions } from '@flowjs/core/flow/seed';

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
