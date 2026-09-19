import type { OptimizationAnalysis, AIProvenance } from '@/flow/runtime';
import type { Finding } from '@/flow/friction';
import type { Metrics } from '@/flow/metrics';
import type { Primitive } from '@/flow/primitives';
import type { CapabilityDescriptor, StateValues } from '@/flow/registry';
import type {
    ApplicationRecord,
    OptimizationRun,
    VersionRecord,
} from '@/flow/store';

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
    state: () => request<StudioState>('GET', '/state'),
    generate: (userRequest?: string) =>
        request<{ version: VersionRecord; provenance: AIProvenance | null }>(
            'POST',
            '/generate',
            userRequest ? { userRequest } : undefined
        ),
    metrics: () => request<MetricsResponse>('GET', '/metrics'),
    optimize: () => request<OptimizationRun>('POST', '/optimize'),
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
