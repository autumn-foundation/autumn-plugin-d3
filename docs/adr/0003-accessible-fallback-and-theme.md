# ADR 0003: Data table fallback, keyboard tooltips, and CSS theme

- Status: accepted
- Date: 2026-10-07

## Context

An SVG chart is not readable without JavaScript or by most screen
readers. Color alone must not carry identity. The strict CSP blocks
`style=""` attributes in markup.

## Decision

- The builder renders a `div.d3-table > table` with the data. It shows
  without JavaScript and on error. When the chart is ready, CSS hides it
  visually but keeps it for screen readers. The wrapper is a `div`
  because a table ignores `width: 1px`. The runtime rewrites the table
  when the data changes (load, refresh, update).
- The SVG has `role="img"` and an `aria-label`. When it has items, it gets
  `tabindex="0"` and a hint (`aria-describedby`). Arrow, Home, and End
  keys move the tooltip. A separate live region (`role="status"`) reads
  the value; the visual tooltip is `aria-hidden`. The pointer does the
  same. Escape closes the tooltip from anywhere.
- The runtime keeps the tooltip inside the plot.
- A legend shows for two or more series or slices.
- Colors come from CSS custom properties with zero specificity
  (`:where()`): the validated 8-slot palette with light and dark steps.
  With `data-theme="dark"`, the surface is `#1a1a19`.
  Marks get a class `d3-sN`. `data-d3-colors` sets `--d3-c` through the
  CSSOM, which the CSP allows.
- `prefers-reduced-motion`: no transitions unless
  `data-d3-reduced="animate"`.
- Forced colors: marks and swatches keep their colors
  (`forced-color-adjust: none`), so series stay different.

## Consequences

- Every chart has an accessible data view by default.
- Hosts theme charts with CSS only.
- More than 8 series repeat colors. The runtime writes a console warning.
