import * as Sentry from '@sentry/nextjs';

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const dsn = process.env.SENTRY_DSN;
        const tracesSampleRate = Number(
            process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.2
        );
        Sentry.init({
            dsn,
            enabled: Boolean(dsn),
            tracesSampleRate: Number.isFinite(tracesSampleRate)
                ? tracesSampleRate
                : 0.2,
            sendDefaultPii: false,
            enableLogs: true,
        });
    }
}

export const onRequestError = Sentry.captureRequestError;
