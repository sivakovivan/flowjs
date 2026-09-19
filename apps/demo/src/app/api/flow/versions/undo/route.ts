import { getRuntime, handle } from '@/server/flow';

/** Activate the active version's parent. History is kept. */
export async function POST() {
    return handle(() => ({ version: getRuntime().undo() }));
}
