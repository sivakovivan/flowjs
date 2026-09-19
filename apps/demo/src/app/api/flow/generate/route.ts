import { getRuntime, handle } from '@/server/flow';

/** Generate dashboard v1 from the registered capabilities with OpenAI. */
export async function POST() {
    return handle(() => getRuntime().generate());
}
