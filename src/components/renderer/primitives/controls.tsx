'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientCapability } from '@flowjs/core/client/api';
import { tracker } from '@flowjs/core/client/telemetry';
import type { UIComponent } from '@flowjs/core/flow/schema';
import { useRenderer } from '../context';
import { Button } from '../../ui/button';
import { ButtonGroup } from '../../ui/button-group';
import { Input } from '../../ui/input';
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
} from '../../ui/select';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group';

/** Portal into the owning dashboard so developer theme variables are inherited. */
function ChoiceSelect({
    label,
    value,
    options,
    onChange,
    onStart,
    compact = false,
}: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    onStart: () => void;
    compact?: boolean;
}) {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    const triggerRef = useCallback((node: HTMLButtonElement | null) => {
        setContainer(node?.closest<HTMLElement>('.stage') ?? null);
    }, []);
    return (
        <Select
            value={value}
            onValueChange={onChange}
            onOpenChange={(open) => {
                if (open) onStart();
            }}
        >
            <SelectTrigger
                ref={triggerRef}
                aria-label={label}
                className={compact ? 'w-auto' : 'w-full'}
                onFocus={onStart}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent container={container} position="popper">
                {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

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
        <ChoiceSelect
            label={capability.label}
            value={state[capability.id] ?? capability.default}
            options={capability.options.map((option) => ({
                value: option,
                label: optionLabel(capability, option),
            }))}
            onStart={() => tracker.track(component.id, 'interaction_start')}
            onChange={(value) =>
                setStateValue(component.id, capability.id, value)
            }
        />
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
        <ToggleGroup
            type="single"
            role="radiogroup"
            variant="outline"
            spacing={segmented ? 0 : 2}
            className="max-w-full flex-wrap"
            aria-label={capability.label}
            value={current}
            onValueChange={(value) => {
                if (value && value !== current)
                    setStateValue(component.id, capability.id, value);
            }}
        >
            {capability.options.map((option) => (
                <ToggleGroupItem
                    key={option}
                    value={option}
                    className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                    {optionLabel(capability, option)}
                </ToggleGroupItem>
            ))}
        </ToggleGroup>
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
        <Input
            type="search"
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
        try {
            await runAction(capability.id, component.id, {
                ...(boundValues as Record<string, string>),
                ...extra,
            });
        } finally {
            setRunning(false);
        }
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
                <ChoiceSelect
                    compact
                    label={choice.name}
                    value={option}
                    options={choice.options.map((value) => ({
                        value,
                        label: value.toUpperCase(),
                    }))}
                    onStart={() =>
                        tracker.track(component.id, 'interaction_start')
                    }
                    onChange={setOption}
                />
            )}
            <Button
                type="button"
                className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                aria-disabled={missing.length > 0 || running}
                aria-busy={running}
                onClick={() => run(choice ? { [choice.name]: option } : {})}
            >
                {running
                    ? 'Working…'
                    : target
                      ? `${capability.label} ${target}`
                      : capability.label}
            </Button>
            {missing.length > 0 && (
                <p className="app-hint">
                    Select a row in {missing.join(', ')} first.
                </p>
            )}
        </div>
    );
}

export function ActionButtonGroup({ component, capability }: ActionProps) {
    const { run, running, missing } = useAction(component, capability);
    const choice = enumInput(capability);
    if (!choice)
        return <ActionButton component={component} capability={capability} />;
    const verb = capability.label.split(' ')[0];
    return (
        <ButtonGroup
            orientation={component.size === 'small' ? 'vertical' : 'horizontal'}
            className="max-w-full flex-wrap"
            role="group"
            aria-label={capability.label}
        >
            {choice.options.map((option) => (
                <Button
                    key={option}
                    type="button"
                    variant="outline"
                    className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    aria-busy={running}
                    aria-disabled={running || missing.length > 0}
                    onClick={() => run({ [choice.name]: option })}
                >
                    {verb} {option.toUpperCase()}
                </Button>
            ))}
        </ButtonGroup>
    );
}
