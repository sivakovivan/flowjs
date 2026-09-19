import * as Sentry from '@sentry/nextjs';
import { salesRecording } from '@/demo/recordings';
import { salesApp } from '@/demo/sales-app';
import {
    createOpenAIProvider,
    createRecordedProvider,
} from '@flowjs/core/flow/ai/providers';
import { createRuntime, type FlowRuntime } from '@flowjs/core/flow/runtime';
import { FlowStore } from '@flowjs/core/flow/store';
export { handle } from '@flowjs/core/server/http';

/*
 * One runtime per server process. The demo has a single global dashboard
 * configuration (global optimization scope).
 */

const globalForFlow = globalThis as unknown as { flowRuntime?: FlowRuntime };

export const aiMode = () => ({
    liveConfigured: Boolean(process.env.OPENAI_API_KEY),
    forcedRecorded: process.env.FLOW_AI_MODE === 'recorded',
    model: process.env.OPENAI_MODEL || null,
});

export function getRuntime(): FlowRuntime {
    if (!globalForFlow.flowRuntime) {
        const store = new FlowStore(
            process.env.FLOW_DB_PATH || '.flow/flow.db'
        );
        const apiKey = process.env.OPENAI_API_KEY;
        globalForFlow.flowRuntime = createRuntime({
            app: salesApp,
            store,
            live: apiKey
                ? createOpenAIProvider({
                      apiKey,
                      model: process.env.OPENAI_MODEL || undefined,
                  })
                : null,
            recorded: createRecordedProvider(salesApp, salesRecording),
            forceRecorded: process.env.FLOW_AI_MODE === 'recorded',
        });
    }
    return globalForFlow.flowRuntime;
}

export function sentryEnabled(): boolean {
    return Sentry.isEnabled();
}
