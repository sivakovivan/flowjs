import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    exportTelemetry,
    latestBaselineWindow,
} from '@flowjs/core/flow/analytics';
import {
    createOpenAIProvider,
    createRecordedProvider,
} from '@flowjs/core/flow/ai/providers';
import {
    createRuntime,
    type OptimizationAnalysis,
} from '@flowjs/core/flow/runtime';
import { seedAggregateCohort } from '@flowjs/core/flow/seed';
import { FlowStore } from '@flowjs/core/flow/store';
import { salesApp } from '../../demo/src/demo/sales-app';
import { salesRecording } from '../../demo/src/demo/recordings';
import { readConfig } from './config';
import { openDatabase } from './database';
import { migrate } from './migrate';
import { createRepository } from './repository';
import { createServer } from './server';

export async function replayAggregateDemo() {
    if (process.env.FLOW_ANALYTICS_SAMPLE_KIND !== 'simulated')
        throw new Error(
            'Aggregate replay requires an explicitly simulated installation.'
        );
    const path = process.env.FLOW_DB_PATH;
    if (!path || !isAbsolute(path))
        throw new Error(
            'Set an absolute FLOW_DB_PATH for the separate demo database.'
        );
    const config = readConfig();
    if (!config.TIGER_DATABASE_URL || !config.FLOW_ANALYTICS_TOKEN)
        throw new Error(
            'Configure Tiger and the analytics token before replaying.'
        );
    const store = new FlowStore(path, Date.now, {
        analytics: true,
        analyticsSampleKind: 'simulated',
    });
    const pool = openDatabase(config.TIGER_DATABASE_URL);
    const repository = createRepository(pool);
    const server = createServer(config, repository);
    try {
        await migrate(pool);
        const recorded = createRecordedProvider(salesApp, salesRecording);
        const starter = createRuntime({
            app: salesApp,
            store,
            live: null,
            recorded,
            forceRecorded: true,
        });
        const { version } = await starter.generate();
        const window = latestBaselineWindow();
        const previous = store.getBaselineJob(salesApp.id, window.to);
        if (previous && !['failed', 'running'].includes(previous.status))
            return {
                sampleKind: 'simulated',
                reused: true,
                result: previous.result,
            };

        if (
            !store
                .listEvents(salesApp.id, version.id)
                .some((event) => event.seeded)
        ) {
            const cohort = seedAggregateCohort({
                app: salesApp,
                schema: version.schema,
                versionId: version.id,
                window,
            });
            store.transaction(() => {
                store.insertEvents(cohort.events);
                for (const call of cohort.calls) store.insertCall(call);
            });
        }
        const address = await server.listen({ host: '127.0.0.1', port: 0 });
        let delivered = 0;
        while (true) {
            const records = store.listTelemetryOutbox(salesApp.id, 100);
            if (!records.length) break;
            const response = await fetch(`${address}/v1/events`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${config.FLOW_ANALYTICS_TOKEN}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    records: records.map((record) =>
                        exportTelemetry(
                            store.telemetrySourceId,
                            record,
                            'simulated'
                        )
                    ),
                }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok)
                throw new Error(
                    `The replay batch was not committed (${response.status}).`
                );
            store.acknowledgeTelemetryOutbox(
                salesApp.id,
                records.map((record) => record.id)
            );
            delivered += records.length;
        }
        const evidence = await repository.evidence({
            sourceId: store.telemetrySourceId,
            applicationId: salesApp.id,
            versionId: version.id,
            schema: version.schema,
            window,
            sampleKind: 'simulated',
        });
        const runtime = createRuntime({
            app: salesApp,
            store,
            recorded,
            dailyBaseline: true,
            live: process.env.OPENAI_API_KEY
                ? createOpenAIProvider({
                      apiKey: process.env.OPENAI_API_KEY,
                      model: process.env.OPENAI_MODEL,
                  })
                : null,
            forceRecorded: process.env.FLOW_AI_MODE === 'recorded',
        });
        runtime.setMutationRate(1);
        const job = await runtime.publishDailyBaseline(evidence);
        const run = job.result?.runId ? store.getRun(job.result.runId) : null;
        const analysis = run?.analysis as OptimizationAnalysis | undefined;
        return {
            sampleKind: 'simulated',
            delivered,
            browsers: evidence.population.users,
            sessions: evidence.population.sessions,
            interactions: evidence.population.interactions,
            window,
            result: job.result,
            aiSource: run?.aiSource ?? null,
            reason: analysis?.ai.reason ?? null,
            insights: evidence.insights.map((insight) => insight.summary),
        };
    } finally {
        await server.close();
        await pool.end();
        store.close();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        console.log(JSON.stringify(await replayAggregateDemo(), null, 2));
    } catch (error) {
        console.error(
            'Aggregate replay failed; no live installation was modified.'
        );
        if (
            error instanceof Error &&
            !/postgres|password|token|sk-/i.test(error.message)
        )
            console.error(error.message);
        process.exitCode = 1;
    }
}
