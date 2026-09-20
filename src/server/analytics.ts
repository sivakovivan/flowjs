import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
    AggregateEvidence,
    exportTelemetry,
    latestBaselineWindow,
} from '../flow/analytics';
import { RuntimeError, type FlowRuntime } from '../flow/runtime';

export function validAnalyticsToken(
    authorization: string | null | undefined,
    token: string | undefined
): boolean {
    if (!token || token.length < 32 || !authorization) return false;
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(authorization);
    return (
        expected.length === supplied.length &&
        timingSafeEqual(expected, supplied)
    );
}

const Command = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('ack'),
        ids: z.array(z.string().uuid()).min(1).max(500),
    }),
    z.object({ action: z.literal('baseline'), evidence: AggregateEvidence }),
]);

export async function analyticsRequest(
    request: Request,
    runtime: FlowRuntime,
    token: string | undefined,
    now = Date.now()
) {
    if (!validAnalyticsToken(request.headers.get('authorization'), token))
        throw new RuntimeError(
            'Analytics service authentication required.',
            401
        );
    if (runtime.state().baselineMode !== 'daily')
        throw new RuntimeError(
            'Daily analytics is not enabled for this application.',
            503
        );
    const applicationId = runtime.app.id;
    if (request.method === 'GET') {
        const version = runtime.store.getActiveVersion(applicationId);
        const window = latestBaselineWindow(now);
        return {
            records: runtime.store
                .listTelemetryOutbox(applicationId, 500)
                .map((record) =>
                    exportTelemetry(
                        runtime.store.telemetrySourceId,
                        record,
                        runtime.store.analyticsSampleKind
                    )
                ),
            request: version
                ? {
                      sourceId: runtime.store.telemetrySourceId,
                      applicationId,
                      versionId: version.id,
                      schema: version.schema,
                      window,
                      sampleKind: runtime.store.analyticsSampleKind,
                  }
                : null,
            job: runtime.store.getBaselineJob(applicationId, window.to),
        };
    }
    if (request.method !== 'POST')
        throw new RuntimeError('Method not allowed.', 405);
    const text = await request.text();
    if (Buffer.byteLength(text) > 1_048_576)
        throw new RuntimeError('Analytics request is too large.', 413);
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        throw new RuntimeError('Invalid JSON.', 400);
    }
    const command = Command.parse(body);
    if (command.action === 'ack') {
        runtime.store.acknowledgeTelemetryOutbox(applicationId, command.ids);
        return { acknowledged: command.ids.length };
    }
    return runtime.publishDailyBaseline(command.evidence);
}
