import { analyticsRequest } from '@flowjs/core/server/analytics';
import { getRuntime, handle } from '@/server/flow';

export function GET(request: Request) {
    return handle(() =>
        analyticsRequest(
            request,
            getRuntime(),
            process.env.FLOW_ANALYTICS_TOKEN
        )
    );
}

export function POST(request: Request) {
    return handle(() =>
        analyticsRequest(
            request,
            getRuntime(),
            process.env.FLOW_ANALYTICS_TOKEN
        )
    );
}
