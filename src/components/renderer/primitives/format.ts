const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const currencyCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat("en-US");
const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatValue(value: number, unit: "currency" | "count", compact = false): string {
  if (unit === "currency") return (compact ? compactCurrency : currency).format(value);
  return (compact ? compactCount : count).format(value);
}

export function formatCell(value: unknown, format: string | undefined): string {
  if (value === null || value === undefined) return "—";
  if (format === "currency" && typeof value === "number") {
    return Number.isInteger(value) ? currency.format(value) : currencyCents.format(value);
  }
  if (typeof value === "number") return count.format(value);
  return String(value);
}

export function formatChange(change: number | null): string | null {
  if (change === null) return null;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  return `${sign}${Math.abs(change * 100).toFixed(1)}%`;
}
