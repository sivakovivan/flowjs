import * as Sentry from '@sentry/nextjs';
import type { TelemetryEventType } from '@flowjs/core/flow/store';

/*
 * Client-side semantic telemetry. Every generated component reports through
 * this tracker; events carry the session, UI version, time since that version
 * was shown, and the Sentry replay id when replay is recording.
 */

interface QueuedEvent {
    eventId: string;
    versionId: string;
    sessionId: string;
    componentId: string;
    eventType: TelemetryEventType;
    sinceLoadMs: number;
    timestamp: number;
    metadata: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 1_500;

interface EngagementSpan {
    componentId: string;
    activeMs: number;
    path: string[];
}

export class EngagementClock {
    private componentId: string | null = null;
    private path: string[] = [];
    private checkpoint = 0;
    private lastActivity = 0;
    private foreground = true;

    read(now: number): EngagementSpan | null {
        const activeMs =
            this.foreground && this.componentId
                ? Math.max(
                      0,
                      Math.min(
                          15_000,
                          Math.min(now, this.lastActivity + 30_000) -
                              this.checkpoint
                      )
                  )
                : 0;
        this.checkpoint = now;
        return activeMs > 0
            ? {
                  componentId: this.componentId!,
                  activeMs: Math.round(activeMs),
                  path: this.path,
              }
            : null;
    }

    focus(componentId: string | null, now: number, path: string[] = []) {
        if (
            componentId === this.componentId &&
            path.join('/') === this.path.join('/')
        )
            return this.activity(now);
        const previous = this.read(now);
        this.componentId = componentId;
        this.path = path;
        this.lastActivity = now;
        return previous;
    }

    activity(now: number) {
        const previous =
            now > this.lastActivity + 30_000 ? this.read(now) : null;
        this.lastActivity = now;
        return previous;
    }

    setForeground(foreground: boolean, now: number) {
        const previous = this.read(now);
        this.foreground = foreground;
        this.lastActivity = now;
        return previous;
    }

    get target() {
        return this.componentId;
    }
}

function newSessionId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function replayId(): string | null {
    try {
        return Sentry.getReplay()?.getReplayId() ?? null;
    } catch {
        return null;
    }
}

export class Tracker {
    /** One session per page load, so a reload is a new session. */
    readonly sessionId = newSessionId();
    readonly userId = (() => {
        const key = 'flowjs:user-id';
        if (typeof window === 'undefined') return 'server-user';
        const created = newSessionId();
        try {
            const existing = localStorage.getItem(key);
            if (existing) return existing;
            localStorage.setItem(key, created);
        } catch {}
        return created;
    })();
    private versionId: string | null = null;
    private shownAt = 0;
    private queue: QueuedEvent[] = [];
    private viewed = new Set<string>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private listeners = new Set<() => void>();
    private engagement = new EngagementClock();
    private flushing = false;

    private capture(span: EngagementSpan | null) {
        if (span)
            this.track(span.componentId, 'active_time', {
                activeMs: span.activeMs,
                path: span.path,
            });
    }

    /** Start measuring against a newly shown UI version. */
    setVersion(versionId: string) {
        if (versionId === this.versionId) return;
        this.capture(this.engagement.focus(null, performance.now()));
        void this.flush();
        this.versionId = versionId;
        this.shownAt = performance.now();
        this.viewed.clear();
        this.engagement.setForeground(
            typeof document !== 'undefined' &&
                document.visibilityState === 'visible' &&
                document.hasFocus(),
            performance.now()
        );
        if (!this.timer && typeof window !== 'undefined') {
            this.timer = setInterval(() => {
                void this.flush();
            }, FLUSH_INTERVAL_MS);
            const visibility = () => {
                this.capture(
                    this.engagement.setForeground(
                        document.visibilityState === 'visible' &&
                            document.hasFocus(),
                        performance.now()
                    )
                );
                if (document.visibilityState !== 'visible')
                    void this.flush(true);
            };
            window.addEventListener('blur', visibility);
            window.addEventListener('focus', visibility);
            document.addEventListener('visibilitychange', visibility);
            window.addEventListener('pagehide', () => {
                this.capture(
                    this.engagement.setForeground(false, performance.now())
                );
                void this.flush(true);
            });
            for (const event of ['pointermove', 'keydown', 'touchstart'])
                window.addEventListener(
                    event,
                    () => {
                        this.capture(
                            this.engagement.activity(performance.now())
                        );
                    },
                    { passive: true }
                );
        }
    }

    get currentVersion() {
        return this.versionId;
    }

    endEngagement(componentId: string) {
        if (this.engagement.target === componentId)
            this.capture(this.engagement.focus(null, performance.now()));
    }

    navigation(
        eventType: 'menu_open' | 'menu_close' | 'menu_select' | 'tab_select',
        path: string[]
    ) {
        this.capture(
            this.engagement.focus('__navigation__', performance.now(), path)
        );
        this.track('__navigation__', eventType, { path });
        if (eventType === 'menu_close' || eventType === 'menu_select')
            this.endEngagement('__navigation__');
    }

    track(
        componentId: string,
        eventType: TelemetryEventType,
        metadata: Record<string, unknown> = {}
    ) {
        if (!this.versionId) return;
        if (
            [
                'component_hover',
                'component_focus',
                'component_scroll',
                'component_click',
                'value_change',
                'disabled_interaction',
            ].includes(eventType)
        )
            this.capture(this.engagement.focus(componentId, performance.now()));
        if (eventType === 'component_view') {
            if (this.viewed.has(componentId)) return;
            this.viewed.add(componentId);
        }
        const replay = replayId();
        const semanticMetadata = Object.fromEntries(
            ['direction', 'element', 'activeMs', 'path', 'traceId']
                .filter((key) => key in metadata)
                .map((key) => [key, metadata[key]])
        );
        semanticMetadata.viewport =
            typeof window === 'undefined'
                ? 'unknown'
                : window.innerWidth < 768
                  ? 'compact'
                  : 'wide';
        if (replay) semanticMetadata.replayId = replay;
        if (this.queue.length >= 2000) this.queue.shift();
        this.queue.push({
            eventId: crypto.randomUUID(),
            versionId: this.versionId,
            sessionId: this.sessionId,
            componentId,
            eventType,
            sinceLoadMs: Math.round(performance.now() - this.shownAt),
            timestamp: Date.now(),
            metadata: semanticMetadata,
        });
    }

    /** Notified after each successful flush, so metrics can refresh. */
    onFlush(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async flush(beacon = false) {
        this.capture(this.engagement.read(performance.now()));
        if (this.queue.length === 0) return;
        if (this.flushing && !beacon) return;
        const events = this.queue.slice(0, 50);
        const body = JSON.stringify({
            events: events.map((event) => ({ ...event, userId: this.userId })),
        });
        if (beacon && navigator.sendBeacon?.('/api/flow/telemetry', body))
            return;
        if (this.flushing) return;
        this.flushing = true;
        try {
            const response = await fetch('/api/flow/telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            });
            if (!response.ok) return;
            const acknowledged = new Set(events.map((event) => event.eventId));
            this.queue = this.queue.filter(
                (event) => !acknowledged.has(event.eventId)
            );
            this.listeners.forEach((listener) => listener());
        } catch {
            return;
        } finally {
            this.flushing = false;
        }
    }
}

export const tracker = new Tracker();
