import { z } from 'zod';
import { MUTATION_TYPES, type Mutation } from '../mutations';
import { PRIMITIVES, SIZES } from '../primitives';
import type { UISchema } from '../schema';

/*
 * Output contracts for OpenAI structured outputs. Structured outputs require
 * every field, so optional values are nullable. These are parsed with Zod and
 * then validated independently by the runtime before anything executes.
 */

export const GeneratedComponentOutput = z.object({
    id: z
        .string()
        .describe('Stable kebab-case component id, e.g. revenue-chart'),
    capability: z
        .string()
        .describe('Id of the registered capability this component binds'),
    primitive: z.enum(PRIMITIVES),
    size: z.enum(SIZES),
    order: z.number().int().describe('0-based position in reading order'),
    visible: z.boolean(),
    group: z
        .string()
        .nullable()
        .describe('Optional short group label, or null'),
    rationale: z.string().describe('One sentence explaining the choice'),
});

export const GeneratedSchemaOutput = z.object({
    reasoning: z
        .string()
        .describe('Two or three sentences on the overall layout'),
    components: z.array(GeneratedComponentOutput),
});
export type GeneratedSchemaOutput = z.infer<typeof GeneratedSchemaOutput>;

export const ProposedMutationOutput = z.object({
    type: z.enum(MUTATION_TYPES),
    element: z.string().describe('Component id to change'),
    target: z
        .string()
        .nullable()
        .describe('MOVE only: component id to move beside'),
    position: z.enum(['before', 'after']).nullable().describe('MOVE only'),
    index: z
        .number()
        .int()
        .nullable()
        .describe('REORDER only: new 0-based index'),
    size: z.enum(SIZES).nullable().describe('RESIZE only'),
    variant: z
        .enum(PRIMITIVES)
        .nullable()
        .describe('SWAP_VARIANT only: new primitive'),
});
export type ProposedMutationOutput = z.infer<typeof ProposedMutationOutput>;

export const OptimizationOutput = z.object({
    finding: z
        .string()
        .describe('The single most important friction, in one sentence'),
    classification: z
        .enum(['ui', 'performance'])
        .describe(
            'ui = interface friction; performance = backend latency is the real cause'
        ),
    evidence: z
        .array(z.string())
        .describe('Short, specific evidence items drawn from the metrics'),
    confidence: z.number().describe('0..1 confidence that the finding is real'),
    expectedBenefit: z
        .number()
        .describe('0..1 expected reduction in friction if applied'),
    reason: z
        .string()
        .describe(
            "Short version label, e.g. 'Date control promoted beside Revenue'"
        ),
    explanation: z
        .string()
        .describe(
            'Two or three sentences a developer can read in the evidence panel'
        ),
    mutations: z
        .array(ProposedMutationOutput)
        .describe(
            'Empty when classification is performance or no change is warranted'
        ),
});
export type OptimizationOutput = z.infer<typeof OptimizationOutput>;

export function toUISchema(output: GeneratedSchemaOutput): UISchema {
    return {
        components: output.components.map(
            ({ rationale: _rationale, ...component }) => component
        ),
    };
}

/** Convert the flat, nullable AI mutation shape into the strict mutation union. */
export function toMutation(
    output: ProposedMutationOutput
): Mutation | Record<string, unknown> {
    const { type, element } = output;
    switch (type) {
        case 'MOVE':
            return {
                type,
                element,
                target: output.target,
                position: output.position,
            };
        case 'REORDER':
            return { type, element, index: output.index };
        case 'RESIZE':
            return { type, element, size: output.size };
        case 'SWAP_VARIANT':
            return { type, element, variant: output.variant };
        case 'SHOW':
        case 'HIDE':
            return { type, element };
    }
}
