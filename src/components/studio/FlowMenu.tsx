'use client';
import './flow-menu.css';

import { useEffect, useRef, useState } from 'react';
import { MenuGlass } from './MenuGlass';
import { tracker } from '@flowjs/core/client/telemetry';
import {
    api,
    type StudioState,
    type VersionRecord,
} from '@flowjs/core/client/api';

const paths = {
    undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
    redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
    regenerate: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
    history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',
    customize: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
};
function Icon({ name }: { name: keyof typeof paths }) {
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={paths[name]} />
        </svg>
    );
}

export function FlowMenu({
    studio,
    onVersion,
    onRegenerate,
    regenerating,
}: {
    studio: StudioState;
    onVersion: (version: VersionRecord) => Promise<void>;
    onRegenerate: () => Promise<void>;
    regenerating: boolean;
}) {
    const [view, setView] = useState<
        'actions' | 'history' | 'customize' | null
    >(null);
    const [redo, setRedo] = useState<Array<{ from: string; to: string }>>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [prompt, setPrompt] = useState('');
    const root = useRef<HTMLDivElement>(null);
    const launcher = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const selected = useRef(false);
    const active = studio.active!;
    const menuPath = (name: 'actions' | 'history' | 'customize') =>
        name === 'actions' ? ['controls'] : ['controls', name];
    function open(next: 'actions' | 'history' | 'customize') {
        if (view && !selected.current)
            tracker.navigation(
                next === 'actions' ? 'menu_close' : 'menu_select',
                menuPath(view)
            );
        tracker.navigation('menu_open', menuPath(next));
        selected.current = false;
        setView(next);
    }
    function close(restoreFocus = true) {
        if (view && !selected.current)
            tracker.navigation('menu_close', menuPath(view));
        selected.current = false;
        setView(null);
        if (restoreFocus) launcher.current?.focus();
    }
    useEffect(() => {
        if (!view) return;
        panel.current
            ?.querySelector<HTMLElement>('button:not(:disabled), textarea')
            ?.focus();
        const outside = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) close(false);
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [view]);
    async function act(
        kind: 'undo' | 'redo' | 'restore' | 'customize',
        id?: string
    ) {
        if (busy) return;
        tracker.navigation('menu_select', menuPath(view ?? 'actions'));
        selected.current = true;
        setBusy(true);
        setError('');
        try {
            const result =
                kind === 'undo'
                    ? await api.undo()
                    : kind === 'customize'
                      ? await api.generate(prompt.trim())
                      : await api.restore(id!);
            if (kind === 'undo')
                setRedo((items) => [
                    ...items,
                    { from: result.version.id, to: active.id },
                ]);
            else if (kind === 'redo') setRedo((items) => items.slice(0, -1));
            else setRedo([]);
            await onVersion(result.version);
            if (kind === 'customize') setPrompt('');
            close();
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not update dashboard.'
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <div
            className="flow-menu"
            ref={root}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    close();
                }
                if (
                    view === 'actions' &&
                    ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                ) {
                    event.preventDefault();
                    const buttons = Array.from(
                        panel.current?.querySelectorAll<HTMLButtonElement>(
                            'button:not(:disabled)'
                        ) ?? []
                    );
                    const index = buttons.indexOf(
                        document.activeElement as HTMLButtonElement
                    );
                    buttons[
                        event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? buttons.length - 1
                              : (index +
                                    (event.key === 'ArrowUp' ? -1 : 1) +
                                    buttons.length) %
                                buttons.length
                    ]?.focus();
                }
            }}
        >
            {view && (
                <div
                    className="flow-glass flow-menu__panel"
                    ref={panel}
                    id="flow-actions"
                    role="dialog"
                    aria-label="flow.js dashboard controls"
                    aria-busy={busy}
                >
                    <MenuGlass key={view} />
                    <header>
                        <button
                            className="flow-menu__back"
                            onClick={() =>
                                view === 'actions' ? close() : open('actions')
                            }
                            aria-label={
                                view === 'actions'
                                    ? 'Close controls'
                                    : 'Back to controls'
                            }
                        >
                            {view === 'actions' ? '×' : '←'}
                        </button>
                        <span>
                            {view === 'actions'
                                ? 'flow.js'
                                : view === 'history'
                                  ? 'Version history'
                                  : 'Customize'}
                        </span>
                    </header>
                    {view === 'actions' && (
                        <div className="flow-menu__actions">
                            <button
                                disabled={busy || !active.parentVersionId}
                                onClick={() => act('undo')}
                            >
                                <Icon name="undo" />
                                Undo
                            </button>
                            <button
                                disabled={
                                    busy || redo.at(-1)?.from !== active.id
                                }
                                onClick={() => act('redo', redo.at(-1)?.to)}
                            >
                                <Icon name="redo" />
                                Redo
                            </button>
                            <button
                                disabled={busy || regenerating}
                                onClick={() => {
                                    close();
                                    void onRegenerate();
                                }}
                            >
                                <Icon name="regenerate" />
                                {regenerating
                                    ? 'Regenerating…'
                                    : 'Regenerate layout'}
                            </button>
                            <button
                                disabled={busy}
                                onClick={() => open('history')}
                            >
                                <Icon name="history" />
                                Version history<span aria-hidden="true">›</span>
                            </button>
                            <button
                                disabled={busy}
                                onClick={() => open('customize')}
                            >
                                <Icon name="customize" />
                                Customize<span aria-hidden="true">›</span>
                            </button>
                        </div>
                    )}
                    {view === 'history' && (
                        <ol className="flow-menu__versions">
                            {studio.versions.map((version) => (
                                <li key={version.id}>
                                    <div>
                                        <strong>{version.id}</strong>
                                        <p>{version.reason}</p>
                                    </div>
                                    <button
                                        disabled={
                                            busy || version.id === active.id
                                        }
                                        onClick={() =>
                                            act('restore', version.id)
                                        }
                                    >
                                        {version.id === active.id
                                            ? 'Current'
                                            : 'Restore'}
                                    </button>
                                </li>
                            ))}
                        </ol>
                    )}
                    {view === 'customize' && (
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (prompt.trim()) act('customize');
                            }}
                        >
                            <label htmlFor="flow-request">
                                What would you like to change?
                            </label>
                            <textarea
                                id="flow-request"
                                value={prompt}
                                onChange={(event) =>
                                    setPrompt(event.target.value)
                                }
                                maxLength={500}
                                rows={4}
                                placeholder="Make the revenue chart more prominent…"
                            />
                            <button
                                disabled={busy || !prompt.trim()}
                                type="submit"
                            >
                                {busy ? 'Updating…' : 'Apply changes'}
                            </button>
                        </form>
                    )}
                    {error && (
                        <p role="alert" className="flow-menu__error">
                            {error}
                        </p>
                    )}
                </div>
            )}
            <button
                ref={launcher}
                className="flow-glass flow-menu__launcher"
                aria-label="flow.js controls"
                aria-expanded={view !== null}
                aria-controls="flow-actions"
                aria-haspopup="dialog"
                aria-busy={regenerating}
                onClick={() => (view ? close() : open('actions'))}
            >
                <MenuGlass circle />
                <svg
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <path d="M5 8h8a4 4 0 0 1 0 8H8m-3-4h11M8 5v14" />
                </svg>
            </button>
        </div>
    );
}
