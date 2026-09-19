import { createFlowApp } from '@/flow/registry';
import {
    DATE_RANGES,
    exportReport,
    getCustomers,
    getOrders,
    getRevenue,
    getTransactions,
    refundTransaction,
    type DateRange,
} from './sales-data';

/*
 * The developer's entire contribution: capabilities, context and theme.
 * No dashboard layout is written anywhere in this application.
 */
export const salesApp = createFlowApp({
    id: 'sales-demo',
    name: 'Northwind Sales',
    context: `
    Sales analytics application used to monitor
    revenue, customers, orders, and transactions.
  `,

    data: {
        revenue: {
            description: 'Revenue over the selected date range',
            output: { kind: 'timeseries', unit: 'currency' },
            dependsOn: ['dateRange'],
            importance: 'primary',
            fetch: ({ state }) => getRevenue(state.dateRange as DateRange),
        },
        orders: {
            description: 'Number of orders over the selected date range',
            output: { kind: 'timeseries', unit: 'count' },
            dependsOn: ['dateRange'],
            importance: 'secondary',
            fetch: ({ state }) => getOrders(state.dateRange as DateRange),
        },
        customers: {
            description: 'Customer accounts matching the customer search',
            output: {
                kind: 'collection',
                rowKey: 'id',
                columns: [
                    { key: 'name', label: 'Customer' },
                    { key: 'company', label: 'Company' },
                    { key: 'orders', label: 'Orders' },
                    {
                        key: 'lifetimeValue',
                        label: 'Lifetime value',
                        format: 'currency',
                    },
                    { key: 'status', label: 'Status', format: 'status' },
                ],
            },
            dependsOn: ['customerQuery'],
            importance: 'secondary',
            fetch: ({ state }) => getCustomers(state.customerQuery),
        },
        transactions: {
            description:
                'Recent customer transactions in the selected date range',
            output: {
                kind: 'collection',
                rowKey: 'id',
                columns: [
                    { key: 'id', label: 'ID' },
                    { key: 'customer', label: 'Customer' },
                    { key: 'amount', label: 'Amount', format: 'currency' },
                    { key: 'date', label: 'Date', format: 'date' },
                    { key: 'status', label: 'Status', format: 'status' },
                ],
            },
            dependsOn: ['dateRange'],
            importance: 'primary',
            fetch: ({ state }) => getTransactions(state.dateRange as DateRange),
        },
    },

    actions: {
        exportReport: {
            description: 'Export the currently filtered report',
            inputs: { format: ['csv', 'pdf'] },
            dependsOn: ['dateRange'],
            execute: (input, { state }) =>
                exportReport(
                    input.format as 'csv' | 'pdf',
                    state.dateRange as DateRange
                ),
        },
        refundTransaction: {
            description: 'Refund a selected transaction',
            inputs: { transactionId: { type: 'string', from: 'transactions' } },
            execute: (input) => refundTransaction(input.transactionId),
        },
    },

    state: {
        dateRange: {
            description: 'Date range applied to analytics',
            type: 'date-range',
            options: DATE_RANGES,
            optionLabels: {
                '7d': '7 days',
                '30d': '30 days',
                '90d': '90 days',
                '12m': '12 months',
            },
            default: '30d',
        },
        customerQuery: {
            label: 'Customer search',
            description: 'Free-text search over customer name, company or id',
            type: 'text',
            default: '',
        },
    },

    theme: {
        primary: '#6366f1',
        background: '#ffffff',
        foreground: '#111827',
        surface: '#f8fafc',
        radius: 8,
        spacing: 8,
        fontFamily: 'Inter',
    },

    mutationRate: 0.5,
});
