import type { UISchema } from "../schema";

/** A valid v1 with a buried, dropdown-rendered date range. */
export function fixtureSchema(): UISchema {
  return {
    components: [
      { id: "revenue-chart", capability: "revenue", primitive: "line-chart", size: "large", order: 0, visible: true, group: null },
      { id: "export", capability: "exportReport", primitive: "button", size: "small", order: 1, visible: true, group: null },
      { id: "transactions-table", capability: "transactions", primitive: "table", size: "full", order: 2, visible: true, group: null },
      { id: "date-range", capability: "dateRange", primitive: "dropdown", size: "small", order: 3, visible: true, group: null },
      { id: "customer-search", capability: "customerQuery", primitive: "search-field", size: "medium", order: 4, visible: true, group: null },
      { id: "refund", capability: "refundTransaction", primitive: "button", size: "small", order: 5, visible: true, group: null },
    ],
  };
}
