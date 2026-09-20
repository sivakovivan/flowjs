import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    TELEMETRY_EVENT_TYPES,
    type AnalyticsSampleKind,
    type TelemetryOutboxRecord,
} from './store';
import { UISchemaSchema, type UISchema } from './schema';

const identifier = z.string().min(1).max(128);
const count = z.number().int().nonnegative().safe();
const duration = z.number().nonnegative().finite();
const ratio = z.number().min(0).max(1);
const optionalDuration = duration.nullable();
export const NavigationPath = z
    .array(z.string().regex(/^[a-z0-9:_-]{1,64}$/i))
    .max(8);

export const AnalyticsEvent = z.object({
    versionId: identifier,
    sessionId: identifier,
    userId: identifier.nullable(),
    componentId: identifier,
    capabilityId: identifier,
    eventType: z.enum(TELEMETRY_EVENT_TYPES),
    sinceLoadMs: duration.max(86_400_000),
    occurredAt: count,
    track: z.enum(['average', 'personal']),
    activeMs: count.max(15_000).default(0),
    path: NavigationPath.default([]),
    viewport: z.enum(['compact', 'wide', 'unknown']).default('unknown'),
});

export const AnalyticsCall = z.object({
    versionId: identifier.nullable(),
    sessionId: identifier.nullable(),
    componentId: identifier.nullable(),
    capabilityId: identifier,
    kind: z.enum(['data', 'action']),
    latencyMs: duration.max(86_400_000),
    ok: z.boolean(),
    traceId: z.string().max(128).nullable(),
    occurredAt: count,
});

const envelope = {
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    applicationId: identifier,
    sampleKind: z.enum(['live', 'simulated']).optional(),
};

export const AnalyticsRecord = z.discriminatedUnion('kind', [
    z.object({
        ...envelope,
        kind: z.literal('event'),
        payload: AnalyticsEvent,
    }),
    z.object({ ...envelope, kind: z.literal('call'), payload: AnalyticsCall }),
]);
export type AnalyticsRecord = z.infer<typeof AnalyticsRecord>;
export const AnalyticsBatch = z.object({
    records: z.array(AnalyticsRecord).max(500),
});

const DAY_MS = 86_400_000;
export const DailyBaselineWindow = z
    .object({ from: count, to: count })
    .refine(
        (window) =>
            window.from % DAY_MS === 0 && window.to - window.from === DAY_MS,
        'Baseline evidence must cover one complete UTC day.'
    );

export function latestBaselineWindow(
    now = Date.now()
): z.infer<typeof DailyBaselineWindow> {
    const to = Math.floor((now - 5 * 60_000) / DAY_MS) * DAY_MS;
    return { from: to - DAY_MS, to };
}

export const EvidenceRequest = z.object({
    sourceId: z.string().uuid(),
    applicationId: identifier,
    versionId: z.string().regex(/^v\d+$/),
    schema: UISchemaSchema,
    window: DailyBaselineWindow,
    sampleKind: z.enum(['live', 'simulated']).optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequest>;

export const AnalyticsFeed = z.object({
    records: z.array(AnalyticsRecord).max(500),
    request: EvidenceRequest.nullable(),
    job: z
        .object({
            status: z.enum([
                'running',
                'applied',
                'unchanged',
                'insufficient-data',
                'rejected',
                'pending',
                'failed',
            ]),
            attempts: count,
            leaseUntil: count,
        })
        .nullable(),
});
export type AnalyticsFeed = z.infer<typeof AnalyticsFeed>;

export function analyticsSchemaHash(schema: UISchema): string {
    return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

export function exportTelemetry(
    sourceId: string,
    record: TelemetryOutboxRecord,
    sampleKind: AnalyticsSampleKind = 'live'
): AnalyticsRecord {
    if (record.payload.seeded && sampleKind !== 'simulated')
        throw new Error('Synthetic telemetry is local-only.');
    const base = {
        id: record.id,
        sourceId,
        applicationId: record.applicationId,
        sampleKind,
    };
    if (record.kind === 'call') {
        const call = record.payload;
        return AnalyticsRecord.parse({
            ...base,
            kind: 'call',
            payload: {
                versionId: call.versionId,
                sessionId: call.sessionId,
                componentId: call.componentId,
                capabilityId: call.capabilityId,
                kind: call.kind,
                latencyMs: call.latencyMs,
                ok: call.ok,
                traceId: call.traceId,
                occurredAt: call.createdAt,
            },
        });
    }
    const event = record.payload;
    const activeMs = count.max(15_000).safeParse(event.metadata.activeMs);
    const path = AnalyticsEvent.shape.path.safeParse(event.metadata.path);
    const viewport = AnalyticsEvent.shape.viewport.safeParse(
        event.metadata.viewport
    );
    return AnalyticsRecord.parse({
        ...base,
        kind: 'event',
        payload: {
            versionId: event.versionId,
            sessionId: event.sessionId,
            userId: event.userId,
            componentId: event.componentId,
            capabilityId: event.capabilityId,
            eventType: event.eventType,
            sinceLoadMs: event.sinceLoadMs,
            occurredAt: event.createdAt,
            track: event.versionId.startsWith('p') ? 'personal' : 'average',
            activeMs:
                event.eventType === 'active_time' && activeMs.success
                    ? activeMs.data
                    : 0,
            path: path.success ? path.data : [],
            viewport: viewport.success ? viewport.data : 'unknown',
        },
    });
}

const followUp = z.object({ componentId: identifier, count, share: ratio });
export const AggregateMetrics = z.object({
    versionId: identifier,
    sessions: z.object({ total: count, live: count, seeded: count }),
    totalInteractions: count,
    components: z
        .array(
            z.object({
                componentId: identifier,
                capabilityId: identifier,
                primitive: identifier,
                visible: z.boolean(),
                views: count,
                hovers: count,
                scrolls: count,
                focusStarts: count,
                disabledAttempts: count,
                interactions: count,
                interactionShare: ratio,
                sessionsUsed: count,
                usageRate: ratio,
                avgDiscoveryMs: optionalDuration,
                avgFirstViewMs: optionalDuration,
                repeatRate: ratio,
                retryLatencyMs: optionalDuration,
                valueChangesPerUsingSession: optionalDuration,
                completions: count,
                errors: count,
                errorRate: ratio.nullable(),
                followedBy: z.array(followUp).max(20),
            })
        )
        .max(200),
    transitions: z
        .array(z.object({ from: identifier, to: identifier, count }))
        .max(100),
    latency: z
        .array(
            z.object({
                capabilityId: identifier,
                kind: z.enum(['data', 'action']),
                calls: count,
                p50Ms: duration,
                p95Ms: duration,
                errorRate: ratio,
                slow: z.boolean(),
                slowTail: z.boolean(),
                traceIds: z.array(z.string().max(128)).max(3),
                replayIds: z.array(z.string().max(128)).max(3),
            })
        )
        .max(200),
});

export const AggregateEvidence = z
    .object({
        source: z.literal('tiger'),
        sampleKind: z.enum(['live', 'simulated']).optional(),
        sourceId: z.string().uuid(),
        applicationId: identifier,
        versionId: identifier,
        schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
        generatedAt: count,
        window: z.object({ from: count, to: count }),
        uniqueUsers: count,
        population: z.object({
            users: count,
            sessions: count,
            interactions: count,
        }),
        capabilityUsage: z
            .array(
                z.object({
                    capabilityId: identifier,
                    users: count,
                    sessions: count,
                    interactions: count,
                    activeMs: count,
                })
            )
            .max(200),
        metrics: AggregateMetrics,
        engagement: z
            .array(
                z.object({
                    componentId: identifier,
                    exposedSessions: count,
                    activeMs: count,
                    usageAmongExposed: ratio.nullable(),
                })
            )
            .max(200),
        navigation: z
            .array(
                z.object({
                    path: z.array(identifier).max(8),
                    opens: count,
                    selections: count,
                    dismissals: count,
                    activeMs: count,
                    users: count,
                    sessions: count,
                })
            )
            .max(100),
        insights: z
            .array(
                z.object({
                    kind: z.enum([
                        'discovery',
                        'workflow',
                        'navigation',
                        'performance',
                        'engagement',
                    ]),
                    componentIds: z.array(identifier).max(10),
                    summary: z.string().max(1000),
                })
            )
            .max(20),
    })
    .refine(
        (evidence) =>
            evidence.versionId === evidence.metrics.versionId &&
            evidence.window.from < evidence.window.to &&
            evidence.metrics.sessions.total ===
                evidence.metrics.sessions.live +
                    evidence.metrics.sessions.seeded &&
            (evidence.sampleKind === 'simulated'
                ? evidence.metrics.sessions.live === 0
                : evidence.metrics.sessions.seeded === 0) &&
            evidence.uniqueUsers <= evidence.metrics.sessions.total,
        'Inconsistent aggregate evidence scope or sample counts.'
    );
export type AggregateEvidence = z.infer<typeof AggregateEvidence>;

export const DEFAULT_AGGREGATE_GATE = {
    users: 5,
    sessions: 5,
    interactions: 20,
};

export function aggregateReadiness(evidence: AggregateEvidence): string[] {
    const reasons: string[] = [];
    if (evidence.population.users < DEFAULT_AGGREGATE_GATE.users)
        reasons.push(
            `Needs ${DEFAULT_AGGREGATE_GATE.users} distinct browser identities.`
        );
    if (evidence.population.sessions < DEFAULT_AGGREGATE_GATE.sessions)
        reasons.push(`Needs ${DEFAULT_AGGREGATE_GATE.sessions} live sessions.`);
    if (evidence.population.interactions < DEFAULT_AGGREGATE_GATE.interactions)
        reasons.push(
            `Needs ${DEFAULT_AGGREGATE_GATE.interactions} interactions.`
        );
    return reasons;
}
