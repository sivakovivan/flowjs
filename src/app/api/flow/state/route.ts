import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compatiblePrimitives } from '@/flow/primitives';
import { aiMode, getRuntime, handle, sentryEnabled } from '@/server/flow';

/** Everything the client needs to render: capabilities, active version, history. */
export async function GET() {
    return handle(async () => {
        const runtime = getRuntime();
        const { application, active, versions } = runtime.state();
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
