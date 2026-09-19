import { zodTextFormat } from "openai/helpers/zod";
import { expect, it } from "vitest";
import { GeneratedSchemaOutput, OptimizationOutput } from "@/flow/ai/contracts";

// OpenAI strict mode: every object lists all properties as required and forbids extras.
function strictProblems(node: any, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  const problems: string[] = [];
  if (node.type === "object" || node.properties) {
    const keys = Object.keys(node.properties ?? {});
    const required = new Set(node.required ?? []);
    for (const k of keys) if (!required.has(k)) problems.push(`${path}.${k} not required`);
    if (node.additionalProperties !== false) problems.push(`${path} additionalProperties != false`);
  }
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) v.forEach((item, i) => problems.push(...strictProblems(item, `${path}.${k}[${i}]`)));
    else if (typeof v === "object") problems.push(...strictProblems(v, `${path}.${k}`));
  }
  return problems;
}

it.each([
  ["flow_ui_schema", GeneratedSchemaOutput],
  ["flow_optimization", OptimizationOutput],
] as const)("%s converts to a strict JSON schema", (name, schema) => {
  const format = zodTextFormat(schema, name) as any;
  expect(format.strict).toBe(true);
  expect(strictProblems(format.schema)).toEqual([]);
});
