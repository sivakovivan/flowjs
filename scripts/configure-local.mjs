import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = new URL('../.env.local', import.meta.url);

try {
    const { values } = parseArgs({
        options: { openai: { type: 'string' }, tiger: { type: 'string' } },
    });
    if (!values.openai || !values.tiger)
        throw new Error('Provide --openai and --tiger credential file paths.');
    if (existsSync(target))
        throw new Error(
            'The local environment file already exists; it was not overwritten.'
        );
    execFileSync('git', ['check-ignore', '-q', '--', '.env.local'], {
        cwd: root,
        stdio: 'ignore',
    });

    const rawKey = readFileSync(values.openai, 'utf8').trim();
    const apiKey = parseEnv(rawKey).OPENAI_API_KEY ?? rawKey;
    if (!/^sk-[A-Za-z0-9_-]+$/.test(apiKey))
        throw new Error('The OpenAI file does not contain a valid key format.');

    const credentials = readFileSync(values.tiger, 'utf8');
    const connection = credentials.match(
        /^Service URL:\s*(postgres(?:ql)?:\/\/\S+)/m
    )?.[1];
    if (!connection)
        throw new Error('The Tiger file is missing its Service URL entry.');
    const address = new URL(connection);
    if (
        !address.hostname.endsWith('.tsdb.cloud.timescale.com') ||
        !address.password
    )
        throw new Error(
            'Expected a Tiger Cloud URL containing database credentials.'
        );
    address.searchParams.set('sslmode', 'verify-full');

    const settings = {
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: 'gpt-5.5',
        FLOW_AI_MODE: 'live',
        TIGER_DATABASE_URL: address.toString(),
        FLOW_ANALYTICS_TOKEN: randomBytes(32).toString('hex'),
        FLOW_ANALYTICS_ENABLED: '1',
        FLOW_APP_URL: 'http://127.0.0.1:3000',
        FLOW_ANALYTICS_PORT: '4319',
        FLOW_ANALYTICS_POLL_MS: '1500',
    };
    writeFileSync(
        target,
        Object.entries(settings)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join('\n') + '\n',
        { flag: 'wx', mode: 0o600 }
    );
    chmodSync(values.openai, 0o600);
    console.log(
        'Local environment configured with live OpenAI and daily Tiger analytics. Secrets were not printed.'
    );
} catch (error) {
    const safeMessages = [
        'Provide --openai and --tiger credential file paths.',
        'The local environment file already exists; it was not overwritten.',
        'The OpenAI file does not contain a valid key format.',
        'The Tiger file is missing its Service URL entry.',
        'Expected a Tiger Cloud URL containing database credentials.',
    ];
    console.error(
        error instanceof Error && safeMessages.includes(error.message)
            ? error.message
            : 'Local setup failed. Check file paths, permissions, and Git ignore rules; no credentials were printed.'
    );
    process.exitCode = 1;
}
