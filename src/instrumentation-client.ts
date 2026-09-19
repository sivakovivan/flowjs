import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

// Tracing + Session Replay: flow.js correlates UI telemetry with trace and
// replay ids so friction can be attributed to the interface or the backend.
Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false })],
  tracesSampleRate: 1.0,
  tracePropagationTargets: [/^\/api\/flow\//],
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  enableLogs: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
