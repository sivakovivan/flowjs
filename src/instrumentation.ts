import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
    Sentry.init({
      dsn,
      enabled: Boolean(dsn),
      tracesSampleRate: 1.0,
      enableLogs: true,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
