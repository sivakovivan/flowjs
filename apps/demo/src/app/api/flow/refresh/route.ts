import { getRuntime, handle } from '@/server/flow';

/** Refresh-time adaptive pass: apply only an already-approved auto proposal. */
export async function POST() {
    return handle(async () => {
        const runtime = getRuntime();
        const run = await runtime.optimize();
        if (run.status !== 'auto')
            return { run, version: null, applied: false };
        const result = runtime.apply(run.id, 'auto');
        return { run: result.run, version: result.version, applied: true };
    });
}
