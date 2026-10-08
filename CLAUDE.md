# CLAUDE.md: autumn-plugin-d3

D3.js plugin for Autumn (`autumn-web` 0.8). Style: ASD-STE100 for docs
and comments (short sentences, active voice, simple present).

## Layout

| Path | Role |
|---|---|
| `src/assets.rs` | `D3_ASSETS` bundle and the D3 provenance pin. |
| `src/plugin.rs` | `D3Plugin` (installs the bundle). |
| `src/script.rs` | `d3_script()`, `d3_stylesheet()`. |
| `src/chart.rs` | Typed builder `Chart<K>` → `data-d3-*` markup + table. |
| `src/data.rs` | `Datum`, `Series`, `Point`, `Color`, `Format`, `Curve`, `Scale`. |
| `assets/parse.js` | Pure attribute and data parsers. Node-tested. |
| `assets/init.js` | Runtime: draw, interact, lifecycle. E2E-tested. |
| `assets/d3.css` | Palette, plot box, marks, sr-only table. |
| `assets/d3.min.js` | Vendored D3 7.9.0. Do not edit by hand. |
| `scripts/vendor.sh` | Re-vendor D3. |
| `examples/d3_demo.rs` | Demo app. |
| `examples/e2e_fixture.rs` | E2E routes, one per scenario. |
| `tests/js/` | `node --test` unit tests for `parse.js`. |
| `tests/e2e/` | Playwright + Chromium tests. |
| `docs/plan.md`, `docs/adr/` | Plan, acceptance criteria, decisions. |

## Rules

- Keep Rust and JS in sync. A new attribute needs: builder method, entry
  in `chart::ATTRIBUTES` and the `Render` impl, `ATTR` entry in
  `parse.js`, parser test, E2E test, README row. The tests
  `every_listed_attribute_is_rendered` and
  `every_emitted_attribute_is_known_to_the_runtime` check names.
- Limits (clamps) in `src/chart.rs` and `assets/parse.js` must agree.
- The builder never emits non-finite numbers (proptest).
- No inline script, inline style, `style=""` in markup, `innerHTML`, or
  `eval` (CSP). Set styles through the CSSOM (`el.style.setProperty`).
- Text from data goes through `textContent` (`.text()`) only.
- Vendored files change only through `scripts/vendor.sh`. Update
  `D3_JS_INTEGRITY` and `assets/manifest.json` in the same commit.
- The compiler embeds `init.js`. Rebuild the fixture before E2E tests.
- E2E predicates: the page CSP blocks `eval`, so do not use
  `page.waitForFunction`. Use `until()` from `harness.mjs`.

## Commands

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings
cargo test
cargo llvm-cov --lib --fail-under-lines 85 --summary-only
npm ci && npm run test:unit
npx playwright install chromium   # one time
cargo build --example e2e_fixture --example d3_demo && npm run test:e2e
E2E_SKIP_COVERAGE=1 node --test --test-name-pattern="<name>" tests/e2e/chart.test.mjs
```

## Known problems

- autumn-web 0.8.0 does not read `AUTUMN_SECURITY__HEADERS__CSP_NONCE__ENABLED`.
  The nonce E2E test writes an `autumn.toml` (`AUTUMN_MANIFEST_DIR`).
- htmx injects an inline `<style>`. Pages set
  `includeIndicatorStyles: false` for nonce mode.
- A `<table>` ignores `width: 1px`. The sr-only rule targets the
  `div.d3-table` wrapper.
