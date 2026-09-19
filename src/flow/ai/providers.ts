import OpenAI from "openai";
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

/** Server-side OpenAI Responses API with Zod structured outputs. */
export function createOpenAIProvider(options: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}): FlowAIProvider {
  const client = new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs ?? 60_000, maxRetries: 1 });
  const model = options.model ?? DEFAULT_OPENAI_MODEL;

  async function call(instructions: string, brief: unknown, format: ReturnType<typeof zodTextFormat>) {
    const response = await client.responses.parse({
      model,
      instructions,
      input: JSON.stringify(brief),
      text: { format },
    });
    if (response.output_parsed === null) throw new Error("OpenAI returned no parsed output.");
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

export interface Recording {
  /** Where the recording came from, shown next to every recorded result. */
  provenance: string;
  generation: GeneratedSchemaOutput;
  /** Candidate proposals; the first that applies cleanly to the current schema is replayed. */
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
