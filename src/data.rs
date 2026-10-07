//! Chart data and option values: [`Datum`], [`Series`], [`Point`],
//! [`Color`], [`Format`], [`Curve`], [`Scale`].
//!
//! Data serializes to the JSON that `parse.js` reads. A non-finite number
//! serializes as `null`. The runtime shows `null` as a gap.

use serde::ser::{Serialize, SerializeSeq, SerializeStruct, Serializer};

/// One labelled value. Bar and pie charts use it.
///
/// ```rust
/// use autumn_plugin_d3::Datum;
///
/// let d = Datum::new("Apples", 3.0);
/// assert_eq!(serde_json::to_string(&d).unwrap(), r#"{"label":"Apples","value":3.0}"#);
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Datum {
    label: String,
    value: f64,
}

impl Datum {
    /// Makes a datum. A non-finite `value` is a missing value.
    #[must_use]
    pub fn new(label: impl Into<String>, value: f64) -> Self {
        Self {
            label: label.into(),
            value,
        }
    }

    /// The label.
    #[must_use]
    pub fn label(&self) -> &str {
        &self.label
    }

    /// The value, or `None` when it is not finite.
    #[must_use]
    pub fn value(&self) -> Option<f64> {
        finite(self.value)
    }
}

impl<S: Into<String>> From<(S, f64)> for Datum {
    fn from((label, value): (S, f64)) -> Self {
        Self::new(label, value)
    }
}

impl Serialize for Datum {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Datum", 2)?;
        s.serialize_field("label", &self.label)?;
        s.serialize_field("value", &self.value())?;
        s.end()
    }
}

/// One (x, y) point. Line, area, and scatter charts use it.
///
/// With [`Scale::Time`], `x` is Unix time in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    /// The x value.
    pub x: f64,
    /// The y value.
    pub y: f64,
}

impl Point {
    /// Makes a point. A non-finite coordinate is a missing value.
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

impl From<(f64, f64)> for Point {
    fn from((x, y): (f64, f64)) -> Self {
        Self::new(x, y)
    }
}

impl Serialize for Point {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_seq(Some(2))?;
        s.serialize_element(&finite(self.x))?;
        s.serialize_element(&finite(self.y))?;
        s.end()
    }
}

/// A named list of points.
///
/// ```rust
/// use autumn_plugin_d3::Series;
///
/// let s = Series::new("Visits", [(1.0, 10.0), (2.0, f64::NAN)]);
/// assert_eq!(
///     serde_json::to_string(&s).unwrap(),
///     r#"{"name":"Visits","points":[[1.0,10.0],[2.0,null]]}"#
/// );
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    name: String,
    points: Vec<Point>,
}

impl Series {
    /// Makes a series.
    #[must_use]
    pub fn new<P: Into<Point>>(
        name: impl Into<String>,
        points: impl IntoIterator<Item = P>,
    ) -> Self {
        Self {
            name: name.into(),
            points: points.into_iter().map(Into::into).collect(),
        }
    }

    /// The series name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The points.
    #[must_use]
    pub fn points(&self) -> &[Point] {
        &self.points
    }
}

impl Serialize for Series {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Series", 2)?;
        s.serialize_field("name", &self.name)?;
        s.serialize_field("points", &self.points)?;
        s.end()
    }
}

/// An sRGB color.
///
/// ```rust
/// use autumn_plugin_d3::Color;
///
/// assert_eq!(Color::hex(0x2a78d6).to_string(), "#2a78d6");
/// assert_eq!(Color::rgb(255, 0, 16).to_string(), "#ff0010");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Color(u32);

impl Color {
    /// Makes a color from `0xRRGGBB`. The function ignores higher bits.
    #[must_use]
    pub const fn hex(rgb: u32) -> Self {
        Self(rgb & 0x00ff_ffff)
    }

    /// Makes a color from red, green, and blue channels.
    #[must_use]
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self(((r as u32) << 16) | ((g as u32) << 8) | b as u32)
    }
}

impl std::fmt::Display for Color {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "#{:06x}", self.0)
    }
}

/// A number format. It maps to a d3-format specifier.
///
/// ```rust
/// use autumn_plugin_d3::Format;
///
/// assert_eq!(Format::percent(1).spec(), ".1%");
/// assert_eq!(Format::currency(2).spec(), "$,.2f");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Format(String);

/// Most decimals a format keeps.
const MAX_DECIMALS: u8 = 12;

impl Format {
    /// Integer with group separators: `1,234`.
    #[must_use]
    pub fn integer() -> Self {
        Self(",.0f".into())
    }

    /// Fixed decimals with group separators: `1,234.50`.
    #[must_use]
    pub fn decimal(places: u8) -> Self {
        Self(format!(",.{}f", places.min(MAX_DECIMALS)))
    }

    /// Percent. The value `0.25` shows as `25%`.
    #[must_use]
    pub fn percent(places: u8) -> Self {
        Self(format!(".{}%", places.min(MAX_DECIMALS)))
    }

    /// SI prefix with significant digits: `1.2k`, `3.4M`.
    #[must_use]
    pub fn si(digits: u8) -> Self {
        Self(format!(".{}~s", digits.clamp(1, 21)))
    }

    /// Dollar currency: `$1,234.50`.
    #[must_use]
    pub fn currency(places: u8) -> Self {
        Self(format!("$,.{}f", places.min(MAX_DECIMALS)))
    }

    /// A raw d3-format specifier. The runtime ignores a bad specifier and
    /// uses the default format.
    #[must_use]
    pub fn d3(spec: impl Into<String>) -> Self {
        Self(spec.into())
    }

    /// The d3-format specifier.
    #[must_use]
    pub fn spec(&self) -> &str {
        &self.0
    }
}

/// Line and area interpolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum Curve {
    /// Straight segments (default).
    #[default]
    Linear,
    /// Smooth, and keeps monotonic data monotonic.
    Monotone,
    /// Steps at the midpoint between points.
    Step,
    /// Natural cubic spline.
    Natural,
}

impl Curve {
    /// The attribute value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Monotone => "monotone",
            Self::Step => "step",
            Self::Natural => "natural",
        }
    }
}

/// A continuous scale type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum Scale {
    /// Linear (default).
    #[default]
    Linear,
    /// UTC time. Values are Unix time in milliseconds.
    Time,
    /// Base-10 log. The runtime drops values that are not positive.
    Log,
}

impl Scale {
    /// The attribute value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Time => "time",
            Self::Log => "log",
        }
    }
}

/// Returns `Some(v)` when `v` is finite.
pub(crate) fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// Formats a number for the fallback table. Missing values show as `—`.
pub(crate) fn cell(v: f64) -> String {
    finite(v).map_or_else(|| "—".to_owned(), |v| v.to_string())
}

/// Formats Unix milliseconds as a UTC ISO 8601 string for the fallback
/// table. A midnight time shows the date only. Missing values show as `—`.
pub(crate) fn utc(ms: f64) -> String {
    // The range of JavaScript dates: ±8.64e15 ms.
    const MAX_MS: f64 = 8.64e15;
    if !ms.is_finite() || ms.abs() > MAX_MS {
        return cell(f64::NAN);
    }
    #[allow(clippy::cast_possible_truncation)] // In range: |ms| ≤ 8.64e15.
    let ms = ms.floor() as i64;
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let date = format!("{year:04}-{month:02}-{day:02}");
    if rest == 0 {
        return date;
    }
    let (hour, minute, second, milli) = (
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    );
    let time = format!("{date}T{hour:02}:{minute:02}:{second:02}");
    if milli == 0 {
        format!("{time}Z")
    } else {
        format!("{time}.{milli:03}Z")
    }
}

/// Converts days since 1970-01-01 to a proleptic Gregorian (year, month,
/// day). Algorithm: Howard Hinnant, `civil_from_days`.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn json<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).expect("serializes")
    }

    #[test]
    fn non_finite_values_serialize_as_null() {
        assert_eq!(
            json(&Datum::new("a", f64::INFINITY)),
            r#"{"label":"a","value":null}"#
        );
        assert_eq!(json(&Point::new(f64::NAN, 1.0)), "[null,1.0]");
        assert_eq!(Datum::new("a", f64::NAN).value(), None);
        assert_eq!(Datum::new("a", 2.0).value(), Some(2.0));
    }

    #[test]
    fn labels_escape_as_json_strings() {
        assert_eq!(
            json(&Datum::new("\"<b>\"\n", 1.0)),
            r#"{"label":"\"<b>\"\n","value":1.0}"#
        );
    }

    #[test]
    fn tuples_convert() {
        let d: Datum = ("x", 1.5).into();
        assert_eq!(d.label(), "x");
        let s = Series::new(String::from("s"), [Point::new(1.0, 2.0)]);
        assert_eq!(s.name(), "s");
        assert_eq!(s.points(), [Point::new(1.0, 2.0)]);
    }

    #[test]
    fn colors_render_as_lowercase_hex() {
        assert_eq!(Color::hex(0x00ab_cdef).to_string(), "#abcdef");
        assert_eq!(Color::hex(0xff00_0000).to_string(), "#000000");
        assert_eq!(Color::rgb(1, 2, 3).to_string(), "#010203");
    }

    #[test]
    fn formats_map_to_d3_specifiers() {
        assert_eq!(Format::integer().spec(), ",.0f");
        assert_eq!(Format::decimal(2).spec(), ",.2f");
        assert_eq!(Format::decimal(99).spec(), ",.12f");
        assert_eq!(Format::percent(0).spec(), ".0%");
        assert_eq!(Format::si(0).spec(), ".1~s");
        assert_eq!(Format::si(3).spec(), ".3~s");
        assert_eq!(Format::currency(0).spec(), "$,.0f");
        assert_eq!(Format::d3("+.2e").spec(), "+.2e");
    }

    #[test]
    fn enums_map_to_attribute_values() {
        let curves = [Curve::Linear, Curve::Monotone, Curve::Step, Curve::Natural];
        let names: Vec<_> = curves.iter().map(|c| c.as_str()).collect();
        assert_eq!(names, ["linear", "monotone", "step", "natural"]);
        let scales = [Scale::Linear, Scale::Time, Scale::Log];
        let names: Vec<_> = scales.iter().map(|s| s.as_str()).collect();
        assert_eq!(names, ["linear", "time", "log"]);
        assert_eq!(Curve::default(), Curve::Linear);
        assert_eq!(Scale::default(), Scale::Linear);
    }

    #[test]
    fn utc_formats_dates_and_times() {
        assert_eq!(utc(0.0), "1970-01-01");
        assert_eq!(utc(951_782_400_000.0), "2000-02-29");
        assert_eq!(utc(1_767_225_600_000.0), "2026-01-01");
        assert_eq!(
            utc(1_767_225_600_000.0 + 3_723_000.0),
            "2026-01-01T01:02:03Z"
        );
        assert_eq!(
            utc(1_767_225_600_000.0 + 3_723_004.0),
            "2026-01-01T01:02:03.004Z"
        );
        assert_eq!(utc(-86_400_000.0), "1969-12-31");
        assert_eq!(utc(-1.0), "1969-12-31T23:59:59.999Z");
        assert_eq!(utc(f64::NAN), "—");
        assert_eq!(utc(9e15), "—");
    }

    #[test]
    fn cells_show_missing_values_as_a_dash() {
        assert_eq!(cell(1.5), "1.5");
        assert_eq!(cell(f64::NEG_INFINITY), "—");
    }

    proptest! {
        /// Serialized data is valid JSON. A value is `null` exactly when it
        /// is not finite.
        #[test]
        fn json_is_always_valid(label in ".*", v in any::<f64>(), x in any::<f64>(), y in any::<f64>()) {
            let text = json(&(Datum::new(label.clone(), v), Series::new("s", [(x, y)])));
            let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
            prop_assert_eq!(parsed[0]["label"].as_str(), Some(label.as_str()));
            for (got, want) in [
                (&parsed[0]["value"], v),
                (&parsed[1]["points"][0][0], x),
                (&parsed[1]["points"][0][1], y),
            ] {
                prop_assert_eq!(got.is_null(), !want.is_finite(), "{}", text);
                prop_assert_eq!(got.is_f64(), want.is_finite(), "{}", text);
            }
        }

        /// Day arithmetic round-trips: consecutive days give consecutive dates.
        #[test]
        fn civil_dates_are_consecutive(days in -3_000_000i64..3_000_000) {
            let (y0, m0, d0) = civil_from_days(days);
            let (y1, m1, d1) = civil_from_days(days + 1);
            let next_day = y1 == y0 && m1 == m0 && d1 == d0 + 1;
            let next_month = y1 == y0 && m1 == m0 + 1 && d1 == 1;
            let next_year = y1 == y0 + 1 && m0 == 12 && d0 == 31 && m1 == 1 && d1 == 1;
            prop_assert!(next_day || next_month || next_year, "{:?} {:?}", (y0, m0, d0), (y1, m1, d1));
            prop_assert!((1..=12).contains(&m0) && (1..=31).contains(&d0));
        }
    }
}
