import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { openDatabase } from './database';
import { readConfig } from './config';

export async function migrate(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(724196031)');
        await client.query('CREATE SCHEMA IF NOT EXISTS flow_analytics');
        await client.query(`CREATE TABLE IF NOT EXISTS flow_analytics.migrations (
            version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        for (const [version, filename] of [
            [1, '001_telemetry.sql'],
            [2, '002_sources.sql'],
        ] as const) {
            const existing = await client.query(
                'SELECT version FROM flow_analytics.migrations WHERE version = $1',
                [version]
            );
            if (existing.rowCount === 0) {
                await client.query(
                    await readFile(
                        new URL(`../sql/${filename}`, import.meta.url),
                        'utf8'
                    )
                );
                await client.query(
                    'INSERT INTO flow_analytics.migrations (version) VALUES ($1)',
                    [version]
                );
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { TIGER_DATABASE_URL } = readConfig();
    if (!TIGER_DATABASE_URL)
        throw new Error('Set TIGER_DATABASE_URL before running migrations.');
    const pool = openDatabase(TIGER_DATABASE_URL);
    try {
        await migrate(pool);
        console.log('Tiger telemetry migration applied.');
    } finally {
        await pool.end();
    }
}
