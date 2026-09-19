import { describe, expect, it } from "vitest";
import { optimizationBrief } from "@/flow/ai/briefs";
import { GeneratedSchemaOutput, OptimizationOutput, toMutation, toUISchema } from "@/flow/ai/contracts";
import { createRecordedProvider } from "@/flow/ai/providers";
import type { Finding } from "@/flow/friction";
import { computeMetrics } from "@/flow/metrics";
import { parseDataOutput } from "@/flow/data-contracts";
import { applyMutations } from "@/flow/mutations";
import { layoutRows, validateSchema, type UISchema } from "@/flow/schema";
import { salesRecording } from "./recordings";
import { salesApp } from "./sales-app";

describe("sales demo registry", () => {
  it("registers the eight demo capabilities", () => {
    expect(salesApp.capabilities.map((c) => c.id).sort()).toEqual(
      ["customerQuery", "customers", "dateRange", "exportReport", "orders", "refundTransaction", "revenue", "transactions"],
    );
  });

  it("returns data matching each declared output contract", async () => {
    for (const capability of salesApp.capabilities) {
      if (capability.kind !== "data") continue;
      const value = await salesApp.fetchData(capability.id, salesApp.defaultState());
      expect(() => parseDataOutput(capability.output, value)).not.toThrow();
    }
  });

  it("filters customers by the search state", async () => {
    const result = (await salesApp.fetchData("customers", { customerQuery: "northwind" })) as {
      rows: Array<{ company: string }>;
    };
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.company === "Northwind")).toBe(true);
  });

  it("refunds once and rejects a second refund", async () => {
    const { rows } = (await salesApp.fetchData("transactions", { dateRange: "12m" })) as {
      rows: Array<{ id: string; status: string }>;
    };
    const paid = rows.find((r) => r.status === "paid")!;
    await expect(salesApp.executeAction("refundTransaction", { transactionId: paid.id }, {})).resolves.toMatchObject({
      transactionId: paid.id,
    });
    await expect(salesApp.executeAction("refundTransaction", { transactionId: paid.id }, {})).rejects.toThrow(
      /already refunded/,
    );
  });
});

describe("sales recordings", () => {
  it("records a v1 that satisfies the output contract and the registry", () => {
    const parsed = GeneratedSchemaOutput.parse(salesRecording.generation);
    const result = validateSchema(toUISchema(parsed), salesApp);
    expect(result.ok).toBe(true);
  });

  it("buries the date range below the fold in v1, as a plausible inefficiency", () => {
    const rows = layoutRows(toUISchema(salesRecording.generation));
    expect(rows.get("date-range")).toBeGreaterThanOrEqual(3);
    expect(rows.get("revenue-chart")).toBe(1);
  });

  it("chains every recorded optimization as a valid, sequential improvement", () => {
    let schema: UISchema = toUISchema(salesRecording.generation);
    for (const recorded of salesRecording.optimizations) {
      const proposal = OptimizationOutput.parse(recorded);
      if (proposal.mutations.length === 0) continue; // diagnosis only
      const result = applyMutations(schema, proposal.mutations.map(toMutation), salesApp);
      if (!result.ok) throw new Error(`${proposal.reason}: ${result.errors.join(" ")}`);
      schema = result.schema;
    }
    const rows = layoutRows(schema);
    expect(rows.get("date-range")).toBe(rows.get("revenue-chart")! - 1); // filter bar directly above
    expect(rows.get("revenue-chart")).toBe(rows.get("export"));
    expect(rows.get("customer-search")).toBe(rows.get("customers-table"));
  });
});

describe("recorded provider", () => {
  const provider = createRecordedProvider(salesApp, salesRecording);
  const schema = toUISchema(salesRecording.generation);
  const brief = (findings: Finding[]) =>
    optimizationBrief({
      app: salesApp,
      schema,
      findings,
      metrics: computeMetrics({ versionId: "v1", schema, events: [], calls: [] }),
    });
  const finding = (classification: Finding["classification"]): Finding => ({
    kind: "high-retry-action",
    componentIds: ["export"],
    classification,
    severity: 0.9,
    title: "",
    evidence: [],
    suggestion: "",
  });

  it("replays a no-change diagnosis when backend performance is the top finding", async () => {
    const output = (await provider.proposeOptimization(brief([finding("performance")]))) as OptimizationOutput;
    expect(output).toMatchObject({ classification: "performance", mutations: [] });
  });

  it("replays the first applicable redesign for interface friction", async () => {
    const output = (await provider.proposeOptimization(brief([finding("ui")]))) as OptimizationOutput;
    expect(output.reason).toBe("Date control promoted above Revenue");
  });
});
