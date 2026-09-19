import { describe, expect, it } from 'vitest';
import { parseDataOutput } from '@/flow/data-contracts';
import { GeneratedSchemaOutput, toUISchema } from '@/flow/ai/contracts';
import { validateSchema } from '@/flow/schema';
import { operationsApp } from './operations-app';

describe('foreign operations dashboard registry', () => {
    it('registers a non-sales application with mixed dashboard capabilities', () => {
        expect(operationsApp.name).toBe('Operations Control Room');
        expect(
            operationsApp.capabilities.map((capability) => capability.id).sort()
        ).toEqual([
            'acknowledgeIncident',
            'activeIncidents',
            'serviceHealth',
            'severityFilter',
        ]);
    });

    it('accepts a generated schema for the foreign application', async () => {
        const generated = GeneratedSchemaOutput.parse({
            reasoning:
                'Prioritize service health, then active incidents and response actions.',
            components: [
                {
                    id: 'health',
                    capability: 'serviceHealth',
                    primitive: 'line-chart',
                    size: 'large',
                    order: 0,
                    visible: true,
                    group: null,
                    rationale: 'Health trend is the primary signal.',
                },
                {
                    id: 'severity',
                    capability: 'severityFilter',
                    primitive: 'segmented-control',
                    size: 'medium',
                    order: 1,
                    visible: true,
                    group: null,
                    rationale: 'Operators need quick filtering.',
                },
                {
                    id: 'incidents',
                    capability: 'activeIncidents',
                    primitive: 'table',
                    size: 'large',
                    order: 2,
                    visible: true,
                    group: null,
                    rationale: 'Incident rows support triage.',
                },
                {
                    id: 'acknowledge',
                    capability: 'acknowledgeIncident',
                    primitive: 'button',
                    size: 'small',
                    order: 3,
                    visible: true,
                    group: null,
                    rationale: 'Response action stays visible.',
                },
            ],
        });
        expect(validateSchema(toUISchema(generated), operationsApp).ok).toBe(
            true
        );
        const capability = operationsApp.capability('activeIncidents');
        if (!capability || capability.kind !== 'data')
            throw new Error('Missing collection capability');
        const data = await operationsApp.fetchData(
            'activeIncidents',
            operationsApp.defaultState()
        );
        expect(() => parseDataOutput(capability.output, data)).not.toThrow();
    });
});
