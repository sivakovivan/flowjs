import { z } from 'zod';
import { isCompatible, PRIMITIVES, SIZES } from './primitives';
import type { FlowApp } from './registry';
import {
    normalizeOrder,
    validateSchema,
    type UIComponent,
    type UISchema,
} from './schema';

/*
 * The restricted mutation vocabulary. OpenAI proposes mutations; this module
 * decides whether they are safe and executes them deterministically.
 */

export const MUTATION_TYPES = [
    'MOVE',
    'REORDER',
    'RESIZE',
    'SWAP_VARIANT',
    'SHOW',
    'HIDE',
] as const;
export type MutationType = (typeof MUTATION_TYPES)[number];

export const MutationSchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('MOVE'),
        element: z.string(),
        target: z.string(),
        position: z.enum(['before', 'after']),
    }),
    z.strictObject({
        type: z.literal('REORDER'),
        element: z.string(),
        index: z.number().int(),
    }),
    z.strictObject({
        type: z.literal('RESIZE'),
        element: z.string(),
        size: z.enum(SIZES),
    }),
    z.strictObject({
        type: z.literal('SWAP_VARIANT'),
        element: z.string(),
        variant: z.enum(PRIMITIVES),
    }),
    z.strictObject({ type: z.literal('SHOW'), element: z.string() }),
    z.strictObject({ type: z.literal('HIDE'), element: z.string() }),
]);

export type Mutation = z.infer<typeof MutationSchema>;

export const MAX_MUTATIONS_PER_PROPOSAL = 6;

export type MutationResult =
    { ok: true; schema: UISchema } | { ok: false; errors: string[] };

function describe(mutation: Mutation): string {
    return `${mutation.type} ${mutation.element}`;
}

function applyOne(
    components: UIComponent[],
    mutation: Mutation,
    app: FlowApp
): { components: UIComponent[] } | { error: string } {
    const ordered = [...components].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((c) => c.id === mutation.element);
    if (index === -1)
        return {
            error: `${describe(mutation)}: unknown component "${mutation.element}".`,
        };
    const element = ordered[index];
    const replace = (patch: Partial<UIComponent>) =>
        ordered.map((c) => (c.id === element.id ? { ...c, ...patch } : c));
    const renumber = (list: UIComponent[]) =>
        list.map((c, order) => ({ ...c, order }));

    switch (mutation.type) {
        case 'MOVE': {
            if (mutation.target === element.id)
                return {
                    error: `${describe(mutation)}: cannot move beside itself.`,
                };
            const target = ordered.find((c) => c.id === mutation.target);
            if (!target)
                return {
                    error: `${describe(mutation)}: unknown target "${mutation.target}".`,
                };
            if (!target.visible)
                return {
                    error: `${describe(mutation)}: target "${target.id}" is hidden.`,
                };
            const rest = ordered.filter((c) => c.id !== element.id);
            const targetIndex = rest.findIndex((c) => c.id === target.id);
            rest.splice(
                mutation.position === 'before' ? targetIndex : targetIndex + 1,
                0,
                element
            );
            if (rest.every((c, i) => c.id === ordered[i].id)) {
                return {
                    error: `${describe(mutation)}: already ${mutation.position} "${target.id}".`,
                };
            }
            return { components: renumber(rest) };
        }
        case 'REORDER': {
            if (mutation.index < 0 || mutation.index >= ordered.length) {
                return {
                    error: `${describe(mutation)}: index ${mutation.index} is out of range.`,
                };
            }
            if (mutation.index === index)
                return {
                    error: `${describe(mutation)}: already at index ${index}.`,
                };
            const rest = ordered.filter((c) => c.id !== element.id);
            rest.splice(mutation.index, 0, element);
            return { components: renumber(rest) };
        }
        case 'RESIZE': {
            if (element.size === mutation.size)
                return {
                    error: `${describe(mutation)}: already ${mutation.size}.`,
                };
            return { components: replace({ size: mutation.size }) };
        }
        case 'SWAP_VARIANT': {
            const capability = app.capability(element.capability);
            if (!capability || !isCompatible(capability, mutation.variant)) {
                return {
                    error: `${describe(mutation)}: "${mutation.variant}" is not a compatible variant for "${element.capability}".`,
                };
            }
            if (element.primitive === mutation.variant) {
                return {
                    error: `${describe(mutation)}: already a ${mutation.variant}.`,
                };
            }
            return { components: replace({ primitive: mutation.variant }) };
        }
        case 'SHOW': {
            if (element.visible)
                return { error: `${describe(mutation)}: already visible.` };
            return { components: replace({ visible: true }) };
        }
        case 'HIDE': {
            if (!element.visible)
                return { error: `${describe(mutation)}: already hidden.` };
            const capability = app.capability(element.capability);
            const otherVisible = ordered.some(
                (c) =>
                    c.id !== element.id &&
                    c.capability === element.capability &&
                    c.visible
            );
            if (capability?.required && !otherVisible) {
                return {
                    error: `${describe(mutation)}: would remove the only usable control for required capability "${capability.id}".`,
                };
            }
            return { components: replace({ visible: false }) };
        }
    }
}

/**
 * Validate and apply a proposal atomically. Any invalid mutation rejects the
 * whole proposal, and the result is re-validated as a complete schema.
 */
export function applyMutations(
    schema: UISchema,
    proposal: unknown[],
    app: FlowApp
): MutationResult {
    if (proposal.length === 0)
        return { ok: false, errors: ['Proposal contains no mutations.'] };
    if (proposal.length > MAX_MUTATIONS_PER_PROPOSAL) {
        return {
            ok: false,
            errors: [
                `Proposal exceeds ${MAX_MUTATIONS_PER_PROPOSAL} mutations.`,
            ],
        };
    }

    let components = normalizeOrder(schema).components;
    const errors: string[] = [];
    for (const [i, raw] of proposal.entries()) {
        const parsed = MutationSchema.safeParse(raw);
        if (!parsed.success) {
            errors.push(
                `Mutation ${i + 1} is malformed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
            );
            continue;
        }
        const result = applyOne(components, parsed.data, app);
        if ('error' in result) errors.push(result.error);
        else components = result.components;
    }
    if (errors.length > 0) return { ok: false, errors };

    return validateSchema({ components }, app);
}
