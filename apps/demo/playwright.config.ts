import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 3418;

export default defineConfig({
    testDir: 'e2e',
    fullyParallel: false,
    workers: 1,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    use: {
        baseURL: `http://localhost:${PORT}`,
        // Use the locally installed Chrome instead of downloading browsers.
        channel: 'chrome',
        viewport: { width: 1440, height: 1000 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: `next start --port ${PORT}`,
        url: `http://localhost:${PORT}/api/flow/state`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            // A fresh database per run, and recorded AI responses for determinism.
            FLOW_DB_PATH: join(tmpdir(), `flowjs-e2e-${Date.now()}.db`),
            FLOW_AI_MODE: 'recorded',
        },
    },
});
