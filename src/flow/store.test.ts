import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureApp } from './__fixtures__/app';
import { fixtureSchema } from './__fixtures__/schema';
import { FlowStore, VersionError } from './store';

const app = fixtureApp();
let store: FlowStore;

function version(parentVersionId: string | null, reason: string) {
    return store.createVersion({
        applicationId: app.id,
        parentVersionId,
        schema: fixtureSchema(),
        mutations: [],
        reason,
        source: parentVersionId ? 'optimization' : 'generated',
        aiSource: 'recorded',
        cause: parentVersionId ? 'optimize' : 'generate',
    });
}

beforeEach(() => {
    store = new FlowStore(':memory:');
    store.syncApplication(app);
});

describe('applications', () => {
    it('persists the application, its capabilities and mutation rate', () => {
        expect(store.getApplication(app.id)).toMatchObject({
            id: 'fixture',
            mutationRate: 0.5,
            activeVersionId: null,
        });
        const { count } = store.db
            .prepare('SELECT COUNT(*) AS count FROM capabilities')
            .get() as { count: number };
        expect(count).toBe(app.capabilities.length);
    });

    it('keeps a changed mutation rate across re-registration', () => {
        store.setMutationRate(app.id, 0.9);
        store.syncApplication(app);
        expect(store.getApplication(app.id)?.mutationRate).toBe(0.9);
    });

    it('rejects mutation rates outside 0..1', () => {
        expect(() => store.setMutationRate(app.id, 1.2)).toThrow(RangeError);
    });
});

describe('versions', () => {
    it('creates and activates numbered versions atomically', () => {
        const v1 = version(null, 'Generated dashboard');
        const v2 = version('v1', 'Date control promoted');
        expect([v1.id, v2.id]).toEqual(['v1', 'v2']);
        expect(v2.parentVersionId).toBe('v1');
        expect(store.getActiveVersion(app.id)?.id).toBe('v2');
    });

    it('undo activates the parent without deleting history', () => {
        version(null, 'Generated dashboard');
        version('v1', 'Date control promoted');
        expect(store.undo(app.id).id).toBe('v1');
        expect(store.getActiveVersion(app.id)?.id).toBe('v1');
        expect(store.listVersions(app.id).map((v) => v.id)).toEqual([
            'v2',
            'v1',
        ]);
    });

    it('branches a later optimization from the active version', () => {
        version(null, 'Generated dashboard');
        version('v1', 'Date control promoted');
        store.undo(app.id);
        const v3 = version(
            store.getActiveVersion(app.id)!.id,
            'Transactions compacted'
        );
        expect(v3).toMatchObject({ id: 'v3', parentVersionId: 'v1' });
        // v2 remains restorable.
        expect(store.activateVersion(app.id, 'v2', 'restore').id).toBe('v2');
    });

    it('refuses to undo past the root', () => {
        version(null, 'Generated dashboard');
        expect(() => store.undo(app.id)).toThrow(VersionError);
        expect(() => store.activateVersion(app.id, 'v9', 'restore')).toThrow(
            /does not exist/
        );
    });

    it('keeps versions immutable', () => {
        version(null, 'Generated dashboard');
        expect(() =>
            store.db.prepare("UPDATE ui_versions SET reason = 'edited'").run()
        ).toThrow(/immutable/);
        expect(() => store.db.prepare('DELETE FROM ui_versions').run()).toThrow(
            /immutable/
        );
    });

    it('rolls back the version when activation fails', () => {
        expect(() => version('v7', 'Orphan')).toThrow(VersionError);
        expect(store.listVersions(app.id)).toEqual([]);
        expect(store.getApplication(app.id)?.activeVersionId).toBeNull();
    });

    it('counts recent non-generation activations', () => {
        version(null, 'Generated dashboard');
        version('v1', 'Date control promoted');
        store.undo(app.id);
        expect(store.countRecentActivations(app.id, 0)).toBe(2);
    });
});

describe('telemetry', () => {
    it('deduplicates retries and acknowledges only exported records', () => {
        const exporting = new FlowStore(':memory:', () => 100, {
            analytics: true,
        });
        const event = {
            eventId: 'one-event',
            applicationId: app.id,
            versionId: 'v1',
            sessionId: 'session',
            userId: 'user',
            componentId: 'date-range',
            capabilityId: 'dateRange',
            eventType: 'value_change' as const,
            sinceLoadMs: 1200,
            metadata: {},
            seeded: false,
            createdAt: 1,
        };
        expect(exporting.insertEvents([event, event])).toBe(1);
        expect(exporting.insertEvents([event])).toBe(0);
        expect(exporting.listEvents(app.id, 'v1')).toHaveLength(1);
        const pending = exporting.listTelemetryOutbox(app.id);
        expect(pending).toHaveLength(1);
        expect(exporting.listTelemetryOutbox(app.id)).toEqual(pending);
        exporting.acknowledgeTelemetryOutbox('other-app', [pending[0].id]);
        expect(exporting.listTelemetryOutbox(app.id)).toHaveLength(1);
        exporting.acknowledgeTelemetryOutbox(app.id, [pending[0].id]);
        expect(exporting.listTelemetryOutbox(app.id)).toEqual([]);
        expect(exporting.insertEvents([event])).toBe(0);
        exporting.close();
    });

    it('rolls back events and receipts when outbox persistence fails', () => {
        const exporting = new FlowStore(':memory:', () => 100, {
            analytics: true,
        });
        exporting.db
            .exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON telemetry_outbox
            BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;`);
        const event = {
            eventId: 'retry-after-rollback',
            applicationId: app.id,
            versionId: 'v1',
            sessionId: 'session',
            userId: null,
            componentId: 'date-range',
            capabilityId: 'dateRange',
            eventType: 'component_click' as const,
            sinceLoadMs: 10,
            metadata: {},
            seeded: false,
            createdAt: 1,
        };
        expect(() => exporting.insertEvents([event])).toThrow(
            'outbox unavailable'
        );
        expect(exporting.listEvents(app.id, 'v1')).toEqual([]);
        exporting.db.exec('DROP TRIGGER reject_outbox');
        expect(exporting.insertEvents([event])).toBe(1);
        expect(exporting.listTelemetryOutbox(app.id)).toHaveLength(1);
        exporting.close();
    });

    it('exports live backend calls but never synthetic evidence', () => {
        const exporting = new FlowStore(':memory:', () => 100, {
            analytics: true,
        });
        const call = {
            applicationId: app.id,
            versionId: 'v1',
            sessionId: 'session',
            componentId: 'export',
            capabilityId: 'exportReport',
            kind: 'action' as const,
            latencyMs: 1500,
            ok: true,
            error: null,
            traceId: null,
            replayId: null,
            seeded: false,
            createdAt: 1,
        };
        exporting.insertCall(call);
        exporting.insertCall({ ...call, seeded: true });
        expect(exporting.listTelemetryOutbox(app.id)).toMatchObject([
            { kind: 'call', payload: { latencyMs: 1500, seeded: false } },
        ]);
        expect(exporting.listCalls(app.id)).toHaveLength(2);
        exporting.close();
    });

    it('stores events per version and clears only seeded data', () => {
        version(null, 'Generated dashboard');
        const base = {
            applicationId: app.id,
            versionId: 'v1',
            userId: null,
            componentId: 'date-range',
            capabilityId: 'dateRange',
            eventType: 'value_change' as const,
            sinceLoadMs: 1200,
            metadata: { value: '7d' },
            createdAt: 1,
        };
        store.insertEvents([
            { ...base, sessionId: 'live', seeded: false },
            { ...base, sessionId: 'seed', seeded: true },
        ]);
        expect(store.listEvents(app.id, 'v1')).toHaveLength(2);
        store.clearSeeded(app.id);
        expect(store.listEvents(app.id, 'v1').map((e) => e.sessionId)).toEqual([
            'live',
        ]);
    });
});

describe('daily baseline jobs', () => {
    it('allows only one worker and never reclaims a completed day', () => {
        const token = store.claimBaselineJob(app.id, 86_400_000, 'v1')!;
        expect(store.claimBaselineJob(app.id, 86_400_000, 'v1')).toBeNull();
        store.finishBaselineJob(app.id, 86_400_000, token, {
            status: 'unchanged',
            runId: null,
            versionId: 'v1',
            reasons: [],
        });
        expect(store.getBaselineJob(app.id, 86_400_000)).toMatchObject({
            status: 'unchanged',
            attempts: 1,
        });
        expect(store.claimBaselineJob(app.id, 86_400_000, 'v2')).toBeNull();
        expect(
            store.claimBaselineJob(app.id, 172_800_000, 'v2')
        ).not.toBeNull();
    });

    it('recovers an expired lease without allowing the old worker to finish', () => {
        let now = 100;
        const jobs = new FlowStore(':memory:', () => now);
        jobs.syncApplication(app);
        const original = jobs.claimBaselineJob(app.id, 86_400_000, 'v1')!;
        now += 15 * 60_000;
        const replacement = jobs.claimBaselineJob(app.id, 86_400_000, 'v1')!;
        const result = {
            status: 'unchanged' as const,
            runId: null,
            versionId: 'v1',
            reasons: [],
        };
        expect(replacement).not.toBe(original);
        expect(() =>
            jobs.finishBaselineJob(app.id, 86_400_000, original, result)
        ).toThrow(/lease/);
        jobs.finishBaselineJob(app.id, 86_400_000, replacement, result);
        expect(jobs.getBaselineJob(app.id, 86_400_000)?.attempts).toBe(2);
        jobs.close();
    });

    it('rolls back both activation and completion when publication fails', () => {
        version(null, 'Original');
        const token = store.claimBaselineJob(app.id, 86_400_000, 'v1')!;
        expect(() =>
            store.transaction(() => {
                version('v1', 'Daily baseline');
                store.finishBaselineJob(app.id, 86_400_000, token, {
                    status: 'applied',
                    runId: null,
                    versionId: 'v2',
                    reasons: [],
                });
                throw new Error('interrupted');
            })
        ).toThrow('interrupted');
        expect(store.getActiveVersion(app.id)?.id).toBe('v1');
        expect(store.getBaselineJob(app.id, 86_400_000)?.status).toBe(
            'running'
        );
    });
});
