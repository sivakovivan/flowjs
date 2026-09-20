import type {
    OptimizationAnalysis,
    AIProvenance,
} from '@flowjs/core/flow/runtime';
import type { Finding } from '@flowjs/core/flow/friction';
import type { Metrics } from '@flowjs/core/flow/metrics';
import type { Primitive } from '@flowjs/core/flow/primitives';
import type { LayoutTracks } from '@flowjs/core/flow/layout-tracks';
import type {
    CapabilityDescriptor,
    StateValues,
} from '@flowjs/core/flow/registry';
import type {
    ApplicationRecord,
    OptimizationRun,
    VersionRecord,
} from '@flowjs/core/flow/store';

/* Typed client for the flow.js route handlers. */

export type ClientCapability = CapabilityDescriptor & {
    compatiblePrimitives: Primitive[];
};
export type VersionSummary = Omit<
    VersionRecord,
    'schema' | 'telemetrySnapshot'
>;

export interface StudioState {
    application: ApplicationRecord;
    capabilities: ClientCapability[];
    graph: Array<{ from: string; to: string }>;
    defaultState: StateValues;
    active: VersionRecord | null;
    /** Scaffold for aggregate and per-user layout tracks. */
    layouts?: LayoutTracks;
    versions: VersionSummary[];
    ai: {
        liveConfigured: boolean;
        forcedRecorded: boolean;
        model: string | null;
    };
    sentry: { enabled: boolean; org: string | null };
    registration: string | null;
}

export interface MetricsResponse {
    versionId: string;
    metrics: Metrics;
    findings: Finding[];
}

export type {
    AIProvenance,
    OptimizationAnalysis,
    OptimizationRun,
    VersionRecord,
};

export class ApiError extends Error {}

async function request<T>(
    method: string,
    path: string,
    body?: unknown
): Promise<T> {
    const response = await fetch(`/api/flow${path}`, {
        method,
        headers:
            body === undefined
                ? undefined
                : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new ApiError(
            payload.error ?? `Request failed (${response.status}).`
        );
    return payload as T;
}

export const api = {
    state: (userId?: string) =>
        request<StudioState>(
            'GET',
            `/state${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`
        ),
    generate: (userRequest?: string) =>
        request<{ version: VersionRecord; provenance: AIProvenance | null }>(
            'POST',
            '/generate',
            userRequest ? { userRequest } : undefined
        ),
    metrics: () => request<MetricsResponse>('GET', '/metrics'),
    optimize: () => request<OptimizationRun>('POST', '/optimize'),
    refreshOptimize: () =>
        request<{
            run: OptimizationRun | null;
            version: VersionRecord | null;
            applied: boolean;
        }>('POST', '/refresh'),
    refreshPersonal: (userId: string) =>
        request<{
            version: VersionRecord;
            provenance: AIProvenance;
            applied: true;
        }>('POST', '/personal-refresh', { userId }),
    apply: (runId: string, mode: 'auto' | 'manual') =>
        request<{ version: VersionRecord; run: OptimizationRun }>(
            'POST',
            `/optimize/${runId}/apply`,
            { mode }
        ),
    undo: () => request<{ version: VersionRecord }>('POST', '/versions/undo'),
    restore: (versionId: string) =>
        request<{ version: VersionRecord }>(
            'POST',
            `/versions/${versionId}/restore`
        ),
    setMutationRate: (mutationRate: number) =>
        request<{ application: ApplicationRecord }>('PATCH', '/settings', {
            mutationRate,
        }),
    seed: (sessions = 6) =>
        request<{ sessions: number }>('POST', '/telemetry/seed', { sessions }),
    clearSeeded: () =>
        request<{ cleared: boolean }>('DELETE', '/telemetry/seed'),
    data: (capability: string, body: Record<string, unknown>) =>
        request<{ value: unknown; traceId: string | null }>(
            'POST',
            `/data/${capability}`,
            body
        ),
    action: (capability: string, body: Record<string, unknown>) =>
        request<{ value: unknown; traceId: string | null }>(
            'POST',
            `/actions/${capability}`,
            body
        ),
};
