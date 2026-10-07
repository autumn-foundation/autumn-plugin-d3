//! This crate adds D3.js charts to Autumn apps. It works with Maud and
//! htmx.
//!
//! Add [`D3Plugin`] to the app. Put [`d3_stylesheet()`] and [`d3_script()`]
//! in the page `<head>`. Then render a [`Chart`]:
//!
//! ```rust,no_run
//! use autumn_plugin_d3::{Chart, D3Plugin, Format, Scale, Series, d3_script, d3_stylesheet};
//! use autumn_web::prelude::*;
//!
//! #[get("/")]
//! async fn index() -> Markup {
//!     html! {
//!         html {
//!             head { (d3_stylesheet()) (d3_script()) }
//!             body {
//!                 (Chart::bar([("Apples", 30.0), ("Pears", 60.0)])
//!                     .label("Fruit sold")
//!                     .format(&Format::integer()))
//!                 (Chart::line([Series::new("Visits", [(0.0, 3.0), (1.0, 5.0)])])
//!                     .label("Visits"))
//!             }
//!         }
//!     }
//! }
//!
//! # async fn run() {
//! autumn_web::app()
//!     .plugin(D3Plugin::new())
//!     .routes(routes![index])
//!     .run()
//!     .await;
//! # }
//! ```
//!
//! # How it works
//!
//! - The crate contains [D3](https://d3js.org) 7.9.0 (ISC). It does not use
//!   npm or a bundler. [`D3_ASSETS`] serves it under `/static/_plugins/d3/`
//!   at hashed URLs with SRI.
//! - The builder renders a `<figure data-d3="KIND">` with `data-d3-*`
//!   attributes and a data table. `init.js` reads the attributes and draws
//!   an SVG. You can also write the attributes by hand.
//! - Without JavaScript, the table shows. When the chart is ready, the table
//!   stays for screen readers only.
//! - `init.js` starts charts on load, after htmx swaps, and on each DOM
//!   insertion. It redraws on resize and on attribute changes. It frees a
//!   chart when its element leaves the document.
//! - Your own scripts get `window.d3`, the `d3:ready` event, the
//!   `el.autumnD3` handle, and `AutumnD3.register` for custom kinds.
//!
//! # Limits
//!
//! - Built-in kinds: bar, line, area, scatter, pie. Write other kinds in
//!   JavaScript with `AutumnD3.register`.
//! - The palette has 8 colors. More series repeat colors. Keep to 8 or
//!   fewer, or set [`Chart::colors`].
//! - Bars and areas do not stack. There is one value axis.
//! - `data-d3-src` loads same-origin URLs only.
//! - Do not let user content keep `data-d3-*` attributes. User markup could
//!   then start charts and load same-origin URLs.

mod assets;
mod chart;
mod data;
mod error;
mod plugin;
mod script;

pub use assets::{ASSETS_NAMESPACE, D3_ASSETS, D3_JS_INTEGRITY, D3_SOURCE, D3_VERSION};
pub use chart::{Area, Axes, Bar, BuiltIn, Chart, Curved, Custom, Kind, Line, Pie, Scatter, Xy};
pub use data::{Color, Curve, Datum, Format, Point, Scale, Series};
pub use error::Error;
pub use plugin::{D3Plugin, PLUGIN_NAME};
pub use script::{d3_script, d3_stylesheet};
