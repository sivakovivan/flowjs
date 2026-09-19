import type { CapabilityDescriptor } from './registry';

/** The constrained set of renderable components flow.js owns. */
export const PRIMITIVES = [
    'metric-card',
    'line-chart',
    'bar-chart',
    'table',
    'list',
    'button',
    'button-group',
    'dropdown',
    'segmented-control',
    'search-field',
] as const;

export type Primitive = (typeof PRIMITIVES)[number];

export const SIZES = ['small', 'medium', 'large', 'full'] as const;
export type Size = (typeof SIZES)[number];

/** Width of each size on the 12-column dashboard grid. */
export const SIZE_SPAN: Record<Size, number> = {
    small: 3,
    medium: 6,
    large: 9,
    full: 12,
};

/** Option-per-button primitives stop being usable past this many options. */
export const MAX_INLINE_OPTIONS = 6;

/**
 * Primitives a capability may be rendered with. This is the contract both the
 * AI and the mutation engine are held to.
 */
export function compatiblePrimitives(
    capability: CapabilityDescriptor
): Primitive[] {
    switch (capability.kind) {
        case 'data':
            return capability.output.kind === 'timeseries'
                ? ['metric-card', 'line-chart', 'bar-chart']
                : ['table', 'list'];
        case 'state': {
            if (capability.stateType === 'text') return ['search-field'];
            const inline = capability.options.length <= MAX_INLINE_OPTIONS;
            return inline
                ? ['dropdown', 'segmented-control', 'button-group']
                : ['dropdown'];
        }
        case 'action': {
            const inputs = Object.values(capability.inputs);
            const enumInputs = inputs.filter((input) => input.type === 'enum');
            const singleInlineEnum =
                inputs.length === 1 &&
                enumInputs.length === 1 &&
                enumInputs[0].options.length <= MAX_INLINE_OPTIONS;
            return singleInlineEnum ? ['button', 'button-group'] : ['button'];
        }
    }
}

export function isCompatible(
    capability: CapabilityDescriptor,
    primitive: Primitive
): boolean {
    return compatiblePrimitives(capability).includes(primitive);
}
