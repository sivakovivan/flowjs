import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';
import { databaseOptions } from './database';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

describe('analytics configuration', () => {
    it('can report an unconfigured service without inventing a database', () => {
        expect(readConfig({})).toMatchObject({ FLOW_ANALYTICS_PORT: 4319 });
        expect(readConfig({}).TIGER_DATABASE_URL).toBeUndefined();
        expect(
            readConfig({ TIGER_DATABASE_URL: '', FLOW_ANALYTICS_TOKEN: '' })
                .TIGER_DATABASE_URL
        ).toBeUndefined();
    });

    it('rejects invalid settings without printing secrets', () => {
        expect(() =>
            readConfig({ FLOW_ANALYTICS_TOKEN: 'short-secret' })
        ).toThrow('Invalid analytics configuration: FLOW_ANALYTICS_TOKEN');
    });

    it('verifies remote TLS even when a provider URL uses sslmode=require', () => {
        const options = databaseOptions(
            'postgresql://user:secret@database.example/db?sslmode=require'
        );
        expect(options.ssl).toEqual({ rejectUnauthorized: true });
        expect(options.connectionString).not.toContain('sslmode');
        expect(() =>
            databaseOptions(
                'postgresql://user:secret@database.example/db?sslmode=disable'
            )
        ).toThrow('TLS cannot be disabled');
        expect(
            databaseOptions('postgresql://localhost/test?sslmode=disable').ssl
        ).toBe(false);
    });

    it('trusts an explicitly supplied CA while retaining certificate verification', () => {
        vi.mocked(readFileSync).mockReturnValue('provider-ca');
        const options = databaseOptions(
            'postgresql://database.example/db?sslmode=require',
            '/private/root.pem'
        );
        expect(readFileSync).toHaveBeenCalledWith('/private/root.pem', 'utf8');
        expect(options.ssl).toEqual({
            rejectUnauthorized: true,
            ca: 'provider-ca',
        });
        const fromURL = databaseOptions(
            'postgresql://database.example/db?sslrootcert=/private/root.pem',
            ''
        );
        expect(fromURL.ssl).toEqual(options.ssl);
        expect(fromURL.connectionString).not.toContain('sslrootcert');
    });

    it('does not connect with weaker TLS when the CA file is unreadable', () => {
        vi.mocked(readFileSync).mockImplementationOnce(() => {
            throw new Error('CA file unavailable');
        });
        expect(() =>
            databaseOptions(
                'postgresql://database.example/db',
                '/missing/root.pem'
            )
        ).toThrow('CA file unavailable');
    });
});
