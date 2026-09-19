import { z } from 'zod';

/*
 * Capability registration. Developers describe what the application can do;
 * flow.js keeps the executable functions server-side and only ever exposes the
 * serializable descriptors to OpenAI and the renderer.
 */

export type StateValue = string;
export type StateValues = Record<string, StateValue>;

export interface ColumnDefinition {
    key: string;
    label: string;
    format?: 'currency' | 'date' | 'text' | 'status';
}

export type DataOutput =
    | { kind: 'timeseries'; unit: 'currency' | 'count'; label?: string }
    | { kind: 'collection'; rowKey: string; columns: ColumnDefinition[] };

export interface DataContext {
    state: StateValues;
}

export interface DataDefinition {
    description: string;
    label?: string;
    output: DataOutput;
    /** State capabilities this data reads. */
    dependsOn?: string[];
    importance?: 'primary' | 'secondary';
    required?: boolean;
    fetch: (context: DataContext) => Promise<unknown> | unknown;
}

/** Shorthand accepted in registration: `["csv", "pdf"]` or `"string"`. */
export type ActionInputDefinition =
    | readonly string[]
    | 'string'
    | { type: 'enum'; options: readonly string[] }
    | { type: 'string'; from?: string; description?: string };

export type ActionInput =
    | { type: 'enum'; options: string[] }
    | { type: 'string'; from: string | null; description: string | null };

export interface ActionContext {
    state: StateValues;
}

export interface ActionDefinition {
    description: string;
    label?: string;
    inputs?: Record<string, ActionInputDefinition>;
    dependsOn?: string[];
    required?: boolean;
    execute: (
        input: Record<string, string>,
        context: ActionContext
    ) => Promise<unknown> | unknown;
}

export interface StateDefinition {
    description: string;
    label?: string;
    type: 'enum' | 'date-range' | 'text';
    options?: readonly string[];
    /** Human labels for options, e.g. `{ "30d": "Last 30 days" }`. */
    optionLabels?: Record<string, string>;
    default: string;
    required?: boolean;
}

export interface FlowTheme {
    primary: string;
    background?: string;
    foreground?: string;
    surface?: string;
    radius: number;
    spacing: number;
    fontFamily: string;
}

export interface FlowAppConfig {
    id?: string;
    name?: string;
    context: string;
    data: Record<string, DataDefinition>;
    actions: Record<string, ActionDefinition>;
    state: Record<string, StateDefinition>;
    theme: FlowTheme;
    /** 0 disables automatic mutation; 1 is highly experimental. */
    mutationRate?: number;
}

interface DescriptorBase {
    id: string;
    label: string;
    description: string;
    dependsOn: string[];
    /** Must always keep at least one visible, usable component. */
    required: boolean;
}

export type CapabilityDescriptor =
    | (DescriptorBase & {
          kind: 'data';
          output: DataOutput;
          importance: 'primary' | 'secondary';
      })
    | (DescriptorBase & {
          kind: 'action';
          inputs: Record<string, ActionInput>;
      })
    | (DescriptorBase & {
          kind: 'state';
          stateType: 'enum' | 'date-range' | 'text';
          options: string[];
          optionLabels: Record<string, string>;
          default: string;
      });

export interface CapabilityGraph {
    /** Capabilities that read the given state. */
    dependentsOf(stateId: string): string[];
    /** True when one capability depends on the other, or both read the same state. */
    related(a: string, b: string): boolean;
    edges: Array<{ from: string; to: string }>;
}

export interface FlowApp {
    id: string;
    name: string;
    context: string;
    theme: Required<FlowTheme>;
    mutationRate: number;
    capabilities: CapabilityDescriptor[];
    graph: CapabilityGraph;
    capability(id: string): CapabilityDescriptor | undefined;
    defaultState(): StateValues;
    fetchData(id: string, state: StateValues): Promise<unknown>;
    executeAction(
        id: string,
        input: Record<string, unknown>,
        state: StateValues
    ): Promise<unknown>;
}

export class FlowConfigError extends Error {
    constructor(public readonly problems: string[]) {
        super(`Invalid flow.js configuration:\n- ${problems.join('\n- ')}`);
        this.name = 'FlowConfigError';
    }
}

export class CapabilityInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CapabilityInputError';
    }
}

const DEFAULT_THEME = {
    background: '#ffffff',
    foreground: '#111827',
    surface: '#f8fafc',
};

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

function humanize(id: string): string {
    const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeInput(definition: ActionInputDefinition): ActionInput {
    if (definition === 'string')
        return { type: 'string', from: null, description: null };
    if (Array.isArray(definition))
        return { type: 'enum', options: [...definition] };
    const object = definition as Exclude<
        ActionInputDefinition,
        readonly string[] | 'string'
    >;
    if (object.type === 'enum')
        return { type: 'enum', options: [...object.options] };
    return {
        type: 'string',
        from: object.from ?? null,
        description: object.description ?? null,
    };
}

export function createFlowApp(config: FlowAppConfig): FlowApp {
    const problems: string[] = [];
    const ids = new Set<string>();
    const claim = (id: string) => {
        if (!ID_PATTERN.test(id))
            problems.push(
                `"${id}" is not a valid capability id (use camelCase).`
            );
        if (ids.has(id))
            problems.push(
                `Capability id "${id}" is registered more than once.`
            );
        ids.add(id);
    };

    const stateIds = Object.keys(config.state);
    const descriptors: CapabilityDescriptor[] = [];

    for (const [id, state] of Object.entries(config.state)) {
        claim(id);
        const options = state.type === 'text' ? [] : [...(state.options ?? [])];
        if (state.type !== 'text' && options.length < 2) {
            problems.push(`State "${id}" needs at least two options.`);
        }
        if (state.type !== 'text' && !options.includes(state.default)) {
            problems.push(
                `State "${id}" default "${state.default}" is not one of its options.`
            );
        }
        descriptors.push({
            id,
            kind: 'state',
            label: state.label ?? humanize(id),
            description: state.description,
            dependsOn: [],
            required: state.required ?? false,
            stateType: state.type,
            options,
            optionLabels: { ...(state.optionLabels ?? {}) },
            default: state.default,
        });
    }

    for (const [id, data] of Object.entries(config.data)) {
        claim(id);
        descriptors.push({
            id,
            kind: 'data',
            label: data.label ?? humanize(id),
            description: data.description,
            dependsOn: [...(data.dependsOn ?? [])],
            required: data.required ?? false,
            output: data.output,
            importance: data.importance ?? 'primary',
        });
    }

    for (const [id, action] of Object.entries(config.actions)) {
        claim(id);
        const inputs = Object.fromEntries(
            Object.entries(action.inputs ?? {}).map(([name, input]) => [
                name,
                normalizeInput(input),
            ])
        );
        descriptors.push({
            id,
            kind: 'action',
            label: action.label ?? humanize(id),
            description: action.description,
            dependsOn: [...(action.dependsOn ?? [])],
            // Actions are functionality; hiding the only way to run one is never an optimization.
            required: action.required ?? true,
            inputs,
        });
    }

    const byId = new Map(descriptors.map((d) => [d.id, d]));

    for (const descriptor of descriptors) {
        for (const dependency of descriptor.dependsOn) {
            if (!stateIds.includes(dependency)) {
                problems.push(
                    `"${descriptor.id}" depends on "${dependency}", which is not a registered state.`
                );
            }
        }
        if (descriptor.kind === 'action') {
            for (const [name, input] of Object.entries(descriptor.inputs)) {
                if (input.type !== 'string' || input.from === null) continue;
                const source = byId.get(input.from);
                if (
                    !source ||
                    source.kind !== 'data' ||
                    source.output.kind !== 'collection'
                ) {
                    problems.push(
                        `Action "${descriptor.id}" input "${name}" reads from "${input.from}", which is not a collection data capability.`
                    );
                }
            }
        }
    }

    // Read state is required whenever something depends on it, unless the developer says otherwise.
    const edges = descriptors.flatMap((d) =>
        d.dependsOn.map((from) => ({ from, to: d.id }))
    );
    for (const descriptor of descriptors) {
        if (
            descriptor.kind === 'state' &&
            config.state[descriptor.id].required === undefined
        ) {
            descriptor.required = edges.some(
                (edge) => edge.from === descriptor.id
            );
        }
    }

    const mutationRate = config.mutationRate ?? 0.5;
    if (!(mutationRate >= 0 && mutationRate <= 1)) {
        problems.push(
            `mutationRate must be between 0 and 1 (received ${mutationRate}).`
        );
    }

    if (problems.length > 0) throw new FlowConfigError(problems);

    const graph: CapabilityGraph = {
        edges,
        dependentsOf: (stateId) =>
            edges.filter((e) => e.from === stateId).map((e) => e.to),
        related(a, b) {
            if (a === b) return true;
            const depsA = byId.get(a)?.dependsOn ?? [];
            const depsB = byId.get(b)?.dependsOn ?? [];
            return (
                depsA.includes(b) ||
                depsB.includes(a) ||
                depsA.some((dep) => depsB.includes(dep))
            );
        },
    };

    function resolveState(
        capability: CapabilityDescriptor,
        state: StateValues
    ): StateValues {
        const resolved: StateValues = {};
        for (const dependency of capability.dependsOn) {
            const descriptor = byId.get(dependency);
            if (!descriptor || descriptor.kind !== 'state') continue;
            const value = state[dependency] ?? descriptor.default;
            if (
                descriptor.stateType !== 'text' &&
                !descriptor.options.includes(value)
            ) {
                throw new CapabilityInputError(
                    `"${value}" is not a valid value for state "${dependency}".`
                );
            }
            if (typeof value !== 'string' || value.length > 200) {
                throw new CapabilityInputError(
                    `Invalid value for state "${dependency}".`
                );
            }
            resolved[dependency] = value;
        }
        return resolved;
    }

    function inputSchema(
        capability: Extract<CapabilityDescriptor, { kind: 'action' }>
    ) {
        const shape: Record<string, z.ZodType<string>> = {};
        for (const [name, input] of Object.entries(capability.inputs)) {
            shape[name] =
                input.type === 'enum'
                    ? z.enum(input.options as [string, ...string[]])
                    : z.string().min(1).max(200);
        }
        return z.strictObject(shape);
    }

    return {
        id: config.id ?? 'app',
        name: config.name ?? 'flow.js app',
        context: config.context.trim().replace(/\s+/g, ' '),
        theme: { ...DEFAULT_THEME, ...config.theme },
        mutationRate,
        capabilities: descriptors,
        graph,
        capability: (id) => byId.get(id),
        defaultState() {
            return Object.fromEntries(
                descriptors.flatMap((d) =>
                    d.kind === 'state' ? [[d.id, d.default]] : []
                )
            );
        },
        async fetchData(id, state) {
            const capability = byId.get(id);
            if (!capability || capability.kind !== 'data') {
                throw new CapabilityInputError(
                    `Unknown data capability "${id}".`
                );
            }
            return config.data[id].fetch({
                state: resolveState(capability, state),
            });
        },
        async executeAction(id, input, state) {
            const capability = byId.get(id);
            if (!capability || capability.kind !== 'action') {
                throw new CapabilityInputError(
                    `Unknown action capability "${id}".`
                );
            }
            const parsed = inputSchema(capability).safeParse(input);
            if (!parsed.success) {
                throw new CapabilityInputError(
                    `Invalid input for "${id}": ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
                );
            }
            return config.actions[id].execute(parsed.data, {
                state: resolveState(capability, state),
            });
        },
    };
}
