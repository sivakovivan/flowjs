import { describe, expect, it } from "vitest";
import { fixtureApp } from "./__fixtures__/app";
import { fixtureSchema } from "./__fixtures__/schema";
import { diffSchemas, layoutRows, validateSchema, type UISchema } from "./schema";

const app = fixtureApp();

function withComponent(id: string, patch: Partial<UISchema["components"][number]>): UISchema {
  const schema = fixtureSchema();
  return {
    components: schema.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

describe("validateSchema", () => {
  it("accepts a schema covering every capability with compatible primitives", () => {
    const result = validateSchema(fixtureSchema(), app);
    expect(result.ok).toBe(true);
  });

  it("normalizes order to a dense index", () => {
    const schema = fixtureSchema();
    schema.components.forEach((c, i) => (c.order = (schema.components.length - i) * 10));
    const result = validateSchema(schema, app);
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.schema.components.map((c) => c.id)).toEqual([
      "refund",
      "customer-search",
      "date-range",
      "transactions-table",
      "export",
      "revenue-chart",
    ]);
    expect(result.schema.components.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects malformed output", () => {
    const result = validateSchema({ components: [{ id: "Bad Id", capability: "revenue" }] }, app);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown capabilities", () => {
    const result = validateSchema(withComponent("export", { capability: "deleteEverything" }), app);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.errors.join()).toMatch(/unknown capability "deleteEverything"/);
  });

  it("rejects incompatible primitives", () => {
    const result = validateSchema(withComponent("date-range", { primitive: "line-chart" }), app);
    expect(!result.ok && result.errors.join()).toMatch(/cannot render state "dateRange" as "line-chart"/);
  });

  it("rejects duplicate component ids", () => {
    const schema = fixtureSchema();
    schema.components[1].id = "revenue-chart";
    const result = validateSchema(schema, app);
    expect(!result.ok && result.errors.join()).toMatch(/Duplicate component id/);
  });

  it("requires every capability to be represented", () => {
    const schema = fixtureSchema();
    schema.components = schema.components.filter((c) => c.capability !== "customerQuery");
    const result = validateSchema(schema, app);
    expect(!result.ok && result.errors.join()).toMatch(/"customerQuery" has no component/);
  });

  it("requires required capabilities to stay visible", () => {
    const hiddenDate = validateSchema(withComponent("date-range", { visible: false }), app);
    expect(!hiddenDate.ok && hiddenDate.errors.join()).toMatch(/Required capability "dateRange"/);
    // Unread, non-required state may be hidden.
    expect(validateSchema(withComponent("customer-search", { visible: false }), app).ok).toBe(true);
  });
});

describe("layoutRows", () => {
  it("packs visible components into 12-column rows", () => {
    const rows = layoutRows(fixtureSchema());
    expect(Object.fromEntries(rows)).toEqual({
      "revenue-chart": 0, // large (9)
      export: 0, // small (3) fills the row
      "transactions-table": 1, // full
      "date-range": 2,
      "customer-search": 2,
      refund: 2,
    });
  });

  it("skips hidden components", () => {
    const rows = layoutRows(withComponent("transactions-table", { visible: false }));
    expect(rows.has("transactions-table")).toBe(false);
    expect(rows.get("date-range")).toBe(1);
  });
});

describe("diffSchemas", () => {
  it("reports what moved, resized, swapped and changed visibility", () => {
    const before = fixtureSchema();
    const after = withComponent("date-range", { order: -1, primitive: "segmented-control" });
    const changes = diffSchemas(before, withComponent("customer-search", { visible: false, size: "small" }));
    expect(changes).toEqual({ "customer-search": ["resized", "hidden"] });
    expect(diffSchemas(before, after)["date-range"]).toEqual(["moved", "swapped"]);
  });
});
