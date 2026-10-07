# autumn-plugin-d3

[D3.js](https://d3js.org) charts for [Autumn](https://github.com/autumn-foundation/autumn)
apps (`autumn-web` 0.8). Write charts in Rust. Get SVG charts that work
with htmx, with the default CSP, and without JavaScript.

- No npm, no bundler, no inline script. The crate serves D3 7.9.0 with SRI.
- Typed builder: bar, line, area, scatter, pie/donut, custom kinds.
- Data table in every chart: it shows without JavaScript and stays for
  screen readers.
- Tooltips by pointer and keyboard. Legend. Light and dark palette.
- Live data: same-origin JSON with optional refresh.

## Quickstart

```toml
[dependencies]
autumn-plugin-d3 = "0.1"
```

```rust
use autumn_plugin_d3::{Chart, D3Plugin, Format, d3_script, d3_stylesheet};
use autumn_web::prelude::*;

#[get("/")]
async fn index() -> Markup {
    html! {
        html {
            head { (d3_stylesheet()) (d3_script()) }
            body {
                (Chart::bar([("Apples", 30.0), ("Pears", 60.0), ("Plums", 15.0)])
                    .label("Fruit sold")
                    .y_label("Units")
                    .format(&Format::integer()))
            }
        }
    }
}

#[autumn_web::main]
async fn main() {
    autumn_web::app()
        .plugin(D3Plugin::new())
        .routes(routes![index])
        .run()
        .await;
}
```

## Chart kinds

| Builder | Data | Kind options |
|---|---|---|
| `Chart::bar(data)` | `(label, value)` or `Datum` | `horizontal()` |
| `Chart::pie(data)` | `(label, value)` or `Datum` | `donut(inner)` |
| `Chart::line(series)` | `Series` of `(x, y)` | `curve`, `dots`, `x_scale`, `y_scale`, `x_format` |
| `Chart::area(series)` | `Series` of `(x, y)` | `curve`, `x_scale`, `y_scale`, `x_format` |
| `Chart::scatter(series)` | `Series` of `(x, y)` | `radius`, `x_scale`, `y_scale`, `x_format` |
| `Chart::custom(name)?` | `json(&value)?` | all axis options |

Kind options compile only on their kinds. For example, `Chart::bar(..).donut(0.5)`
does not compile. Axis options (`x_label`, `y_label`, `y_min`, `y_max`)
apply to all kinds except pie.

A non-finite value (`NaN`, `±∞`) is a missing value. Bars skip it. Lines
show a gap. With `Scale::Time`, x is Unix time in milliseconds.

## Common options

| Method | Attribute | Effect |
|---|---|---|
| `label(text)` | `data-d3-label` | Accessible name. Also the table caption. |
| `caption(text)` | — | Visible `<figcaption>`. |
| `format(&Format)` | `data-d3-format` | Value format (ticks, tooltips). |
| `colors([Color])` | `data-d3-colors` | Series colors, in order. |
| `aspect(ratio)` | `data-d3-aspect` | Plot width / height. Default 16 / 9. |
| `duration(Duration)` | `data-d3-duration` | Transition time. Default 400 ms. |
| `animate_reduced_motion()` | `data-d3-reduced="animate"` | Animate also for reduced-motion users. |
| `legend(bool)` | `data-d3-legend` | Default: on for two or more series. |
| `src(url)` / `Chart::<K>::from_src(url)` | `data-d3-src` | Load JSON from a same-origin URL. |
| `refresh(Duration)` | `data-d3-refresh` | Load `src` again at this interval. |
| `table(false)` | — | Leave out the data table. |
| `id`, `class` | — | Element id and extra classes. |

`Format` maps to d3-format: `integer()`, `decimal(n)`, `percent(n)`,
`si(n)`, `currency(n)`, or `d3("spec")`.

## Hand-written markup

The builder only writes attributes. This markup works too:

```html
<figure data-d3="bar" data-d3-data='[["a", 1], ["b", 2]]' data-d3-label="Hand"></figure>
```

Data shapes: `[{"label": "a", "value": 1}]` or `[["a", 1]]` for bar and
pie; `[{"name": "s", "points": [[x, y]]}]` for line, area, and scatter. An
x value can also be a numeric string or an ISO 8601 date string (no zone
means UTC). `null` is a missing value.

## htmx and live data

`init.js` starts charts after htmx swaps and frees charts that leave the
page. A change to `data-d3-data` animates the chart to the new data. A
change to another `data-d3-*` attribute rebuilds the chart.

```rust
// The handler returns Vec<Datum> or Vec<Series> as JSON.
#[get("/api/sales.json")]
async fn sales() -> Json<Vec<Datum>> { Json(load_sales()) }

// The chart loads it, then loads it again every 5 s.
(Chart::<Bar>::from_src("/api/sales.json").refresh(Duration::from_secs(5)))
```

## Custom kinds and JavaScript

Load your script after `d3_script()`, with `defer`. Do not inline it.

```rust
(d3_script())
script src=(asset_url("js/charts.js")) defer {}
// ...
(Chart::custom("sparkline")?.json(&values)?.label("Trend"))
```

```js
// static/js/charts.js
AutumnD3.register("sparkline", ({ d3, svg, width, height, data, color }) => {
  const x = d3.scaleLinear([0, data.length - 1], [0, width]);
  const y = d3.scaleLinear(d3.extent(data), [height, 0]);
  svg.append("path").attr("d", d3.line((_, i) => x(i), y)(data))
    .style("fill", "none").style("stroke", color(0));
});
```

The runtime clears the SVG before each draw of a custom kind. Use the
`style()` method for styles (CSSOM). Do not set `style` attributes.

| API | Use |
|---|---|
| `d3:ready` event | First draw. `event.detail` is the handle. |
| `d3:render` event | Each draw. |
| `d3:error` event | `event.detail.error`. The table stays. |
| `el.autumnD3` | Handle: `d3`, `svg`, `data`, `options`, `update(data)`, `render()`, `destroy()`. |
| `AutumnD3` | `register(kind, draw)`, `scan(root)`, `get(el)`, `version`. |
| `data-d3-state` | `loading`, `pending` (custom kind not registered), `ready`, `error`. |

## Theme

Set these custom properties on `[data-d3]` or a parent class. The
defaults use `:where()`, so your rules win.

| Property | Default |
|---|---|
| `--d3-color-1` … `--d3-color-8` | Validated palette (light and dark steps). |
| `--d3-surface` | `Canvas`. Ring and tooltip background. |
| `--d3-muted`, `--d3-grid` | Mixes of `currentColor`. |
| `--d3-bar-max` | `24` (largest bar thickness in px). |
| `--d3-area-opacity` | `0.1`. |

Add class `d3-show-table` to keep the data table visible.

## Gotchas

- **CSP.** Do not inline `<script>` or `<style>`. Put page scripts in
  `static/` and load them with `defer` after `d3_script()`.
- **One D3.** Use `window.d3`. Do not load a second copy.
- **htmx in nonce mode.** htmx adds an inline `<style>`. Set
  `<meta name="htmx-config" content='{"includeIndicatorStyles":false}'>`.
- **Big data.** Large inline data makes large HTML. Use `src`.

## Demo

```sh
cargo run --example d3_demo
# then open http://127.0.0.1:3000
```

## Development

See [CLAUDE.md](CLAUDE.md) for commands, and [docs/plan.md](docs/plan.md)
and [docs/adr/](docs/adr/) for the design.

## License

Apache-2.0 for the plugin. D3 is ISC (`assets/D3-LICENSE`).
