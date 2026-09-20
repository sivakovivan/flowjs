import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngagementClock, Tracker } from './telemetry';

vi.mock('@sentry/nextjs', () => ({ getReplay: () => null }));
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('active engagement time', () => {
    it('accumulates continuous activity without emitting one event per pointer movement', () => {
        const clock = new EngagementClock();
        clock.focus('chart', 0);
        for (let timestamp = 10; timestamp <= 1000; timestamp += 10)
            expect(clock.activity(timestamp)).toBeNull();
        expect(clock.focus('chart', 1200)).toBeNull();
        expect(clock.read(1500)?.activeMs).toBe(1500);
    });

    it('stops at the idle cutoff rather than counting gaps between clicks', () => {
        const clock = new EngagementClock();
        clock.focus('chart', 0);
        expect(clock.read(10_000)?.activeMs).toBe(10_000);
        expect(clock.read(20_000)?.activeMs).toBe(10_000);
        expect(clock.read(40_000)?.activeMs).toBe(10_000);
        expect(clock.read(100_000)).toBeNull();
    });

    it('excludes hidden/background time and attributes a transition only once', () => {
        const clock = new EngagementClock();
        clock.focus('chart', 0);
        expect(clock.setForeground(false, 5000)?.activeMs).toBe(5000);
        expect(clock.read(15_000)).toBeNull();
        expect(clock.setForeground(true, 20_000)).toBeNull();
        expect(clock.focus('filter', 23_000)).toMatchObject({
            componentId: 'chart',
            activeMs: 3000,
        });
        expect(clock.read(25_000)).toMatchObject({
            componentId: 'filter',
            activeMs: 2000,
        });
        expect(clock.read(25_000)).toBeNull();
    });
});

describe('telemetry delivery', () => {
    it('retries non-2xx batches with the same IDs and never includes typed values', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(Response.json({ accepted: 1 }));
        vi.stubGlobal('fetch', fetcher);
        const tracker = new Tracker();
        tracker.setVersion('v1');
        tracker.track('customer-search', 'value_change', {
            value: 'private@example.com',
        });
        const flushed = vi.fn();
        tracker.onFlush(flushed);
        await tracker.flush();
        expect(flushed).not.toHaveBeenCalled();
        await tracker.flush();
        const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        const second = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
        expect(second).toEqual(first);
        expect(first.events[0].eventId).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(first)).not.toContain('private@example.com');
        expect(flushed).toHaveBeenCalledOnce();
        await tracker.flush();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('keeps each event attributed to its displayed version across a retry', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(Response.json({ accepted: 2 }));
        vi.stubGlobal('fetch', fetcher);
        const tracker = new Tracker();
        tracker.setVersion('v1');
        tracker.track('chart', 'component_click');
        await tracker.flush();
        tracker.setVersion('p12345678');
        tracker.track('chart', 'component_click');
        await Promise.resolve();
        await tracker.flush();
        const delivered = fetcher.mock.calls.flatMap(
            (call) => JSON.parse(String(call[1]?.body)).events
        );
        expect(
            delivered.some(
                (event: { versionId: string }) => event.versionId === 'v1'
            )
        ).toBe(true);
        expect(
            delivered.some(
                (event: { versionId: string }) =>
                    event.versionId === 'p12345678'
            )
        ).toBe(true);
    });
});
