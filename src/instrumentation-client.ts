import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const tracesSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.2
);
const replaySessionSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? 0.1
);

// Tracing + Session Replay: flow.js correlates UI telemetry with trace and
// replay ids so friction can be attributed to the interface or the backend.
Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    tracesSampleRate: Number.isFinite(tracesSampleRate)
        ? tracesSampleRate
        : 0.2,
    tracePropagationTargets: [/^\/api\/flow\//],
    replaysSessionSampleRate: Number.isFinite(replaySessionSampleRate)
        ? replaySessionSampleRate
        : 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    enableLogs: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
