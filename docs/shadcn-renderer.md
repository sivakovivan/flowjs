# shadcn renderer

The generated dashboard uses checked-in shadcn/ui New York components in
`src/components/ui`. The capability IDs, ten primitive names, compatibility
rules, schema, and mutation engine are unchanged, so saved layouts continue to
work. The adapters in `src/components/renderer/primitives` connect these
components to Flow state, data, actions, selection, and telemetry.

| Flow primitive            | shadcn components                                                    |
| ------------------------- | -------------------------------------------------------------------- |
| `metric-card`             | Card frame with formatted total and change                           |
| `line-chart`, `bar-chart` | ChartContainer and ChartTooltipContent with Recharts                 |
| `table`                   | Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge |
| `list`                    | Ghost Buttons inside a semantic list                                 |
| `button`                  | Button, with Select when the action takes an enum                    |
| `button-group`            | ButtonGroup for actions; single-value ToggleGroup for state          |
| `dropdown`                | Select                                                               |
| `segmented-control`       | Connected single-value ToggleGroup                                   |
| `search-field`            | Input with the existing 350 ms debounce                              |

Every dashboard component uses a Card frame. Loading indicators use Skeleton.
Option controls retain one selected value, and actions still read bound input
from selected collection rows. Busy actions use `aria-disabled` with an execution
guard so attempted interactions can still be measured.

## Styling and maintenance

The demo compiles Tailwind v4 through `apps/demo/postcss.config.mjs`.
`apps/demo/src/app/shadcn.css` scans the shared component directory and maps
shadcn's semantic color/radius tokens to Flow's developer-provided `--app-*`
variables. Tailwind's global reset is omitted to preserve studio chrome. Select
menus portal into the owning `.stage` to inherit that dashboard's theme.

Components were sourced from the official
[New York v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json).
Imports use relative paths because core and the demo have separate `@/` aliases.
SelectContent adds an optional portal container. `components.json` records the
installation configuration; preserve these adaptations when updating components.

Run `pnpm typecheck`, `pnpm test`, `pnpm --filter @flowjs/demo test`, and
`pnpm test:e2e` to validate changes. The browser suite exercises the Select popup,
chart/table rendering, row-bound actions, primitive swaps, persistence, and undo.
