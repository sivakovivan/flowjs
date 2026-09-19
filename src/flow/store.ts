import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Mutation } from './mutations';
import type { FlowApp } from './registry';
import type { UISchema } from './schema';

/*
 * Local persistence on Node's built-in SQLite. UI versions are immutable
 * (enforced by triggers); activating a version is the only way the dashboard
 * changes, and every activation is logged.
 */

export type VersionSource = 'generated' | 'optimization';
export type ActivationCause = 'generate' | 'optimize' | 'undo' | 'restore';
export type AISource = 'live' | 'recorded';

export interface VersionRecord {
    id: string;
    applicationId: string;
    number: number;
    parentVersionId: string | null;
    schema: UISchema;
    mutations: Mutation[];
    reason: string;
    evidence: unknown;
    telemetrySnapshot: unknown;
    source: VersionSource;
    aiSource: AISource | null;
    optimizationRunId: string | null;
    createdAt: number;
}

export interface ApplicationRecord {
    id: string;
    name: string;
    context: string;
    mutationRate: number;
    activeVersionId: string | null;
    theme: FlowApp['theme'];
    createdAt: number;
}

export const TELEMETRY_EVENT_TYPES = [
    'component_view',
    'component_hover',
    'component_scroll',
    'component_focus',
    'disabled_interaction',
    'component_click',
    'value_change',
    'interaction_start',
    'interaction_complete',
    'interaction_error',
] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export interface TelemetryEvent {
    applicationId: string;
    versionId: string;
    sessionId: string;
    userId: string | null;
    componentId: string;
    capabilityId: string;
    eventType: TelemetryEventType;
    /** Milliseconds since this session's dashboard was loaded. */
    sinceLoadMs: number;
    metadata: Record<string, unknown>;
    seeded: boolean;
    createdAt: number;
}

export interface CapabilityCall {
    applicationId: string;
    versionId: string | null;
    sessionId: string | null;
    componentId: string | null;
    capabilityId: string;
    kind: 'data' | 'action';
    latencyMs: number;
    ok: boolean;
    error: string | null;
    traceId: string | null;
    replayId: string | null;
    seeded: boolean;
    createdAt: number;
}

export type RunStatus =
    'rejected' | 'pending' | 'auto' | 'applied' | 'no-change' | 'stale';

export interface OptimizationRun {
    id: string;
    applicationId: string;
    sourceVersionId: string;
    status: RunStatus;
    analysis: unknown;
    proposedMutations: Mutation[];
    score: unknown;
    threshold: number | null;
    mutationRate: number;
    aiSource: AISource;
    errors: string[];
    appliedVersionId: string | null;
    createdAt: number;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  context TEXT NOT NULL,
  mutation_rate REAL NOT NULL CHECK (mutation_rate >= 0 AND mutation_rate <= 1),
  active_version_id TEXT,
  theme TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  schema TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (application_id, id)
);

CREATE TABLE IF NOT EXISTS ui_versions (
  id TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  number INTEGER NOT NULL,
  parent_version_id TEXT,
  config_json TEXT NOT NULL,
  mutations_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT,
  telemetry_snapshot_json TEXT,
  source TEXT NOT NULL,
  ai_source TEXT,
  optimization_run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (application_id, id),
  UNIQUE (application_id, number)
);

CREATE TRIGGER IF NOT EXISTS ui_versions_immutable_update
BEFORE UPDATE ON ui_versions
BEGIN SELECT RAISE(ABORT, 'ui_versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS ui_versions_immutable_delete
BEFORE DELETE ON ui_versions
BEGIN SELECT RAISE(ABORT, 'ui_versions are immutable'); END;

CREATE TABLE IF NOT EXISTS version_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  component_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  since_load_ms REAL NOT NULL,
  metadata TEXT NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_events_version ON telemetry_events (application_id, version_id);

CREATE TABLE IF NOT EXISTS capability_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  version_id TEXT,
  session_id TEXT,
  component_id TEXT,
  capability_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  latency_ms REAL NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  trace_id TEXT,
  replay_id TEXT,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_calls_app ON capability_calls (application_id, capability_id);

CREATE TABLE IF NOT EXISTS optimization_runs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  analysis TEXT NOT NULL,
  proposed_mutations TEXT NOT NULL,
  score TEXT,
  threshold REAL,
  mutation_rate REAL NOT NULL,
  ai_source TEXT NOT NULL,
  errors TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  applied_version_id TEXT,
  created_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

const json = (value: unknown) =>
    value === undefined ? null : JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T =>
    typeof value === 'string' ? (JSON.parse(value) as T) : fallback;

function toVersion(row: Row): VersionRecord {
    return {
        id: row.id as string,
        applicationId: row.application_id as string,
        number: Number(row.number),
        parentVersionId: (row.parent_version_id as string | null) ?? null,
        schema: parse(row.config_json, { components: [] }),
        mutations: parse(row.mutations_json, []),
        reason: row.reason as string,
        evidence: parse(row.evidence_json, null),
        telemetrySnapshot: parse(row.telemetry_snapshot_json, null),
        source: row.source as VersionSource,
        aiSource: (row.ai_source as AISource | null) ?? null,
        optimizationRunId: (row.optimization_run_id as string | null) ?? null,
        createdAt: Number(row.created_at),
    };
}

function toRun(row: Row): OptimizationRun {
    return {
        id: row.id as string,
        applicationId: row.application_id as string,
        sourceVersionId: row.source_version_id as string,
        status: row.status as RunStatus,
        analysis: parse(row.analysis, null),
        proposedMutations: parse(row.proposed_mutations, []),
        score: parse(row.score, null),
        threshold: row.threshold === null ? null : Number(row.threshold),
        mutationRate: Number(row.mutation_rate),
        aiSource: row.ai_source as AISource,
        errors: parse(row.errors, []),
        appliedVersionId: (row.applied_version_id as string | null) ?? null,
        createdAt: Number(row.created_at),
    };
}

export class VersionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VersionError';
    }
}

export class FlowStore {
    readonly db: DatabaseSync;

    constructor(
        path = ':memory:',
        private readonly now: () => number = Date.now
    ) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
        this.db.exec(MIGRATION);
    }

    close() {
        this.db.close();
    }

    /** Run `fn` in one transaction; nested calls join the outer transaction. */
    transaction<T>(fn: () => T): T {
        if (this.db.isTransaction) return fn();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // ── applications & capabilities ───────────────────────────────────────────

    /** Upsert the application and its capability descriptors; keeps the persisted mutation rate. */
    syncApplication(app: FlowApp): ApplicationRecord {
        return this.transaction(() => {
            const now = this.now();
            this.db
                .prepare(
                    `INSERT INTO applications (id, name, context, mutation_rate, active_version_id, theme, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, context = excluded.context, theme = excluded.theme`
                )
                .run(
                    app.id,
                    app.name,
                    app.context,
                    app.mutationRate,
                    JSON.stringify(app.theme),
                    now
                );
            this.db
                .prepare('DELETE FROM capabilities WHERE application_id = ?')
                .run(app.id);
            const insert = this.db.prepare(
                `INSERT INTO capabilities (id, application_id, kind, description, schema, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            for (const capability of app.capabilities) {
                const {
                    id,
                    kind,
                    description,
                    label,
                    dependsOn,
                    required,
                    ...shape
                } = capability;
                insert.run(
                    id,
                    app.id,
                    kind,
                    description,
                    JSON.stringify(shape),
                    JSON.stringify({ label, dependsOn, required }),
                    now
                );
            }
            return this.getApplication(app.id)!;
        });
    }

    getApplication(id: string): ApplicationRecord | null {
        const row = this.db
            .prepare('SELECT * FROM applications WHERE id = ?')
            .get(id) as Row | undefined;
        if (!row) return null;
        return {
            id: row.id as string,
            name: row.name as string,
            context: row.context as string,
            mutationRate: Number(row.mutation_rate),
            activeVersionId: (row.active_version_id as string | null) ?? null,
            theme: JSON.parse(row.theme as string),
            createdAt: Number(row.created_at),
        };
    }

    setMutationRate(applicationId: string, rate: number): void {
        if (!(rate >= 0 && rate <= 1))
            throw new RangeError('mutationRate must be between 0 and 1.');
        this.db
            .prepare('UPDATE applications SET mutation_rate = ? WHERE id = ?')
            .run(rate, applicationId);
    }

    // ── versions ──────────────────────────────────────────────────────────────

    /** Commit an immutable version and activate it in the same transaction. */
    createVersion(input: {
        applicationId: string;
        parentVersionId: string | null;
        schema: UISchema;
        mutations: Mutation[];
        reason: string;
        evidence?: unknown;
        telemetrySnapshot?: unknown;
        source: VersionSource;
        aiSource: AISource | null;
        optimizationRunId?: string | null;
        cause: ActivationCause;
    }): VersionRecord {
        return this.transaction(() => {
            if (
                input.parentVersionId &&
                !this.getVersion(input.applicationId, input.parentVersionId)
            ) {
                throw new VersionError(
                    `Parent version "${input.parentVersionId}" does not exist.`
                );
            }
            const { next } = this.db
                .prepare(
                    'SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ui_versions WHERE application_id = ?'
                )
                .get(input.applicationId) as { next: number };
            const id = `v${next}`;
            this.db
                .prepare(
                    `INSERT INTO ui_versions (id, application_id, number, parent_version_id, config_json, mutations_json,
             reason, evidence_json, telemetry_snapshot_json, source, ai_source, optimization_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    id,
                    input.applicationId,
                    next,
                    input.parentVersionId,
                    JSON.stringify(input.schema),
                    JSON.stringify(input.mutations),
                    input.reason,
                    json(input.evidence),
                    json(input.telemetrySnapshot),
                    input.source,
                    input.aiSource,
                    input.optimizationRunId ?? null,
                    this.now()
                );
            this.activateVersion(input.applicationId, id, input.cause);
            return this.getVersion(input.applicationId, id)!;
        });
    }

    activateVersion(
        applicationId: string,
        versionId: string,
        cause: ActivationCause
    ): VersionRecord {
        return this.transaction(() => {
            const version = this.getVersion(applicationId, versionId);
            if (!version)
                throw new VersionError(
                    `Version "${versionId}" does not exist.`
                );
            this.db
                .prepare(
                    'UPDATE applications SET active_version_id = ? WHERE id = ?'
                )
                .run(versionId, applicationId);
            this.db
                .prepare(
                    'INSERT INTO version_activations (application_id, version_id, cause, created_at) VALUES (?, ?, ?, ?)'
                )
                .run(applicationId, versionId, cause, this.now());
            return version;
        });
    }

    /** Activate the active version's parent. History is never deleted. */
    undo(applicationId: string): VersionRecord {
        return this.transaction(() => {
            const active = this.getActiveVersion(applicationId);
            if (!active) throw new VersionError('There is no active version.');
            if (!active.parentVersionId)
                throw new VersionError(
                    `${active.id} has no parent to undo to.`
                );
            return this.activateVersion(
                applicationId,
                active.parentVersionId,
                'undo'
            );
        });
    }

    getVersion(applicationId: string, id: string): VersionRecord | null {
        const row = this.db
            .prepare(
                'SELECT * FROM ui_versions WHERE application_id = ? AND id = ?'
            )
            .get(applicationId, id) as Row | undefined;
        return row ? toVersion(row) : null;
    }

    getActiveVersion(applicationId: string): VersionRecord | null {
        const app = this.getApplication(applicationId);
        return app?.activeVersionId
            ? this.getVersion(applicationId, app.activeVersionId)
            : null;
    }

    listVersions(applicationId: string): VersionRecord[] {
        return (
            this.db
                .prepare(
                    'SELECT * FROM ui_versions WHERE application_id = ? ORDER BY number DESC'
                )
                .all(applicationId) as Row[]
        ).map(toVersion);
    }

    /** Activations since `sinceMs`, excluding the initial generation. */
    countRecentActivations(applicationId: string, sinceMs: number): number {
        const { count } = this.db
            .prepare(
                "SELECT COUNT(*) AS count FROM version_activations WHERE application_id = ? AND created_at >= ? AND cause != 'generate'"
            )
            .get(applicationId, sinceMs) as { count: number };
        return Number(count);
    }

    // ── telemetry ─────────────────────────────────────────────────────────────

    insertEvents(events: TelemetryEvent[]): void {
        if (events.length === 0) return;
        this.transaction(() => {
            const insert = this.db.prepare(
                `INSERT INTO telemetry_events (application_id, version_id, session_id, user_id, component_id, capability_id,
           event_type, since_load_ms, metadata, seeded, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const e of events) {
                insert.run(
                    e.applicationId,
                    e.versionId,
                    e.sessionId,
                    e.userId,
                    e.componentId,
                    e.capabilityId,
                    e.eventType,
                    e.sinceLoadMs,
                    JSON.stringify(e.metadata),
                    e.seeded ? 1 : 0,
                    e.createdAt
                );
            }
        });
    }

    listEvents(applicationId: string, versionId: string): TelemetryEvent[] {
        const rows = this.db
            .prepare(
                'SELECT * FROM telemetry_events WHERE application_id = ? AND version_id = ? ORDER BY created_at, id'
            )
            .all(applicationId, versionId) as Row[];
        return rows.map((row) => ({
            applicationId: row.application_id as string,
            versionId: row.version_id as string,
            sessionId: row.session_id as string,
            userId: (row.user_id as string | null) ?? null,
            componentId: row.component_id as string,
            capabilityId: row.capability_id as string,
            eventType: row.event_type as TelemetryEventType,
            sinceLoadMs: Number(row.since_load_ms),
            metadata: parse(row.metadata, {}),
            seeded: Number(row.seeded) === 1,
            createdAt: Number(row.created_at),
        }));
    }

    insertCall(call: CapabilityCall): void {
        this.db
            .prepare(
                `INSERT INTO capability_calls (application_id, version_id, session_id, component_id, capability_id, kind,
           latency_ms, ok, error, trace_id, replay_id, seeded, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                call.applicationId,
                call.versionId,
                call.sessionId,
                call.componentId,
                call.capabilityId,
                call.kind,
                call.latencyMs,
                call.ok ? 1 : 0,
                call.error,
                call.traceId,
                call.replayId,
                call.seeded ? 1 : 0,
                call.createdAt
            );
    }

    /** Capability calls, newest first. Latency describes the backend, so it is not scoped to a UI version. */
    listCalls(applicationId: string, limit = 2000): CapabilityCall[] {
        const rows = this.db
            .prepare(
                'SELECT * FROM capability_calls WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
            )
            .all(applicationId, limit) as Row[];
        return rows.map((row) => ({
            applicationId: row.application_id as string,
            versionId: (row.version_id as string | null) ?? null,
            sessionId: (row.session_id as string | null) ?? null,
            componentId: (row.component_id as string | null) ?? null,
            capabilityId: row.capability_id as string,
            kind: row.kind as 'data' | 'action',
            latencyMs: Number(row.latency_ms),
            ok: Number(row.ok) === 1,
            error: (row.error as string | null) ?? null,
            traceId: (row.trace_id as string | null) ?? null,
            replayId: (row.replay_id as string | null) ?? null,
            seeded: Number(row.seeded) === 1,
            createdAt: Number(row.created_at),
        }));
    }

    /** Remove seeded demo telemetry, leaving live data untouched. */
    clearSeeded(applicationId: string): void {
        this.transaction(() => {
            this.db
                .prepare(
                    'DELETE FROM telemetry_events WHERE application_id = ? AND seeded = 1'
                )
                .run(applicationId);
            this.db
                .prepare(
                    'DELETE FROM capability_calls WHERE application_id = ? AND seeded = 1'
                )
                .run(applicationId);
        });
    }

    // ── optimization runs ─────────────────────────────────────────────────────

    createRun(
        input: Omit<OptimizationRun, 'id' | 'createdAt' | 'appliedVersionId'>
    ): OptimizationRun {
        const id = randomUUID();
        this.db
            .prepare(
                `INSERT INTO optimization_runs (id, application_id, source_version_id, status, analysis, proposed_mutations,
           score, threshold, mutation_rate, ai_source, errors, accepted, applied_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
            )
            .run(
                id,
                input.applicationId,
                input.sourceVersionId,
                input.status,
                JSON.stringify(input.analysis),
                JSON.stringify(input.proposedMutations),
                json(input.score),
                input.threshold,
                input.mutationRate,
                input.aiSource,
                JSON.stringify(input.errors),
                this.now()
            );
        return this.getRun(id)!;
    }

    getRun(id: string): OptimizationRun | null {
        const row = this.db
            .prepare('SELECT * FROM optimization_runs WHERE id = ?')
            .get(id) as Row | undefined;
        return row ? toRun(row) : null;
    }

    setRunStatus(
        id: string,
        status: RunStatus,
        appliedVersionId: string | null = null
    ): void {
        this.db
            .prepare(
                'UPDATE optimization_runs SET status = ?, accepted = ?, applied_version_id = ? WHERE id = ?'
            )
            .run(status, status === 'applied' ? 1 : 0, appliedVersionId, id);
    }
}
