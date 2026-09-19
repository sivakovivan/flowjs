import type { Recording } from '@/flow/ai/providers';

/*
 * Recorded AI responses for the sales demo, replayed only when a live OpenAI
 * call fails or FLOW_AI_MODE=recorded. They follow the exact structured-output
 * contracts and are validated against the demo registry by the test suite.
 * The UI labels every result produced from them as "Recorded".
 */

const none = {
    target: null,
    position: null,
    index: null,
    size: null,
    variant: null,
};

export const salesRecording: Recording = {
    provenance:
        'Hand-authored to the flow.js structured-output contracts; validated against the sales registry by src/demo/demo.test.ts.',

    generation: {
        reasoning:
            'Headline revenue and order totals lead, followed by the revenue trend and recent transactions as the primary analytics. Secondary views, the date filter and account tools follow below.',
        components: [
            {
                id: 'revenue-total',
                capability: 'revenue',
                primitive: 'metric-card',
                size: 'small',
                order: 0,
                visible: true,
                group: 'Overview',
                rationale: 'Headline revenue for the period.',
            },
            {
                id: 'orders-total',
                capability: 'orders',
                primitive: 'metric-card',
                size: 'small',
                order: 1,
                visible: true,
                group: 'Overview',
                rationale: 'Headline order count.',
            },
            {
                id: 'customer-search',
                capability: 'customerQuery',
                primitive: 'search-field',
                size: 'medium',
                order: 2,
                visible: true,
                group: null,
                rationale: 'Global search for customer accounts.',
            },
            {
                id: 'revenue-chart',
                capability: 'revenue',
                primitive: 'line-chart',
                size: 'large',
                order: 3,
                visible: true,
                group: null,
                rationale: 'Revenue trend is the primary view.',
            },
            {
                id: 'export',
                capability: 'exportReport',
                primitive: 'button-group',
                size: 'small',
                order: 4,
                visible: true,
                group: null,
                rationale: 'Export beside the primary chart.',
            },
            {
                id: 'transactions-table',
                capability: 'transactions',
                primitive: 'table',
                size: 'full',
                order: 5,
                visible: true,
                group: null,
                rationale:
                    'Recent transactions need full width for their columns.',
            },
            {
                id: 'orders-chart',
                capability: 'orders',
                primitive: 'bar-chart',
                size: 'full',
                order: 6,
                visible: true,
                group: null,
                rationale: 'Order volume over time.',
            },
            {
                id: 'date-range',
                capability: 'dateRange',
                primitive: 'dropdown',
                size: 'small',
                order: 7,
                visible: true,
                group: 'Filters',
                rationale: 'Date filter for all analytics.',
            },
            {
                id: 'refund',
                capability: 'refundTransaction',
                primitive: 'button',
                size: 'small',
                order: 8,
                visible: true,
                group: null,
                rationale: 'Refund the selected transaction.',
            },
            {
                id: 'customers-table',
                capability: 'customers',
                primitive: 'table',
                size: 'medium',
                order: 9,
                visible: true,
                group: null,
                rationale: 'Customer accounts.',
            },
        ],
    },

    optimizations: [
        {
            finding:
                'Export is clicked repeatedly because PDF generation is slow, not because the control is hard to use.',
            classification: 'performance',
            evidence: [
                'export is clicked again within 30 seconds of the first click',
                'backend latency in the retrying sessions is well above the 1.5s slow threshold',
                'the export control is visible and found quickly',
            ],
            confidence: 0.78,
            expectedBenefit: 0,
            reason: 'Export latency flagged for the backend',
            explanation:
                'Sentry-correlated latency shows the retries line up with slow PDF exports. Moving or restyling the button would not help; the report endpoint needs to be faster or asynchronous.',
            mutations: [],
        },
        {
            finding:
                'The date range is used in most sessions but sits below the fold, far from the revenue chart it drives.',
            classification: 'ui',
            evidence: [
                'date-range is used in most sessions',
                'long average discovery time; it scrolls into view late',
                'date-range → revenue-chart is the most common interaction sequence',
                'revenue backend latency is normal, so the delay is discovery, not performance',
            ],
            confidence: 0.82,
            expectedBenefit: 0.4,
            reason: 'Date control promoted above Revenue',
            explanation:
                'Date filtering is frequent, slow to discover and strongly associated with Revenue. Moving it directly above the chart as a full-width bar of segments removes the scroll and the extra dropdown click.',
            mutations: [
                {
                    ...none,
                    type: 'MOVE',
                    element: 'date-range',
                    target: 'revenue-chart',
                    position: 'before',
                },
                {
                    ...none,
                    type: 'SWAP_VARIANT',
                    element: 'date-range',
                    variant: 'segmented-control',
                },
                {
                    ...none,
                    type: 'RESIZE',
                    element: 'date-range',
                    size: 'full',
                },
            ],
        },
        {
            finding:
                'Customer search is at the top of the page while the customer table it filters is at the bottom.',
            classification: 'ui',
            evidence: [
                'customer-search → customers-table is a common sequence',
                'the two components are several rows apart',
                'customers backend latency is normal',
            ],
            confidence: 0.74,
            expectedBenefit: 0.28,
            reason: 'Customer search moved beside Customers',
            explanation:
                'Searching is almost always followed by reading the customer table, so they belong together.',
            mutations: [
                {
                    ...none,
                    type: 'MOVE',
                    element: 'customer-search',
                    target: 'customers-table',
                    position: 'before',
                },
                {
                    ...none,
                    type: 'RESIZE',
                    element: 'customer-search',
                    size: 'small',
                },
            ],
        },
        {
            finding:
                'The full-width orders chart takes a large footprint but is rarely used.',
            classification: 'ui',
            evidence: [
                'orders-chart receives a small share of interactions',
                'it spans a full row',
            ],
            confidence: 0.66,
            expectedBenefit: 0.18,
            reason: 'Orders chart compacted',
            explanation:
                'Shrinking the orders chart and moving it below the account tools frees space without removing it.',
            mutations: [
                {
                    ...none,
                    type: 'MOVE',
                    element: 'orders-chart',
                    target: 'customers-table',
                    position: 'after',
                },
                {
                    ...none,
                    type: 'RESIZE',
                    element: 'orders-chart',
                    size: 'medium',
                },
            ],
        },
    ],
};
