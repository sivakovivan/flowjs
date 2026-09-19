import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { salesRecording } from "@/demo/recordings";
import { salesApp } from "@/demo/sales-app";
import { createBackboardClient, createBackboardMemory, createBackboardProvider } from "@/flow/ai/backboard";
import { createOpenAIProvider, createRecordedProvider, type FlowAIProvider } from "@/flow/ai/providers";
import { tierModelsFromEnv, type RoutingMode } from "@/flow/ai/routing";
import type { FlowMemory } from "@/flow/memory";
import { CapabilityInputError } from "@/flow/registry";
import { createRuntime, RuntimeError, type FlowRuntime } from "@/flow/runtime";
import { FlowStore } from "@/flow/store";

/*
 * One runtime per server process. The demo has a single global dashboard
 * configuration (global optimization scope).
 */

const globalForFlow = globalThis as unknown as { flowRuntime?: FlowRuntime };

type Vendor = "backboard" | "openai";

/** BackBoard when its key is set (or FLOW_AI_PROVIDER says so), otherwise OpenAI directly. */
function vendor(): Vendor | null {
  const requested = process.env.FLOW_AI_PROVIDER;
  if (requested === "backboard" || requested === "openai") return requested;
  if (process.env.BACKBOARD_API_KEY) return "backboard";
  return process.env.OPENAI_API_KEY ? "openai" : null;
}

const routingMode = (): RoutingMode => (process.env.BACKBOARD_ROUTING === "openrouter-auto" ? "openrouter-auto" : "rules");

export const aiMode = () => {
  const active = vendor();
  const key = active === "backboard" ? process.env.BACKBOARD_API_KEY : process.env.OPENAI_API_KEY;
  return {
    vendor: active,
    liveConfigured: Boolean(active && key),
    forcedRecorded: process.env.FLOW_AI_MODE === "recorded",
    model: active === "backboard" ? `routed (${routingMode()})` : process.env.OPENAI_MODEL || null,
    memory: active === "backboard" && Boolean(key) && process.env.FLOW_AI_MODE !== "recorded",
  };
};

function liveProvider(): { live: FlowAIProvider | null; memory: FlowMemory | undefined } {
  // Recorded mode makes no network calls at all, so it is deterministic offline.
  if (process.env.FLOW_AI_MODE === "recorded") return { live: null, memory: undefined };
  const active = vendor();
  if (active === "backboard" && process.env.BACKBOARD_API_KEY) {
    const client = createBackboardClient({ apiKey: process.env.BACKBOARD_API_KEY });
    return {
      live: createBackboardProvider({
        client,
        appId: salesApp.id,
        models: tierModelsFromEnv(process.env),
        mode: routingMode(),
      }),
      memory: createBackboardMemory({ client, appId: salesApp.id }),
    };
  }
  if (active === "openai" && process.env.OPENAI_API_KEY) {
    const apiKey = process.env.OPENAI_API_KEY;
    return { live: createOpenAIProvider({ apiKey, model: process.env.OPENAI_MODEL || undefined }), memory: undefined };
  }
  return { live: null, memory: undefined };
}

export function getRuntime(): FlowRuntime {
  if (!globalForFlow.flowRuntime) {
    const store = new FlowStore(process.env.FLOW_DB_PATH || ".flow/flow.db");
    const { live, memory } = liveProvider();
    globalForFlow.flowRuntime = createRuntime({
      app: salesApp,
      store,
      live,
      memory,
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
