// autumn-plugin-d3 attribute parsers.
//
// Pure functions: no DOM, no D3. init.js uses them in the browser
// (`self.AutumnD3Parse`). tests/js/parse.test.mjs uses them in Node
// (CommonJS). Keep the limits in sync with src/chart.rs.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.AutumnD3Parse = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** Attribute names. The Rust builder emits the same names. */
  const ATTR = Object.freeze({
    kind: "data-d3",
    data: "data-d3-data",
    src: "data-d3-src",
    refresh: "data-d3-refresh",
    label: "data-d3-label",
    xLabel: "data-d3-x-label",
    yLabel: "data-d3-y-label",
    format: "data-d3-format",
    xFormat: "data-d3-x-format",
    colors: "data-d3-colors",
    aspect: "data-d3-aspect",
    duration: "data-d3-duration",
    reduced: "data-d3-reduced",
    legend: "data-d3-legend",
    xScale: "data-d3-x-scale",
    yScale: "data-d3-y-scale",
    curve: "data-d3-curve",
    horizontal: "data-d3-horizontal",
    inner: "data-d3-inner",
    dots: "data-d3-dots",
    radius: "data-d3-radius",
    yMin: "data-d3-y-min",
    yMax: "data-d3-y-max",
    state: "data-d3-state",
  });

  /** Built-in kinds and their data shapes. */
  const SHAPES = Object.freeze({ "bar": "categories", "line": "series", "area": "series", "scatter": "series", "pie": "categories" });
  const KINDS = Object.freeze(Object.keys(SHAPES));
  const KIND_NAME = /^[a-z][a-z0-9-]{0,63}$/;
  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const MAX_COLORS = 16;
  const SCALES = ["linear", "time", "log"];
  const Y_SCALES = ["linear", "log"];
  const CURVES = ["linear", "monotone", "step", "natural"];

  /** Returns `{ name, builtIn, shape }`, or null for a bad name. */
  function parseKind(value) {
    const name = String(value ?? "").trim();
    if (!KIND_NAME.test(name)) return null;
    const builtIn = Object.hasOwn(SHAPES, name);
    return { name, builtIn, shape: builtIn ? SHAPES[name] : "any" };
  }

  /** Returns `v` when it is a finite number, else null. */
  const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /**
   * Gives each item a unique `key`: its name, plus a counter for repeats
   * (`a`, `a\u00002`). Repeated labels then draw as separate marks.
   */
  function keyed(items, name) {
    const seen = new Map();
    for (const item of items) {
      const n = (seen.get(item[name]) ?? 0) + 1;
      seen.set(item[name], n);
      item.key = n === 1 ? item[name] : `${item[name]}\u0000${n}`;
    }
    return items;
  }

  /**
   * Bar and pie data: `[{ label, value }]` or `[[label, value]]`.
   * Returns `[{ label: string, value: number | null, key: string }]`.
   */
  function parseCategories(input) {
    if (!Array.isArray(input)) throw new Error("data must be an array");
    const out = input.map((item, i) => {
      const [label, value] = Array.isArray(item) ? item : item && typeof item === "object" ? [item.label, item.value] : [];
      if (!Array.isArray(item) && (item === null || typeof item !== "object")) throw new Error(`item ${i + 1} must be an object or a pair`);
      if (label === undefined || label === null) throw new Error(`item ${i + 1} has no label`);
      return { label: String(label), value: finite(value) };
    });
    return keyed(out, "label");
  }

  /** ISO 8601 date, with optional time and zone. */
  const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

  /**
   * An x value: a finite number, a numeric string, or an ISO 8601 date
   * string (Unix ms; no zone means UTC). Else null.
   */
  function parseX(x) {
    if (typeof x !== "string") return finite(x);
    const text = x.trim();
    if (text !== "" && Number.isFinite(Number(text))) return Number(text);
    const match = ISO_DATE.exec(text);
    if (!match) return null;
    const ms = Date.parse(match[2] && !match[3] ? `${text}Z` : text);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Line, area, and scatter data: `[{ name, points: [[x, y]] | [{ x, y }] }]`.
   * Points with no x are dropped. A null y is a gap. Points sort by x.
   * Returns `[{ name, points, key }]`.
   */
  function parseSeries(input) {
    if (!Array.isArray(input)) throw new Error("data must be an array");
    const out = input.map((s, i) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`series ${i + 1} must be an object`);
      if (!Array.isArray(s.points)) throw new Error(`series ${i + 1} points must be an array`);
      const points = [];
      s.points.forEach((p, j) => {
        const [x, y] = Array.isArray(p) ? p : p && typeof p === "object" ? [p.x, p.y] : [undefined, undefined];
        if (x === undefined) throw new Error(`series ${i + 1} point ${j + 1} must be a pair or an object`);
        const px = parseX(x);
        if (px !== null) points.push([px, finite(y)]);
      });
      points.sort((a, b) => a[0] - b[0]);
      const name = s.name === undefined || s.name === null ? `Series ${i + 1}` : String(s.name);
      return { name, points };
    });
    return keyed(out, "name");
  }

  /** Parses data (JSON text or a value) for a kind from `parseKind`. */
  function parseData(kind, input) {
    let value = input;
    if (typeof input === "string") {
      try {
        value = JSON.parse(input);
      } catch (error) {
        throw new Error(`data is not valid JSON: ${error.message}`);
      }
    }
    if (kind.shape === "categories") return parseCategories(value);
    if (kind.shape === "series") return parseSeries(value);
    return value;
  }

  /** A finite number, clamped to [min, max]. Else null. */
  function parseNumber(value, min = -Infinity, max = Infinity) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  }

  /** `"true"` or `""` → true, `"false"` → false, else null. */
  function parseBool(value) {
    if (value === "" || value === "true") return true;
    if (value === "false") return false;
    return null;
  }

  /** Space-separated hex colors. Other tokens are dropped. */
  function parseColors(value) {
    return String(value ?? "")
      .split(/\s+/)
      .filter((c) => HEX_COLOR.test(c))
      .slice(0, MAX_COLORS);
  }

  /** `value` when it is one of `choices`, else `fallback`. */
  const parseChoice = (value, choices, fallback) => (choices.includes(value) ? value : fallback);

  /** The absolute URL of `src` when it has the origin of `base`. Else null. */
  function sameOrigin(src, base) {
    if (!src) return null;
    try {
      const url = new URL(src, base);
      return url.origin === new URL(base).origin && /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Reads all options through `get(name)` (for example `el.getAttribute`). */
  function readOptions(get) {
    const text = (name) => {
      const v = get(name);
      return v === null || v === undefined || v === "" ? null : String(v);
    };
    const refresh = parseNumber(get(ATTR.refresh), 1000, 86_400_000);
    return {
      label: text(ATTR.label),
      xLabel: text(ATTR.xLabel),
      yLabel: text(ATTR.yLabel),
      format: text(ATTR.format),
      xFormat: text(ATTR.xFormat),
      colors: parseColors(get(ATTR.colors)),
      aspect: parseNumber(get(ATTR.aspect), 0.2, 10),
      duration: parseNumber(get(ATTR.duration), 0, 10_000) ?? 400,
      reducedAnimate: get(ATTR.reduced) === "animate",
      legend: parseBool(get(ATTR.legend)),
      src: text(ATTR.src),
      refresh: refresh === null ? null : Math.round(refresh),
      xScale: parseChoice(get(ATTR.xScale), SCALES, "linear"),
      yScale: parseChoice(get(ATTR.yScale), Y_SCALES, "linear"),
      curve: parseChoice(get(ATTR.curve), CURVES, "linear"),
      horizontal: parseBool(get(ATTR.horizontal)) === true,
      inner: parseNumber(get(ATTR.inner), 0, 0.95) ?? 0,
      dots: parseBool(get(ATTR.dots)) === true,
      radius: parseNumber(get(ATTR.radius), 1, 50) ?? 4,
      yMin: parseNumber(get(ATTR.yMin)),
      yMax: parseNumber(get(ATTR.yMax)),
    };
  }

  return Object.freeze({
    ATTR,
    KINDS,
    parseKind,
    parseCategories,
    parseSeries,
    parseData,
    parseNumber,
    parseBool,
    parseColors,
    parseChoice,
    sameOrigin,
    readOptions,
  });
});
