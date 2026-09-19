import { z } from "zod";
import { isCompatible, PRIMITIVES, SIZE_SPAN, SIZES } from "./primitives";
import type { FlowApp } from "./registry";

/*
 * The UI schema is the central mutable artifact: structured data describing
 * which primitive renders each capability, and where. Never source code.
 */

export const UIComponentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, "component ids are kebab-case"),
  capability: z.string(),
  primitive: z.enum(PRIMITIVES),
  size: z.enum(SIZES),
  order: z.number().int().min(0),
  visible: z.boolean(),
  group: z.string().max(40).nullable(),
});

export const UISchemaSchema = z.strictObject({
  components: z.array(UIComponentSchema).min(1).max(40),
});

export type UIComponent = z.infer<typeof UIComponentSchema>;
export type UISchema = z.infer<typeof UISchemaSchema>;

export type ValidationResult =
  | { ok: true; schema: UISchema }
  | { ok: false; errors: string[] };

/** Sort by order and renumber 0..n-1 so order is always a dense index. */
export function normalizeOrder(schema: UISchema): UISchema {
  const components = [...schema.components]
    .sort((a, b) => a.order - b.order)
    .map((component, index) => ({ ...component, order: index }));
  return { components };
}

/**
 * Validate a schema against the registered capabilities. Every capability must
 * be represented, primitives must be compatible, and every required capability
 * must keep at least one visible component.
 */
export function validateSchema(input: unknown, app: FlowApp): ValidationResult {
  const parsed = UISchemaSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "schema"}: ${issue.message}`),
    };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const component of parsed.data.components) {
    if (seen.has(component.id)) errors.push(`Duplicate component id "${component.id}".`);
    seen.add(component.id);

    const capability = app.capability(component.capability);
    if (!capability) {
      errors.push(`Component "${component.id}" references unknown capability "${component.capability}".`);
      continue;
    }
    if (!isCompatible(capability, component.primitive)) {
      errors.push(
        `Component "${component.id}" cannot render ${capability.kind} "${capability.id}" as "${component.primitive}".`,
      );
    }
  }

  for (const capability of app.capabilities) {
    const bound = parsed.data.components.filter((c) => c.capability === capability.id);
    if (bound.length === 0) {
      errors.push(`Capability "${capability.id}" has no component.`);
    } else if (capability.required && !bound.some((c) => c.visible)) {
      errors.push(`Required capability "${capability.id}" has no visible component.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, schema: normalizeOrder(parsed.data) };
}

/** Pack visible components into 12-column rows; returns each component's row index. */
export function layoutRows(schema: UISchema): Map<string, number> {
  const rows = new Map<string, number>();
  let row = 0;
  let used = 0;
  for (const component of normalizeOrder(schema).components) {
    if (!component.visible) continue;
    const span = SIZE_SPAN[component.size];
    if (used + span > 12) {
      row += 1;
      used = 0;
    }
    rows.set(component.id, row);
    used += span;
  }
  return rows;
}

export type ComponentChange = "moved" | "resized" | "swapped" | "shown" | "hidden";

/** What changed per component between two schemas, used to highlight a transition. */
export function diffSchemas(before: UISchema, after: UISchema): Record<string, ComponentChange[]> {
  const previous = new Map(normalizeOrder(before).components.map((c) => [c.id, c]));
  const changes: Record<string, ComponentChange[]> = {};
  for (const component of normalizeOrder(after).components) {
    const old = previous.get(component.id);
    if (!old) continue;
    const list: ComponentChange[] = [];
    if (old.order !== component.order) list.push("moved");
    if (old.size !== component.size) list.push("resized");
    if (old.primitive !== component.primitive) list.push("swapped");
    if (!old.visible && component.visible) list.push("shown");
    if (old.visible && !component.visible) list.push("hidden");
    if (list.length > 0) changes[component.id] = list;
  }
  return changes;
}
