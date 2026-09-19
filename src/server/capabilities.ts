import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { parseDataOutput } from '../flow/data-contracts';
import { CapabilityInputError } from '../flow/registry';
import type { FlowRuntime } from '../flow/runtime';

/*
 * Execute a registered capability inside a Sentry span, and record the locally
 * measured latency with the span's trace id. That pairing lets flow.js tell
 * slow backends apart from hard-to-find controls.
 */

export const CallContext = z.object({
    state: z.record(z.string(), z.string().max(200)).default({}),
    sessionId: z.string().max(64).nullable().default(null),
    versionId: z.string().max(16).nullable().default(null),
    componentId: z.string().max(64).nullable().default(null),
    replayId: z.string().max(64).nullable().default(null),
});

export const ActionRequest = CallContext.extend({
    input: z.record(z.string(), z.unknown()).default({}),
});

export async function runCapability(
    runtime: FlowRuntime,
    kind: 'data' | 'action',
    capabilityId: string,
    context: z.infer<typeof ActionRequest>
) {
    const { app, store } = runtime;
    const capability = app.capability(capabilityId);
    if (!capability || capability.kind !== kind) {
        throw new CapabilityInputError(
            `Unknown ${kind} capability "${capabilityId}".`
        );
    }

    return Sentry.startSpan(
        {
            name: `flow.${kind} ${capabilityId}`,
            op: `flow.${kind}`,
            attributes: {
                'flow.capability': capabilityId,
                'flow.component': context.componentId ?? '',
                'flow.version': context.versionId ?? '',
                'flow.session': context.sessionId ?? '',
                ...(context.replayId
                    ? { 'flow.replay_id': context.replayId }
                    : {}),
            },
        },
        async (span) => {
            const traceId = Sentry.isEnabled()
                ? span.spanContext().traceId
                : null;
            const started = performance.now();
            let ok = true;
            let error: string | null = null;
            try {
                if (kind === 'data') {
                    const value = await app.fetchData(
                        capabilityId,
                        context.state
                    );
                    if (capability.kind !== 'data')
                        throw new Error('unreachable');
                    return {
                        value: parseDataOutput(capability.output, value),
                        traceId,
                    };
                }
                return {
                    value: await app.executeAction(
                        capabilityId,
                        context.input,
                        context.state
                    ),
                    traceId,
                };
            } catch (caught) {
                ok = false;
                error =
                    caught instanceof Error ? caught.message : String(caught);
                span.setStatus({ code: 2, message: error });
                Sentry.logger.error('flow.capability failed', {
                    capability: capabilityId,
                    kind,
                    error,
                });
                throw caught instanceof CapabilityInputError
                    ? caught
                    : new CapabilityInputError(error);
            } finally {
                const latencyMs =
                    Math.round((performance.now() - started) * 10) / 10;
                span.setAttribute('flow.latency_ms', latencyMs);
                store.insertCall({
                    applicationId: app.id,
                    versionId: context.versionId,
                    sessionId: context.sessionId,
                    componentId: context.componentId,
                    capabilityId,
                    kind,
                    latencyMs,
                    ok,
                    error,
                    traceId,
                    replayId: context.replayId,
                    seeded: false,
                    createdAt: Date.now(),
                });
                if (ok)
                    Sentry.logger.info('flow.capability', {
                        capability: capabilityId,
                        kind,
                        latencyMs,
                    });
            }
        }
    );
}
