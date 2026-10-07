//! The typed chart builder: [`Chart`].
//!
//! A chart renders one `<figure data-d3="KIND">` element. The builder writes
//! `data-d3-*` attributes. `init.js` reads them and draws an SVG. The
//! figure also holds a data table, so the data is readable without
//! JavaScript and by screen readers.
//!
//! The type parameter is the chart kind. Kind-specific options only
//! compile on their kinds:
//!
//! ```compile_fail
//! use autumn_plugin_d3::Chart;
//!
//! // `donut` is a pie option. A bar chart does not have it.
//! let _ = Chart::bar([("a", 1.0)]).donut(0.5);
//! ```

use std::borrow::Cow;
use std::marker::PhantomData;
use std::time::Duration;

use autumn_web::{Markup, html};
use maud::Render;
use serde::Serialize;

use crate::data::{Color, Curve, Datum, Format, Scale, Series, cell, finite, utc};
use crate::error::Error;

/// Every attribute the builder can emit. `parse.js` must know each one.
#[cfg(test)]
const ATTRIBUTES: &[&str] = &[
    attr::KIND,
    attr::DATA,
    attr::SRC,
    attr::REFRESH,
    attr::LABEL,
    attr::X_LABEL,
    attr::Y_LABEL,
    attr::FORMAT,
    attr::X_FORMAT,
    attr::COLORS,
    attr::ASPECT,
    attr::DURATION,
    attr::REDUCED,
    attr::LEGEND,
    attr::X_SCALE,
    attr::Y_SCALE,
    attr::CURVE,
    attr::HORIZONTAL,
    attr::INNER,
    attr::DOTS,
    attr::RADIUS,
    attr::Y_MIN,
    attr::Y_MAX,
];

/// Attribute names.
mod attr {
    #[cfg(test)]
    pub const KIND: &str = "data-d3";
    #[cfg(test)]
    pub const DATA: &str = "data-d3-data";
    pub const SRC: &str = "data-d3-src";
    pub const REFRESH: &str = "data-d3-refresh";
    pub const LABEL: &str = "data-d3-label";
    pub const X_LABEL: &str = "data-d3-x-label";
    pub const Y_LABEL: &str = "data-d3-y-label";
    pub const FORMAT: &str = "data-d3-format";
    pub const X_FORMAT: &str = "data-d3-x-format";
    pub const COLORS: &str = "data-d3-colors";
    pub const ASPECT: &str = "data-d3-aspect";
    pub const DURATION: &str = "data-d3-duration";
    pub const REDUCED: &str = "data-d3-reduced";
    pub const LEGEND: &str = "data-d3-legend";
    pub const X_SCALE: &str = "data-d3-x-scale";
    pub const Y_SCALE: &str = "data-d3-y-scale";
    pub const CURVE: &str = "data-d3-curve";
    pub const HORIZONTAL: &str = "data-d3-horizontal";
    pub const INNER: &str = "data-d3-inner";
    pub const DOTS: &str = "data-d3-dots";
    pub const RADIUS: &str = "data-d3-radius";
    pub const Y_MIN: &str = "data-d3-y-min";
    pub const Y_MAX: &str = "data-d3-y-max";
}

/// Built-in kind names. A custom kind must not use them.
pub(crate) const BUILT_IN: [&str; 5] = ["bar", "line", "area", "scatter", "pie"];

/// Limits. `parse.js` uses the same limits.
const ASPECT_RANGE: (f64, f64) = (0.2, 10.0);
const MAX_DURATION_MS: u128 = 10_000;
const MIN_REFRESH_MS: u128 = 1_000;
const MAX_REFRESH_MS: u128 = 86_400_000;
const MAX_INNER: f64 = 0.95;
const RADIUS_RANGE: (f64, f64) = (1.0, 50.0);
const MAX_COLORS: usize = 16;
const MAX_KIND_LEN: usize = 64;

mod sealed {
    pub trait Sealed {}
}

/// A chart kind. The crate defines all kinds.
pub trait Kind: sealed::Sealed {}
/// Kinds with x and y axes: bar, line, area, scatter, custom.
pub trait Axes: Kind {}
/// Kinds with a continuous x axis: line, area, scatter, custom.
pub trait Xy: Axes {}
/// Kinds with a curve: line, area, custom.
pub trait Curved: Xy {}
/// Built-in kinds. They have a fixed name.
pub trait BuiltIn: Kind {
    /// The `data-d3` value.
    const NAME: &'static str;
}

macro_rules! kind {
    ($(#[$doc:meta] $ty:ident = $name:literal: $($tr:ident),*;)*) => {$(
        #[$doc]
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $ty;
        impl sealed::Sealed for $ty {}
        impl Kind for $ty {}
        impl BuiltIn for $ty {
            const NAME: &'static str = $name;
        }
        $(impl $tr for $ty {})*
    )*};
}

kind! {
    /// Bar chart kind.
    Bar = "bar": Axes;
    /// Line chart kind.
    Line = "line": Axes, Xy, Curved;
    /// Area chart kind.
    Area = "area": Axes, Xy, Curved;
    /// Scatter chart kind.
    Scatter = "scatter": Axes, Xy;
    /// Pie and donut chart kind.
    Pie = "pie":;
}

/// Custom chart kind. Register the draw function in JavaScript with
/// `AutumnD3.register(name, draw)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Custom;
impl sealed::Sealed for Custom {}
impl Kind for Custom {}
impl Axes for Custom {}
impl Xy for Custom {}
impl Curved for Custom {}

/// Chart data.
#[derive(Debug, Clone, PartialEq)]
enum Payload {
    /// No inline data (`data-d3-src` gives it).
    Empty,
    /// Bar and pie data.
    Categories(Vec<Datum>),
    /// Line, area, and scatter data.
    Series(Vec<Series>),
    /// Custom data, as JSON.
    Json(String),
}

/// A D3 chart. Render it in a Maud template.
///
/// ```rust
/// use autumn_plugin_d3::{Chart, Format};
///
/// let chart = Chart::bar([("Apples", 3.0), ("Pears", 5.0)])
///     .label("Fruit sold")
///     .y_label("Units")
///     .format(&Format::integer());
/// let html = autumn_web::html! { (chart) }.into_string();
/// assert!(html.contains(r#"data-d3="bar""#), "{html}");
/// assert!(html.contains("<table"), "fallback table: {html}");
/// ```
#[derive(Debug, Clone, PartialEq)]
#[must_use]
pub struct Chart<K: Kind> {
    kind: Cow<'static, str>,
    payload: Payload,
    attrs: Vec<(&'static str, String)>,
    id: Option<String>,
    class: Option<String>,
    caption: Option<String>,
    table: bool,
    _kind: PhantomData<K>,
}

impl<K: Kind> Chart<K> {
    const fn with(kind: Cow<'static, str>, payload: Payload) -> Self {
        Self {
            kind,
            payload,
            attrs: Vec::new(),
            id: None,
            class: None,
            caption: None,
            table: true,
            _kind: PhantomData,
        }
    }

    /// Sets an attribute. A later call replaces an earlier one.
    fn set(mut self, name: &'static str, value: impl Into<String>) -> Self {
        let value = value.into();
        match self.attrs.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = value,
            None => self.attrs.push((name, value)),
        }
        self
    }

    /// Sets a number attribute. A non-finite value removes it.
    fn set_number(self, name: &'static str, value: f64) -> Self {
        match finite(value) {
            Some(v) => self.set(name, v.to_string()),
            None => self.unset(name),
        }
    }

    fn unset(mut self, name: &'static str) -> Self {
        self.attrs.retain(|(n, _)| *n != name);
        self
    }

    /// The value of an emitted attribute (for tests and custom code).
    #[must_use]
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    /// The `data-d3` kind name.
    #[must_use]
    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// Sets the element `id`.
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// Adds CSS classes to the figure, after `d3-chart`.
    pub fn class(mut self, class: impl Into<String>) -> Self {
        self.class = Some(class.into());
        self
    }

    /// Sets the accessible name of the chart. It is also the table caption.
    pub fn label(self, label: impl Into<String>) -> Self {
        self.set(attr::LABEL, label)
    }

    /// Adds a visible `<figcaption>`.
    pub fn caption(mut self, caption: impl Into<String>) -> Self {
        self.caption = Some(caption.into());
        self
    }

    /// Sets the value format (axis ticks, tooltips, labels).
    pub fn format(self, format: &Format) -> Self {
        self.set(attr::FORMAT, format.spec())
    }

    /// Sets the series colors, in order. They replace the palette. At most
    /// 16 colors are used.
    pub fn colors(self, colors: impl IntoIterator<Item = Color>) -> Self {
        let list: Vec<String> = colors
            .into_iter()
            .take(MAX_COLORS)
            .map(|c| c.to_string())
            .collect();
        if list.is_empty() {
            return self.unset(attr::COLORS);
        }
        self.set(attr::COLORS, list.join(" "))
    }

    /// Sets the plot width / height ratio. The value is clamped to
    /// `0.2..=10`. The default is 16 / 9 (from `d3.css`).
    pub fn aspect(self, ratio: f64) -> Self {
        self.set_number(attr::ASPECT, ratio.clamp(ASPECT_RANGE.0, ASPECT_RANGE.1))
    }

    /// Sets the transition time. Zero turns transitions off. At most 10 s.
    pub fn duration(self, duration: Duration) -> Self {
        let ms = duration.as_millis().min(MAX_DURATION_MS);
        self.set(attr::DURATION, ms.to_string())
    }

    /// Animates also for users who ask for reduced motion.
    pub fn animate_reduced_motion(self) -> Self {
        self.set(attr::REDUCED, "animate")
    }

    /// Shows or hides the legend. The default shows it for two or more
    /// series, and for pie charts.
    pub fn legend(self, show: bool) -> Self {
        self.set(attr::LEGEND, if show { "true" } else { "false" })
    }

    /// Loads the data from a same-origin JSON URL. The JSON has the same
    /// shape as the inline data. Inline data, if any, shows first.
    pub fn src(self, url: impl Into<String>) -> Self {
        self.set(attr::SRC, url)
    }

    /// Loads [`src`](Self::src) again at this interval. The interval is
    /// clamped to 1 s ..= 24 h. Without `src`, the runtime ignores it.
    pub fn refresh(self, every: Duration) -> Self {
        let ms = every.as_millis().clamp(MIN_REFRESH_MS, MAX_REFRESH_MS);
        self.set(attr::REFRESH, ms.to_string())
    }

    /// Includes the fallback data table (default `true`).
    pub const fn table(mut self, show: bool) -> Self {
        self.table = show;
        self
    }

    /// The JSON for `data-d3-data`, if any.
    fn data_json(&self) -> Option<String> {
        match &self.payload {
            Payload::Empty => None,
            Payload::Categories(data) => serde_json::to_string(data).ok(),
            Payload::Series(data) => serde_json::to_string(data).ok(),
            Payload::Json(json) => Some(json.clone()),
        }
    }

    /// The fallback table.
    fn table_markup(&self) -> Markup {
        let caption = self.attribute(attr::LABEL);
        let x_head = self.attribute(attr::X_LABEL);
        let y_head = self.attribute(attr::Y_LABEL).unwrap_or("Value");
        let time = self.attribute(attr::X_SCALE) == Some(Scale::Time.as_str());
        html! {
            table class="d3-table" {
                @if let Some(caption) = caption { caption { (caption) } }
                @match &self.payload {
                    Payload::Categories(data) => {
                        thead { tr { th scope="col" { (x_head.unwrap_or("Label")) } th scope="col" { (y_head) } } }
                        tbody {
                            @for d in data {
                                tr { th scope="row" { (d.label()) } td { (cell(d.value().unwrap_or(f64::NAN))) } }
                            }
                        }
                    }
                    Payload::Series(data) => {
                        thead { tr { th scope="col" { "Series" } th scope="col" { (x_head.unwrap_or("x")) } th scope="col" { (y_head) } } }
                        tbody {
                            @for s in data {
                                @for p in s.points() {
                                    tr {
                                        th scope="row" { (s.name()) }
                                        td { @if time { (utc(p.x)) } @else { (cell(p.x)) } }
                                        td { (cell(p.y)) }
                                    }
                                }
                            }
                        }
                    }
                    Payload::Empty | Payload::Json(_) => {}
                }
            }
        }
    }
}

impl<K: BuiltIn> Chart<K> {
    /// Makes a chart with no inline data. It loads the data from `url`.
    ///
    /// ```rust
    /// use autumn_plugin_d3::{Bar, Chart};
    ///
    /// let chart = Chart::<Bar>::from_src("/api/sales.json");
    /// assert_eq!(chart.attribute("data-d3-src"), Some("/api/sales.json"));
    /// ```
    pub fn from_src(url: impl Into<String>) -> Self {
        Self::with(Cow::Borrowed(K::NAME), Payload::Empty).src(url)
    }
}

impl<K: Axes> Chart<K> {
    /// Sets the x axis title.
    pub fn x_label(self, label: impl Into<String>) -> Self {
        self.set(attr::X_LABEL, label)
    }

    /// Sets the y axis (value axis) title.
    pub fn y_label(self, label: impl Into<String>) -> Self {
        self.set(attr::Y_LABEL, label)
    }

    /// Sets the lower end of the value axis. The data can extend it.
    pub fn y_min(self, min: f64) -> Self {
        self.set_number(attr::Y_MIN, min)
    }

    /// Sets the upper end of the value axis. The data can extend it.
    pub fn y_max(self, max: f64) -> Self {
        self.set_number(attr::Y_MAX, max)
    }
}

impl<K: Xy> Chart<K> {
    /// Sets the x scale type. With [`Scale::Time`], x is Unix milliseconds.
    pub fn x_scale(self, scale: Scale) -> Self {
        self.set(attr::X_SCALE, scale.as_str())
    }

    /// Sets the y scale type. [`Scale::Time`] is not a y scale; it means
    /// [`Scale::Linear`].
    pub fn y_scale(self, scale: Scale) -> Self {
        let scale = if scale == Scale::Time {
            Scale::Linear
        } else {
            scale
        };
        self.set(attr::Y_SCALE, scale.as_str())
    }

    /// Sets the x tick format. Time scales ignore it.
    pub fn x_format(self, format: &Format) -> Self {
        self.set(attr::X_FORMAT, format.spec())
    }
}

impl<K: Curved> Chart<K> {
    /// Sets the line interpolation.
    pub fn curve(self, curve: Curve) -> Self {
        self.set(attr::CURVE, curve.as_str())
    }
}

impl Chart<Bar> {
    /// Makes a bar chart.
    pub fn bar<D: Into<Datum>>(data: impl IntoIterator<Item = D>) -> Self {
        let data = data.into_iter().map(Into::into).collect();
        Self::with(Cow::Borrowed(Bar::NAME), Payload::Categories(data))
    }

    /// Draws horizontal bars.
    pub fn horizontal(self) -> Self {
        self.set(attr::HORIZONTAL, "true")
    }
}

impl Chart<Pie> {
    /// Makes a pie chart.
    pub fn pie<D: Into<Datum>>(data: impl IntoIterator<Item = D>) -> Self {
        let data = data.into_iter().map(Into::into).collect();
        Self::with(Cow::Borrowed(Pie::NAME), Payload::Categories(data))
    }

    /// Makes a donut. `inner` is the hole radius as a fraction of the outer
    /// radius, clamped to `0..=0.95`.
    pub fn donut(self, inner: f64) -> Self {
        self.set_number(attr::INNER, inner.clamp(0.0, MAX_INNER))
    }
}

impl Chart<Line> {
    /// Makes a line chart.
    pub fn line(series: impl IntoIterator<Item = Series>) -> Self {
        Self::with(
            Cow::Borrowed(Line::NAME),
            Payload::Series(series.into_iter().collect()),
        )
    }

    /// Draws a dot on each point.
    pub fn dots(self) -> Self {
        self.set(attr::DOTS, "true")
    }
}

impl Chart<Area> {
    /// Makes an area chart. Each series fills down to zero (or to the
    /// lower end of the value axis).
    pub fn area(series: impl IntoIterator<Item = Series>) -> Self {
        Self::with(
            Cow::Borrowed(Area::NAME),
            Payload::Series(series.into_iter().collect()),
        )
    }
}

impl Chart<Scatter> {
    /// Makes a scatter chart.
    pub fn scatter(series: impl IntoIterator<Item = Series>) -> Self {
        Self::with(
            Cow::Borrowed(Scatter::NAME),
            Payload::Series(series.into_iter().collect()),
        )
    }

    /// Sets the dot radius in pixels, clamped to `1..=50`. Default 4.
    pub fn radius(self, px: f64) -> Self {
        self.set_number(attr::RADIUS, px.clamp(RADIUS_RANGE.0, RADIUS_RANGE.1))
    }
}

impl Chart<Custom> {
    /// Makes a custom chart. `name` is the kind name that
    /// `AutumnD3.register` uses in JavaScript.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidKind`] when `name` is not 1–64 characters of `a-z`,
    /// `0-9`, and `-`, starting with a letter, or when it is a built-in
    /// kind name.
    ///
    /// ```rust
    /// use autumn_plugin_d3::Chart;
    ///
    /// let chart = Chart::custom("network").unwrap().json(&[1, 2, 3]).unwrap();
    /// assert_eq!(chart.attribute("data-d3-data"), None);
    /// assert!(Chart::custom("Bad Name").is_err());
    /// ```
    pub fn custom(name: impl Into<String>) -> Result<Self, Error> {
        let name = name.into();
        let valid = !name.is_empty()
            && name.len() <= MAX_KIND_LEN
            && name.starts_with(|c: char| c.is_ascii_lowercase())
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !BUILT_IN.contains(&name.as_str());
        if !valid {
            return Err(Error::InvalidKind(name));
        }
        Ok(Self::with(Cow::Owned(name), Payload::Empty))
    }

    /// Sets the inline data from any serializable value.
    ///
    /// # Errors
    ///
    /// [`Error::Json`] when the value does not serialize (for example, a
    /// map with non-string keys).
    pub fn json<T: Serialize + ?Sized>(mut self, data: &T) -> Result<Self, Error> {
        self.payload = Payload::Json(serde_json::to_string(data)?);
        Ok(self)
    }
}

impl<K: Kind> Render for Chart<K> {
    fn render(&self) -> Markup {
        let class = self
            .class
            .as_ref()
            .map_or_else(|| "d3-chart".to_owned(), |c| format!("d3-chart {c}"));
        let a = |name| self.attribute(name);
        html! {
            figure class=(class) id=[self.id.as_deref()] data-d3=(self.kind)
                data-d3-data=[self.data_json()]
                data-d3-src=[a(attr::SRC)] data-d3-refresh=[a(attr::REFRESH)]
                data-d3-label=[a(attr::LABEL)]
                data-d3-x-label=[a(attr::X_LABEL)] data-d3-y-label=[a(attr::Y_LABEL)]
                data-d3-format=[a(attr::FORMAT)] data-d3-x-format=[a(attr::X_FORMAT)]
                data-d3-colors=[a(attr::COLORS)] data-d3-aspect=[a(attr::ASPECT)]
                data-d3-duration=[a(attr::DURATION)] data-d3-reduced=[a(attr::REDUCED)]
                data-d3-legend=[a(attr::LEGEND)]
                data-d3-x-scale=[a(attr::X_SCALE)] data-d3-y-scale=[a(attr::Y_SCALE)]
                data-d3-curve=[a(attr::CURVE)] data-d3-horizontal=[a(attr::HORIZONTAL)]
                data-d3-inner=[a(attr::INNER)] data-d3-dots=[a(attr::DOTS)]
                data-d3-radius=[a(attr::RADIUS)]
                data-d3-y-min=[a(attr::Y_MIN)] data-d3-y-max=[a(attr::Y_MAX)] {
                @if let Some(caption) = &self.caption {
                    figcaption class="d3-caption" { (caption) }
                }
                @if self.table { (self.table_markup()) }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Point;
    use proptest::prelude::*;

    fn render<K: Kind>(chart: &Chart<K>) -> String {
        chart.render().into_string()
    }

    /// The parsed `data-d3-data` JSON.
    fn data<K: Kind>(chart: &Chart<K>) -> serde_json::Value {
        let json = chart.data_json().expect("inline data");
        serde_json::from_str(&json).expect("valid JSON")
    }

    #[test]
    fn bar_chart_renders_a_figure_with_kind_data_and_table() {
        let chart = Chart::bar([("Apples", 3.0), ("Pears", 5.5)])
            .id("fruit")
            .label("Fruit");
        let html = render(&chart);
        assert!(
            html.starts_with(r#"<figure class="d3-chart" id="fruit" data-d3="bar""#),
            "{html}"
        );
        assert!(
            html.contains(r#"data-d3-data="[{&quot;label&quot;:&quot;Apples&quot;,&quot;value&quot;:3.0},{&quot;label&quot;:&quot;Pears&quot;,&quot;value&quot;:5.5}]""#),
            "{html}"
        );
        assert!(html.contains(r#"data-d3-label="Fruit""#), "{html}");
        assert!(html.contains("<caption>Fruit</caption>"), "{html}");
        assert!(
            html.contains(r#"<th scope="row">Apples</th><td>3</td>"#),
            "{html}"
        );
        assert!(
            html.contains(r#"<th scope="col">Label</th><th scope="col">Value</th>"#),
            "{html}"
        );
    }

    #[test]
    fn attributes_follow_the_builder_calls() {
        let chart = Chart::bar([("a", 1.0)])
            .x_label("Fruit")
            .y_label("Kg")
            .format(&Format::decimal(1))
            .colors([Color::hex(0x00ff_0000), Color::hex(0x0000_ff00)])
            .aspect(2.0)
            .duration(Duration::from_millis(250))
            .animate_reduced_motion()
            .legend(false)
            .y_min(0.0)
            .y_max(10.0)
            .horizontal()
            .class("wide");
        let html = render(&chart);
        for (name, value) in [
            ("data-d3-x-label", "Fruit"),
            ("data-d3-y-label", "Kg"),
            ("data-d3-format", ",.1f"),
            ("data-d3-colors", "#ff0000 #00ff00"),
            ("data-d3-aspect", "2"),
            ("data-d3-duration", "250"),
            ("data-d3-reduced", "animate"),
            ("data-d3-legend", "false"),
            ("data-d3-y-min", "0"),
            ("data-d3-y-max", "10"),
            ("data-d3-horizontal", "true"),
        ] {
            assert_eq!(chart.attribute(name), Some(value), "{name}");
            assert!(
                html.contains(&format!(r#"{name}="{value}""#)),
                "{name}: {html}"
            );
        }
        assert!(
            html.starts_with(r#"<figure class="d3-chart wide""#),
            "{html}"
        );
        assert!(
            html.contains(r#"<th scope="col">Fruit</th><th scope="col">Kg</th>"#),
            "{html}"
        );
    }

    #[test]
    fn later_calls_replace_earlier_ones() {
        let chart = Chart::bar([("a", 1.0)]).label("one").label("two");
        assert_eq!(chart.attribute("data-d3-label"), Some("two"));
        assert_eq!(render(&chart).matches("data-d3-label").count(), 1);
        let chart = chart.colors([]);
        assert_eq!(chart.attribute("data-d3-colors"), None);
    }

    #[test]
    fn numbers_are_clamped() {
        let chart = Chart::pie([("a", 1.0)]).donut(2.0).aspect(100.0);
        assert_eq!(chart.attribute("data-d3-inner"), Some("0.95"));
        assert_eq!(chart.attribute("data-d3-aspect"), Some("10"));
        let chart = Chart::pie([("a", 1.0)]).donut(-1.0).aspect(0.0);
        assert_eq!(chart.attribute("data-d3-inner"), Some("0"));
        assert_eq!(chart.attribute("data-d3-aspect"), Some("0.2"));
        let chart = Chart::scatter([]).radius(0.0);
        assert_eq!(chart.attribute("data-d3-radius"), Some("1"));
        let chart = Chart::scatter([]).radius(99.0);
        assert_eq!(chart.attribute("data-d3-radius"), Some("50"));
        let chart = Chart::bar([("a", 1.0)])
            .duration(Duration::from_secs(60))
            .src("/d")
            .refresh(Duration::from_millis(10));
        assert_eq!(chart.attribute("data-d3-duration"), Some("10000"));
        assert_eq!(chart.attribute("data-d3-refresh"), Some("1000"));
        let chart = chart.refresh(Duration::from_secs(1_000_000));
        assert_eq!(chart.attribute("data-d3-refresh"), Some("86400000"));
    }

    #[test]
    fn non_finite_options_are_dropped() {
        let chart = Chart::bar([("a", 1.0)])
            .y_min(1.0)
            .y_min(f64::NAN)
            .y_max(f64::INFINITY);
        assert_eq!(chart.attribute("data-d3-y-min"), None);
        assert_eq!(chart.attribute("data-d3-y-max"), None);
        let chart = Chart::pie([("a", 1.0)]).donut(f64::NAN).aspect(f64::NAN);
        assert_eq!(chart.attribute("data-d3-inner"), None);
        assert_eq!(chart.attribute("data-d3-aspect"), None);
        let chart = Chart::scatter([]).radius(f64::NAN);
        assert_eq!(chart.attribute("data-d3-radius"), None);
    }

    #[test]
    fn xy_charts_take_series() {
        let series = [
            Series::new("a", [(1.0, 2.0), (2.0, f64::NAN)]),
            Series::new("b", [Point::new(1.0, 3.0)]),
        ];
        let chart = Chart::line(series.clone())
            .curve(Curve::Monotone)
            .x_scale(Scale::Log)
            .y_scale(Scale::Log)
            .x_format(&Format::si(2))
            .dots();
        assert_eq!(chart.kind(), "line");
        assert_eq!(
            data(&chart),
            serde_json::json!([
                {"name": "a", "points": [[1.0, 2.0], [2.0, null]]},
                {"name": "b", "points": [[1.0, 3.0]]}
            ])
        );
        for (name, value) in [
            ("data-d3-curve", "monotone"),
            ("data-d3-x-scale", "log"),
            ("data-d3-y-scale", "log"),
            ("data-d3-x-format", ".2~s"),
            ("data-d3-dots", "true"),
        ] {
            assert_eq!(chart.attribute(name), Some(value), "{name}");
        }
        let html = render(&chart);
        assert!(
            html.contains(
                r#"<th scope="col">Series</th><th scope="col">x</th><th scope="col">Value</th>"#
            ),
            "{html}"
        );
        assert!(
            html.contains(r#"<th scope="row">a</th><td>2</td><td>—</td>"#),
            "{html}"
        );
        assert_eq!(Chart::area(series.clone()).kind(), "area");
        assert_eq!(Chart::scatter(series).kind(), "scatter");
    }

    #[test]
    fn time_scale_is_not_a_y_scale() {
        let chart = Chart::line([]).y_scale(Scale::Time);
        assert_eq!(chart.attribute("data-d3-y-scale"), Some("linear"));
    }

    #[test]
    fn time_x_values_show_as_dates_in_the_table() {
        let chart =
            Chart::line([Series::new("s", [(1_767_225_600_000.0, 1.0)])]).x_scale(Scale::Time);
        let html = render(&chart);
        assert!(html.contains("<td>2026-01-01</td><td>1</td>"), "{html}");
    }

    #[test]
    fn markup_escapes_text() {
        let chart = Chart::bar([("<script>", 1.0)]).label("a\"b").caption("<i>");
        let html = render(&chart);
        assert!(!html.contains("<script>"), "{html}");
        assert!(!html.contains("<i>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(html.contains(r#"data-d3-label="a&quot;b""#), "{html}");
    }

    #[test]
    fn caption_renders_a_figcaption() {
        let html = render(&Chart::pie([("a", 1.0)]).caption("Share"));
        assert!(
            html.contains(r#"<figcaption class="d3-caption">Share</figcaption>"#),
            "{html}"
        );
    }

    #[test]
    fn table_can_be_left_out() {
        let html = render(&Chart::bar([("a", 1.0)]).table(false));
        assert!(!html.contains("<table"), "{html}");
    }

    #[test]
    fn from_src_has_no_inline_data() {
        let chart = Chart::<Line>::from_src("/api/x").refresh(Duration::from_secs(5));
        let html = render(&chart);
        assert!(html.contains(r#"data-d3="line""#), "{html}");
        assert!(html.contains(r#"data-d3-src="/api/x""#), "{html}");
        assert!(html.contains(r#"data-d3-refresh="5000""#), "{html}");
        assert!(!html.contains("data-d3-data"), "{html}");
        assert!(!html.contains("<tbody"), "empty table: {html}");
    }

    #[test]
    fn custom_charts_validate_the_kind_name() {
        for good in ["network", "a", "tree-map2"] {
            assert!(Chart::custom(good).is_ok(), "{good}");
        }
        let long = "a".repeat(65);
        for bad in ["", "Net", "1a", "a b", "a_b", "bar", "pie", long.as_str()] {
            assert!(
                matches!(Chart::custom(bad), Err(Error::InvalidKind(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn custom_charts_carry_json_and_xy_options() {
        let chart = Chart::custom("network")
            .expect("valid")
            .json(&serde_json::json!({"nodes": [1]}))
            .expect("serializes")
            .x_label("x")
            .curve(Curve::Step);
        let html = render(&chart);
        assert!(html.contains(r#"data-d3="network""#), "{html}");
        assert!(
            html.contains(r#"data-d3-data="{&quot;nodes&quot;:[1]}""#),
            "{html}"
        );
        assert!(html.contains(r#"data-d3-curve="step""#), "{html}");
        assert!(
            !html.contains("<tbody"),
            "custom data has no table rows: {html}"
        );
    }

    #[test]
    fn custom_json_errors_are_reported() {
        let mut map = std::collections::BTreeMap::new();
        map.insert((1, 2), 3);
        let error = Chart::custom("x")
            .expect("valid")
            .json(&map)
            .expect_err("bad keys");
        assert!(matches!(error, Error::Json(_)), "{error}");
    }

    #[test]
    fn every_listed_attribute_is_rendered() {
        for name in &ATTRIBUTES[2..] {
            let html = render(&Chart::<Bar>::from_src("/s").set(name, "v"));
            assert!(html.contains(&format!(r#" {name}="v""#)), "{name}: {html}");
        }
        assert_eq!(&ATTRIBUTES[..2], [attr::KIND, attr::DATA]);
    }

    #[test]
    fn every_emitted_attribute_is_known_to_the_runtime() {
        let parse = include_str!("../assets/parse.js");
        for name in ATTRIBUTES {
            assert!(
                parse.contains(&format!("\"{name}\"")),
                "parse.js lacks {name}"
            );
        }
        for kind in BUILT_IN {
            assert!(
                parse.contains(&format!("\"{kind}\"")),
                "parse.js lacks kind {kind}"
            );
        }
    }

    proptest! {
        /// No emitted number attribute is non-finite, whatever the input.
        #[test]
        fn number_attributes_are_always_finite(a in any::<f64>(), b in any::<f64>(), c in any::<f64>()) {
            let charts = [
                Chart::bar([("x", a)]).y_min(a).y_max(b).aspect(c).attrs,
                Chart::pie([("x", a)]).donut(b).attrs,
                Chart::scatter([Series::new("s", [(a, b)])]).radius(c).attrs,
            ];
            for attrs in charts {
                for (name, value) in attrs {
                    if let Ok(n) = value.parse::<f64>() {
                        prop_assert!(n.is_finite(), "{} = {}", name, value);
                    }
                }
            }
        }

        /// Inline data is always valid JSON, and labels round-trip.
        #[test]
        fn inline_data_is_valid_json(label in ".*", v in any::<f64>()) {
            let chart = Chart::bar([(label.clone(), v)]);
            let parsed = data(&chart);
            prop_assert_eq!(parsed[0]["label"].as_str(), Some(label.as_str()));
            prop_assert_eq!(parsed[0]["value"].is_null(), !v.is_finite());
        }
    }
}
