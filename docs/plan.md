# Plan: autumn-plugin-d3 0.1.0

Target: Autumn `autumn-web` 0.8.0. Prior art: `autumn-plugin-motion` 0.2.0
and `autumn-plugin-three` 0.1.0. Style: ASD-STE100. Method: SPEC → RED →
GREEN → REFACTOR.

## 1. Goal

Give Autumn apps D3.js charts. Do not use npm, a bundler, or inline
script. Write the chart in Rust or in HTML attributes. Keep the charts
correct across htmx swaps. Keep the data readable without JavaScript.

## 2. Brainstorming

All ideas first, no filter:

1. Vendor the D3 UMD build (`d3.min.js`, sets `window.d3`) and serve it
   with `PluginAssets`.
2. Typed Rust builder: `Chart::bar`, `line`, `area`, `scatter`, `pie`.
3. Typestate: kind-specific options (`donut`, `horizontal`, `curve`) only
   compile on the kinds that use them.
4. Declarative `data-d3-*` attributes. One interpreter (`init.js`).
5. Data as JSON in one attribute (`data-d3-data`).
6. Data from a same-origin JSON URL (`data-d3-src`), with optional refresh.
7. Table-first: the runtime reads data from an HTML `<table>`.
8. Server-rendered fallback table: works without JS and for screen readers.
9. Server-side SVG render in Rust (no JS at all).
10. Re-scan on `htmx:afterSwap` and on DOM insertion. Dispose on removal.
11. Redraw on resize (`ResizeObserver`) and on `data-d3-*` change.
12. Animated update when the data changes (D3 data join with keys).
13. `d3:ready` / `d3:error` events and an `el.autumnD3` handle.
14. Custom chart registry: `AutumnD3.register(kind, draw)`.
15. Theme with CSS custom properties. Dark mode. Validated palette.
16. Hover tooltip and keyboard focus on marks.
17. `prefers-reduced-motion`: no transitions.
18. ESM build of D3 with an import map.
19. Maps (`d3-geo`), force graphs, treemaps as built-in kinds.
20. Headless Chromium tests that read the real SVG.

Selected: 1–6, 8, 10–17, 20. Rejected:

- 7: verbose to write by hand. Number parsing from text is fragile. The
  builder makes the table from the same data (idea 8).
- 9: large scope. It duplicates D3. Record as a limit.
- 18: an import map is an inline script. The default CSP blocks it.
- 19: large scope. Idea 14 covers it: write a custom kind.

## 3. Reverse brainstorming

Question: "How can we make this plugin fail?" Then invert each answer.

| Way to fail | Prevention |
|---|---|
| Inline `<script>` or `style=""` blocked by CSP. | External files only. Styles set through the CSSOM (`el.style`), which CSP does not block. Maud emits no `style` attribute. |
| `eval` or `new Function` blocked by CSP. | Data uses `JSON.parse`. No `d3.html`, no `innerHTML`. |
| Vendored bytes drift from upstream. | `sha384` pin. Test and `scripts/vendor.sh` check it. |
| Chart text injects HTML (XSS). | Labels go through `textContent` only. Maud escapes attributes. |
| `NaN` / `Infinity` breaks scales. | Rust emits `null` for non-finite values. JS treats `null` as a gap. Options drop non-finite input. |
| Bad JSON stops all charts. | Parse per chart. Catch per chart. Keep the fallback table. Fire `d3:error`. |
| `data-d3-src` loads another origin. | The runtime accepts same-origin URLs only. |
| A chart draws two times. | A `Map` from element to state. |
| htmx swaps leak observers and timers. | Dispose on removal: disconnect `ResizeObserver`, clear the refresh timer, abort `fetch`. |
| Chart has zero size. | Default `aspect-ratio: 16 / 9` on `.d3-plot`. |
| Resize loop (draw changes size, size changes draw). | The plot box size comes from CSS only. The SVG uses the measured box. Redraw only when the width or height changes. |
| Reduced-motion users see motion. | No transitions unless `data-d3-reduced="animate"`. |
| Color is the only identity channel. | Legend for two or more series. Table view. Tooltip with the series name. |
| Colors fail for color-blind users. | Validated 8-slot palette from the dataviz method. Light and dark steps. |
| Custom kind loads after the scan. | `register()` rescans. The chart waits in state `pending`. |
| Tests only check strings; the chart does not draw. | E2E tests in headless Chromium read the SVG geometry. |
| Two copies of D3 load. | One global `window.d3`. Docs say: use it, do not load another. |

## 4. Six thinking hats

- **White (facts).** D3 7.9.0 is the latest release (ISC). `dist/d3.min.js`
  is one 280 KB UMD file. It sets `window.d3`. Autumn 0.8 serves
  `PluginAssets` with hashed URLs, SRI, ETag, and Range. Default CSP:
  `script-src 'self'`, `connect-src 'self'`. Nonce mode drops
  `'unsafe-inline'` from `style-src`. CSSOM writes are not blocked. Verus
  is not available in this container, and the crate has no `unsafe` code
  and no state machine. Proptests cover the builder invariants. E2E tests
  cover the JS lifecycle.
- **Red (feelings).** Users want "a chart on my page in five lines". The
  default look must be calm and good without CSS work.
- **Black (risks).** UMD globals and load order: `defer` keeps document
  order. A custom chart script must come after `d3_script()`. A large
  dataset in an attribute makes the HTML big: use `data-d3-src`.
- **Yellow (benefits).** One crate, no build step. Typed API catches bad
  options at compile time. Charts work in htmx partials and survive swaps.
  The data table works with no JavaScript.
- **Green (creative).** Live charts: `data-d3-src` + `data-d3-refresh`,
  or an htmx attribute change, animate in place with keyed joins. Custom
  kinds reuse the lifecycle, sizing, and events.
- **Blue (process).** Write spec (this file + ADRs). Then RED tests per
  slice, GREEN code, REFACTOR. Then a multi-angle review. Then the AC
  evidence table.

## 5. Spec (invariants)

1. The bundle holds exactly the served files. `manifest.json` and
   `D3-LICENSE` are not served.
2. `d3.min.js` matches its pinned upstream `sha384`.
3. `d3_script()` emits three deferred scripts with SRI, in this order:
   `d3.min.js`, `parse.js`, `init.js`.
4. The builder never emits a non-finite number. Missing values are `null`.
5. Every attribute the builder emits is known to `parse.js`.
6. One chart element owns at most one runtime state. Removal frees it.
7. Reduced motion: no transitions without opt-in.
8. A bad chart never stops other charts.
9. Text from data never reaches `innerHTML`.

## 6. Acceptance criteria

No GitHub issue exists for this work. These criteria come from the
request and the prior art.

| # | Criterion |
|---|---|
| AC1 | `D3Plugin` installs vendored D3 7.9.0 through `PluginAssets` (autumn-web 0.8.0) under `/static/_plugins/d3/`, with hashed URLs and SRI. Provenance files are not served. |
| AC2 | The vendored file matches a pinned upstream `sha384`. `scripts/vendor.sh` reproduces it. |
| AC3 | `d3_script()` and `d3_stylesheet()` emit tags with SRI. No inline script or style. Charts work under the default CSP and nonce CSP. |
| AC4 | A typed Rust builder makes bar, line, area, scatter, pie/donut, and custom charts. Kind-specific options compile only on their kinds. No non-finite numbers. |
| AC5 | Hand-written `data-d3-*` attributes work. The runtime starts charts on load, after htmx swaps, and on DOM insertion. It disposes them on removal. It redraws on resize and on attribute change. |
| AC6 | Data comes inline (JSON) or from a same-origin URL, with optional refresh. Errors fire `d3:error` and keep the fallback. |
| AC7 | Accessibility: labelled SVG, fallback data table, legend for two or more series, keyboard-focusable marks with tooltips, reduced motion. |
| AC8 | Extension: `d3:ready` event, `el.autumnD3` handle, `AutumnD3.register` for custom kinds, shared `window.d3`. |
| AC9 | Theme: CSS custom properties, validated light and dark palette, typed color override. |
| AC10 | A runnable demo app and an E2E fixture app. |
| AC11 | Tests: Rust unit, proptest, and doc tests with ≥ 85 % line coverage. `parse.js` unit tests with ≥ 85 % coverage. Browser E2E tests with ≥ 90 % `init.js` line coverage. |
| AC12 | CI: fmt, clippy (pedantic + nursery), tests, docs, coverage, MSRV 1.88, JS unit, E2E. |
| AC13 | Docs: README, CLAUDE.md, ADRs, this plan. ASD-STE100, short. |
| AC14 | A multi-angle code review ran. All findings are fixed or answered. |

## 7. Slices

| # | Slice | RED test first |
|---|---|---|
| 1 | Asset bundle + manifest | `assets.rs` tests |
| 2 | `D3Plugin` | serve, 404, routes, conformance |
| 3 | `d3_script()` / `d3_stylesheet()` | tag tests |
| 4 | Builder | unit + proptest |
| 5 | `parse.js` | `node --test` |
| 6 | `init.js` runtime | E2E (Chromium) |
| 7 | Demo + fixture | E2E |
| 8 | CI, README, ADRs, CLAUDE.md | review |
