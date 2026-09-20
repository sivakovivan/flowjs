import { z } from 'zod';
import { getRuntime, handle } from '@/server/flow';

const RequestBody = z.object({
    userId: z.string().min(1).max(64),
});

/** Every refresh creates a complete, immutable personal layout without score gating. */
export async function POST(request: Request) {
    return handle(async () => {
        const { userId } = RequestBody.parse(await request.json());
        const result = await getRuntime().regeneratePersonal(userId);
        return { ...result, applied: true as const };
    });
}
