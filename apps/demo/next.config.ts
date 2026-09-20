import { withSentryConfig } from '@sentry/nextjs/config';
import { loadEnvConfig } from '@next/env';
import path from 'node:path';
import type { NextConfig } from 'next';

// The workspace keeps local credentials at the repository root while Next
// runs with apps/demo as its project directory.
loadEnvConfig(path.resolve(process.cwd(), '../..'));

const nextConfig: NextConfig = {
    transpilePackages: ['@flowjs/core'],
};

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    silent: !process.env.CI,
    // Source maps are only uploaded when an auth token is configured.
    sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    telemetry: false,
});
