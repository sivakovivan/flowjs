import { AnalyticsFeed } from '@flowjs/core/flow/analytics';
import type { AnalyticsConfig } from './config';
import type { AnalyticsRepository } from './repository';

export function createWorker(options: {
    config: AnalyticsConfig;
    repository: AnalyticsRepository;
    fetch?: typeof fetch;
    now?: () => number;
    log?: (entry: Record<string, unknown>) => void;
}) {
    const { config, repository } = options;
    const fetcher = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
    const endpoint = new URL('/api/flow/analytics', config.FLOW_APP_URL);
    let busy = false;
    let stopped = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;

    async function request(body?: unknown) {
        const response = await fetcher(endpoint, {
            method: body ? 'POST' : 'GET',
            headers: {
                authorization: `Bearer ${config.FLOW_ANALYTICS_TOKEN}`,
                'content-type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(
                body &&
                    typeof body === 'object' &&
                    'action' in body &&
                    body.action === 'baseline'
                    ? 180_000
                    : 10_000
            ),
        });
        if (!response.ok)
            throw new Error(`Flow analytics API returned ${response.status}.`);
        return response.json() as Promise<unknown>;
    }

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const feed = AnalyticsFeed.parse(await request());
            if (feed.records.length) {
                await repository.ingest(feed.records);
                await request({
                    action: 'ack',
                    ids: feed.records.map((record) => record.id),
                });
                if (feed.records.length === 500) return;
            }
            if (!feed.request) return;
            if (
                feed.job &&
                (!['running', 'failed'].includes(feed.job.status) ||
                    feed.job.leaseUntil > now() ||
                    feed.job.attempts >= 3)
            )
                return;
            const evidence = await repository.evidence(feed.request);
            const result = AnalyticsFeed.shape.job
                .unwrap()
                .parse(await request({ action: 'baseline', evidence }));
            log({
                event: 'daily-baseline',
                day: new Date(feed.request.window.from)
                    .toISOString()
                    .slice(0, 10),
                status: result.status,
                users: evidence.population.users,
                interactions: evidence.population.interactions,
            });
        } finally {
            busy = false;
        }
    }

    async function loop() {
        let delay = config.FLOW_ANALYTICS_POLL_MS;
        try {
            await tick();
            failures = 0;
        } catch {
            delay = Math.min(
                60_000,
                config.FLOW_ANALYTICS_POLL_MS * 2 ** Math.min(++failures, 6)
            );
            log({ event: 'analytics-retry', retryInMs: delay });
        }
        if (!stopped)
            timer = setTimeout(() => {
                inFlight = loop();
            }, delay);
    }

    return {
        tick,
        start() {
            if (!stopped) return;
            stopped = false;
            inFlight = loop();
        },
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await inFlight;
        },
    };
}
