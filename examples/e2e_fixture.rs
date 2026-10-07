//! Test fixture app for the browser E2E tests in `tests/e2e/`.
//!
//! Each route is one scenario. Run it with:
//!
//! ```sh
//! AUTUMN_SERVER__PORT=3111 cargo run --example e2e_fixture
//! ```
//!
//! Not a demo. See `examples/d3_demo.rs` for the demo.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use autumn_plugin_d3::{
    Bar, Chart, Color, Curve, D3_ASSETS, D3Plugin, Datum, Format, Line, Scale, Series, d3_script,
    d3_stylesheet,
};
use autumn_web::assets::asset_url;
use autumn_web::extract::Json;
use autumn_web::{Markup, html};

/// The crate `static/` dir: fixture scripts and styles.
static STATIC: autumn_web::include_dir::Dir = autumn_web::embed_static!();

/// Requests to `/data/live.json`. Each request changes the data.
static LIVE: AtomicU32 = AtomicU32::new(0);

#[autumn_web::main]
async fn main() {
    autumn_web::app()
        .plugin(D3Plugin::new())
        .embedded_static(&STATIC)
        .routes(autumn_web::routes![
            bar,
            horizontal,
            line,
            area,
            scatter,
            pie,
            handwritten,
            bad,
            remote,
            remote_bad,
            live,
            live_json,
            sales_json,
            swap,
            swap_next,
            custom,
            options,
            empty,
            edge,
            slow,
            slow_json,
            no_d3,
        ])
        .run()
        .await;
}

/// The page shell. `extra` adds deferred page scripts after `d3_script()`.
fn page_with(content: &Markup, extra: &[&str]) -> Markup {
    html! {
        (maud::DOCTYPE)
        html {
            head {
                meta charset="utf-8";
                title { "d3 e2e" }
                // htmx adds an inline <style> for indicators. CSP nonce mode
                // blocks it, so turn it off.
                meta name="htmx-config" content=r#"{"includeIndicatorStyles":false}"#;
                link rel="stylesheet" href=(asset_url("css/fixture.css"));
                (d3_stylesheet())
                (d3_script())
                script src=(asset_url("js/htmx.min.js")) defer {}
                script src=(asset_url("js/fixture-listener.js")) defer {}
                @for path in extra {
                    script src=(asset_url(path)) defer {}
                }
            }
            body { (content) }
        }
    }
}

fn page(content: &Markup) -> Markup {
    page_with(content, &[])
}

/// Three fruit values. The tests know them.
fn fruit() -> [Datum; 3] {
    [
        Datum::new("Apples", 30.0),
        Datum::new("Pears", 60.0),
        Datum::new("Plums", 15.0),
    ]
}

/// Two series over three days (Unix ms, 2026-01-01..03).
fn visits() -> [Series; 2] {
    let day = |n: f64| 86_400_000.0f64.mul_add(n, 1_767_225_600_000.0);
    [
        Series::new(
            "Web",
            [(day(0.0), 10.0), (day(1.0), 20.0), (day(2.0), 15.0)],
        ),
        Series::new(
            "App",
            [(day(0.0), 5.0), (day(1.0), f64::NAN), (day(2.0), 25.0)],
        ),
    ]
}

#[autumn_web::get("/bar")]
async fn bar() -> Markup {
    page(&html! {
        (Chart::bar(fruit()).id("chart").label("Fruit sold").caption("Fruit").x_label("Fruit").y_label("Units"))
    })
}

#[autumn_web::get("/horizontal")]
async fn horizontal() -> Markup {
    page(&html! {
        (Chart::bar(fruit()).id("chart").horizontal().format(&Format::integer()))
        (Chart::bar([("Up", 10.0), ("Down", -5.0), ("None", f64::NAN)]).id("signed"))
    })
}

#[autumn_web::get("/line")]
async fn line() -> Markup {
    page(&html! {
        (Chart::line(visits()).id("chart").label("Visits").x_scale(Scale::Time).curve(Curve::Monotone).dots())
        (Chart::line([Series::new("Solo", [(1.0, 1.0), (2.0, 4.0), (3.0, 9.0)])]).id("solo").y_scale(Scale::Log))
    })
}

#[autumn_web::get("/area")]
async fn area() -> Markup {
    page(&html! {
        (Chart::area(visits()).id("chart").x_scale(Scale::Time).curve(Curve::Step))
    })
}

#[autumn_web::get("/scatter")]
async fn scatter() -> Markup {
    page(&html! {
        (Chart::scatter([
            Series::new("A", [(1.0, 1.0), (2.0, 3.0), (3.0, 2.0)]),
            Series::new("B", [(1.5, 2.5)]),
        ])
        .id("chart")
        .radius(6.0)
        .x_format(&Format::decimal(1))
        .colors([Color::hex(0x00ff_0000), Color::hex(0x0000_00ff)]))
    })
}

#[autumn_web::get("/pie")]
async fn pie() -> Markup {
    page(&html! {
        (Chart::pie(fruit()).id("chart").label("Fruit share").donut(0.5).aspect(1.0))
        (Chart::pie([("Only", 1.0)]).id("plain").legend(false))
    })
}

/// Charts written as raw attributes, without the builder.
#[autumn_web::get("/handwritten")]
async fn handwritten() -> Markup {
    page(&html! {
        figure id="chart" data-d3="bar" data-d3-data=r#"[["a",1],["b",2]]"# data-d3-label="Hand" {}
        div id="plain" data-d3="line" data-d3-data=r#"[{"name":"s","points":[{"x":0,"y":0},{"x":1,"y":1}]}]"# {}
    })
}

/// One bad chart per failure kind, and one good chart.
#[autumn_web::get("/bad")]
async fn bad() -> Markup {
    page(&html! {
        figure id="json" class="d3-chart" data-d3="bar" data-d3-data="[1," {
            div class="d3-table" { table { tr { td { "fallback" } } } }
        }
        figure id="shape" data-d3="line" data-d3-data=r#"[{"name":"a"}]"# {}
        figure id="kind" data-d3="Not A Kind" data-d3-data="[]" {}
        figure id="nodata" data-d3="bar" {}
        figure id="format" data-d3="bar" data-d3-data=r#"[["a",1]]"# data-d3-format="%%%bad" {}
        (Chart::bar(fruit()).id("good"))
    })
}

#[autumn_web::get("/data/sales.json")]
async fn sales_json() -> Json<Vec<Datum>> {
    Json(fruit().to_vec())
}

#[autumn_web::get("/data/live.json")]
async fn live_json() -> Json<Vec<Series>> {
    let n = f64::from(LIVE.fetch_add(1, Ordering::Relaxed));
    Json(vec![Series::new("Live", [(0.0, n), (1.0, n + 1.0)])])
}

#[autumn_web::get("/remote")]
async fn remote() -> Markup {
    page(&html! {
        (Chart::<Bar>::from_src("/data/sales.json").id("chart"))
        (Chart::bar([("Inline", 1.0)]).id("both").src("/data/sales.json"))
    })
}

#[autumn_web::get("/remote-bad")]
async fn remote_bad() -> Markup {
    page(&html! {
        (Chart::<Bar>::from_src("/data/missing.json").id("missing"))
        (Chart::<Bar>::from_src("https://example.com/x.json").id("cross"))
        (Chart::<Bar>::from_src("/bar").id("html"))
    })
}

#[autumn_web::get("/live")]
async fn live() -> Markup {
    page(&html! {
        (Chart::<Line>::from_src("/data/live.json").id("chart").refresh(Duration::from_secs(1)))
    })
}

#[autumn_web::get("/swap")]
async fn swap() -> Markup {
    page(&html! {
        button id="next" hx-get="/swap/next" hx-target="#slot" hx-swap="innerHTML" { "Next" }
        div id="slot" { (Chart::bar(fruit()).id("first")) }
    })
}

#[autumn_web::get("/swap/next")]
async fn swap_next() -> Markup {
    html! { (Chart::pie(fruit()).id("second")) }
}

/// Custom kinds. `js/custom-chart.js` registers `dots`. `late` is never
/// registered by a page script; the test registers it.
#[autumn_web::get("/custom")]
async fn custom() -> Markup {
    let dots = Chart::custom("dots").map(|c| c.json(&[1, 2, 3]));
    let late = Chart::custom("late").map(|c| c.json(&[4]));
    let broken = Chart::custom("broken").map(|c| c.json(&[0]));
    page_with(
        &html! {
            @if let Ok(Ok(chart)) = dots { (chart.id("chart").label("Dots")) }
            @if let Ok(Ok(chart)) = late { (chart.id("late")) }
            @if let Ok(Ok(chart)) = broken { (chart.id("broken")) }
        },
        &["js/custom-chart.js"],
    )
}

/// Options that change the look: aspect, colors, legend, domain, duration.
#[autumn_web::get("/options")]
async fn options() -> Markup {
    page(&html! {
        (Chart::bar(fruit()).id("wide").aspect(4.0).y_min(0.0).y_max(200.0))
        (Chart::bar(fruit()).id("animated").duration(Duration::from_millis(600)).animate_reduced_motion())
        (Chart::bar(fruit()).id("still").duration(Duration::ZERO))
        (Chart::line(visits()).id("nolegend").legend(false))
        (Chart::bar(fruit()).id("visible-table").class("d3-show-table"))
    })
}

#[autumn_web::get("/empty")]
async fn empty() -> Markup {
    page(&html! {
        (Chart::bar(Vec::<Datum>::new()).id("bar"))
        (Chart::line(Vec::new()).id("line"))
        (Chart::pie([("Zero", 0.0)]).id("pie"))
    })
}

/// Edge cases: log scales, times, all-missing x values, bar size tokens.
#[autumn_web::get("/edge")]
async fn edge() -> Markup {
    let hour = |n: f64| 3_600_000.0f64.mul_add(n, 1_767_225_600_000.0);
    page(&html! {
        (Chart::line([Series::new("s", [(1.0, 0.5), (2.0, 50.0), (3.0, -1.0)])]).id("log").y_scale(Scale::Log).y_min(0.1).y_max(1000.0))
        (Chart::area([Series::new("s", [(1.0, 2.0), (2.0, 20.0)])]).id("logarea").y_scale(Scale::Log))
        (Chart::line(Vec::new()).id("emptylog").x_scale(Scale::Log).y_scale(Scale::Log))
        (Chart::scatter([Series::new("s", [(0.0, 1.0), (10.0, 2.0)])]).id("xlog").x_scale(Scale::Log))
        (Chart::line([Series::new("s", [(hour(6.0), 1.0), (hour(7.0), 2.0)])]).id("hours").x_scale(Scale::Time))
        (Chart::line([Series::new("one", [(5.0, 1.0)])]).id("single").x_scale(Scale::Time))
        (Chart::line([
            Series::new("a", [(1.0, 1.0), (2.0, f64::NAN)]),
            Series::new("b", [(1.0, 2.0), (2.0, f64::NAN)]),
        ]).id("allmissing"))
        (Chart::scatter([Series::new("s", [(1.0, 2.0), (1.0, 1.0)])]).id("ties"))
        (Chart::bar([("a", 1.0)]).id("fat").class("fat"))
        (Chart::bar([("a", 1.0)]).id("badmax").class("bad-max"))
        figure data-d3="bar" data-d3-data=r#"[["a",1]]"# id="captioned" {
            figcaption { "  From the caption  " }
        }
        figure data-d3="bar" class="noid" {}
    })
}

#[autumn_web::get("/data/slow.json")]
async fn slow_json() -> Json<Vec<Datum>> {
    tokio::time::sleep(Duration::from_millis(800)).await;
    Json(fruit().to_vec())
}

#[autumn_web::get("/slow")]
async fn slow() -> Markup {
    page(&html! {
        (Chart::<Bar>::from_src("/data/slow.json").id("chart"))
        (Chart::bar([("a", 1.0)]).id("inline").src("/data/slow.json"))
    })
}

/// `init.js` without D3: the runtime must report it.
#[autumn_web::get("/no-d3")]
async fn no_d3() -> Markup {
    html! {
        (maud::DOCTYPE)
        html {
            head { (D3_ASSETS.deferred_script_tag("init.js")) }
            body { (Chart::bar(fruit()).id("chart")) }
        }
    }
}
