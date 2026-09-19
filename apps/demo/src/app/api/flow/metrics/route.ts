import { getRuntime, handle } from '@/server/flow';

/** Live UX metrics, backend latency and heuristic findings for the active version. */
export async function GET() {
    return handle(() => {
        const { version, metrics, findings } = getRuntime().analyze();
        return { versionId: version.id, metrics, findings };
    });
}
