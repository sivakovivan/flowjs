import { z } from 'zod';
import { applyMutations } from '@flowjs/core/flow/mutations';
import { getRuntime, handle } from '@/server/flow';

const RequestBody = z.object({ userId: z.string().min(1).max(64) });

/** Optimize one browser's layout without activating or mutating the average track. */
export async function POST(request: Request) {
    return handle(async () => {
        const { userId } = RequestBody.parse(await request.json());
        const runtime = getRuntime();
        let run;
        try {
            run = await runtime.optimize({ userId });
        } catch {
            return {
                run: null,
                schema: demoPersonalSchema(runtime, userId),
                applied: true,
            };
        }
        // Demo mode intentionally applies any validated proposal so the
        // personal track is observable before we tune confidence thresholds.
        if (
            (run.status !== 'auto' && run.status !== 'pending') ||
            run.proposedMutations.length === 0
        )
            return {
                run,
                schema: demoPersonalSchema(runtime, userId),
                applied: true,
            };
        const result = applyMutations(
            runtime.store.getActiveVersion(runtime.app.id)!.schema,
            run.proposedMutations,
            runtime.app
        );
        if (!result.ok) return { run, schema: null, applied: false };
        return { run, schema: result.schema, applied: true };
    });
}

function demoPersonalSchema(
    runtime: ReturnType<typeof getRuntime>,
    userId: string
) {
    const average = runtime.store.getActiveVersion(runtime.app.id)!.schema;
    const events = runtime.store.listEvents(runtime.app.id, average.id, userId);
    const shift = events.length % Math.max(1, average.components.length);
    const components = [...average.components];
    if (shift) components.push(...components.splice(0, shift));
    return {
        ...average,
        components: components.map((component, order) => ({
            ...component,
            order,
        })),
    };
}
