import { getRuntime, handle } from '@/server/flow';

/** Generate dashboard v1 from the registered capabilities with OpenAI. */
export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    return handle(() =>
        typeof body.userRequest === 'string'
            ? getRuntime().customize(body.userRequest)
            : getRuntime().generate()
    );
}
