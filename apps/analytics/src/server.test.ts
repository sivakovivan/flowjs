import { describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';
import type { AnalyticsRepository } from './repository';
import { createServer } from './server';

const token = 'test-analytics-token-with-32-characters';
const config = readConfig({ FLOW_ANALYTICS_TOKEN: token });

describe('ingestion HTTP service', () => {
    it('reports missing configuration without pretending to have a database', async () => {
        const server = createServer(readConfig({}), null);
        const health = await server.inject('/health');
        expect(health.statusCode).toBe(503);
        expect(health.json().status).toBe('unconfigured');
        await server.close();
    });

    it('authenticates before ingestion and rejects malformed batches', async () => {
        const repository = {
            health: vi.fn(),
            ingest: vi.fn(),
            evidence: vi.fn(),
        } satisfies AnalyticsRepository;
        const server = createServer(config, repository);
        expect(
            (
                await server.inject({
                    method: 'POST',
                    url: '/v1/events',
                    payload: { records: [] },
                })
            ).statusCode
        ).toBe(401);
        expect(
            (
                await server.inject({
                    method: 'POST',
                    url: '/v1/events',
                    headers: { authorization: `Bearer ${token}` },
                    payload: { records: [{ userId: 'bad' }] },
                })
            ).statusCode
        ).toBe(400);
        expect(repository.ingest).not.toHaveBeenCalled();
        await server.close();
    });

    it('returns a retryable error when persistence fails, not a success acknowledgement', async () => {
        const repository = {
            health: vi.fn(),
            ingest: vi.fn().mockRejectedValue(new Error('database offline')),
            evidence: vi.fn(),
        } satisfies AnalyticsRepository;
        const server = createServer(config, repository);
        const response = await server.inject({
            method: 'POST',
            url: '/v1/events',
            headers: { authorization: `Bearer ${token}` },
            payload: { records: [] },
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain('database offline');
        await server.close();
    });
});
