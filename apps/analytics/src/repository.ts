import type { Pool } from 'pg';
import {
    AggregateEvidence,
    AnalyticsBatch,
    EvidenceRequest,
    analyticsSchemaHash,
    latestBaselineWindow,
    type AnalyticsRecord,
} from '@flowjs/core/flow/analytics';
import { SLOW_LATENCY_MS, type Metrics } from '@flowjs/core/flow/metrics';
import {
    EVENT_COUNTS,
    INGEST,
    LATENCY,
    POPULATION,
    SESSION_STATS,
} from './queries';

export interface AnalyticsRepository {
    health(): Promise<void>;
    ingest(records: AnalyticsRecord[]): Promise<number>;
    evidence(request: EvidenceRequest): Promise<AggregateEvidence>;
}

interface CountsRow {
    component_id: string;
    event_type: string;
    count: number;
    active_ms: number;
}
interface SessionRow {
    sessions: number;
    users: number;
    components: Array<{
        component_id: string;
        sessions_used: number;
        exposed_sessions: number;
        used_exposed: number;
        discovery: number | null;
        first_view: number | null;
    }>;
    repeats: Array<{ component_id: string; count: number }>;
    transitions: Metrics['transitions'];
    retry_latency: Array<{ component_id: string; latency: number }>;
    navigation: AggregateEvidence['navigation'];
}
interface PopulationRow {
    users: number;
    sessions: number;
    interactions: number;
    usage: AggregateEvidence['capabilityUsage'];
}
interface LatencyRow {
    capability_id: string;
    kind: 'data' | 'action';
    calls: number;
    error_rate: number;
    p50: number;
    p95: number;
}

function share(numerator: number, denominator: number, digits = 3): number {
    return denominator ? Number((numerator / denominator).toFixed(digits)) : 0;
}

export function deriveInsights(
    evidence: Pick<
        AggregateEvidence,
        'metrics' | 'capabilityUsage' | 'navigation' | 'population'
    >
): AggregateEvidence['insights'] {
    const insights: AggregateEvidence['insights'] = [];
    for (const latency of evidence.metrics.latency) {
        if (latency.slow || latency.slowTail)
            insights.push({
                kind: 'performance',
                componentIds: [],
                summary: `${latency.capabilityId} has approximately ${Math.round(latency.p95Ms)}ms p95 backend latency across ${latency.calls} calls. Retries may be performance friction, not a layout problem.`,
            });
    }
    for (const component of evidence.metrics.components) {
        if (
            component.sessionsUsed >= 3 &&
            (component.avgDiscoveryMs ?? 0) >= 4000
        )
            insights.push({
                kind: 'discovery',
                componentIds: [component.componentId],
                summary: `${component.componentId} was used in ${component.sessionsUsed} current-average sessions; mean time to first interaction was ${component.avgDiscoveryMs}ms.`,
            });
    }
    for (const usage of evidence.capabilityUsage.slice(0, 3)) {
        insights.push({
            kind: 'engagement',
            componentIds: [],
            summary: `${usage.capabilityId} received ${usage.interactions} interactions from ${usage.users} browser identities across ${usage.sessions} sessions and multiple layouts, with ${usage.activeMs}ms measured foreground time. This is preference evidence, not evidence about the current position or proof of task success.`,
        });
    }
    for (const transition of evidence.metrics.transitions.slice(0, 3)) {
        if (transition.count >= 3)
            insights.push({
                kind: 'workflow',
                componentIds: [transition.from, transition.to],
                summary: `${transition.from} was followed by ${transition.to} ${transition.count} times on the current average layout. Sequence frequency is not proof of causality.`,
            });
    }
    for (const navigation of evidence.navigation) {
        if (
            navigation.opens >= 5 &&
            navigation.dismissals / navigation.opens >= 0.5
        )
            insights.push({
                kind: 'navigation',
                componentIds: [],
                summary: `${navigation.path.join(' > ')} had ${navigation.opens} opens and ${navigation.dismissals} dismissals without a selection. Runtime menus are not mutable dashboard components.`,
            });
        if (navigation.activeMs > 0 && navigation.users >= 3)
            insights.push({
                kind: 'engagement',
                componentIds: [],
                summary: `${navigation.path.join(' > ')} recorded ${navigation.activeMs}ms of foreground activity across ${navigation.users} browser identities. Idle and hidden time is excluded; duration alone does not establish success or friction.`,
            });
    }
    return insights.slice(0, 20);
}

export function createRepository(
    pool: Pool,
    now: () => number = Date.now
): AnalyticsRepository {
    return {
        async health() {
            const result = await pool.query(
                'SELECT version FROM flow_analytics.migrations WHERE version = 2'
            );
            if (!result.rowCount)
                throw new Error('Analytics migration is missing.');
        },

        async ingest(records) {
            const parsed = AnalyticsBatch.parse({ records });
            const unique = new Map<string, AnalyticsRecord>();
            for (const record of parsed.records) {
                const key = `${record.sourceId}:${record.id}`;
                const prior = unique.get(key);
                if (prior && JSON.stringify(prior) !== JSON.stringify(record))
                    throw new Error('Conflicting telemetry delivery IDs.');
                unique.set(key, record);
            }
            if (!unique.size) return 0;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const sourceId of [
                    ...new Set(
                        [...unique.values()].map((record) => record.sourceId)
                    ),
                ].sort()) {
                    await client.query(
                        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                        [sourceId]
                    );
                    const records = [...unique.values()].filter(
                        (record) => record.sourceId === sourceId
                    );
                    for (const applicationId of new Set(
                        records.map((record) => record.applicationId)
                    )) {
                        const samples = records.filter(
                            (record) => record.applicationId === applicationId
                        );
                        const sampleKind = samples[0].sampleKind ?? 'live';
                        if (
                            samples.some(
                                (record) =>
                                    (record.sampleKind ?? 'live') !== sampleKind
                            )
                        )
                            throw new Error(
                                'A source cannot mix live and simulated telemetry.'
                            );
                        await client.query(
                            `INSERT INTO flow_analytics.sources (source_id, application_id, sample_kind)
                            VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                            [sourceId, applicationId, sampleKind]
                        );
                        const registered = await client.query<{
                            sample_kind: string;
                        }>(
                            'SELECT sample_kind FROM flow_analytics.sources WHERE source_id = $1 AND application_id = $2',
                            [sourceId, applicationId]
                        );
                        if (registered.rows[0].sample_kind !== sampleKind)
                            throw new Error(
                                'Analytics source provenance cannot be changed.'
                            );
                    }
                }
                const result = await client.query<{ accepted: number }>(
                    INGEST,
                    [JSON.stringify([...unique.values()])]
                );
                await client.query('COMMIT');
                return result.rows[0].accepted;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        },

        async evidence(input) {
            const request = EvidenceRequest.parse(input);
            const generatedAt = now();
            const { from, to } = request.window;
            if (to > latestBaselineWindow(generatedAt).to)
                throw new Error('The daily baseline window is not closed yet.');
            const scoped = [
                request.sourceId,
                request.applicationId,
                request.versionId,
                from,
                to,
            ];
            const populationScope = [
                request.sourceId,
                request.applicationId,
                from,
                to,
            ];
            const client = await pool.connect();
            let locked = false;
            try {
                await client.query(
                    'SELECT pg_advisory_lock(hashtextextended($1, 0))',
                    [request.sourceId]
                );
                locked = true;
                const source = await client.query<{ sample_kind: string }>(
                    'SELECT sample_kind FROM flow_analytics.sources WHERE source_id = $1 AND application_id = $2',
                    [request.sourceId, request.applicationId]
                );
                if (
                    source.rowCount &&
                    source.rows[0].sample_kind !==
                        (request.sampleKind ?? 'live')
                )
                    throw new Error(
                        'Analytics evidence provenance does not match its source.'
                    );
                for (const view of ['events_minute', 'latency_minute']) {
                    await client.query(
                        `CALL refresh_continuous_aggregate('flow_analytics.${view}',
                        to_timestamp($1::double precision / 1000), to_timestamp($2::double precision / 1000))`,
                        [from, to]
                    );
                }
                await client.query(
                    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
                );
                const counts = (
                    await client.query<CountsRow>(EVENT_COUNTS, scoped)
                ).rows;
                const sessions = (
                    await client.query<SessionRow>(SESSION_STATS, scoped)
                ).rows[0];
                const population = (
                    await client.query<PopulationRow>(POPULATION, [
                        ...populationScope,
                        [
                            ...new Set(
                                request.schema.components.map(
                                    (component) => component.capability
                                )
                            ),
                        ],
                    ])
                ).rows[0];
                const latency = (
                    await client.query<LatencyRow>(LATENCY, populationScope)
                ).rows;
                await client.query('COMMIT');

                const totalInteractions = counts
                    .filter((row) =>
                        ['component_click', 'value_change'].includes(
                            row.event_type
                        )
                    )
                    .reduce((total, row) => total + row.count, 0);
                const metrics: Metrics & { versionId: string } = {
                    versionId: request.versionId,
                    sessions: {
                        total: sessions.sessions,
                        live:
                            request.sampleKind === 'simulated'
                                ? 0
                                : sessions.sessions,
                        seeded:
                            request.sampleKind === 'simulated'
                                ? sessions.sessions
                                : 0,
                    },
                    totalInteractions,
                    components: request.schema.components.map((component) => {
                        const own = counts.filter(
                            (row) => row.component_id === component.id
                        );
                        const count = (type: string) =>
                            own.find((row) => row.event_type === type)?.count ??
                            0;
                        const stats = sessions.components.find(
                            (row) => row.component_id === component.id
                        );
                        const interactions =
                            count('component_click') + count('value_change');
                        const completions = count('interaction_complete');
                        const errors = count('interaction_error');
                        const outgoing = sessions.transitions.filter(
                            (transition) => transition.from === component.id
                        );
                        const outgoingCount = outgoing.reduce(
                            (total, transition) => total + transition.count,
                            0
                        );
                        return {
                            componentId: component.id,
                            capabilityId: component.capability,
                            primitive: component.primitive,
                            visible: component.visible,
                            views: count('component_view'),
                            hovers: count('component_hover'),
                            scrolls: count('component_scroll'),
                            focusStarts: count('component_focus'),
                            disabledAttempts: count('disabled_interaction'),
                            interactions,
                            interactionShare: share(
                                interactions,
                                totalInteractions
                            ),
                            sessionsUsed: stats?.sessions_used ?? 0,
                            usageRate: share(
                                stats?.sessions_used ?? 0,
                                sessions.sessions
                            ),
                            avgDiscoveryMs: stats?.discovery ?? null,
                            avgFirstViewMs: stats?.first_view ?? null,
                            repeatRate: share(
                                sessions.repeats.find(
                                    (row) => row.component_id === component.id
                                )?.count ?? 0,
                                interactions
                            ),
                            retryLatencyMs:
                                sessions.retry_latency.find(
                                    (row) => row.component_id === component.id
                                )?.latency ?? null,
                            valueChangesPerUsingSession: stats?.sessions_used
                                ? share(
                                      count('value_change'),
                                      stats.sessions_used,
                                      2
                                  )
                                : null,
                            completions,
                            errors,
                            errorRate:
                                completions + errors
                                    ? share(errors, completions + errors)
                                    : null,
                            followedBy: outgoing
                                .slice(0, 20)
                                .map((transition) => ({
                                    componentId: transition.to,
                                    count: transition.count,
                                    share: share(
                                        transition.count,
                                        outgoingCount
                                    ),
                                })),
                        };
                    }),
                    transitions: sessions.transitions,
                    latency: latency.map((row) => ({
                        capabilityId: row.capability_id,
                        kind: row.kind,
                        calls: row.calls,
                        p50Ms: row.p50,
                        p95Ms: row.p95,
                        errorRate: row.error_rate,
                        slow: row.p50 >= SLOW_LATENCY_MS,
                        slowTail: row.p95 >= SLOW_LATENCY_MS,
                        traceIds: [],
                        replayIds: [],
                    })),
                };
                const evidence: AggregateEvidence = {
                    source: 'tiger',
                    sampleKind: request.sampleKind ?? 'live',
                    sourceId: request.sourceId,
                    applicationId: request.applicationId,
                    versionId: request.versionId,
                    schemaHash: analyticsSchemaHash(request.schema),
                    generatedAt,
                    window: { from, to },
                    uniqueUsers: sessions.users,
                    population: {
                        users: population.users,
                        sessions: population.sessions,
                        interactions: population.interactions,
                    },
                    capabilityUsage: population.usage,
                    metrics,
                    engagement: request.schema.components.map((component) => {
                        const stats = sessions.components.find(
                            (row) => row.component_id === component.id
                        );
                        return {
                            componentId: component.id,
                            exposedSessions: stats?.exposed_sessions ?? 0,
                            activeMs: counts
                                .filter(
                                    (row) => row.component_id === component.id
                                )
                                .reduce(
                                    (total, row) => total + row.active_ms,
                                    0
                                ),
                            usageAmongExposed: stats?.exposed_sessions
                                ? share(
                                      stats.used_exposed,
                                      stats.exposed_sessions
                                  )
                                : null,
                        };
                    }),
                    navigation: sessions.navigation,
                    insights: [],
                };
                evidence.insights = deriveInsights(evidence);
                return AggregateEvidence.parse(evidence);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                try {
                    if (locked)
                        await client.query(
                            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
                            [request.sourceId]
                        );
                    client.release();
                } catch (error) {
                    client.release(true);
                    throw error;
                }
            }
        },
    };
}
