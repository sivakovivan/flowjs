import { getRuntime, handle } from '@/server/flow';

/** Optimize Now: analyze, ask OpenAI for a proposal, validate and score it. */
export async function POST() {
    return handle(() => getRuntime().optimize());
}
