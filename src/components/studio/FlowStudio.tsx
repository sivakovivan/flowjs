'use client';

import { MotionConfig } from 'motion/react';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import {
    api,
    type MetricsResponse,
    type OptimizationRun,
    type StudioState,
    type VersionRecord,
} from '@flowjs/core/client/api';
import { tracker } from '@flowjs/core/client/telemetry';
import { diffSchemas, type ComponentChange } from '@flowjs/core/flow/schema';
import { acceptanceThreshold } from '@flowjs/core/flow/scoring';
import { Dashboard } from '../renderer/Dashboard';
import { RendererProvider, type Notice } from '../renderer/context';
import { CapabilitiesPanel } from './CapabilitiesPanel';
import { EvidencePanel } from './EvidencePanel';
import { GeneratePrompt } from './GeneratePrompt';
import { HistoryMenu } from './HistoryMenu';
import { SourceBadge } from './SourceBadge';
import { TelemetryPanel } from './TelemetryPanel';
import { CustomizationChat } from './CustomizationChat';

type Tab = 'evidence' | 'telemetry' | 'capabilities';

const AUTO_APPLY_DELAY_S = 3;
const METRICS_POLL_MS = 4_000;
const HIGHLIGHT_MS = 6_000;

function themeStyle(theme: StudioState['application']['theme']): CSSProperties {
    return {
        '--app-primary': theme.primary,
        '--app-bg': theme.background,
        '--app-fg': theme.foreground,
        '--app-surface': theme.surface,
        '--app-radius': `${theme.radius}px`,
        '--app-space': `${theme.spacing}px`,
        '--app-font': `var(--font-inter), ${theme.fontFamily}, system-ui, sans-serif`,
    } as CSSProperties;
}

export function FlowStudio({
    developerMode = false,
}: {
    developerMode?: boolean;
}) {
    const [studio, setStudio] = useState<StudioState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState<string | null>(null);
    const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
    const [run, setRun] = useState<OptimizationRun | null>(null);
    const [optimizing, setOptimizing] = useState(false);
    const [applying, setApplying] = useState(false);
    const [countdown, setCountdown] = useState<number | null>(null);
    const [changes, setChanges] = useState<Record<string, ComponentChange[]>>(
        {}
    );
    const [tab, setTab] = useState<Tab>('telemetry');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [operationsOpen, setOperationsOpen] = useState(false);
    const [rate, setRate] = useState(0.5);
    const [busy, setBusy] = useState(false);
    const [notices, setNotices] = useState<Notice[]>([]);
    const noticeId = useRef(0);
    const userToolsRef = useRef<HTMLDivElement>(null);

    const notify = useCallback((tone: Notice['tone'], text: string) => {
        const id = ++noticeId.current;
        setNotices((list) => [...list.slice(-2), { id, tone, text }]);
        setTimeout(
            () => setNotices((list) => list.filter((n) => n.id !== id)),
            4_500
        );
    }, []);

    useEffect(() => {
        if (developerMode) return;
        const close = (event: MouseEvent) => {
            if (
                userToolsRef.current &&
                !userToolsRef.current.contains(event.target as Node)
            ) {
                setOperationsOpen(false);
                setHistoryOpen(false);
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [developerMode]);

    const refreshState = useCallback(async () => {
        const next = await api.state();
        setStudio(next);
        setRate(next.application.mutationRate);
        return next;
    }, []);

    const refreshMetrics = useCallback(async () => {
        try {
            setMetrics(await api.metrics());
        } catch {
            // No active version yet.
        }
    }, []);

    useEffect(() => {
        refreshState().catch((error: Error) => setLoadError(error.message));
    }, [refreshState]);

    const activeId = studio?.active?.id ?? null;
    useEffect(() => {
        if (!activeId) return;
        refreshMetrics();
        const interval = setInterval(refreshMetrics, METRICS_POLL_MS);
        const unsubscribe = tracker.onFlush(refreshMetrics);
        return () => {
            clearInterval(interval);
            unsubscribe();
        };
    }, [activeId, refreshMetrics]);

    /** Switch to another version and highlight what changed. */
    const transitionTo = useCallback(
        async (version: VersionRecord) => {
            const previous = studio?.active;
            if (previous)
                setChanges(diffSchemas(previous.schema, version.schema));
            setStudio((current) =>
                current ? { ...current, active: version } : current
            );
            setTimeout(() => setChanges({}), HIGHLIGHT_MS);
            await refreshState();
            refreshMetrics();
        },
        [refreshMetrics, refreshState, studio?.active]
    );

    async function generate() {
        setGenerating(true);
        setGenerateError(null);
        try {
            const { provenance } = await api.generate();
            await refreshState();
            if (provenance?.source === 'recorded')
                notify('ok', 'Generated v1 from a recorded AI response.');
            else notify('ok', 'Generated v1 with OpenAI.');
        } catch (error) {
            setGenerateError(
                error instanceof Error ? error.message : 'Generation failed.'
            );
        } finally {
            setGenerating(false);
        }
    }

    const apply = useCallback(
        async (target: OptimizationRun, mode: 'auto' | 'manual') => {
            setApplying(true);
            setCountdown(null);
            try {
                const result = await api.apply(target.id, mode);
                setRun(result.run);
                await transitionTo(result.version);
                notify('ok', `${result.version.id}: ${result.version.reason}`);
            } catch (error) {
                notify(
                    'error',
                    error instanceof Error
                        ? error.message
                        : 'Could not apply the change.'
                );
                setRun((current) =>
                    current ? { ...current, status: 'stale' } : current
                );
            } finally {
                setApplying(false);
            }
        },
        [notify, transitionTo]
    );

    async function optimize() {
        tracker.flush();
        setOptimizing(true);
        setTab('evidence');
        setRun(null);
        try {
            const next = await api.optimize();
            setRun(next);
            if (next.status === 'auto') setCountdown(AUTO_APPLY_DELAY_S);
        } catch (error) {
            notify(
                'error',
                error instanceof Error ? error.message : 'Optimization failed.'
            );
        } finally {
            setOptimizing(false);
        }
    }

    // Automatic application waits a moment so the evidence is visible first.
    useEffect(() => {
        if (countdown === null || !run) return;
        if (countdown === 0) {
            apply(run, 'auto');
            return;
        }
        const timer = setTimeout(
            () => setCountdown((n) => (n === null ? null : n - 1)),
            1_000
        );
        return () => clearTimeout(timer);
    }, [countdown, run, apply]);

    async function undo() {
        try {
            const { version } = await api.undo();
            await transitionTo(version);
            notify('ok', `Undone. ${version.id} is active again.`);
        } catch (error) {
            notify(
                'error',
                error instanceof Error ? error.message : 'Nothing to undo.'
            );
        }
    }

    async function restore(versionId: string) {
        setHistoryOpen(false);
        try {
            const { version } = await api.restore(versionId);
            await transitionTo(version);
            notify('ok', `Restored ${version.id}.`);
        } catch (error) {
            notify(
                'error',
                error instanceof Error ? error.message : 'Could not restore.'
            );
        }
    }

    // Persist the mutation rate shortly after the slider settles.
    const savedRate = studio?.application.mutationRate;
    useEffect(() => {
        if (savedRate === undefined || rate === savedRate) return;
        const timer = setTimeout(() => {
            api.setMutationRate(rate).then(
                ({ application }) =>
                    setStudio((s) => (s ? { ...s, application } : s)),
                (error: Error) => notify('error', error.message)
            );
        }, 300);
        return () => clearTimeout(timer);
    }, [rate, savedRate, notify]);

    async function seed() {
        setBusy(true);
        try {
            const result = await api.seed(6);
            notify('ok', `Added ${result.sessions} seeded sessions.`);
            await refreshMetrics();
        } catch (error) {
            notify(
                'error',
                error instanceof Error
                    ? error.message
                    : 'Could not seed sessions.'
            );
        } finally {
            setBusy(false);
        }
    }

    async function clearSeeded() {
        setBusy(true);
        try {
            await api.clearSeeded();
            notify('ok', 'Removed seeded sessions.');
            await refreshMetrics();
        } finally {
            setBusy(false);
        }
    }

    if (loadError) {
        return (
            <main className="studio studio--error">
                <p role="alert">
                    flow.js could not load its state: {loadError}
                </p>
            </main>
        );
    }
    if (!studio) {
        return <main className="studio studio--loading" aria-busy="true" />;
    }

    const active = studio.active;
    const threshold = acceptanceThreshold(rate);
    const generatedProvenance =
        active &&
        (
            active.evidence as {
                ai?: {
                    source: 'live' | 'recorded';
                    model: string;
                    fallbackReason: string | null;
                };
            } | null
        )?.ai;

    return (
        <MotionConfig reducedMotion="user">
            <main className="studio">
                <header className="bar">
                    <div className="bar__brand">
                        <span className="wordmark">flow.js</span>
                        <span className="bar__app">
                            {studio.application.name}
                        </span>
                    </div>

                    {active && developerMode && (
                        <div className="bar__versions">
                            <span
                                className="version-badge"
                                aria-label={`Active version ${active.id}`}
                            >
                                {active.id}
                            </span>
                            <button
                                type="button"
                                className="chrome-button"
                                onClick={undo}
                                disabled={!active.parentVersionId}
                            >
                                ↶ Undo
                            </button>
                            <div className="history-anchor">
                                <button
                                    type="button"
                                    className="chrome-button"
                                    aria-expanded={historyOpen}
                                    onClick={() =>
                                        setHistoryOpen((open) => !open)
                                    }
                                >
                                    History
                                </button>
                                {historyOpen && (
                                    <HistoryMenu
                                        versions={studio.versions}
                                        activeId={active.id}
                                        onRestore={restore}
                                        onClose={() => setHistoryOpen(false)}
                                    />
                                )}
                            </div>
                        </div>
                    )}

                    {active && developerMode && (
                        <div className="bar__controls">
                            <label className="rate">
                                <span className="rate__ends">
                                    <span>Stable</span>
                                    <span>Experimental</span>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={rate}
                                    onChange={(event) =>
                                        setRate(Number(event.target.value))
                                    }
                                    aria-label="Mutation rate"
                                    aria-valuetext={`${rate.toFixed(2)}`}
                                />
                                <span className="rate__hint">
                                    {threshold === null
                                        ? 'Rate 0: never applies changes automatically'
                                        : `Rate ${rate.toFixed(2)}: auto-applies scores of ${threshold.toFixed(2)} or more`}
                                </span>
                            </label>
                            <button
                                type="button"
                                className="chrome-button chrome-button--signal"
                                onClick={optimize}
                                disabled={optimizing || applying}
                            >
                                {optimizing ? 'Optimizing…' : 'Optimize now'}
                            </button>
                        </div>
                    )}
                </header>

                {!active ? (
                    <GeneratePrompt
                        studio={studio}
                        generating={generating}
                        error={generateError}
                        onGenerate={generate}
                    />
                ) : (
                    <div className="workspace">
                        <section
                            className="stage"
                            style={themeStyle(studio.application.theme)}
                            aria-label={`${studio.application.name} dashboard`}
                        >
                            <div className="stage__meta">
                                <p>
                                    Generated interface, {active.id}:{' '}
                                    {active.reason}
                                </p>
                                {generatedProvenance &&
                                    active.source === 'generated' && (
                                        <SourceBadge
                                            source={generatedProvenance.source}
                                            model={generatedProvenance.model}
                                            fallbackReason={
                                                generatedProvenance.fallbackReason
                                            }
                                        />
                                    )}
                            </div>
                            <RendererProvider
                                versionId={active.id}
                                capabilities={studio.capabilities}
                                initialState={studio.defaultState}
                                notify={notify}
                            >
                                <Dashboard
                                    schema={active.schema}
                                    changes={changes}
                                />
                            </RendererProvider>
                        </section>

                        {developerMode && (
                            <aside
                                className="panel"
                                aria-label="flow.js developer console"
                            >
                                <div className="tabs" role="tablist">
                                    {(
                                        [
                                            'telemetry',
                                            'evidence',
                                            'capabilities',
                                        ] as const
                                    ).map((name) => (
                                        <button
                                            key={name}
                                            type="button"
                                            role="tab"
                                            aria-selected={tab === name}
                                            className={
                                                tab === name
                                                    ? 'is-active'
                                                    : undefined
                                            }
                                            onClick={() => setTab(name)}
                                        >
                                            {name === 'telemetry'
                                                ? 'Telemetry'
                                                : name === 'evidence'
                                                  ? 'Optimization'
                                                  : 'Capabilities'}
                                        </button>
                                    ))}
                                </div>
                                <div className="panel__body" role="tabpanel">
                                    {tab === 'telemetry' && (
                                        <TelemetryPanel
                                            data={metrics}
                                            onSeed={seed}
                                            onClearSeeded={clearSeeded}
                                            busy={busy}
                                        />
                                    )}
                                    {tab === 'evidence' && (
                                        <EvidencePanel
                                            run={run}
                                            optimizing={optimizing}
                                            countdown={countdown}
                                            applying={applying}
                                            sentryOrg={studio.sentry.org}
                                            onApply={() =>
                                                run && apply(run, 'manual')
                                            }
                                            onCancelAuto={() =>
                                                setCountdown(null)
                                            }
                                        />
                                    )}
                                    {tab === 'capabilities' && (
                                        <CapabilitiesPanel studio={studio} />
                                    )}
                                </div>
                                <p className="panel__foot">
                                    {studio.sentry.enabled
                                        ? 'Sentry tracing and replay are on.'
                                        : 'Sentry is off (no DSN); latency is still measured locally.'}
                                </p>
                            </aside>
                        )}
                    </div>
                )}

                {active && !developerMode && (
                    <div className="user-tools" ref={userToolsRef}>
                        <CustomizationChat
                            generating={generating}
                            onCustomize={async (prompt) => {
                                setGenerating(true);
                                try {
                                    await api.generate(prompt);
                                    await refreshState();
                                    notify(
                                        'ok',
                                        'Your request created a new dashboard version.'
                                    );
                                } catch (error) {
                                    notify(
                                        'error',
                                        error instanceof Error
                                            ? error.message
                                            : 'Could not customize the dashboard.'
                                    );
                                } finally {
                                    setGenerating(false);
                                }
                            }}
                        />
                        <div className="history-anchor">
                            <button
                                type="button"
                                className="operations-button"
                                aria-expanded={operationsOpen}
                                onClick={() =>
                                    setOperationsOpen((open) => !open)
                                }
                            >
                                Operations
                            </button>
                            {operationsOpen && (
                                <div
                                    className="operations-menu"
                                    role="menu"
                                    aria-label="Dashboard operations"
                                >
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={undo}
                                        disabled={!active.parentVersionId}
                                    >
                                        ↶ Undo
                                    </button>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setOperationsOpen(false);
                                            setHistoryOpen(true);
                                        }}
                                    >
                                        Version history
                                    </button>
                                </div>
                            )}
                            {historyOpen && (
                                <HistoryMenu
                                    versions={studio.versions}
                                    activeId={active.id}
                                    onRestore={restore}
                                    onClose={() => setHistoryOpen(false)}
                                />
                            )}
                        </div>
                    </div>
                )}

                <div className="notices" aria-live="polite">
                    {notices.map((notice) => (
                        <p
                            key={notice.id}
                            className={`notice notice--${notice.tone}`}
                        >
                            {notice.text}
                        </p>
                    ))}
                </div>
            </main>
        </MotionConfig>
    );
}
