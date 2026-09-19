import { createFlowApp, type FlowAppConfig } from "../registry";

export function fixtureConfig(overrides: Partial<FlowAppConfig> = {}): FlowAppConfig {
  return {
    id: "fixture",
    name: "Fixture analytics",
    context: "Sales analytics used to monitor revenue and transactions.",
    state: {
      dateRange: {
        description: "Date range applied to analytics",
        type: "date-range",
        options: ["7d", "30d", "90d"],
        default: "30d",
      },
      customerQuery: {
        description: "Free-text customer search",
        type: "text",
        default: "",
      },
    },
    data: {
      revenue: {
        description: "Revenue over the selected date range",
        output: { kind: "timeseries", unit: "currency" },
        dependsOn: ["dateRange"],
        fetch: ({ state }) => ({ range: state.dateRange }),
      },
      transactions: {
        description: "Recent transactions",
        output: {
          kind: "collection",
          rowKey: "id",
          columns: [{ key: "id", label: "ID" }],
        },
        dependsOn: ["dateRange"],
        fetch: () => [{ id: "t1" }],
      },
    },
    actions: {
      exportReport: {
        description: "Export the currently filtered report",
        inputs: { format: ["csv", "pdf"] },
        dependsOn: ["dateRange"],
        execute: (input, { state }) => ({ ...input, ...state }),
      },
      refundTransaction: {
        description: "Refund a selected transaction",
        inputs: { transactionId: { type: "string", from: "transactions" } },
        execute: (input) => ({ refunded: input.transactionId }),
      },
    },
    theme: { primary: "#6366f1", radius: 8, spacing: 8, fontFamily: "Inter" },
    mutationRate: 0.5,
    ...overrides,
  };
}

export const fixtureApp = () => createFlowApp(fixtureConfig());
