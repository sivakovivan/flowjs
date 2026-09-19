'use client';

import type {
    OptimizationAnalysis,
    OptimizationRun,
} from '@flowjs/core/client/api';
import type { Mutation } from '@flowjs/core/flow/mutations';
import { SourceBadge } from './SourceBadge';

function describeMutation(mutation: Mutation): string {
    switch (mutation.type) {
        case 'MOVE':
            return `Move ${mutation.element} ${mutation.position} ${mutation.target}`;
        case 'REORDER':
            return `Reorder ${mutation.element} to position ${mutation.index + 1}`;
        case 'RESIZE':
            return `Resize ${mutation.element} to ${mutation.size}`;
        case 'SWAP_VARIANT':
            return `Swap ${mutation.element} to a ${mutation.variant.replace('-', ' ')}`;
        case 'SHOW':
            return `Show ${mutation.element}`;
        case 'HIDE':
            return `Hide ${mutation.element}`;
    }
}

function sentryLink(org: string | null, kind: 'trace' | 'replay', id: string) {
    if (!org) return null;
    return kind === 'trace'
        ? `https://${org}.sentry.io/explore/traces/trace/${id}/`
        : `https://${org}.sentry.io/explore/replays/${id}/`;
}

function ScoreMeter({ analysis }: { analysis: OptimizationAnalysis }) {
    const { score, decision } = analysis;
    if (!score) return null;
    const clamp = (n: number) => Math.min(100, Math.max(0, n * 100));
    return (
        <div className="score">
            <div
                className="score__bar"
                role="img"
                aria-label={`Score ${score.score}, threshold ${decision.threshold ?? 'disabled'}`}
            >
                <span
                    className="score__fill"
                    style={{ width: `${clamp(score.score)}%` }}
                />
                {decision.threshold !== null && (
                    <span
                        className="score__threshold"
                        style={{ left: `${clamp(decision.threshold)}%` }}
                    />
                )}
            </div>
            <dl className="score__terms">
                <div>
                    <dt>Benefit</dt>
                    <dd>{score.benefit.toFixed(2)}</dd>
                </div>
                <div>
                    <dt>Confidence</dt>
                    <dd>{score.confidence.toFixed(2)}</dd>
                </div>
                <div>
                    <dt>Evidence</dt>
                    <dd>{score.evidence.toFixed(2)}</dd>
                </div>
                <div>
                    <dt>Disruption</dt>
                    <dd>−{score.disruption.toFixed(2)}</dd>
                </div>
                <div>
                    <dt>Score</dt>
                    <dd>
                        <strong>{score.score.toFixed(2)}</strong>
                    </dd>
                </div>
            </dl>
            <p className="score__verdict">
                {decision.threshold === null
                    ? 'Mutation rate is 0, so nothing applies automatically.'
                    : decision.autoApply
                      ? `Clears the ${decision.threshold.toFixed(2)} threshold for automatic application.`
                      : `Below the ${decision.threshold.toFixed(2)} threshold, so it needs your approval.`}
            </p>
        </div>
    );
}

export function EvidencePanel(props: {
    run: OptimizationRun | null;
    optimizing: boolean;
    countdown: number | null;
    applying: boolean;
    sentryOrg: string | null;
    onApply: () => void;
    onCancelAuto: () => void;
}) {
    const { run } = props;
    if (props.optimizing) {
        return (
            <div className="panel-empty" aria-live="polite">
                <p className="panel-empty__title">Analyzing usage…</p>
                <p>
                    Aggregating telemetry and latency, then asking OpenAI for
                    the most important friction.
                </p>
            </div>
        );
    }
    if (!run) {
        return (
            <div className="panel-empty">
                <p className="panel-empty__title">No optimization yet</p>
                <p>
                    Use the dashboard, then choose Optimize now. flow.js will
                    explain what it found before changing anything.
                </p>
            </div>
        );
    }

    const analysis = run.analysis as OptimizationAnalysis;
    const { ai, sampleSize } = analysis;
    const mutations = run.proposedMutations;
    const relevantLatency = analysis.latency
        .filter((l) => l.calls > 0)
        .sort((a, b) => b.p50Ms - a.p50Ms);

    return (
        <article className="evidence" aria-live="polite">
            <header className="evidence__head">
                <span
                    className={`classification classification--${ai.classification}`}
                >
                    {ai.classification === 'performance'
                        ? 'Backend performance'
                        : 'Interface friction'}
                </span>
                <SourceBadge
                    source={ai.source}
                    model={ai.model}
                    fallbackReason={ai.fallbackReason}
                />
            </header>
            <h3 className="evidence__finding">{ai.finding}</h3>
            <p className="evidence__explanation">{ai.explanation}</p>

            <section className="evidence__section">
                <h4>Evidence</h4>
                <ul className="evidence__list">
                    {ai.evidence.map((item) => (
                        <li key={item}>{item}</li>
                    ))}
                </ul>
                <p className="evidence__sample">
                    Based on {sampleSize.sessions} session
                    {sampleSize.sessions === 1 ? '' : 's'} (
                    {sampleSize.liveSessions} live
                    {sampleSize.seededSessions > 0 &&
                        `, ${sampleSize.seededSessions} seeded`}
                    ) and {sampleSize.interactions} interactions. Confidence{' '}
                    {ai.confidence.toFixed(2)}.
                </p>
            </section>

            {analysis.findings.length > 0 && (
                <section className="evidence__section">
                    <h4>Heuristic findings</h4>
                    <ul className="findings">
                        {analysis.findings.slice(0, 4).map((finding) => (
                            <li
                                key={`${finding.kind}:${finding.componentIds.join()}`}
                            >
                                <p>
                                    <span
                                        className={`dot dot--${finding.classification}`}
                                        aria-hidden
                                    />
                                    {finding.title}
                                </p>
                                <p className="findings__evidence">
                                    {finding.evidence.join('; ')}
                                </p>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {relevantLatency.length > 0 && (
                <section className="evidence__section">
                    <h4>Backend latency</h4>
                    <table className="latency">
                        <thead>
                            <tr>
                                <th>Capability</th>
                                <th className="is-numeric">p50</th>
                                <th className="is-numeric">p95</th>
                                <th>Sentry</th>
                            </tr>
                        </thead>
                        <tbody>
                            {relevantLatency.map((l) => {
                                const trace = l.traceIds[0];
                                const href = trace
                                    ? sentryLink(
                                          props.sentryOrg,
                                          'trace',
                                          trace
                                      )
                                    : null;
                                return (
                                    <tr
                                        key={l.capabilityId}
                                        className={
                                            l.slow ? 'is-slow' : undefined
                                        }
                                    >
                                        <td>{l.capabilityId}</td>
                                        <td className="is-numeric">
                                            {Math.round(l.p50Ms)}ms
                                        </td>
                                        <td
                                            className={`is-numeric ${l.slowTail ? 'is-slow-tail' : ''}`}
                                        >
                                            {Math.round(l.p95Ms)}ms
                                        </td>
                                        <td>
                                            {trace ? (
                                                href ? (
                                                    <a
                                                        href={href}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        {trace.slice(0, 8)}
                                                    </a>
                                                ) : (
                                                    <code title={trace}>
                                                        {trace.slice(0, 8)}
                                                    </code>
                                                )
                                            ) : (
                                                <span className="muted">
                                                    no trace
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}

            <section className="evidence__section">
                <h4>Proposed change</h4>
                {mutations.length === 0 ? (
                    <p>
                        No interface change.{' '}
                        {ai.classification === 'performance' &&
                            'Fix the backend before redesigning this control.'}
                    </p>
                ) : (
                    <ol className="mutations">
                        {mutations.map((mutation, i) => (
                            <li key={i}>
                                <code>{mutation.type}</code>{' '}
                                {describeMutation(mutation)}
                            </li>
                        ))}
                    </ol>
                )}
                {run.status === 'rejected' && (
                    <div className="rejected" role="alert">
                        <p>
                            flow.js rejected this proposal. Nothing was changed.
                        </p>
                        <ul>
                            {run.errors.map((error) => (
                                <li key={error}>{error}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>

            <ScoreMeter analysis={analysis} />

            <footer className="evidence__actions">
                {run.status === 'applied' && (
                    <p className="applied">
                        Applied as {run.appliedVersionId}.
                    </p>
                )}
                {run.status === 'stale' && (
                    <p className="muted">
                        The dashboard changed since this proposal. Optimize
                        again.
                    </p>
                )}
                {run.status === 'auto' && props.countdown !== null && (
                    <>
                        <p>Applying automatically in {props.countdown}s…</p>
                        <button
                            type="button"
                            className="chrome-button"
                            onClick={props.onCancelAuto}
                        >
                            Cancel
                        </button>
                    </>
                )}
                {(run.status === 'pending' ||
                    (run.status === 'auto' && props.countdown === null)) && (
                    <button
                        type="button"
                        className="chrome-button chrome-button--signal"
                        onClick={props.onApply}
                        disabled={props.applying}
                    >
                        {props.applying ? 'Applying…' : 'Apply change'}
                    </button>
                )}
            </footer>
        </article>
    );
}
