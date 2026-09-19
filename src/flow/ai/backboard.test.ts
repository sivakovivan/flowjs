import { describe, expect, it } from "vitest";
import { fixtureApp } from "../__fixtures__/app";
import { fixtureSchema } from "../__fixtures__/schema";
import { createBackboardClient, createBackboardMemory, createBackboardProvider, parseJsonReply } from "./backboard";
import { generationBrief } from "./briefs";
import type { GeneratedSchemaOutput } from "./contracts";
import { ProviderOutput } from "./providers";
import { DEFAULT_TIER_MODELS } from "./routing";

const app = fixtureApp();
const valid: GeneratedSchemaOutput = {
  reasoning: "Chart first.",
  components: fixtureSchema().components.map((c) => ({ ...c, rationale: "fixture" })),
};

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  apiKey: string | null;
}

/** A scripted BackBoard: each message reply is the next item in `replies`. */
function fakeBackboard(replies: Array<string | { status: number; body: string }>, assistants: Array<{ name: string; assistant_id: string }> = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://bb.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path, body, apiKey: new Headers(init?.headers).get("X-API-Key") });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/assistants" && init?.method === "GET") return json(assistants);
    if (path === "/assistants") return json({ assistant_id: "asst-new" });
    if (path === "/threads/messages") {
      const next = replies.shift();
      if (next === undefined) throw new Error("no scripted reply left");
      if (typeof next !== "string") return new Response(next.body, { status: next.status });
      return json({
        content: next,
        status: "COMPLETED",
        thread_id: "thread-1",
        model_provider: body.llm_provider,
        model_name: body.model_name,
        input_tokens: 100,
        output_tokens: 50,
      });
    }
    if (path.includes("/memories") && (init?.method ?? "GET") === "GET") {
      return json({
        memories: [
          { id: "m1", content: "older", metadata: { app: "fixture" }, created_at: "2026-09-19T10:00:00" },
          { id: "m2", content: "other app", metadata: { app: "someone-else" }, created_at: "2026-09-19T12:00:00" },
          { id: "m3", content: "newer", metadata: { app: "fixture" }, created_at: "2026-09-19T11:00:00" },
        ],
      });
    }
    if (path.endsWith("/memories")) return json({ memory_id: "m1" }, 201);
    return json({}, 404);
  }) as typeof fetch;
  const client = createBackboardClient({ apiKey: "test-key", baseUrl: "https://bb.test", fetch: fetchImpl });
  const provider = createBackboardProvider({ client, appId: app.id, models: DEFAULT_TIER_MODELS });
  const messages = () => calls.filter((c) => c.path === "/threads/messages");
  return { client, provider, calls, messages };
}

async function generate(bb: ReturnType<typeof fakeBackboard>, check?: (output: unknown) => string[]) {
  const result = await bb.provider.generateSchema(generationBrief(app), check);
  if (!(result instanceof ProviderOutput)) throw new Error("expected ProviderOutput");
  return result;
}

describe("structured output over BackBoard", () => {
  it("sends the JSON Schema, asks for JSON output and authenticates with X-API-Key", async () => {
    const bb = fakeBackboard([JSON.stringify(valid)]);
    const { output, meta } = await generate(bb);
    expect(output).toEqual(valid);
    const [message] = bb.messages();
    expect(message.apiKey).toBe("test-key");
    expect(message.body).toMatchObject({
      assistant_id: "asst-new",
      json_output: true,
      memory: "off",
      llm_provider: "openai",
      model_name: "gpt-5.6-sol", // generation routes to the balanced tier
    });
    expect(message.body!.system_prompt).toContain('"components"');
    expect(message.body!.system_prompt).toContain("JSON Schema");
    expect(meta).toMatchObject({
      vendor: "backboard",
      model: "openai/gpt-5.6-sol",
      tier: "balanced",
      attempts: 1,
      repairs: 0,
      escalated: false,
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("reuses an existing assistant instead of creating one", async () => {
    const bb = fakeBackboard([JSON.stringify(valid)], [{ name: "flowjs-fixture", assistant_id: "asst-existing" }]);
    await generate(bb);
    expect(bb.messages()[0].body).toMatchObject({ assistant_id: "asst-existing" });
    expect(bb.calls.filter((c) => c.path === "/assistants" && c.method === "POST")).toHaveLength(0);
  });

  it("resolves assistants per name", async () => {
    const bb = fakeBackboard([], [{ name: "flowjs-a", assistant_id: "asst-a" }]);
    expect(await bb.client.assistantId("flowjs-a", "p")).toBe("asst-a");
    expect(await bb.client.assistantId("flowjs-b", "p")).toBe("asst-new");
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const bb = fakeBackboard(["```json\n" + JSON.stringify(valid) + "\n```"]);
    expect((await generate(bb)).output).toEqual(valid);
  });

  it("repairs a schema-invalid reply in the same thread", async () => {
    const broken = { reasoning: "x", components: [{ id: "only-id" }] };
    const bb = fakeBackboard([JSON.stringify(broken), JSON.stringify(valid)]);
    const { output, meta } = await generate(bb);
    expect(output).toEqual(valid);
    expect(meta).toMatchObject({ attempts: 2, repairs: 1, escalated: false, inputTokens: 200 });
    const [, repair] = bb.messages();
    expect(repair.body).toMatchObject({ thread_id: "thread-1", json_output: true });
    expect(repair.body!.content).toMatch(/validator rejected/);
    expect(repair.body!.content).toMatch(/components\.0\.capability/);
  });

  it("repairs a reply the runtime's validator rejects, quoting its errors", async () => {
    const bb = fakeBackboard([JSON.stringify(valid), JSON.stringify(valid)]);
    let calls = 0;
    const { meta } = await generate(bb, () => (calls++ === 0 ? ['unknown capability "launchMissiles"'] : []));
    expect(meta.repairs).toBe(1);
    expect(bb.messages()[1].body!.content).toContain("launchMissiles");
  });

  it("escalates to the next tier when repair fails, in a fresh thread", async () => {
    const bb = fakeBackboard(["not json", "still not json", JSON.stringify(valid)]);
    const { meta } = await generate(bb);
    expect(meta).toMatchObject({ model: "anthropic/claude-sonnet-5", tier: "deep", escalated: true, attempts: 3 });
    expect(bb.messages()[2].body).not.toHaveProperty("thread_id");
  });

  it("escalates past a model whose request fails", async () => {
    const bb = fakeBackboard([{ status: 429, body: "rate limited" }, JSON.stringify(valid)]);
    const { meta } = await generate(bb);
    expect(meta).toMatchObject({ model: "anthropic/claude-sonnet-5", escalated: true });
  });

  it("throws when no routed model returns usable JSON", async () => {
    const bb = fakeBackboard(["nope", "nope", "nope", "nope"]);
    await expect(generate(bb)).rejects.toThrow(/No routed model produced a valid output/);
  });

  it("returns a shape-valid but rejected output so the runtime can explain the rejection", async () => {
    const bb = fakeBackboard(Array.from({ length: 4 }, () => JSON.stringify(valid)));
    const { output, meta } = await generate(bb, () => ["always unsafe"]);
    expect(output).toEqual(valid);
    expect(meta.attempts).toBe(4);
  });
});

describe("parseJsonReply", () => {
  it("rejects empty and non-JSON replies", () => {
    expect(parseJsonReply(null).ok).toBe(false);
    expect(parseJsonReply("Sure! Here you go").ok).toBe(false);
  });
});

describe("BackBoard memory", () => {
  it("adds memories with app metadata and recalls this app's decisions, newest first", async () => {
    const bb = fakeBackboard([]);
    const memory = createBackboardMemory({ client: bb.client, appId: app.id });
    await memory.remember("The developer undid v2.", { kind: "undone" });
    expect(await memory.recall(5)).toEqual([
      { content: "newer", createdAt: "2026-09-19T11:00:00" },
      { content: "older", createdAt: "2026-09-19T10:00:00" },
    ]);
    expect(await memory.recall(1)).toHaveLength(1);
    const add = bb.calls.find((c) => c.path === "/assistants/asst-new/memories")!;
    expect(add.body).toEqual({ content: "The developer undid v2.", metadata: { app: "fixture", kind: "undone" } });
  });
});
