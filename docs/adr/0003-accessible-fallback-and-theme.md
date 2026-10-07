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
  because a table ignores `width: 1px`.
- The SVG has `role="img"`, an `aria-label`, and `tabindex="0"`. Arrow,
  Home, and End keys move a tooltip (`role="status"`) over the items.
  The pointer does the same.
- A legend shows for two or more series and for pie charts.
- Colors come from CSS custom properties with zero specificity
  (`:where()`): the validated 8-slot palette with light and dark steps.
  Marks get a class `d3-sN`. `data-d3-colors` sets `--d3-c` through the
  CSSOM, which the CSP allows.
- `prefers-reduced-motion`: no transitions unless
  `data-d3-reduced="animate"`.

## Consequences

- Every chart has an accessible data view by default.
- Hosts theme charts with CSS only.
- More than 8 series repeat colors. The docs say to keep to 8 or fewer.
