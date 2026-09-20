import { readConfig } from './config';
import { openDatabase } from './database';
import { createRepository } from './repository';
import { createServer } from './server';
import { createWorker } from './worker';

const config = readConfig();
const pool =
    config.TIGER_DATABASE_URL && config.FLOW_ANALYTICS_TOKEN
        ? openDatabase(config.TIGER_DATABASE_URL)
        : null;
const repository = pool ? createRepository(pool) : null;
const server = createServer(config, repository);
const worker = repository ? createWorker({ config, repository }) : null;

pool?.on('error', () =>
    console.error(
        'Tiger connection interrupted; pending telemetry remains in the app outbox.'
    )
);
await server.listen({ port: config.FLOW_ANALYTICS_PORT, host: '127.0.0.1' });
console.log(
    `Analytics service: http://127.0.0.1:${config.FLOW_ANALYTICS_PORT}`
);
if (worker) worker.start();
else
    console.log(
        'Unconfigured: set TIGER_DATABASE_URL and FLOW_ANALYTICS_TOKEN. No mock database is used.'
    );

let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true;
    await worker?.stop();
    await server.close();
    await pool?.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
