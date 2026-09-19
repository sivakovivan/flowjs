import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CapabilityInputError } from '../flow/registry';
import { RuntimeError } from '../flow/runtime';

/** Uniform JSON errors for flow.js route handlers. */
export async function handle(
    fn: () => Promise<unknown> | unknown
): Promise<NextResponse> {
    try {
        return NextResponse.json(await fn());
    } catch (error) {
        if (error instanceof RuntimeError)
            return NextResponse.json(
                { error: error.message },
                { status: error.status }
            );
        if (error instanceof CapabilityInputError)
            return NextResponse.json({ error: error.message }, { status: 400 });
        if (error instanceof ZodError) {
            return NextResponse.json(
                { error: 'Invalid request.', issues: error.issues },
                { status: 400 }
            );
        }
        Sentry.captureException(error);
        console.error(error);
        return NextResponse.json(
            {
                error:
                    error instanceof Error ? error.message : 'Internal error',
            },
            { status: 500 }
        );
    }
}
