import { describe, expect, it } from 'vitest';
import { fixtureApp, fixtureConfig } from './__fixtures__/app';
import { compatiblePrimitives } from './primitives';
import {
    CapabilityInputError,
    createFlowApp,
    FlowConfigError,
} from './registry';

describe('createFlowApp', () => {
    it('registers data, actions and state as serializable descriptors', () => {
        const app = fixtureApp();
        expect(app.capabilities.map((c) => `${c.kind}:${c.id}`)).toEqual([
            'state:dateRange',
            'state:customerQuery',
            'data:revenue',
            'data:transactions',
            'action:exportReport',
            'action:refundTransaction',
        ]);
        // Descriptors never carry executable code.
        expect(JSON.parse(JSON.stringify(app.capabilities))).toEqual(
            app.capabilities
        );
    });

    it('normalizes action input shorthand', () => {
        const app = fixtureApp();
        const exportReport = app.capability('exportReport');
        expect(exportReport?.kind === 'action' && exportReport.inputs).toEqual({
            format: { type: 'enum', options: ['csv', 'pdf'] },
        });
    });

    it('builds a dependency graph from state to dependents', () => {
        const { graph } = fixtureApp();
        expect(graph.dependentsOf('dateRange')).toEqual([
            'revenue',
            'transactions',
            'exportReport',
        ]);
        expect(graph.related('dateRange', 'revenue')).toBe(true);
        expect(graph.related('revenue', 'exportReport')).toBe(true); // share dateRange
        expect(graph.related('customerQuery', 'revenue')).toBe(false);
    });

    it('marks depended-on state and actions as required, but not unread state', () => {
        const app = fixtureApp();
        expect(app.capability('dateRange')?.required).toBe(true);
        expect(app.capability('customerQuery')?.required).toBe(false);
        expect(app.capability('exportReport')?.required).toBe(true);
        expect(app.capability('revenue')?.required).toBe(false);
    });

    it('rejects invalid registrations with every problem listed', () => {
        const config = fixtureConfig({ mutationRate: 1.5 });
        config.data.revenue.dependsOn = ['missingState'];
        config.state.dateRange.default = '1y';
        config.actions.refundTransaction.inputs = {
            transactionId: { type: 'string', from: 'revenue' },
        };
        try {
            createFlowApp(config);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(FlowConfigError);
            const problems = (error as FlowConfigError).problems.join('\n');
            expect(problems).toMatch(/missingState/);
            expect(problems).toMatch(/default "1y"/);
            expect(problems).toMatch(/not a collection/);
            expect(problems).toMatch(/mutationRate/);
        }
    });

    it('rejects duplicate capability ids across kinds', () => {
        const config = fixtureConfig();
        config.actions.revenue = { description: 'dup', execute: () => null };
        expect(() => createFlowApp(config)).toThrow(/more than once/);
    });

    it('passes only declared, valid state to data functions', async () => {
        const app = fixtureApp();
        await expect(
            app.fetchData('revenue', { dateRange: '7d', customerQuery: 'x' })
        ).resolves.toEqual({
            range: '7d',
        });
        await expect(app.fetchData('revenue', {})).resolves.toEqual({
            range: '30d',
        });
        await expect(
            app.fetchData('revenue', { dateRange: '5y' })
        ).rejects.toBeInstanceOf(CapabilityInputError);
    });

    it('validates action inputs against the declared contract', async () => {
        const app = fixtureApp();
        await expect(
            app.executeAction('exportReport', { format: 'csv' }, {})
        ).resolves.toEqual({
            format: 'csv',
            dateRange: '30d',
        });
        await expect(
            app.executeAction('exportReport', { format: 'xls' }, {})
        ).rejects.toThrow(/format/);
        await expect(
            app.executeAction('exportReport', { format: 'csv', extra: 1 }, {})
        ).rejects.toThrow();
        await expect(app.executeAction('revenue', {}, {})).rejects.toThrow(
            /Unknown action/
        );
    });
});

describe('compatiblePrimitives', () => {
    it('maps each capability shape to its allowed primitives', () => {
        const app = fixtureApp();
        const of = (id: string) => compatiblePrimitives(app.capability(id)!);
        expect(of('revenue')).toEqual([
            'metric-card',
            'line-chart',
            'bar-chart',
        ]);
        expect(of('transactions')).toEqual(['table', 'list']);
        expect(of('dateRange')).toEqual([
            'dropdown',
            'segmented-control',
            'button-group',
        ]);
        expect(of('customerQuery')).toEqual(['search-field']);
        expect(of('exportReport')).toEqual(['button', 'button-group']);
        expect(of('refundTransaction')).toEqual(['button']);
    });

    it('restricts long option lists to dropdowns', () => {
        const config = fixtureConfig();
        config.state.dateRange.options = ['1', '2', '3', '4', '5', '6', '7'];
        config.state.dateRange.default = '1';
        const app = createFlowApp(config);
        expect(compatiblePrimitives(app.capability('dateRange')!)).toEqual([
            'dropdown',
        ]);
    });
});
