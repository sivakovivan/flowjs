import { describe, expect, it } from "vitest";
import { fixtureApp } from "./__fixtures__/app";
import { fixtureSchema } from "./__fixtures__/schema";
import { applyMutations } from "./mutations";
import type { UISchema } from "./schema";

const app = fixtureApp();

function apply(mutations: unknown[], schema: UISchema = fixtureSchema()) {
  return applyMutations(schema, mutations, app);
}

function ids(schema: UISchema) {
  return schema.components.map((c) => c.id);
}

function expectOk(result: ReturnType<typeof apply>): UISchema {
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.schema;
}

function expectRejected(result: ReturnType<typeof apply>, pattern: RegExp) {
  expect(result.ok).toBe(false);
  expect(!result.ok && result.errors.join("\n")).toMatch(pattern);
}

describe("MOVE", () => {
  it("places the element before the target", () => {
    const schema = expectOk(apply([{ type: "MOVE", element: "date-range", target: "revenue-chart", position: "before" }]));
    expect(ids(schema)).toEqual(["date-range", "revenue-chart", "export", "transactions-table", "customer-search", "refund"]);
    expect(schema.components.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("places the element after the target", () => {
    const schema = expectOk(apply([{ type: "MOVE", element: "customer-search", target: "export", position: "after" }]));
    expect(ids(schema).slice(0, 3)).toEqual(["revenue-chart", "export", "customer-search"]);
  });

  it("rejects unknown targets, self-targets, hidden targets and no-ops", () => {
    expectRejected(apply([{ type: "MOVE", element: "date-range", target: "nope", position: "before" }]), /unknown target/);
    expectRejected(apply([{ type: "MOVE", element: "date-range", target: "date-range", position: "before" }]), /itself/);
    expectRejected(apply([{ type: "MOVE", element: "export", target: "revenue-chart", position: "after" }]), /already after/);
    const hidden = expectOk(apply([{ type: "HIDE", element: "customer-search" }]));
    expectRejected(
      apply([{ type: "MOVE", element: "date-range", target: "customer-search", position: "before" }], hidden),
      /is hidden/,
    );
  });
});

describe("REORDER", () => {
  it("moves the element to an absolute index", () => {
    const schema = expectOk(apply([{ type: "REORDER", element: "refund", index: 1 }]));
    expect(ids(schema).slice(0, 3)).toEqual(["revenue-chart", "refund", "export"]);
  });

  it("rejects out-of-range and no-op indexes", () => {
    expectRejected(apply([{ type: "REORDER", element: "refund", index: 6 }]), /out of range/);
    expectRejected(apply([{ type: "REORDER", element: "refund", index: -1 }]), /out of range/);
    expectRejected(apply([{ type: "REORDER", element: "refund", index: 5 }]), /already at index/);
  });
});

describe("RESIZE", () => {
  it("changes the size", () => {
    const schema = expectOk(apply([{ type: "RESIZE", element: "transactions-table", size: "medium" }]));
    expect(schema.components.find((c) => c.id === "transactions-table")?.size).toBe("medium");
  });

  it("rejects unknown sizes and no-ops", () => {
    expectRejected(apply([{ type: "RESIZE", element: "transactions-table", size: "huge" }]), /malformed/);
    expectRejected(apply([{ type: "RESIZE", element: "transactions-table", size: "full" }]), /already full/);
  });
});

describe("SWAP_VARIANT", () => {
  it("swaps to a compatible primitive", () => {
    const schema = expectOk(apply([{ type: "SWAP_VARIANT", element: "date-range", variant: "segmented-control" }]));
    expect(schema.components.find((c) => c.id === "date-range")?.primitive).toBe("segmented-control");
  });

  it("rejects incompatible variants", () => {
    expectRejected(
      apply([{ type: "SWAP_VARIANT", element: "date-range", variant: "line-chart" }]),
      /not a compatible variant/,
    );
    expectRejected(apply([{ type: "SWAP_VARIANT", element: "refund", variant: "button-group" }]), /not a compatible/);
    expectRejected(apply([{ type: "SWAP_VARIANT", element: "date-range", variant: "hologram" }]), /malformed/);
  });
});

describe("SHOW / HIDE", () => {
  it("hides and shows a non-required component", () => {
    const hidden = expectOk(apply([{ type: "HIDE", element: "customer-search" }]));
    expect(hidden.components.find((c) => c.id === "customer-search")?.visible).toBe(false);
    const shown = expectOk(apply([{ type: "SHOW", element: "customer-search" }], hidden));
    expect(shown.components.find((c) => c.id === "customer-search")?.visible).toBe(true);
  });

  it("refuses to hide the only usable control for a required capability", () => {
    expectRejected(apply([{ type: "HIDE", element: "date-range" }]), /only usable control.*dateRange/);
    expectRejected(apply([{ type: "HIDE", element: "export" }]), /only usable control.*exportReport/);
  });

  it("allows hiding a required capability's duplicate control", () => {
    const schema = fixtureSchema();
    schema.components.push({
      id: "date-range-top",
      capability: "dateRange",
      primitive: "segmented-control",
      size: "small",
      order: 6,
      visible: true,
      group: null,
    });
    expect(apply([{ type: "HIDE", element: "date-range" }], schema).ok).toBe(true);
  });

  it("rejects no-op visibility changes", () => {
    expectRejected(apply([{ type: "SHOW", element: "date-range" }]), /already visible/);
  });
});

describe("proposals", () => {
  it("applies a multi-mutation proposal in sequence", () => {
    const schema = expectOk(
      apply([
        { type: "MOVE", element: "date-range", target: "revenue-chart", position: "before" },
        { type: "SWAP_VARIANT", element: "date-range", variant: "segmented-control" },
        { type: "RESIZE", element: "date-range", size: "medium" },
      ]),
    );
    expect(schema.components[0]).toMatchObject({ id: "date-range", primitive: "segmented-control", size: "medium" });
  });

  it("rejects the whole proposal when any mutation is unsafe", () => {
    const original = fixtureSchema();
    const result = apply(
      [
        { type: "MOVE", element: "date-range", target: "revenue-chart", position: "before" },
        { type: "HIDE", element: "export" },
      ],
      original,
    );
    expectRejected(result, /only usable control/);
    expect(original).toEqual(fixtureSchema()); // input never mutated
  });

  it("rejects unknown elements, unknown mutation types, empty and oversized proposals", () => {
    expectRejected(apply([{ type: "HIDE", element: "ghost" }]), /unknown component "ghost"/);
    expectRejected(apply([{ type: "DELETE", element: "export" }]), /malformed/);
    expectRejected(apply([]), /no mutations/);
    expectRejected(apply(Array.from({ length: 7 }, () => ({ type: "SHOW", element: "export" }))), /exceeds/);
  });
});
