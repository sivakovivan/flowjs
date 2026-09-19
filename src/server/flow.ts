import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { salesRecording } from "@/demo/recordings";
import { salesApp } from "@/demo/sales-app";
import { createOpenAIProvider, createRecordedProvider } from "@/flow/ai/providers";
import { CapabilityInputError } from "@/flow/registry";
import { createRuntime, RuntimeError, type FlowRuntime } from "@/flow/runtime";
import { FlowStore } from "@/flow/store";

/*
 * One runtime per server process. The demo has a single global dashboard
 * configuration (global optimization scope).
 */

const globalForFlow = globalThis as unknown as { flowRuntime?: FlowRuntime };

export const aiMode = () => ({
  liveConfigured: Boolean(process.env.OPENAI_API_KEY),
  forcedRecorded: process.env.FLOW_AI_MODE === "recorded",
  model: process.env.OPENAI_MODEL || null,
});

export function getRuntime(): FlowRuntime {
  if (!globalForFlow.flowRuntime) {
    const store = new FlowStore(process.env.FLOW_DB_PATH || ".flow/flow.db");
    const apiKey = process.env.OPENAI_API_KEY;
    globalForFlow.flowRuntime = createRuntime({
      app: salesApp,
      store,
      live: apiKey ? createOpenAIProvider({ apiKey, model: process.env.OPENAI_MODEL || undefined }) : null,
      recorded: createRecordedProvider(salesApp, salesRecording),
      forceRecorded: process.env.FLOW_AI_MODE === "recorded",
    });
  }
  return globalForFlow.flowRuntime;
}

export function sentryEnabled(): boolean {
  return Sentry.isEnabled();
}

/** Uniform JSON errors for route handlers. */
export async function handle(fn: () => Promise<unknown> | unknown): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (error) {
    if (error instanceof RuntimeError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof CapabilityInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Invalid request.", issues: error.issues }, { status: 400 });
    }
    Sentry.captureException(error);
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal error" }, { status: 500 });
  }
}
