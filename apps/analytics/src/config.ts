import { z } from 'zod';

const optionalSetting = <Schema extends z.ZodType>(schema: Schema) =>
    z.preprocess(
        (value) => (value === '' ? undefined : value),
        schema.optional()
    );

const Settings = z.object({
    TIGER_DATABASE_URL: optionalSetting(z.url()),
    FLOW_ANALYTICS_TOKEN: optionalSetting(z.string().min(32)),
    FLOW_ANALYTICS_PORT: z.coerce
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(4319),
    FLOW_APP_URL: z.url().default('http://127.0.0.1:3000'),
    FLOW_ANALYTICS_POLL_MS: z.coerce
        .number()
        .int()
        .min(500)
        .max(60_000)
        .default(1500),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
    const parsed = Settings.safeParse(env);
    if (!parsed.success)
        throw new Error(
            `Invalid analytics configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`
        );
    return parsed.data;
}

export type AnalyticsConfig = ReturnType<typeof readConfig>;
