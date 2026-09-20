import { generationBrief, optimizationBrief } from './ai/briefs';
import {
    GeneratedSchemaOutput,
    OptimizationOutput,
    toMutation,
    toUISchema,
} from './ai/contracts';
import type { FlowAIProvider } from './ai/providers';
import { findFriction, type Finding } from './friction';
import { computeMetrics, type Metrics } from './metrics';
import { applyMutations, type Mutation } from './mutations';
import { compatiblePrimitives } from './primitives';
import { seedSessions } from './seed';
import type { FlowApp } from './registry';
import {
    diffSchemas,
    normalizeOrder,
    validateSchema,
    type UISchema,
} from './schema';
import { decideAutoApply, scoreProposal, type MutationScore } from './scoring';
import {
    FlowStore,
    TELEMETRY_EVENT_TYPES,
    VersionError,
    type AISource,
    type OptimizationRun,
    type TelemetryEvent,
    type VersionRecord,
} from './store';
import { z } from 'zod';
import { defaultLayoutTracks } from './layout-tracks';
import {
    AggregateEvidence,
    DailyBaselineWindow,
    NavigationPath,
    aggregateReadiness,
    analyticsSchemaHash,
    latestBaselineWindow,
} from './analytics';
import type { DailyBaselineJob, DailyBaselineResult } from './store';

/*
 * The adaptive loop: generate → observe → analyze → propose → validate →
 * score → apply → version. OpenAI proposes; this runtime validates and executes.
 */

export const INSTABILITY_WINDOW_MS = 15 * 60_000;

export interface AIProvenance {
    source: AISource;
    model: string;
    /** Why the live call was not used, when it was not. */
    fallbackReason: string | null;
}

export interface OptimizationAnalysis {
    ai: AIProvenance & Omit<OptimizationOutput, 'mutations'>;
    findings: Finding[];
    sampleSize: {
        sessions: number;
        liveSessions: number;
        seededSessions: number;
        interactions: number;
    };
    latency: Metrics['latency'];
    score: MutationScore | null;
    decision: { autoApply: boolean; threshold: number | null };
    aggregate?: AggregateEvidence;
}

export const IncomingEvent = z.object({
    eventId: z.string().uuid().optional(),
    versionId: z.string().max(16),
    sessionId: z.string().min(1).max(64),
    userId: z.string().max(64).nullable().default(null),
    componentId: z.string().max(64),
    eventType: z.enum(TELEMETRY_EVENT_TYPES),
    sinceLoadMs: z.number().min(0).max(86_400_000),
    timestamp: z.number(),
    metadata: z.record(z.string(), z.unknown()).default({}),
});
export type IncomingEvent = z.input<typeof IncomingEvent>;

/** Client clocks are trusted only within this skew. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

function layoutSignature(schema: UISchema): string {
    return JSON.stringify(
        normalizeOrder(schema).components.map(
            ({ id, primitive, size, order, visible }) => ({
                id,
                primitive,
                size,
                order,
                visible,
            })
        )
    );
}

/**
 * A personal regeneration is a visible product moment. Keep a strong AI result,
 * but amplify conservative/recorded output so the user can see the adaptation.
 */
function ensureDemonstrableLayoutChange(
    schema: UISchema,
    previous: UISchema,
    app: FlowApp
): UISchema {
    const normalized = normalizeOrder(schema);
    const initialChanges = Object.values(diffSchemas(previous, normalized));
    const changedComponents = initialChanges.length;
    const hasStructuralChange = initialChanges.some((changes) =>
        changes.some((change) => change === 'resized' || change === 'swapped')
    );
    if (
        layoutSignature(normalized) !== layoutSignature(previous) &&
        changedComponents >= 4 &&
        hasStructuralChange
    )
        return normalized;

    const components = [...normalized.components];
    if (components.length > 2) {
        components.push(...components.splice(0, 2));
    }
    const sizes = ['small', 'medium', 'large', 'full'] as const;
    let swaps = 0;
    return {
        components: components.map((component, order) => {
            const capability = app.capability(component.capability);
            const variants = capability
                ? compatiblePrimitives(capability)
                : [component.primitive];
            const canSwap = swaps < 2 && variants.length > 1;
            if (canSwap) swaps += 1;
            return {
                ...component,
                order,
                size:
                    component.visible && order < 4
                        ? sizes[
                              (sizes.indexOf(component.size) + 1) % sizes.length
                          ]
                        : component.size,
                primitive: canSwap
                    ? variants[
                          (variants.indexOf(component.primitive) + 1) %
                              variants.length
                      ]
                    : component.primitive,
            };
        }),
    };
}

export class RuntimeError extends Error {
    constructor(
        message: string,
        readonly status = 400
    ) {
        super(message);
        this.name = 'RuntimeError';
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type Check<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function createRuntime(deps: {
    app: FlowApp;
    store: FlowStore;
    /** Null when no API key is configured. */
    live: FlowAIProvider | null;
    recorded: FlowAIProvider;
    /** Skip live calls and replay recordings (the presentation fallback switch). */
    forceRecorded?: boolean;
    dailyBaseline?: boolean;
    now?: () => number;
}) {
    const { app, store, live, recorded } = deps;
    const now = deps.now ?? Date.now;
    store.syncApplication(app);

    /** Try the live provider, falling back to recordings on failure or malformed output. */
    async function withFallback<T>(
        call: (provider: FlowAIProvider) => Promise<unknown>,
        check: (output: unknown) => Check<T>
    ): Promise<{ value: T; provenance: AIProvenance }> {
        let fallbackReason: string | null = null;
        if (deps.forceRecorded)
            fallbackReason =
                'Recorded mode is enabled (FLOW_AI_MODE=recorded).';
        else if (!live)
            throw new RuntimeError(
                'OPENAI_API_KEY is required for live AI operations. Set FLOW_AI_MODE=recorded only for explicit demo mode.',
                503
            );
        else {
            try {
                const result = check(await call(live));
                if (result.ok)
                    return {
                        value: result.value,
                        provenance: {
                            source: 'live',
                            model: live.model,
                            fallbackReason: null,
                        },
                    };
                fallbackReason = `Live output failed validation: ${result.errors.slice(0, 3).join(' ')}`;
            } catch (error) {
                fallbackReason = `Live call failed: ${errorMessage(error)}`;
            }
        }
        const result = check(await call(recorded));
        if (!result.ok) {
            throw new RuntimeError(
                `Recorded response is invalid: ${result.errors.join(' ')}`,
                500
            );
        }
        return {
            value: result.value,
            provenance: {
                source: 'recorded',
                model: recorded.model,
                fallbackReason,
            },
        };
    }

    function activeVersion(): VersionRecord {
        const version = store.getActiveVersion(app.id);
        if (!version)
            throw new RuntimeError('No dashboard has been generated yet.', 409);
        return version;
    }

    function analyze(
        version: VersionRecord = activeVersion(),
        userId?: string
    ) {
        const metrics = computeMetrics({
            versionId: version.id,
            schema: version.schema,
            events: store.listEvents(app.id, version.id, userId),
            calls: store.listCalls(app.id),
        });
        const findings = findFriction({ app, schema: version.schema, metrics });
        return { version, metrics, findings };
    }

    function validateAggregate(
        evidence: AggregateEvidence,
        version: VersionRecord
    ) {
        if ((evidence.sampleKind ?? 'live') !== store.analyticsSampleKind)
            throw new RuntimeError(
                'Simulated evidence cannot be used by a live analytics source.',
                409
            );
        if (
            evidence.applicationId !== app.id ||
            evidence.sourceId !== store.telemetrySourceId
        )
            throw new RuntimeError(
                'Aggregate evidence belongs to a different application or installation.',
                409
            );
        if (
            !DailyBaselineWindow.safeParse(evidence.window).success ||
            evidence.window.to !== latestBaselineWindow(now()).to
        )
            throw new RuntimeError(
                'Aggregate evidence must cover the latest completed baseline day.',
                409
            );
        if (
            evidence.versionId !== version.id ||
            evidence.schemaHash !== analyticsSchemaHash(version.schema)
        )
            throw new RuntimeError(
                'The baseline changed since this evidence was collected.',
                409
            );
        if (
            evidence.metrics.components.length !==
                version.schema.components.length ||
            evidence.metrics.components.some(
                (metric) =>
                    !version.schema.components.some(
                        (component) =>
                            component.id === metric.componentId &&
                            component.capability === metric.capabilityId &&
                            component.primitive === metric.primitive &&
                            component.visible === metric.visible
                    )
            )
        )
            throw new RuntimeError(
                'Aggregate component metrics do not match the baseline.',
                409
            );
        if (
            evidence.generatedAt > now() + 60_000 ||
            now() - evidence.generatedAt > 15 * 60_000
        )
            throw new RuntimeError(
                'Aggregate evidence has expired; collect a fresh snapshot.',
                409
            );
    }

    return {
        app,
        store,

        state(userId?: string) {
            const application = store.getApplication(app.id)!;
            const active = store.getActiveVersion(app.id);
            const personal = userId
                ? store.getLatestPersonalVersion(app.id, userId)
                : null;
            const currentPersonal =
                personal &&
                userId &&
                (!deps.dailyBaseline ||
                    store.getPersonalBaselineId(app.id, userId, personal.id) ===
                        active?.id)
                    ? personal
                    : null;
            const baselineJob = deps.dailyBaseline
                ? store.getBaselineJob(app.id, latestBaselineWindow(now()).to)
                : null;
            const baselineRunId =
                baselineJob?.result?.runId ?? active?.optimizationRunId;
            return {
                application,
                active,
                versions: store.listVersions(app.id),
                layouts: {
                    ...defaultLayoutTracks(active),
                    personal: currentPersonal,
                },
                baselineMode: deps.dailyBaseline
                    ? ('daily' as const)
                    : ('interactive' as const),
                analyticsSampleKind: store.analyticsSampleKind,
                baselineRun: baselineRunId ? store.getRun(baselineRunId) : null,
            };
        },

        /** Generate v1 from capabilities. Idempotent once a dashboard exists. */
        async generate(): Promise<{
            version: VersionRecord;
            provenance: AIProvenance | null;
        }> {
            const existing = store.getActiveVersion(app.id);
            if (existing) return { version: existing, provenance: null };

            const { value, provenance } = await withFallback<{
                schema: UISchema;
                reasoning: string;
            }>(
                (provider) => provider.generateSchema(generationBrief(app)),
                (output) => {
                    const parsed = GeneratedSchemaOutput.safeParse(output);
                    if (!parsed.success)
                        return {
                            ok: false,
                            errors: parsed.error.issues.map((i) => i.message),
                        };
                    const validated = validateSchema(
                        toUISchema(parsed.data),
                        app
                    );
                    return validated.ok
                        ? {
                              ok: true,
                              value: {
                                  schema: validated.schema,
                                  reasoning: parsed.data.reasoning,
                              },
                          }
                        : validated;
                }
            );

            const version = store.createVersion({
                applicationId: app.id,
                parentVersionId: null,
                schema: value.schema,
                mutations: [],
                reason: 'Generated dashboard',
                evidence: { reasoning: value.reasoning, ai: provenance },
                source: 'generated',
                aiSource: provenance.source,
                cause: 'generate',
            });
            return { version, provenance };
        },

        async customize(
            userRequest: string
        ): Promise<{ version: VersionRecord; provenance: AIProvenance }> {
            const request = userRequest.trim();
            if (!request)
                throw new RuntimeError('A customization request is required.');
            if (request.length > 500)
                throw new RuntimeError(
                    'Customization requests must be 500 characters or fewer.'
                );
            const previous = activeVersion();
            const { value, provenance } = await withFallback<{
                schema: UISchema;
                reasoning: string;
            }>(
                (provider) =>
                    provider.generateSchema({
                        ...generationBrief(app),
                        userRequest: request,
                    }),
                (output) => {
                    const parsed = GeneratedSchemaOutput.safeParse(output);
                    if (!parsed.success)
                        return {
                            ok: false,
                            errors: parsed.error.issues.map((i) => i.message),
                        };
                    const validated = validateSchema(
                        toUISchema(parsed.data),
                        app
                    );
                    return validated.ok
                        ? {
                              ok: true,
                              value: {
                                  schema: validated.schema,
                                  reasoning: parsed.data.reasoning,
                              },
                          }
                        : validated;
                }
            );
            const version = store.createVersion({
                applicationId: app.id,
                parentVersionId: previous.id,
                schema: value.schema,
                mutations: [],
                reason: `User request: ${request}`,
                evidence: {
                    reasoning: value.reasoning,
                    request,
                    ai: provenance,
                },
                source: 'generated',
                aiSource: provenance.source,
                cause: 'generate',
            });
            return { version, provenance };
        },

        /** Regenerate a complete personal schema from this user's evidence on demand. */
        async regeneratePersonal(userId: string): Promise<{
            version: VersionRecord;
            provenance: AIProvenance;
        }> {
            if (!userId || userId.length > 64)
                throw new RuntimeError('A valid user id is required.');
            const average = activeVersion();
            const personal = store.getLatestPersonalVersion(app.id, userId);
            const previous =
                personal &&
                (!deps.dailyBaseline ||
                    store.getPersonalBaselineId(app.id, userId, personal.id) ===
                        average.id)
                    ? personal
                    : average;
            const metrics = computeMetrics({
                versionId: previous.id,
                schema: previous.schema,
                events: store.listUserEvents(app.id, userId),
                calls: store.listCalls(app.id),
            });
            const findings = findFriction({
                app,
                schema: previous.schema,
                metrics,
            });
            const brief = {
                ...optimizationBrief({
                    app,
                    schema: previous.schema,
                    metrics,
                    findings,
                }),
                previousPersonalVersionId:
                    previous.id === average.id ? null : previous.id,
                refreshInstruction:
                    'Create a complete new personal layout. Make the adaptation visually obvious: move several components and change useful sizes or primitive variants, even with sparse evidence. Keep the overall reasoning to one plain-language sentence of no more than 25 words.',
            };
            const { value, provenance } = await withFallback<{
                schema: UISchema;
                reasoning: string;
            }>(
                (provider) => provider.generatePersonalSchema(brief),
                (output) => {
                    const parsed = GeneratedSchemaOutput.safeParse(output);
                    if (!parsed.success)
                        return {
                            ok: false,
                            errors: parsed.error.issues.map((i) => i.message),
                        };
                    const validated = validateSchema(
                        toUISchema(parsed.data),
                        app
                    );
                    return validated.ok
                        ? {
                              ok: true,
                              value: {
                                  schema: ensureDemonstrableLayoutChange(
                                      validated.schema,
                                      previous.schema,
                                      app
                                  ),
                                  reasoning: parsed.data.reasoning,
                              },
                          }
                        : validated;
                }
            );
            if (deps.dailyBaseline && activeVersion().id !== average.id)
                throw new RuntimeError(
                    'The baseline changed during personal generation. Refresh again.',
                    409
                );
            const version = store.createPersonalVersion({
                applicationId: app.id,
                userId,
                parentVersionId: previous.id,
                schema: value.schema,
                reason: `Personal layout regenerated: ${value.reasoning}`,
            });
            return { version, provenance };
        },

        analyze,

        async publishDailyBaseline(input: unknown): Promise<DailyBaselineJob> {
            const aggregate = AggregateEvidence.parse(input);
            if (
                aggregate.applicationId !== app.id ||
                aggregate.sourceId !== store.telemetrySourceId ||
                (aggregate.sampleKind ?? 'live') !== store.analyticsSampleKind
            )
                throw new RuntimeError(
                    'Aggregate evidence belongs to a different application or installation.',
                    409
                );
            const previous = store.getBaselineJob(app.id, aggregate.window.to);
            if (
                previous &&
                previous.status !== 'running' &&
                previous.status !== 'failed'
            )
                return previous;
            const version = activeVersion();
            validateAggregate(aggregate, version);
            const token = store.claimBaselineJob(
                app.id,
                aggregate.window.to,
                version.id
            );
            if (!token)
                return store.getBaselineJob(app.id, aggregate.window.to)!;
            try {
                const reasons = aggregateReadiness(aggregate);
                let result: DailyBaselineResult;
                if (reasons.length) {
                    result = {
                        status: 'insufficient-data',
                        runId: null,
                        versionId: version.id,
                        reasons,
                    };
                } else {
                    const run = await this.optimize({ aggregate });
                    return store.transaction(() => {
                        if (
                            run.aiSource === 'recorded' &&
                            !deps.forceRecorded
                        ) {
                            store.setRunStatus(run.id, 'rejected');
                            result = {
                                status: 'rejected',
                                runId: run.id,
                                versionId: version.id,
                                reasons: [
                                    'A recorded fallback cannot automatically publish a daily baseline.',
                                ],
                            };
                        } else if (run.status === 'auto') {
                            result = {
                                status: 'applied',
                                runId: run.id,
                                versionId: this.apply(run.id, 'auto').version
                                    .id,
                                reasons: [],
                            };
                        } else {
                            result = {
                                status:
                                    run.status === 'no-change'
                                        ? 'unchanged'
                                        : run.status === 'pending'
                                          ? 'pending'
                                          : 'rejected',
                                runId: run.id,
                                versionId: version.id,
                                reasons: run.errors,
                            };
                        }
                        store.finishBaselineJob(
                            app.id,
                            aggregate.window.to,
                            token,
                            result
                        );
                        return store.getBaselineJob(
                            app.id,
                            aggregate.window.to
                        )!;
                    });
                }
                store.finishBaselineJob(
                    app.id,
                    aggregate.window.to,
                    token,
                    result
                );
                return store.getBaselineJob(app.id, aggregate.window.to)!;
            } catch (error) {
                store.finishBaselineJob(app.id, aggregate.window.to, token, {
                    status: 'failed',
                    runId: null,
                    versionId: version.id,
                    reasons: [
                        error instanceof RuntimeError
                            ? error.message
                            : 'Daily baseline generation failed.',
                    ],
                });
                throw error;
            }
        },

        /** Ask OpenAI for a finding and proposal, validate and score it. Never changes the UI. */
        async optimize(
            options: { userId?: string; aggregate?: AggregateEvidence } = {}
        ): Promise<OptimizationRun> {
            if (deps.dailyBaseline && !options.aggregate)
                throw new RuntimeError(
                    'Shared baselines are generated by the daily analytics job.',
                    409
                );
            const version = activeVersion();
            const aggregate = options.aggregate
                ? AggregateEvidence.parse(options.aggregate)
                : undefined;
            if (aggregate) validateAggregate(aggregate, version);
            const metrics =
                aggregate?.metrics ?? analyze(version, options.userId).metrics;
            const findings = findFriction({
                app,
                schema: version.schema,
                metrics,
            });
            if (
                (aggregate?.population.interactions ??
                    metrics.totalInteractions) === 0
            ) {
                throw new RuntimeError(
                    'No interactions recorded for this version yet. Use the dashboard first.',
                    409
                );
            }
            const brief = optimizationBrief({
                app,
                schema: version.schema,
                metrics,
                findings,
                aggregate,
            });
            const { value: output, provenance } =
                await withFallback<OptimizationOutput>(
                    (provider) => provider.proposeOptimization(brief),
                    (raw) => {
                        const parsed = OptimizationOutput.safeParse(raw);
                        return parsed.success
                            ? { ok: true, value: parsed.data }
                            : {
                                  ok: false,
                                  errors: parsed.error.issues.map(
                                      (i) => `${i.path.join('.')}: ${i.message}`
                                  ),
                              };
                    }
                );

            const { mutations: proposed, ...aiAnalysis } = output;
            const candidate = proposed.map(toMutation);
            const sampleSize = {
                sessions:
                    aggregate?.population.sessions ?? metrics.sessions.total,
                liveSessions: aggregate
                    ? aggregate.sampleKind === 'simulated'
                        ? 0
                        : aggregate.population.sessions
                    : metrics.sessions.live,
                seededSessions:
                    aggregate?.sampleKind === 'simulated'
                        ? aggregate.population.sessions
                        : metrics.sessions.seeded,
                interactions:
                    aggregate?.population.interactions ??
                    metrics.totalInteractions,
            };
            const rate = store.getApplication(app.id)!.mutationRate;
            const base = {
                applicationId: app.id,
                sourceVersionId: version.id,
                mutationRate: rate,
                aiSource: provenance.source,
            };
            const analysis = (
                score: MutationScore | null,
                decision: OptimizationAnalysis['decision']
            ): OptimizationAnalysis => ({
                ai: { ...provenance, ...aiAnalysis },
                findings,
                sampleSize,
                latency: metrics.latency,
                score,
                decision,
                ...(aggregate ? { aggregate } : {}),
            });

            if (candidate.length === 0) {
                return store.createRun({
                    ...base,
                    status: 'no-change',
                    analysis: analysis(null, {
                        autoApply: false,
                        threshold: null,
                    }),
                    proposedMutations: [],
                    score: null,
                    threshold: null,
                    errors: [],
                });
            }

            const result = applyMutations(version.schema, candidate, app);
            if (!result.ok) {
                return store.createRun({
                    ...base,
                    status: 'rejected',
                    analysis: analysis(null, {
                        autoApply: false,
                        threshold: null,
                    }),
                    proposedMutations: candidate as Mutation[],
                    score: null,
                    threshold: null,
                    errors: result.errors,
                });
            }

            const score = scoreProposal({
                expectedBenefit: output.expectedBenefit,
                confidence: output.confidence,
                sessions: sampleSize.sessions,
                interactions: sampleSize.interactions,
                mutations: candidate as Mutation[],
                recentVersions: store.countRecentActivations(
                    app.id,
                    now() - INSTABILITY_WINDOW_MS
                ),
            });
            const decision = decideAutoApply(score.score, rate);
            return store.createRun({
                ...base,
                status: decision.autoApply ? 'auto' : 'pending',
                analysis: analysis(score, decision),
                proposedMutations: candidate as Mutation[],
                score,
                threshold: decision.threshold,
                errors: [],
            });
        },

        /**
         * Apply a validated proposal as a new immutable version. `auto` requires the
         * score to clear the current mutation-rate threshold; `manual` is an explicit
         * approval of the proposal shown in the evidence panel.
         */
        apply(
            runId: string,
            mode: 'auto' | 'manual'
        ): { version: VersionRecord; run: OptimizationRun } {
            const run = store.getRun(runId);
            if (!run || run.applicationId !== app.id)
                throw new RuntimeError('Unknown optimization run.', 404);
            if (run.status !== 'pending' && run.status !== 'auto') {
                throw new RuntimeError(
                    `This proposal cannot be applied (status: ${run.status}).`,
                    409
                );
            }
            const current = activeVersion();
            if (current.id !== run.sourceVersionId) {
                store.setRunStatus(run.id, 'stale');
                throw new RuntimeError(
                    `The dashboard changed since this proposal (${run.sourceVersionId} → ${current.id}). Optimize again.`,
                    409
                );
            }

            return store.transaction(() => {
                const active = activeVersion();
                if (active.id !== run.sourceVersionId)
                    throw new RuntimeError(
                        'The dashboard changed. Optimize again.',
                        409
                    );
                if (mode === 'auto') {
                    const rate = store.getApplication(app.id)!.mutationRate;
                    const score =
                        (run.score as MutationScore | null)?.score ?? 0;
                    if (!decideAutoApply(score, rate).autoApply) {
                        throw new RuntimeError(
                            'The proposal does not clear the current mutation-rate threshold.',
                            409
                        );
                    }
                }
                const result = applyMutations(
                    active.schema,
                    run.proposedMutations,
                    app
                );
                if (!result.ok)
                    throw new RuntimeError(
                        `Proposal is no longer valid: ${result.errors.join(' ')}`,
                        409
                    );

                const analysis = run.analysis as OptimizationAnalysis;
                const metrics =
                    analysis.aggregate?.metrics ?? analyze(active).metrics;
                const version = store.createVersion({
                    applicationId: app.id,
                    parentVersionId: active.id,
                    schema: result.schema,
                    mutations: run.proposedMutations,
                    reason: analysis.ai.reason,
                    evidence: { ...analysis, appliedBy: mode },
                    telemetrySnapshot: metrics,
                    source: 'optimization',
                    aiSource: run.aiSource,
                    optimizationRunId: run.id,
                    cause: 'optimize',
                });
                store.setRunStatus(run.id, 'applied', version.id);
                return { version, run: store.getRun(run.id)! };
            });
        },

        undo(): VersionRecord {
            try {
                return store.undo(app.id);
            } catch (error) {
                if (error instanceof VersionError)
                    throw new RuntimeError(error.message, 409);
                throw error;
            }
        },

        restore(versionId: string): VersionRecord {
            try {
                return store.activateVersion(app.id, versionId, 'restore');
            } catch (error) {
                if (error instanceof VersionError)
                    throw new RuntimeError(error.message, 404);
                throw error;
            }
        },

        /**
         * Ingest client telemetry. Events must reference a real version and a
         * component in that version; the capability is taken from the schema.
         */
        recordTelemetry(raw: unknown[]): {
            accepted: number;
            rejected: number;
        } {
            const schemas = new Map<string, Map<string, string>>();
            const accepted: TelemetryEvent[] = [];
            for (const item of raw) {
                const parsed = IncomingEvent.safeParse(item);
                if (!parsed.success) continue;
                const event = parsed.data;
                if (
                    event.componentId === '__navigation__' &&
                    (![
                        'menu_open',
                        'menu_close',
                        'menu_select',
                        'tab_select',
                        'active_time',
                    ].includes(event.eventType) ||
                        !NavigationPath.min(1).safeParse(event.metadata.path)
                            .success)
                )
                    continue;
                if (!schemas.has(event.versionId)) {
                    const version =
                        store.getVersion(app.id, event.versionId) ??
                        (event.userId
                            ? store.getPersonalVersion(
                                  app.id,
                                  event.userId,
                                  event.versionId
                              )
                            : null);
                    schemas.set(
                        event.versionId,
                        new Map([
                            ...(version?.schema.components.map(
                                (c) => [c.id, c.capability] as [string, string]
                            ) ?? []),
                            ...(version
                                ? [
                                      ['__navigation__', '__navigation__'] as [
                                          string,
                                          string,
                                      ],
                                  ]
                                : []),
                        ])
                    );
                }
                const capabilityId = schemas
                    .get(event.versionId)!
                    .get(event.componentId);
                if (!capabilityId) continue;
                const received = now();
                accepted.push({
                    eventId: event.eventId,
                    applicationId: app.id,
                    versionId: event.versionId,
                    sessionId: event.sessionId,
                    userId: event.userId,
                    componentId: event.componentId,
                    capabilityId,
                    eventType: event.eventType,
                    sinceLoadMs: event.sinceLoadMs,
                    metadata: event.metadata,
                    seeded: false,
                    createdAt:
                        Math.abs(event.timestamp - received) <=
                        MAX_CLOCK_SKEW_MS
                            ? event.timestamp
                            : received,
                });
            }
            store.insertEvents(accepted);
            return {
                accepted: accepted.length,
                rejected: raw.length - accepted.length,
            };
        },

        /** Add clearly flagged synthetic sessions for the active version. */
        seedDemoSessions(count: number) {
            const version = activeVersion();
            const { events, calls } = seedSessions({
                app,
                schema: version.schema,
                versionId: version.id,
                count,
                now: now(),
            });
            store.transaction(() => {
                store.insertEvents(events);
                for (const call of calls) store.insertCall(call);
            });
            return {
                sessions: count,
                events: events.length,
                calls: calls.length,
            };
        },

        clearSeeded() {
            store.clearSeeded(app.id);
        },

        setMutationRate(rate: number) {
            if (!(typeof rate === 'number' && rate >= 0 && rate <= 1)) {
                throw new RuntimeError('mutationRate must be between 0 and 1.');
            }
            store.setMutationRate(app.id, rate);
            return store.getApplication(app.id)!;
        },
    };
}

export type FlowRuntime = ReturnType<typeof createRuntime>;
