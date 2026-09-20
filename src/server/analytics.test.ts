import { afterEach, describe, expect, it } from 'vitest';
import { fixtureApp } from '../flow/__fixtures__/app';
import { fixtureSchema } from '../flow/__fixtures__/schema';
import { AnalyticsFeed } from '../flow/analytics';
import { createRecordedProvider } from '../flow/ai/providers';
import { createRuntime } from '../flow/runtime';
import { FlowStore } from '../flow/store';
import { analyticsRequest, validAnalyticsToken } from './analytics';

const token = 'test-analytics-token-with-32-characters';
const stores: FlowStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
});

function setup(dailyBaseline = true) {
    const app = fixtureApp();
    const store = new FlowStore(':memory:', Date.now, { analytics: true });
    stores.push(store);
    const runtime = createRuntime({
        app,
        store,
        live: null,
        recorded: createRecordedProvider(app, undefined),
        dailyBaseline,
    });
    store.createVersion({
        applicationId: app.id,
        parentVersionId: null,
        schema: fixtureSchema(),
        mutations: [],
        reason: 'Test baseline',
        source: 'generated',
        aiSource: 'recorded',
        cause: 'generate',
    });
    return runtime;
}

describe('analytics service boundary', () => {
    it('requires a long server-side bearer token and explicit daily mode', async () => {
        const runtime = setup();
        expect(validAnalyticsToken(`Bearer ${token}`, token)).toBe(true);
        expect(validAnalyticsToken('Bearer short', 'short')).toBe(false);
        expect(validAnalyticsToken(`Bearer ${token}x`, token)).toBe(false);
        await expect(
            analyticsRequest(
                new Request('http://localhost/api'),
                runtime,
                token
            )
        ).rejects.toMatchObject({ status: 401 });
        await expect(
            analyticsRequest(
                new Request('http://localhost/api', {
                    headers: { authorization: `Bearer ${token}` },
                }),
                setup(false),
                token
            )
        ).rejects.toMatchObject({ status: 503 });
    });

    it('exports an allowlisted outbox without deleting records until acknowledgement', async () => {
        const runtime = setup();
        runtime.recordTelemetry([
            {
                versionId: 'v1',
                sessionId: 'session',
                userId: 'browser',
                componentId: 'date-range',
                eventType: 'value_change',
                sinceLoadMs: 10,
                timestamp: Date.now(),
                metadata: { value: 'private text' },
            },
        ]);
        const headers = { authorization: `Bearer ${token}` };
        const feed = AnalyticsFeed.parse(
            await analyticsRequest(
                new Request('http://localhost/api', { headers }),
                runtime,
                token
            )
        );
        expect(feed.request?.versionId).toBe('v1');
        expect(feed.records).toHaveLength(1);
        expect(JSON.stringify(feed)).not.toContain('private text');
        expect(runtime.store.listTelemetryOutbox(runtime.app.id)).toHaveLength(
            1
        );
        await analyticsRequest(
            new Request('http://localhost/api', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    action: 'ack',
                    ids: [feed.records[0].id],
                }),
            }),
            runtime,
            token
        );
        expect(runtime.store.listTelemetryOutbox(runtime.app.id)).toEqual([]);
    });
});
