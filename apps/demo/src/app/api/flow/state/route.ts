import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compatiblePrimitives } from '@flowjs/core/flow/primitives';
import { aiMode, getRuntime, handle, sentryEnabled } from '@/server/flow';

/** Everything the client needs to render: capabilities, tracks, active version, history. */
export async function GET(request: Request) {
    return handle(async () => {
        const runtime = getRuntime();
        const userId = new URL(request.url).searchParams.get('userId');
        const {
            application,
            active,
            versions,
            layouts,
            baselineMode,
            analyticsSampleKind,
            baselineRun,
        } = runtime.state(userId ?? undefined);
        const registration = await readFile(
            join(process.cwd(), 'src/demo/sales-app.ts'),
            'utf8'
        ).catch(() => null);
        return {
            application,
            capabilities: runtime.app.capabilities.map((c) => ({
                ...c,
                compatiblePrimitives: compatiblePrimitives(c),
            })),
            graph: runtime.app.graph.edges,
            defaultState: runtime.app.defaultState(),
            active,
            baselineMode,
            analyticsSampleKind,
            baselineRun,
            layouts,
            versions: versions.map(
                ({
                    schema: _schema,
                    telemetrySnapshot: _snapshot,
                    ...version
                }) => version
            ),
            ai: aiMode(),
            sentry: {
                enabled: sentryEnabled(),
                org: process.env.NEXT_PUBLIC_SENTRY_ORG || null,
            },
            registration,
        };
    });
}
