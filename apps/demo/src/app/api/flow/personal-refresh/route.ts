import { z } from 'zod';
import { applyMutations } from '@flowjs/core/flow/mutations';
import type { UISchema } from '@flowjs/core/flow/schema';
import { getRuntime, handle } from '@/server/flow';

const RequestBody = z.object({
    userId: z.string().min(1).max(64),
    refreshCount: z.number().int().min(1).max(10_000),
});

/** Optimize one browser's layout without activating or mutating the average track. */
export async function POST(request: Request) {
    return handle(async () => {
        const { userId, refreshCount } = RequestBody.parse(
            await request.json()
        );
        const runtime = getRuntime();
        let run;
        try {
            run = await runtime.optimize({ userId });
        } catch {
            return {
                run: null,
                version: savePersonal(
                    runtime,
                    userId,
                    demoPersonalSchema(runtime, userId, refreshCount)
                ),
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
                version: savePersonal(
                    runtime,
                    userId,
                    demoPersonalSchema(runtime, userId, refreshCount)
                ),
                applied: true,
            };
        const result = applyMutations(
            runtime.store.getActiveVersion(runtime.app.id)!.schema,
            run.proposedMutations,
            runtime.app
        );
        if (!result.ok) return { run, version: null, applied: false };
        return {
            run,
            version: savePersonal(runtime, userId, result.schema),
            applied: true,
        };
    });
}

function savePersonal(
    runtime: ReturnType<typeof getRuntime>,
    userId: string,
    schema: UISchema
) {
    const average = runtime.store.getActiveVersion(runtime.app.id)!;
    return runtime.store.createPersonalVersion({
        applicationId: runtime.app.id,
        userId,
        parentVersionId: average.id,
        schema,
        reason: 'Personal layout updated from individual usage',
    });
}

function demoPersonalSchema(
    runtime: ReturnType<typeof getRuntime>,
    userId: string,
    refreshCount: number
) {
    const average = runtime.store.getActiveVersion(runtime.app.id)!.schema;
    const events = runtime.store.listEvents(runtime.app.id, average.id, userId);
    const shift =
        Math.max(events.length, refreshCount) %
        Math.max(1, average.components.length);
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
