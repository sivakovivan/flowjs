'use client';

import { useEffect, useRef } from 'react';
import type { VersionSummary } from '@/client/api';

const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
});

export function HistoryMenu(props: {
    versions: VersionSummary[];
    activeId: string | null;
    onRestore: (versionId: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) =>
            event.key === 'Escape' && props.onClose();
        const onClick = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node))
                props.onClose();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onClick);
        };
    }, [props]);

    return (
        <div
            className="history"
            ref={ref}
            role="dialog"
            aria-label="UI history"
        >
            <p className="history__title">UI history</p>
            <ol className="history__list">
                {props.versions.map((version) => {
                    const active = version.id === props.activeId;
                    return (
                        <li
                            key={version.id}
                            className={active ? 'is-active' : undefined}
                        >
                            <span className="history__id">{version.id}</span>
                            <div className="history__body">
                                <p className="history__reason">
                                    {version.reason}
                                </p>
                                <p className="history__meta">
                                    {version.parentVersionId
                                        ? `From ${version.parentVersionId}`
                                        : 'Generated from capabilities'}
                                    {', '}
                                    {time.format(version.createdAt)}
                                    {version.aiSource === 'recorded' &&
                                        ', recorded AI response'}
                                </p>
                            </div>
                            {active ? (
                                <span className="history__current">
                                    Current
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    className="chrome-link"
                                    onClick={() => props.onRestore(version.id)}
                                >
                                    Restore
                                </button>
                            )}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
