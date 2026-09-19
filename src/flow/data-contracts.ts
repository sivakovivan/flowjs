import { z } from "zod";
import type { DataOutput } from "./registry";

/*
 * Shapes a data capability's fetch must return for its declared output kind.
 * Checked at the API boundary so primitives can trust what they render.
 */

export const TimeseriesData = z.object({
  points: z.array(z.object({ label: z.string(), value: z.number() })),
  total: z.number(),
  /** Change versus the previous period, as a fraction (0.12 = +12%). */
  change: z.number().nullable(),
});
export type TimeseriesData = z.infer<typeof TimeseriesData>;

export const CollectionData = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  total: z.number().int(),
});
export type CollectionData = z.infer<typeof CollectionData>;

export function parseDataOutput(output: DataOutput, value: unknown): TimeseriesData | CollectionData {
  return output.kind === "timeseries" ? TimeseriesData.parse(value) : CollectionData.parse(value);
}
