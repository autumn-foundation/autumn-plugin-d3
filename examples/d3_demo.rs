//! Demo app: a small dashboard with every chart kind.
//!
//! ```sh
//! cargo run --example d3_demo
//! # then open http://127.0.0.1:3000
//! ```
//!
//! It shows typed charts, a live chart (`src` + `refresh`), an htmx swap,
//! and a custom kind (`sparkline`, in `static/js/demo.js`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use autumn_plugin_d3::{
    Chart, Color, Curve, D3Plugin, Datum, Format, Line, Scale, Series, d3_script, d3_stylesheet,
};
use autumn_web::assets::asset_url;
use autumn_web::extract::{Json, Path};
use autumn_web::{Markup, html};

/// The crate `static/` dir: demo script and styles.
static STATIC: autumn_web::include_dir::Dir = autumn_web::embed_static!();

/// Ticks of the live chart.
static TICK: AtomicU32 = AtomicU32::new(0);

/// 2026-09-01T00:00:00Z in Unix ms.
const SEPT_1: f64 = 1_788_220_800_000.0;
const DAY_MS: f64 = 86_400_000.0;

#[autumn_web::main]
async fn main() {
    autumn_web::app()
        .plugin(D3Plugin::new())
        .embedded_static(&STATIC)
        .routes(autumn_web::routes![index, sales, live])
        .run()
        .await;
}

/// A smooth, repeatable wave for demo data.
fn wave(i: u32, seed: f64) -> f64 {
    let t = f64::from(i);
    let slow = seed.mul_add(2.0, t * 0.11).cos() * 0.15;
    t.mul_add(0.35, seed).sin().mul_add(0.25, slow) + 1.0
}

/// Monthly sales for a year.
fn sales_for(year: u32) -> Vec<Datum> {
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let seed = f64::from(year % 100);
    (0u32..)
        .zip(months)
        .map(|(i, m)| Datum::new(m, (wave(i, seed) * 42_000.0).round()))
        .collect()
}

/// The sales chart for a year. The htmx buttons swap it.
fn sales_chart(year: u32) -> Markup {
    html! {
        (Chart::bar(sales_for(year))
            .id("sales")
            .aspect(3.0)
            .label(format!("Monthly sales, {year}"))
            .y_label("Revenue")
            .format(Format::currency(0)))
    }
}

#[autumn_web::get("/sales/{year}")]
async fn sales(Path(year): Path<u32>) -> Markup {
    sales_chart(year.clamp(2000, 2100))
}

#[autumn_web::get("/api/live.json")]
async fn live() -> Json<Vec<Series>> {
    let now = TICK.fetch_add(1, Ordering::Relaxed);
    let points: Vec<(f64, f64)> = (now..now + 30)
        .map(|i| (f64::from(i), (wave(i, 0.5) * 120.0).round()))
        .collect();
    Json(vec![Series::new("Requests / s", points)])
}

#[autumn_web::get("/")]
async fn index() -> Markup {
    html! {
        (maud::DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                meta name="htmx-config" content=r#"{"includeIndicatorStyles":false}"#;
                title { "autumn-plugin-d3 demo" }
                link rel="stylesheet" href=(asset_url("css/demo.css"));
                (d3_stylesheet())
                (d3_script())
                script src=(asset_url("js/htmx.min.js")) defer {}
                // Custom kinds register after d3_script(), also deferred.
                script src=(asset_url("js/demo.js")) defer {}
            }
            body {
                header {
                    h1 { "Orchard dashboard" }
                    p { "D3 charts from Rust. No npm, no bundler, no inline script." }
                }
                main class="grid" {
                    section class="card wide" {
                        div class="toolbar" {
                            h2 { "Sales" }
                            div role="group" aria-label="Year" {
                                button hx-get="/sales/2025" hx-target="#sales-slot" { "2025" }
                                button hx-get="/sales/2026" hx-target="#sales-slot" { "2026" }
                            }
                        }
                        div id="sales-slot" { (sales_chart(2026)) }
                    }
                    (time_cards())
                    (other_cards())
                }
            }
        }
    }
}

/// A titled card.
fn card(title: &str, body: &Markup) -> Markup {
    html! { section class="card" { h2 { (title) } (body) } }
}

/// Line and area charts over September 2026.
fn time_cards() -> Markup {
    let day = |i: u32| DAY_MS.mul_add(f64::from(i), SEPT_1);
    let daily =
        |seed: f64, scale: f64| (0..30).map(move |i| (day(i), (wave(i, seed) * scale).round()));
    let visits = [
        Series::new("Web", daily(1.0, 900.0)),
        Series::new("App", daily(2.0, 600.0)),
    ];
    let signups = [Series::new("Signups", daily(3.0, 80.0))];
    html! {
        (card("Visits", &html! {
            (Chart::line(visits)
                .label("Daily visits, September 2026")
                .x_scale(Scale::Time)
                .curve(Curve::Monotone)
                .format(Format::integer()))
        }))
        (card("Signups", &html! {
            (Chart::area(signups)
                .label("Daily signups, September 2026")
                .x_scale(Scale::Time)
                .curve(Curve::Monotone))
        }))
    }
}

/// Scatter, donut, live, and custom charts.
fn other_cards() -> Markup {
    let product = |seed: f64, step: f64, start: f64, spread: f64, base: f64| {
        (0..12).map(move |i| {
            (
                f64::from(i).mul_add(step, start),
                wave(i, seed).mul_add(spread, base),
            )
        })
    };
    let products = [
        Series::new("Fruit", product(4.0, 1.5, 2.0, 2.0, 2.0)),
        Series::new("Juice", product(5.0, 1.2, 4.0, 1.5, 2.5)),
    ];
    let trend = Chart::custom("sparkline")
        .and_then(|c| c.json(&(0..24).map(|i| wave(i, 6.0)).collect::<Vec<_>>()))
        .map(|c| c.label("Uptime trend, last 24 hours").aspect(4.0));
    html! {
        (card("Price and rating", &html! {
            (Chart::scatter(products)
                .label("Price against rating")
                .x_label("Price (USD)")
                .y_label("Rating")
                .x_format(Format::currency(0))
                .y_min(0.0)
                .y_max(5.0))
        }))
        (card("Traffic share", &html! {
            (Chart::pie([("Search", 46.0), ("Direct", 27.0), ("Social", 15.0), ("Email", 12.0)])
                .label("Traffic share by source")
                .donut(0.6)
                .aspect(1.6))
        }))
        (card("Live load", &html! {
            (Chart::<Line>::from_src("/api/live.json")
                .label("Requests per second, live")
                .refresh(Duration::from_secs(2))
                .colors([Color::hex(0x001b_af7a)])
                .table(false))
        }))
        (card("Uptime", &html! { @if let Ok(chart) = trend { (chart) } }))
    }
}
