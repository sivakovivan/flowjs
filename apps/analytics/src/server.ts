import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AnalyticsBatch } from '@flowjs/core/flow/analytics';
import { validAnalyticsToken } from '@flowjs/core/server/analytics';
import type { AnalyticsConfig } from './config';
import type { AnalyticsRepository } from './repository';

export function createServer(
    config: AnalyticsConfig,
    repository: AnalyticsRepository | null
) {
    const server = Fastify({ bodyLimit: 1_048_576 });

    server.get('/health', async (_request, reply) => {
        if (!repository || !config.FLOW_ANALYTICS_TOKEN)
            return reply.code(503).send({
                status: 'unconfigured',
                required: ['TIGER_DATABASE_URL', 'FLOW_ANALYTICS_TOKEN'],
            });
        try {
            await repository.health();
            return { status: 'ready', baselineSchedule: 'daily at 00:05 UTC' };
        } catch {
            return reply.code(503).send({
                status: 'unavailable',
                error: 'Tiger database or migrations unavailable.',
            });
        }
    });

    server.post(
        '/v1/events',
        {
            onRequest: async (request, reply) => {
                if (
                    !validAnalyticsToken(
                        request.headers.authorization,
                        config.FLOW_ANALYTICS_TOKEN
                    )
                )
                    return reply.code(401).send({
                        error: 'Analytics service authentication required.',
                    });
            },
        },
        async (request, reply) => {
            if (!repository)
                return reply
                    .code(503)
                    .send({ error: 'Tiger database is not configured.' });
            const { records } = AnalyticsBatch.parse(request.body);
            const accepted = await repository.ingest(records);
            return { accepted, duplicates: records.length - accepted };
        }
    );

    server.setErrorHandler((error, _request, reply) => {
        const status =
            error instanceof ZodError
                ? 400
                : typeof error === 'object' &&
                    error !== null &&
                    'statusCode' in error &&
                    (error.statusCode === 400 || error.statusCode === 413)
                  ? error.statusCode
                  : 503;
        return reply.code(status).send({
            error:
                status === 400
                    ? 'Invalid telemetry batch.'
                    : status === 413
                      ? 'Telemetry batch is too large.'
                      : 'Telemetry was not committed; retry the batch.',
        });
    });
    return server;
}
