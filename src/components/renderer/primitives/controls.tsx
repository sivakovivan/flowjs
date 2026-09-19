'use client';

import { useEffect, useRef, useState } from 'react';
import type { ClientCapability } from '@flowjs/core/client/api';
import { tracker } from '@flowjs/core/client/telemetry';
import type { UIComponent } from '@flowjs/core/flow/schema';
import { useRenderer } from '../context';

type StateCapability = Extract<ClientCapability, { kind: 'state' }>;
type ActionCapability = Extract<ClientCapability, { kind: 'action' }>;

interface StateProps {
    component: UIComponent;
    capability: StateCapability;
}

const optionLabel = (capability: StateCapability, option: string) =>
    capability.optionLabels[option] ?? option;

export function Dropdown({ component, capability }: StateProps) {
    const { state, setStateValue } = useRenderer();
    return (
        <select
            className="app-select"
            aria-label={capability.label}
            value={state[capability.id] ?? capability.default}
            onPointerDown={() =>
                tracker.track(component.id, 'interaction_start')
            }
            onFocus={() => tracker.track(component.id, 'interaction_start')}
            onChange={(event) =>
                setStateValue(component.id, capability.id, event.target.value)
            }
        >
            {capability.options.map((option) => (
                <option key={option} value={option}>
                    {optionLabel(capability, option)}
                </option>
            ))}
        </select>
    );
}

/** One button per option. `segmented` joins them into a single control. */
export function OptionButtons({
    component,
    capability,
    segmented,
}: StateProps & { segmented: boolean }) {
    const { state, setStateValue } = useRenderer();
    const current = state[capability.id] ?? capability.default;
    return (
        <div
            className={segmented ? 'app-segmented' : 'app-button-group'}
            role="radiogroup"
            aria-label={capability.label}
        >
            {capability.options.map((option) => (
                <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={option === current}
                    className={option === current ? 'is-active' : undefined}
                    onClick={() =>
                        option !== current &&
                        setStateValue(component.id, capability.id, option)
                    }
                >
                    {optionLabel(capability, option)}
                </button>
            ))}
        </div>
    );
}

const SEARCH_DEBOUNCE_MS = 350;

export function SearchField({ component, capability }: StateProps) {
    const { state, setStateValue } = useRenderer();
    const [draft, setDraft] = useState(state[capability.id] ?? '');
    const committed = useRef(draft);

    useEffect(() => {
        if (draft === committed.current) return;
        const timer = setTimeout(() => {
            committed.current = draft;
            setStateValue(component.id, capability.id, draft);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [draft, component.id, capability.id, setStateValue]);

    return (
        <input
            type="search"
            className="app-input"
            placeholder={`Search ${capability.description.toLowerCase().replace(/^free-text search over /, '')}`}
            aria-label={capability.label}
            value={draft}
            onFocus={() => tracker.track(component.id, 'interaction_start')}
            onChange={(event) => setDraft(event.target.value)}
        />
    );
}

interface ActionProps {
    component: UIComponent;
    capability: ActionCapability;
}

function useAction(component: UIComponent, capability: ActionCapability) {
    const { runAction, selection } = useRenderer();
    const [running, setRunning] = useState(false);

    // Inputs bound to a collection come from that collection's selected row.
    const bound = Object.entries(capability.inputs).flatMap(([name, input]) =>
        input.type === 'string' && input.from
            ? [[name, input.from] as const]
            : []
    );
    const boundValues = Object.fromEntries(
        bound.map(([name, from]) => [name, selection[from] ?? null])
    );
    const missing = bound
        .filter(([name]) => !boundValues[name])
        .map(([, from]) => from);

    async function run(extra: Record<string, string> = {}) {
        tracker.track(component.id, 'component_click', extra);
        if (running || missing.length > 0) return;
        setRunning(true);
        await runAction(capability.id, component.id, {
            ...(boundValues as Record<string, string>),
            ...extra,
        });
        setRunning(false);
    }

    return { run, running, missing, boundValues };
}

function enumInput(capability: ActionCapability) {
    const entry = Object.entries(capability.inputs).find(
        ([, input]) => input.type === 'enum'
    );
    return entry && entry[1].type === 'enum'
        ? { name: entry[0], options: entry[1].options }
        : null;
}

export function ActionButton({ component, capability }: ActionProps) {
    const { run, running, missing, boundValues } = useAction(
        component,
        capability
    );
    const choice = enumInput(capability);
    const [option, setOption] = useState(choice?.options[0] ?? '');
    const target = Object.values(boundValues).find(Boolean);

    return (
        <div className="app-action">
            {choice && (
                <select
                    className="app-select app-select--compact"
                    aria-label={choice.name}
                    value={option}
                    onFocus={() =>
                        tracker.track(component.id, 'interaction_start')
                    }
                    onChange={(event) => setOption(event.target.value)}
                >
                    {choice.options.map((o) => (
                        <option key={o} value={o}>
                            {o.toUpperCase()}
                        </option>
                    ))}
                </select>
            )}
            <button
                type="button"
                className="app-button"
                aria-disabled={missing.length > 0 || running}
                aria-busy={running}
                onClick={() => run(choice ? { [choice.name]: option } : {})}
            >
                {running
                    ? 'Working…'
                    : target
                      ? `${capability.label} ${target}`
                      : capability.label}
            </button>
            {missing.length > 0 && (
                <p className="app-hint">
                    Select a row in {missing.join(', ')} first.
                </p>
            )}
        </div>
    );
}

export function ActionButtonGroup({ component, capability }: ActionProps) {
    const { run, running } = useAction(component, capability);
    const choice = enumInput(capability);
    if (!choice)
        return <ActionButton component={component} capability={capability} />;
    const verb = capability.label.split(' ')[0];
    return (
        <div
            className="app-button-group"
            role="group"
            aria-label={capability.label}
        >
            {choice.options.map((option) => (
                <button
                    key={option}
                    type="button"
                    className="app-button app-button--quiet"
                    aria-busy={running}
                    onClick={() => run({ [choice.name]: option })}
                >
                    {verb} {option.toUpperCase()}
                </button>
            ))}
        </div>
    );
}
