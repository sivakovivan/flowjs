import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const environment = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(environment)) process.loadEnvFile(environment);

await import('next/dist/bin/next');
