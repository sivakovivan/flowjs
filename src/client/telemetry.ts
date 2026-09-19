import * as Sentry from "@sentry/nextjs";
import type { TelemetryEventType } from "@/flow/store";

/*
 * Client-side semantic telemetry. Every generated component reports through
 * this tracker; events carry the session, UI version, time since that version
 * was shown, and the Sentry replay id when replay is recording.
 */

interface QueuedEvent {
  versionId: string;
  sessionId: string;
  componentId: string;
  eventType: TelemetryEventType;
  sinceLoadMs: number;
  timestamp: number;
  metadata: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 1_500;

function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
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

class Tracker {
  /** One session per page load, so a reload is a new session. */
  readonly sessionId = newSessionId();
  private versionId: string | null = null;
  private shownAt = 0;
  private queue: QueuedEvent[] = [];
  private viewed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  /** Start measuring against a newly shown UI version. */
  setVersion(versionId: string) {
    if (versionId === this.versionId) return;
    this.flush();
    this.versionId = versionId;
    this.shownAt = performance.now();
    this.viewed.clear();
    if (!this.timer && typeof window !== "undefined") {
      this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      window.addEventListener("pagehide", () => this.flush(true));
    }
  }

  get currentVersion() {
    return this.versionId;
  }

  track(componentId: string, eventType: TelemetryEventType, metadata: Record<string, unknown> = {}) {
    if (!this.versionId) return;
    if (eventType === "component_view") {
      if (this.viewed.has(componentId)) return;
      this.viewed.add(componentId);
    }
    const replay = replayId();
    this.queue.push({
      versionId: this.versionId,
      sessionId: this.sessionId,
      componentId,
      eventType,
      sinceLoadMs: Math.round(performance.now() - this.shownAt),
      timestamp: Date.now(),
      metadata: replay ? { ...metadata, replayId: replay } : metadata,
    });
  }

  /** Notified after each successful flush, so metrics can refresh. */
  onFlush(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(beacon = false) {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);
    const body = JSON.stringify({ events });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/flow/telemetry", body);
      return;
    }
    fetch("/api/flow/telemetry", { method: "POST", body, keepalive: true })
      .then(() => this.listeners.forEach((listener) => listener()))
      .catch(() => {
        // Telemetry is best-effort; drop the batch rather than block the UI.
      });
  }
}

export const tracker = new Tracker();
