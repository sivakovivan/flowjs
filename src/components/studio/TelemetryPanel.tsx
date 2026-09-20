'use client';

import type { MetricsResponse } from '@flowjs/core/client/api';
import type { AggregateEvidence } from '@flowjs/core/flow/analytics';
import { describeLatency } from '@flowjs/core/flow/friction';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number | null) =>
    ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`;

export function TelemetryPanel(props: {
    data: MetricsResponse | null;
    aggregate?: AggregateEvidence;
    onSeed: () => void;
    onClearSeeded: () => void;
    busy: boolean;
}) {
    const { data } = props;
    if (!data) {
        return (
            <div className="panel-empty">
                <p className="panel-empty__title">Waiting for telemetry</p>
                <p>
                    Every generated component reports views, clicks, value
                    changes and action results.
                </p>
            </div>
        );
    }
    const { metrics, findings } = data;
    const rows = [...metrics.components]
        .filter((c) => c.views + c.interactions > 0)
        .sort((a, b) => b.interactions - a.interactions);

    return (
        <div className="telemetry">
            {props.aggregate && (
                <section
                    className="evidence__section"
                    aria-label="Aggregate baseline evidence"
                >
                    <h4>Aggregate baseline evidence</h4>
                    <p>
                        {props.aggregate.sampleKind === 'simulated'
                            ? 'Simulated cohort'
                            : 'Live cohort'}
                        {' · '}
                        {props.aggregate.population.users} browsers
                        {' · '}
                        {props.aggregate.population.sessions} sessions
                        {' · '}
                        {props.aggregate.population.interactions} interactions
                    </p>
                    <p className="muted">
                        {new Date(props.aggregate.window.from)
                            .toISOString()
                            .slice(0, 10)}{' '}
                        UTC
                        {' · Source layout '}
                        {props.aggregate.versionId}
                        {' · Tiger Data'}
                    </p>
                    <ul className="findings">
                        {props.aggregate.insights
                            .slice(0, 5)
                            .map((insight, index) => (
                                <li key={`${insight.kind}:${index}`}>
                                    <p>{insight.summary}</p>
                                </li>
                            ))}
                    </ul>
                </section>
            )}
            <section className="telemetry__sessions">
                <p>
                    <strong>{metrics.sessions.total}</strong> session
                    {metrics.sessions.total === 1 ? '' : 's'} on{' '}
                    {data.versionId}: {metrics.sessions.live} live
                    {metrics.sessions.seeded > 0 && (
                        <>
                            ,{' '}
                            <span className="seeded">
                                {metrics.sessions.seeded} seeded
                            </span>
                        </>
                    )}
                    . {metrics.totalInteractions} interactions.
                </p>
                <div className="telemetry__seed">
                    <button
                        type="button"
                        className="chrome-button"
                        onClick={props.onSeed}
                        disabled={props.busy}
                    >
                        Add 6 seeded sessions
                    </button>
                    {metrics.sessions.seeded > 0 && (
                        <button
                            type="button"
                            className="chrome-link"
                            onClick={props.onClearSeeded}
                            disabled={props.busy}
                        >
                            Remove seeded data
                        </button>
                    )}
                </div>
                <p className="muted">
                    Seeded sessions are synthetic demo data and are counted
                    separately everywhere.
                </p>
            </section>

            <section className="evidence__section">
                <h4>Components</h4>
                <table className="metrics-table">
                    <thead>
                        <tr>
                            <th>Component</th>
                            <th
                                className="is-numeric"
                                title="Share of sessions that used it"
                            >
                                Used
                            </th>
                            <th
                                className="is-numeric"
                                title="Average time until first interaction"
                            >
                                Found
                            </th>
                            <th
                                className="is-numeric"
                                title="Interactions repeated within 30 seconds"
                            >
                                Repeat
                            </th>
                            <th className="is-numeric">Uses</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((c) => (
                            <tr key={c.componentId}>
                                <td>{c.componentId}</td>
                                <td className="is-numeric">
                                    {pct(c.usageRate)}
                                </td>
                                <td className="is-numeric">
                                    {secs(c.avgDiscoveryMs)}
                                </td>
                                <td className="is-numeric">
                                    {pct(c.repeatRate)}
                                </td>
                                <td className="is-numeric">{c.interactions}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            {metrics.transitions.length > 0 && (
                <section className="evidence__section">
                    <h4>Common sequences</h4>
                    <ul className="sequences">
                        {metrics.transitions.slice(0, 5).map((t) => (
                            <li key={`${t.from}>${t.to}`}>
                                <span>{t.from}</span>
                                <span aria-label="then">→</span>
                                <span>{t.to}</span>
                                <span className="muted">{t.count}×</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {metrics.latency.length > 0 && (
                <section className="evidence__section">
                    <h4>Backend latency</h4>
                    <ul className="latency-list">
                        {metrics.latency.map((l) => (
                            <li
                                key={l.capabilityId}
                                className={l.slow ? 'is-slow' : undefined}
                            >
                                <span>{l.capabilityId}</span>
                                <span className="muted">
                                    {describeLatency(l)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="evidence__section">
                <h4>Friction detected</h4>
                {findings.length === 0 ? (
                    <p className="muted">
                        Nothing stands out yet. Heuristics need repeated use
                        before they fire.
                    </p>
                ) : (
                    <ul className="findings">
                        {findings.map((f) => (
                            <li key={`${f.kind}:${f.componentIds.join()}`}>
                                <p>
                                    <span
                                        className={`dot dot--${f.classification}`}
                                        aria-hidden
                                    />
                                    {f.title}
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
