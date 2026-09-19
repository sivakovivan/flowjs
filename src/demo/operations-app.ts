import { createFlowApp } from '@/flow/registry';

const incidents = [
    {
        id: 'INC-1042',
        service: 'Checkout',
        severity: 'critical',
        status: 'open',
    },
    {
        id: 'INC-1041',
        service: 'Search',
        severity: 'high',
        status: 'investigating',
    },
    { id: 'INC-1040', service: 'Billing', severity: 'medium', status: 'open' },
];

export const operationsApp = createFlowApp({
    id: 'operations-demo',
    name: 'Operations Control Room',
    context:
        'Incident response dashboard for an engineering operations team monitoring services and resolving production issues.',
    data: {
        serviceHealth: {
            description: 'Service health score over the selected time range',
            output: { kind: 'timeseries', unit: 'count' },
            dependsOn: ['severityFilter'],
            importance: 'primary',
            fetch: () => ({
                points: [
                    { label: '09:00', value: 98 },
                    { label: '10:00', value: 94 },
                    { label: '11:00', value: 96 },
                    { label: '12:00', value: 91 },
                ],
                total: 91,
                change: -4,
            }),
        },
        activeIncidents: {
            description: 'Active incidents requiring operator attention',
            output: {
                kind: 'collection',
                rowKey: 'id',
                columns: [
                    { key: 'id', label: 'Incident' },
                    { key: 'service', label: 'Service' },
                    { key: 'severity', label: 'Severity', format: 'status' },
                    { key: 'status', label: 'Status', format: 'status' },
                ],
            },
            dependsOn: ['severityFilter'],
            importance: 'primary',
            fetch: ({ state }) => {
                const rows = incidents.filter(
                    (incident) =>
                        state.severityFilter === 'all' ||
                        incident.severity === state.severityFilter
                );
                return { rows, total: rows.length };
            },
        },
    },
    actions: {
        acknowledgeIncident: {
            description: 'Acknowledge an incident and begin response',
            inputs: { incidentId: { type: 'string', from: 'activeIncidents' } },
            execute: (input) => ({
                message: `Acknowledged ${input.incidentId}.`,
            }),
        },
    },
    state: {
        severityFilter: {
            label: 'Severity filter',
            description: 'Filter incidents by severity',
            type: 'enum',
            options: ['all', 'critical', 'high', 'medium'],
            optionLabels: {
                all: 'All',
                critical: 'Critical',
                high: 'High',
                medium: 'Medium',
            },
            default: 'all',
        },
    },
    theme: {
        primary: '#0f766e',
        background: '#ffffff',
        foreground: '#17202b',
        surface: '#f3f7f6',
        radius: 8,
        spacing: 8,
        fontFamily: 'Inter',
    },
});
