'use client';

import type { StudioState } from '@/client/api';

/** What the developer supplied: capabilities and their graph, not a layout. */
export function CapabilitiesPanel({ studio }: { studio: StudioState }) {
    return (
        <div className="capabilities">
            <p className="muted">{studio.application.context}</p>
            <ul className="capability-list">
                {studio.capabilities.map((c) => (
                    <li key={c.id}>
                        <p>
                            <span className={`kind kind--${c.kind}`}>
                                {c.kind}
                            </span>
                            <strong>{c.id}</strong>
                            {c.required && (
                                <span className="muted"> required</span>
                            )}
                        </p>
                        <p className="muted">{c.description}</p>
                        <p className="capability-list__meta">
                            Renders as {c.compatiblePrimitives.join(', ')}
                            {c.dependsOn.length > 0 &&
                                `. Reads ${c.dependsOn.join(', ')}`}
                            .
                        </p>
                    </li>
                ))}
            </ul>
        </div>
    );
}
