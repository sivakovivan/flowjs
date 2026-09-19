import { z } from "zod";
import type { FlowMemory, RecalledMemory } from "../memory";
import { GENERATION_INSTRUCTIONS, OPTIMIZATION_INSTRUCTIONS } from "./briefs";
import { GeneratedSchemaOutput, OptimizationOutput } from "./contracts";
import { ProviderOutput, type CallMeta, type FlowAIProvider, type OutputCheck } from "./providers";
import { routeTask, type Route, type RouteStep, type RoutingMode, type RoutingSignals, type TierModels } from "./routing";

/*
 * BackBoard (https://docs.backboard.io) as the reasoning layer: one API key,
 * many model vendors, threads and persistent memory.
 *
 * BackBoard's `json_output` guarantees a JSON object, not a schema. Structure
 * is enforced here: the JSON Schema goes in the system prompt, the reply is
 * parsed with Zod and checked by the runtime's validator, and problems are
 * sent back in the same thread for repair before escalating to a stronger model.
 */

export const BACKBOARD_BASE_URL = "https://app.backboard.io/api";
export const MAX_REPAIRS_PER_MODEL = 1;

type Fetch = typeof fetch;

export class BackboardError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "BackboardError";
  }
}

interface MessageResponse {
  content: string | null;
  status: string;
  thread_id: string;
  model_provider?: string | null;
  model_name?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export function createBackboardClient(options: { apiKey: string; baseUrl?: string; fetch?: Fetch; timeoutMs?: number }) {
  const baseUrl = options.baseUrl ?? BACKBOARD_BASE_URL;
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { "X-API-Key": options.apiKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new BackboardError(`BackBoard request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new BackboardError(`BackBoard ${response.status}: ${text.slice(0, 300)}`, response.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  const assistants = new Map<string, Promise<string>>();

  return {
    /** Find or create the assistant that owns an application's threads and memory. */
    assistantId(name: string, systemPrompt: string): Promise<string> {
      let pending = assistants.get(name);
      if (!pending) {
        pending = (async () => {
          const existing = await request<Array<{ name: string; assistant_id: string }>>("GET", "/assistants");
          const match = existing.find((a) => a.name === name);
          if (match) return match.assistant_id;
          const created = await request<{ assistant_id: string }>("POST", "/assistants", {
            name,
            system_prompt: systemPrompt,
          });
          return created.assistant_id;
        })();
        pending.catch(() => assistants.delete(name));
        assistants.set(name, pending);
      }
      return pending;
    },
    sendMessage: (body: Record<string, unknown>) => request<MessageResponse>("POST", "/threads/messages", body),
    addMemory: (assistantId: string, content: string, metadata: Record<string, unknown>) =>
      request<{ memory_id: string }>("POST", `/assistants/${assistantId}/memories`, { content, metadata }),
    listMemories: (assistantId: string) =>
      request<{
        memories: Array<{ id: string; content: string; metadata: Record<string, unknown> | null; created_at: string | null }>;
      }>("GET", `/assistants/${assistantId}/memories?page=1&page_size=100`),
    resetMemories: (assistantId: string) => request<{ success: boolean }>("DELETE", `/assistants/${assistantId}/memories`),
    deleteAssistant: (assistantId: string) => request<unknown>("DELETE", `/assistants/${assistantId}`),
  };
}

export type BackboardClient = ReturnType<typeof createBackboardClient>;

export const assistantName = (appId: string) => `flowjs-${appId}`;
const ASSISTANT_PROMPT =
  "You are flow.js, an adaptive interface runtime. You generate UI schemas and propose structured interface mutations as JSON.";

/** Models sometimes wrap JSON in a code fence despite instructions. */
export function parseJsonReply(content: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!content) return { ok: false, error: "The reply was empty." };
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(unfenced) };
  } catch (error) {
    return { ok: false, error: `The reply was not valid JSON (${error instanceof Error ? error.message : "parse error"}).` };
  }
}

function structuredPrompt(instructions: string, schema: z.ZodType): string {
  return `${instructions}

Output format: reply with one JSON object only, no prose and no markdown fences. It must conform to this JSON Schema, with every property present:
${JSON.stringify(z.toJSONSchema(schema))}`;
}

const zodErrors = (schema: z.ZodType, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
};

export function createBackboardProvider(options: {
  client: BackboardClient;
  appId: string;
  models: TierModels;
  mode?: RoutingMode;
  now?: () => number;
}): FlowAIProvider {
  const { client } = options;
  const now = options.now ?? (() => performance.now());

  async function structuredCall(
    route: Route,
    instructions: string,
    schema: z.ZodType,
    brief: unknown,
    check: OutputCheck | undefined,
  ): Promise<ProviderOutput> {
    const started = now();
    const assistant_id = await client.assistantId(assistantName(options.appId), ASSISTANT_PROMPT);
    const system_prompt = structuredPrompt(instructions, schema);
    const meta: CallMeta = {
      vendor: "backboard",
      model: "",
      tier: null,
      routeReason: route.reason,
      attempts: 0,
      repairs: 0,
      rejections: [],
      escalated: false,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      threadId: null,
    };
    let lastOutput: unknown;
    let lastError = "No model was tried.";

    const attempt = async (step: RouteStep, content: string, threadId: string | null) => {
      meta.attempts += 1;
      const reply = await client.sendMessage({
        assistant_id,
        ...(threadId ? { thread_id: threadId } : {}),
        content,
        system_prompt,
        json_output: true,
        memory: "off", // decisions are remembered explicitly, not extracted from JSON briefs
        llm_provider: step.provider,
        model_name: step.model,
        ...step.options,
      });
      meta.inputTokens += reply.input_tokens ?? 0;
      meta.outputTokens += reply.output_tokens ?? 0;
      meta.threadId = reply.thread_id;
      meta.model = `${reply.model_provider ?? step.provider}/${reply.model_name ?? step.model}`;
      meta.tier = step.tier;
      if (reply.status !== "COMPLETED") return { errors: [`The run ended with status ${reply.status}.`] };
      const json = parseJsonReply(reply.content);
      if (!json.ok) return { errors: [json.error] };
      lastOutput = json.value;
      const shape = zodErrors(schema, json.value);
      return { errors: shape.length > 0 ? shape : (check?.(json.value) ?? []) };
    };

    for (const [index, step] of route.chain.entries()) {
      meta.escalated = index > 0;
      try {
        let { errors } = await attempt(step, JSON.stringify(brief), null);
        for (let repair = 0; errors.length > 0 && repair < MAX_REPAIRS_PER_MODEL; repair++) {
          meta.repairs += 1;
          meta.rejections.push(`${step.provider}/${step.model}: ${errors.slice(0, 3).join(" | ")}`);
          ({ errors } = await attempt(
            step,
            `The flow.js validator rejected your previous reply:\n- ${errors.slice(0, 8).join("\n- ")}\nReturn the corrected, complete JSON object only.`,
            meta.threadId,
          ));
        }
        if (errors.length === 0) {
          meta.latencyMs = Math.round(now() - started);
          return new ProviderOutput(lastOutput, meta);
        }
        lastError = errors.join(" ");
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    meta.latencyMs = Math.round(now() - started);
    // Hand back the best effort so the runtime can show why it was rejected; throw if there is nothing to show.
    if (lastOutput !== undefined && zodErrors(schema, lastOutput).length === 0) return new ProviderOutput(lastOutput, meta);
    throw new BackboardError(`No routed model produced a valid output: ${lastError}`);
  }

  const route = (signals: RoutingSignals) => routeTask(signals, options.models, options.mode ?? "rules");

  return {
    source: "live",
    model: "backboard",
    generateSchema: (brief, check) =>
      structuredCall(
        route({ task: "generate", capabilities: brief.capabilities.length }),
        GENERATION_INSTRUCTIONS,
        GeneratedSchemaOutput,
        brief,
        check,
      ),
    proposeOptimization: (brief, check) =>
      structuredCall(
        route({
          task: "optimize",
          components: brief.currentSchema.length,
          findings: brief.heuristicFindings,
          pastDecisions: brief.pastDecisions,
        }),
        OPTIMIZATION_INSTRUCTIONS,
        OptimizationOutput,
        brief,
        check,
      ),
  };
}

/** Persistent decision memory on the application's BackBoard assistant. */
export function createBackboardMemory(options: { client: BackboardClient; appId: string }): FlowMemory {
  const { client, appId } = options;
  const assistant = () => client.assistantId(assistantName(appId), ASSISTANT_PROMPT);
  return {
    async remember(content, metadata) {
      await client.addMemory(await assistant(), content, { app: appId, ...metadata });
    },
    // Listing, not semantic search: the decision log is small, and BackBoard's search applies a
    // relevance cutoff that silently dropped decisions for some queries when measured live.
    async recall(limit): Promise<RecalledMemory[]> {
      const { memories } = await client.listMemories(await assistant());
      return memories
        .filter((m) => m.metadata?.app === appId)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .slice(0, limit)
        .map((m) => ({ content: m.content, createdAt: m.created_at }));
    },
    async reset() {
      await client.resetMemories(await assistant());
    },
  };
}
