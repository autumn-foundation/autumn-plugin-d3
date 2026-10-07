//! D3.js charts for Autumn.

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
