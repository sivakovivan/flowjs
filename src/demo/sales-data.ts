import type { CollectionData, TimeseriesData } from '@/flow/data-contracts';

/*
 * Fictional sales backend for the demo. Deterministic data, simulated network
 * latency, and in-memory refunds. PDF export is slow on purpose so the demo can
 * show backend-performance friction next to interface friction.
 */

export const DATE_RANGES = ['7d', '30d', '90d', '12m'] as const;
export type DateRange = (typeof DATE_RANGES)[number];

const DAY = 86_400_000;
/** Fixed "today" so the fictional data never drifts between runs. */
const TODAY = Date.UTC(2026, 8, 18);

function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (base: number, spread: number) =>
    base + Math.round(Math.random() * spread);

const FIRST = [
    'Ava',
    'Liam',
    'Maya',
    'Noah',
    'Iris',
    'Omar',
    'Zoe',
    'Ezra',
    'Lena',
    'Kai',
    'Ruth',
    'Theo',
    'Nia',
    'Jude',
    'Sana',
    'Felix',
];
const LAST = [
    'Okafor',
    'Lindqvist',
    'Tanaka',
    'Moreau',
    'Reyes',
    'Kowalski',
    'Haddad',
    'Brennan',
    'Castillo',
    'Nakamura',
    'Petrov',
    'Adeyemi',
];
const COMPANY = [
    'Northwind',
    'Bluefin Labs',
    'Cobalt & Co',
    'Juniper Supply',
    'Kestrel Retail',
    'Lumen Goods',
    'Meridian',
    'Orchard Market',
    'Pinecrest',
    'Quarry Studio',
];

const random = mulberry32(7);

export const CUSTOMERS = Array.from({ length: 36 }, (_, i) => {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
    return {
        id: `C-${1001 + i}`,
        name,
        company: COMPANY[(i * 3) % COMPANY.length],
        orders: 2 + Math.floor(random() * 40),
        lifetimeValue: Math.round(800 + random() * 42_000),
        status: random() > 0.18 ? 'active' : 'churned',
    };
});

const TRANSACTIONS = Array.from({ length: 320 }, (_, i) => {
    const customer = CUSTOMERS[Math.floor(random() * CUSTOMERS.length)];
    return {
        id: `TX-${48210 + i}`,
        customer: customer.name,
        amount: Math.round((40 + random() * 1_900) * 100) / 100,
        date: TODAY - Math.floor(random() * 365) * DAY,
        status: random() > 0.06 ? 'paid' : 'failed',
    };
}).sort((a, b) => b.date - a.date);

/** Refunds live in memory: a fictional backend state change. */
const refunded = new Set<string>();

const RANGE_DAYS: Record<DateRange, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '12m': 365,
};

function buckets(
    range: DateRange
): Array<{ label: string; start: number; end: number }> {
    const days = RANGE_DAYS[range];
    const size =
        range === '7d' || range === '30d' ? 1 : range === '90d' ? 7 : 30;
    const count = Math.ceil(days / size);
    const format = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        ...(range === '12m' ? {} : { day: 'numeric' }),
        timeZone: 'UTC',
    });
    return Array.from({ length: count }, (_, i) => {
        const end = TODAY - (count - 1 - i) * size * DAY + DAY;
        return {
            label: format.format(end - DAY),
            start: end - size * DAY,
            end,
        };
    });
}

/** A smooth, seasonal daily series derived from the date, so every range agrees. */
function dailyValue(day: number, base: number, amplitude: number): number {
    const t = day / DAY;
    const weekly = Math.sin((t / 7) * Math.PI * 2) * 0.12;
    const seasonal = Math.sin((t / 365) * Math.PI * 2 + 1.2) * 0.18;
    const trend = (t - TODAY / DAY) * 0.0009;
    const noise = (mulberry32(Math.floor(t))() - 0.5) * 0.16;
    return Math.max(
        0,
        base * (1 + weekly + seasonal + trend + noise) + amplitude * noise
    );
}

function series(
    range: DateRange,
    base: number,
    amplitude: number,
    round: (n: number) => number
): TimeseriesData {
    const sumRange = (start: number, end: number) => {
        let total = 0;
        for (let day = start; day < end; day += DAY)
            total += dailyValue(day, base, amplitude);
        return total;
    };
    const points = buckets(range).map((b) => ({
        label: b.label,
        value: round(sumRange(b.start, b.end)),
    }));
    const total = round(points.reduce((sum, p) => sum + p.value, 0));
    const days = RANGE_DAYS[range];
    const previous = sumRange(
        TODAY - 2 * days * DAY + DAY,
        TODAY - days * DAY + DAY
    );
    return {
        points,
        total,
        change: previous
            ? Math.round(((total - previous) / previous) * 1000) / 1000
            : null,
    };
}

export async function getRevenue(range: DateRange): Promise<TimeseriesData> {
    await sleep(jitter(70, 90));
    return series(range, 18_400, 2_000, (n) => Math.round(n));
}

export async function getOrders(range: DateRange): Promise<TimeseriesData> {
    await sleep(jitter(60, 80));
    return series(range, 212, 30, (n) => Math.round(n));
}

export async function getCustomers(query: string): Promise<CollectionData> {
    await sleep(jitter(50, 70));
    const q = query.trim().toLowerCase();
    const rows = CUSTOMERS.filter(
        (c) =>
            !q ||
            c.name.toLowerCase().includes(q) ||
            c.company.toLowerCase().includes(q) ||
            c.id.toLowerCase() === q
    );
    return { rows: rows.slice(0, 12), total: rows.length };
}

export async function getTransactions(
    range: DateRange
): Promise<CollectionData> {
    await sleep(jitter(80, 90));
    const since = TODAY - RANGE_DAYS[range] * DAY;
    const rows = TRANSACTIONS.filter((t) => t.date > since).map((t) => ({
        ...t,
        date: new Date(t.date).toISOString().slice(0, 10),
        status: refunded.has(t.id) ? 'refunded' : t.status,
    }));
    return { rows: rows.slice(0, 10), total: rows.length };
}

export async function exportReport(format: 'csv' | 'pdf', range: DateRange) {
    // Fictional: CSV streams quickly; PDF rendering is slow on purpose.
    await sleep(format === 'pdf' ? jitter(2_400, 700) : jitter(90, 90));
    const { rows, total } = await getTransactions(range);
    if (format === 'pdf') {
        return {
            format,
            filename: `sales-${range}.pdf`,
            message: `PDF report for ${total} transactions is ready.`,
        };
    }
    const header = 'id,customer,amount,date,status';
    const lines = rows.map((r) =>
        [r.id, `"${r.customer}"`, r.amount, r.date, r.status].join(',')
    );
    return {
        format,
        filename: `sales-${range}.csv`,
        message: `Exported ${rows.length} of ${total} transactions.`,
        content: [header, ...lines].join('\n'),
    };
}

export async function refundTransaction(transactionId: string) {
    await sleep(jitter(180, 120));
    const transaction = TRANSACTIONS.find((t) => t.id === transactionId);
    if (!transaction)
        throw new Error(`Transaction ${transactionId} does not exist.`);
    if (transaction.status === 'failed')
        throw new Error(`${transactionId} failed and cannot be refunded.`);
    if (refunded.has(transactionId))
        throw new Error(`${transactionId} was already refunded.`);
    refunded.add(transactionId);
    return {
        transactionId,
        message: `Refunded ${transactionId} ($${transaction.amount.toFixed(2)}).`,
    };
}
