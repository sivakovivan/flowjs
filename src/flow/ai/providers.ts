import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { applyMutations } from "../mutations";
import type { FlowApp } from "../registry";
import type { UISchema } from "../schema";
import {
  GENERATION_INSTRUCTIONS,
  OPTIMIZATION_INSTRUCTIONS,
  type GenerationBrief,
  type OptimizationBrief,
} from "./briefs";
import { GeneratedSchemaOutput, OptimizationOutput, toMutation } from "./contracts";

export interface FlowAIProvider {
  source: "live" | "recorded";
  model: string;
  generateSchema(brief: GenerationBrief): Promise<unknown>;
  proposeOptimization(brief: OptimizationBrief): Promise<unknown>;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_BACKBOARD_MODEL = "gpt-4o-mini";

type BackboardResponse = {
  content: string | Record<string, unknown> | null;
  message?: string | null;
  status?: string | null;
  thread_id?: string;
  assistant_id?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
};

function normalizeBackboardContent(raw: unknown): unknown {
  if (raw == null) return raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (stripped !== trimmed) {
      try {
        return JSON.parse(stripped);
      } catch {
        return stripped;
      }
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["json", "data", "output", "result", "response", "answer", "text", "content"]) {
      if (key in obj && obj[key] !== undefined) {
        return normalizeBackboardContent(obj[key]);
      }
    }
    if (obj.message !== undefined) {
        return normalizeBackboardContent(obj.message);
    }
    return obj;
  }

  return raw;
}

async function backboardStructuredRequest<T>(instructions: string, brief: unknown, schema: z.ZodType<T>): Promise<T> {
  const baseURL = process.env.BACKBOARD_BASE_URL ?? "https://app.backboard.io/api";
  const apiKey = process.env.BACKBOARD_API_KEY;
  if (!apiKey) throw new Error("BACKBOARD_API_KEY is required when AI_PROVIDER=backboard.");

  let prompt = `Input context:\n${JSON.stringify(brief, null, 2)}\n\nReturn exactly one JSON object matching the requested fields and types. Do not omit required fields. If the requested object contains mutations, evidence, or components, return them as arrays; each mutation must include its type and element, with null for non-applicable fields. Do not include markdown fences, commentary, or explanation.`.trim();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseURL}/threads/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        content: prompt,
        system_prompt: instructions,
        llm_provider: process.env.BACKBOARD_LLM_PROVIDER ?? "openai",
        model_name: process.env.BACKBOARD_MODEL ?? DEFAULT_BACKBOARD_MODEL,
        json_output: true,
        stream: false,
        memory: "off",
        web_search: "off",
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Backboard ${response.status}: ${text || "unknown error"}`);
    }

    const result = (await response.json()) as BackboardResponse;
    if (!result.content) {
      if (attempt === 0) {
        prompt = `Return one concise JSON object only. Follow the requested fields and types exactly.\n\nInput context:\n${JSON.stringify(brief)}`;
        continue;
      }
      throw new Error(
        `Backboard returned empty content (status=${result.status ?? "unknown"}, model=${result.model_name ?? "unknown"}${result.message ? `, message=${result.message}` : ""}).`,
      );
    }

    let json: unknown;
    try {
      json = normalizeBackboardContent(result.content);
      if (typeof json === "string") {
        json = JSON.parse(json);
      }
      // Some Backboard models omit the evidence array even when json_output is
      // enabled. Preserve the contract by reusing the deterministic evidence
      // already supplied in the optimization brief.
      if (
        json &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        !("evidence" in json) &&
        brief &&
        typeof brief === "object" &&
        Array.isArray((brief as { heuristicFindings?: unknown }).heuristicFindings)
      ) {
        const findings = (brief as { heuristicFindings: Array<{ evidence?: unknown }> }).heuristicFindings;
        const evidence = findings.flatMap((finding) => (Array.isArray(finding.evidence) ? finding.evidence : []));
        const first = findings[0] as { finding?: unknown } | undefined;
        const candidate = { ...(json as Record<string, unknown>), evidence };
        if (typeof candidate.finding !== "string" && typeof first?.finding === "string") {
          candidate.finding = first.finding;
        }
        if (Array.isArray(candidate.evidence)) {
          candidate.evidence = candidate.evidence.map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
              const value = item as Record<string, unknown>;
              return String(value.text ?? value.description ?? value.detail ?? JSON.stringify(value));
            }
            return String(item);
          });
        }
        if (Array.isArray(candidate.mutations)) {
          candidate.mutations = candidate.mutations
            .map((mutation) => {
              if (!mutation || typeof mutation !== "object") return null;
              const item = mutation as Record<string, unknown>;
              const rawType = item.type ?? item.action ?? item.operation;
              const type = typeof rawType === "string" ? rawType.toUpperCase().replace(/[- ]/g, "_") : null;
              const element = item.element ?? item.component ?? item.componentId ?? item.component_id;
              const position = item.position ?? item.direction;
              if (!["MOVE", "REORDER", "RESIZE", "SWAP_VARIANT", "SHOW", "HIDE"].includes(type ?? "")) return null;
              if (typeof element !== "string") return null;
              const normalized: Record<string, unknown> = { ...item, type, element };
              if (type === "MOVE" && (position === "before" || position === "after")) normalized.position = position;
              if (type === "MOVE" && (typeof normalized.target !== "string" || (position !== "before" && position !== "after"))) return null;
              if (type === "REORDER" && typeof normalized.index !== "number") return null;
              if (type === "RESIZE" && typeof normalized.size !== "string") return null;
              if (type === "SWAP_VARIANT" && typeof normalized.variant !== "string") return null;
              return normalized;
            })
            .filter((mutation): mutation is Record<string, unknown> => mutation !== null);
        }
        json = candidate;
      }
    } catch {
      if (attempt === 1) throw new Error(`Backboard returned invalid JSON: ${JSON.stringify(result.content)}`);
      prompt = `${instructions}\n\nThe previous response was not valid JSON.\nPrevious response:\n${JSON.stringify(result.content)}\n\nReturn ONLY the corrected JSON object.`;
      continue;
    }

    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;

    if (attempt === 1) {
      console.error("Backboard normalized JSON failed schema validation:", JSON.stringify(json));
      if (
        Array.isArray((brief as { heuristicFindings?: unknown })?.heuristicFindings) &&
        (brief as { heuristicFindings: Array<Record<string, unknown>> }).heuristicFindings.length > 0
      ) {
        const finding = (brief as { heuristicFindings: Array<Record<string, unknown>> }).heuristicFindings[0];
        const evidence = Array.isArray(finding.evidence)
          ? finding.evidence.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
          : [];
        return {
          finding: String(finding.finding ?? "Observed user friction"),
          classification: finding.classification === "performance" ? "performance" : "ui",
          evidence,
          confidence: typeof finding.confidence === "number" ? finding.confidence : 0.5,
          expectedBenefit: typeof finding.expectedBenefit === "number" ? finding.expectedBenefit : 0,
          reason: "Heuristic finding retained; no safe AI mutation applied",
          explanation: "The live model response did not match the required contract, so no UI mutation was applied.",
          mutations: [],
        } as T;
      }
      throw new Error(`Backboard response failed schema validation: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }

    prompt = `The previous JSON failed validation.\nValidation errors:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nPrevious output:\n${JSON.stringify(json, null, 2)}\n\nReturn the corrected JSON object only. Follow the required top-level fields and mutation field rules exactly.`;
  }

  throw new Error("Backboard structured generation failed.");
}

/** Server-side OpenAI-compatible Responses API with Zod structured outputs. */
export function createOpenAICompatibleProvider(options: {
  apiKey: string;
  model?: string;
  baseURL?: string;
  timeoutMs?: number;
}): FlowAIProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 1,
  });
  const model = options.model ?? DEFAULT_OPENAI_MODEL;

  async function call(instructions: string, brief: unknown, format: ReturnType<typeof zodTextFormat>) {
    const response = await client.responses.parse({
      model,
      instructions,
      input: JSON.stringify(brief),
      text: { format },
    });
    if (response.output_parsed === null) throw new Error("AI provider returned no parsed output.");
    return response.output_parsed;
  }

  return {
    source: "live",
    model,
    generateSchema: (brief) =>
      call(GENERATION_INSTRUCTIONS, brief, zodTextFormat(GeneratedSchemaOutput, "flow_ui_schema")),
    proposeOptimization: (brief) =>
      call(OPTIMIZATION_INSTRUCTIONS, brief, zodTextFormat(OptimizationOutput, "flow_optimization")),
  };
}

export function createOpenAIProvider(options: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}): FlowAIProvider {
  return createOpenAICompatibleProvider(options);
}

export function createBackboardProvider(): FlowAIProvider {
  return {
    source: "live",
    model: process.env.BACKBOARD_MODEL ?? DEFAULT_BACKBOARD_MODEL,
    async generateSchema(brief) {
      return backboardStructuredRequest(GENERATION_INSTRUCTIONS, brief, GeneratedSchemaOutput);
    },
    async proposeOptimization(brief) {
      return backboardStructuredRequest(OPTIMIZATION_INSTRUCTIONS, brief, OptimizationOutput);
    },
  };
}

export function createConfiguredAIProvider(options: {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
} = {}): FlowAIProvider | null {
  const providerName = (process.env.AI_PROVIDER ?? "openai").toLowerCase();

  if (providerName === "backboard") {
    const apiKey = process.env.BACKBOARD_API_KEY ?? options.apiKey;
    if (!apiKey) throw new Error("BACKBOARD_API_KEY is required when AI_PROVIDER=backboard.");
    return createBackboardProvider();
  }

  if (providerName === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? options.apiKey;
    if (!apiKey) return null;
    return createOpenAIProvider({
      apiKey,
      model: process.env.OPENAI_MODEL ?? options.model,
      timeoutMs: options.timeoutMs,
    });
  }

  throw new Error(`Unsupported AI provider "${providerName}". Use "openai" or "backboard".`);
}

export interface Recording {
  /** Where the recording came from, shown next to every recorded result. */
  provenance: string;
  generation: GeneratedSchemaOutput;
  /**
   * Candidate proposals; the first that applies cleanly to the current schema is
   * replayed. A performance diagnosis without mutations is replayed when the top
   * heuristic finding is backend performance.
   */
  optimizations: OptimizationOutput[];
}

/**
 * Replays recorded, previously validated responses. Used when a live call fails
 * or when recorded mode is forced, and always labelled as recorded.
 */
export function createRecordedProvider(app: FlowApp, recording: Recording | undefined): FlowAIProvider {
  return {
    source: "recorded",
    model: "recorded",
    async generateSchema() {
      if (!recording) throw new Error(`No recorded responses for application "${app.id}".`);
      return structuredClone(recording.generation);
    },
    async proposeOptimization(brief) {
      if (!recording) throw new Error(`No recorded responses for application "${app.id}".`);
      // When the strongest finding is backend latency, replay the matching diagnosis instead of a redesign.
      const top = brief.heuristicFindings[0];
      if (top?.classification === "performance") {
        const diagnosis = recording.optimizations.find(
          (candidate) => candidate.classification === "performance" && candidate.mutations.length === 0,
        );
        if (diagnosis) return structuredClone(diagnosis);
      }
      const schema: UISchema = {
        components: brief.currentSchema.map(({ row: _row, ...component }) => component),
      };
      const match = recording.optimizations.find(
        (candidate) =>
          candidate.mutations.length > 0 && applyMutations(schema, candidate.mutations.map(toMutation), app).ok,
      );
      if (!match) throw new Error("No recorded proposal applies to the current version.");
      return structuredClone(match);
    },
  };
}
