"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ClientCapability } from "@/client/api";
import { tracker } from "@/client/telemetry";
import type { CollectionData, TimeseriesData } from "@/flow/data-contracts";
import type { UIComponent } from "@/flow/schema";
import { useCapabilityData, useRenderer } from "../context";
import { formatCell, formatChange, formatValue } from "./format";

type DataCapability = Extract<ClientCapability, { kind: "data" }>;

interface DataProps {
  component: UIComponent;
  capability: DataCapability;
}

function Status({ loading, error, empty }: { loading: boolean; error: string | null; empty?: boolean }) {
  if (error) return <p className="app-status app-status--error">Couldn’t load: {error}</p>;
  if (loading) return <div className="app-skeleton" aria-busy="true" aria-label="Loading" />;
  if (empty) return <p className="app-status">No results.</p>;
  return null;
}

function unitOf(capability: DataCapability) {
  return capability.output.kind === "timeseries" ? capability.output.unit : "count";
}

export function MetricCard({ component, capability }: DataProps) {
  const { data, loading, error } = useCapabilityData<TimeseriesData>(capability.id, component.id);
  const change = data ? formatChange(data.change) : null;
  return (
    <div className="app-metric" onClick={() => tracker.track(component.id, "component_click")}>
      {data ? (
        <>
          <strong className="app-metric__value">{formatValue(data.total, unitOf(capability))}</strong>
          {change && (
            <span className={`app-metric__change ${data.change! >= 0 ? "is-up" : "is-down"}`}>
              {change} vs previous period
            </span>
          )}
        </>
      ) : (
        <Status loading={loading} error={error} />
      )}
    </div>
  );
}

function ChartShell({ component, children }: { component: UIComponent; children: React.ReactNode }) {
  return (
    <div
      className={`app-chart app-chart--${component.size}`}
      onClick={() => tracker.track(component.id, "component_click")}
    >
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

const axis = { fontSize: 12, fill: "var(--app-muted)" };

export function TimeseriesChart({ component, capability, kind }: DataProps & { kind: "line" | "bar" }) {
  const { data, loading, error } = useCapabilityData<TimeseriesData>(capability.id, component.id);
  if (!data) return <Status loading={loading} error={error} />;
  const unit = unitOf(capability);
  const common = {
    data: data.points,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  };
  const axes = [
    <CartesianGrid key="grid" stroke="var(--app-grid)" vertical={false} />,
    <XAxis key="x" dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />,
    <YAxis
      key="y"
      tick={axis}
      tickLine={false}
      axisLine={false}
      width={56}
      tickFormatter={(value: number) => formatValue(value, unit, true)}
    />,
    <Tooltip
      key="tooltip"
      formatter={(value) => formatValue(Number(value), unit)}
      contentStyle={{ borderRadius: "var(--app-radius)", border: "1px solid var(--app-border)", fontSize: 13 }}
    />,
  ];
  return (
    <div className={loading ? "is-refreshing" : undefined}>
      <p className="app-chart__total">
        {formatValue(data.total, unit)}
        {formatChange(data.change) && <span> {formatChange(data.change)}</span>}
      </p>
      <ChartShell component={component}>
        {kind === "line" ? (
          <LineChart {...common}>
            {axes}
            <Line type="monotone" dataKey="value" stroke="var(--app-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        ) : (
          <BarChart {...common}>
            {axes}
            <Bar dataKey="value" fill="var(--app-primary)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        )}
      </ChartShell>
    </div>
  );
}

function useSelectable(capability: DataCapability) {
  const { capabilities } = useRenderer();
  return [...capabilities.values()].some(
    (c) => c.kind === "action" && Object.values(c.inputs).some((input) => input.type === "string" && input.from === capability.id),
  );
}

export function Table({ component, capability }: DataProps) {
  const { data, loading, error } = useCapabilityData<CollectionData>(capability.id, component.id);
  const { selection, select } = useRenderer();
  const selectable = useSelectable(capability);
  if (capability.output.kind !== "collection") return null;
  const { columns, rowKey } = capability.output;
  if (!data) return <Status loading={loading} error={error} />;
  if (data.rows.length === 0) return <Status loading={false} error={null} empty />;
  const selected = selection[capability.id] ?? null;

  return (
    <div className={`app-table-wrap ${loading ? "is-refreshing" : ""}`}>
      <table className="app-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.format === "currency" ? "is-numeric" : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const key = String(row[rowKey]);
            const isSelected = selectable && selected === key;
            return (
              <tr
                key={key}
                className={isSelected ? "is-selected" : undefined}
                aria-selected={selectable ? isSelected : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={() => {
                  tracker.track(component.id, "component_click", { row: key });
                  if (selectable) select(capability.id, isSelected ? null : key);
                }}
                onKeyDown={(event) => {
                  if (selectable && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    select(capability.id, isSelected ? null : key);
                  }
                }}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.format === "currency" ? "is-numeric" : undefined}>
                    {column.format === "status" ? (
                      <span className={`app-pill app-pill--${String(row[column.key])}`}>{String(row[column.key])}</span>
                    ) : (
                      formatCell(row[column.key], column.format)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="app-table__foot">
        Showing {data.rows.length} of {data.total}.
        {selectable && (selected ? ` ${selected} is selected.` : " Select a row to act on it.")}
      </p>
    </div>
  );
}

export function List({ component, capability }: DataProps) {
  const { data, loading, error } = useCapabilityData<CollectionData>(capability.id, component.id);
  const { selection, select } = useRenderer();
  const selectable = useSelectable(capability);
  if (capability.output.kind !== "collection") return null;
  const { columns, rowKey } = capability.output;
  if (!data) return <Status loading={loading} error={error} />;
  if (data.rows.length === 0) return <Status loading={false} error={null} empty />;
  const [primary, secondary] = columns.filter((c) => c.key !== rowKey);

  return (
    <ul className="app-list">
      {data.rows.map((row) => {
        const key = String(row[rowKey]);
        const isSelected = selectable && selection[capability.id] === key;
        return (
          <li key={key}>
            <button
              type="button"
              className={isSelected ? "is-selected" : undefined}
              onClick={() => {
                tracker.track(component.id, "component_click", { row: key });
                if (selectable) select(capability.id, isSelected ? null : key);
              }}
            >
              <span>{formatCell(row[primary?.key ?? rowKey], primary?.format)}</span>
              {secondary && <span className="app-list__meta">{formatCell(row[secondary.key], secondary.format)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
