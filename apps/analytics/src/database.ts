import { readFileSync } from 'node:fs';
import { Pool, type PoolConfig } from 'pg';

export function databaseOptions(
    connectionString: string,
    caFile = process.env.TIGER_SSL_ROOT_CERT
): PoolConfig {
    const address = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(address.protocol))
        throw new Error(
            'TIGER_DATABASE_URL must be a PostgreSQL connection URL.'
        );
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(
        address.hostname
    );
    const disableTLS = address.searchParams.get('sslmode') === 'disable';
    if (disableTLS && !local)
        throw new Error('TLS cannot be disabled for a remote Tiger database.');
    const rootCertificate = caFile || address.searchParams.get('sslrootcert');
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])
        address.searchParams.delete(key);
    return {
        connectionString: address.toString(),
        ssl:
            local && disableTLS
                ? false
                : {
                      rejectUnauthorized: true,
                      ...(rootCertificate
                          ? { ca: readFileSync(rootCertificate, 'utf8') }
                          : {}),
                  },
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 10_000,
        application_name: 'flowjs-analytics',
    };
}

export function openDatabase(connectionString: string): Pool {
    return new Pool(databaseOptions(connectionString));
}
