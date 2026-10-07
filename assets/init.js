// autumn-plugin-d3 runtime.
//
// Finds [data-d3] elements and draws a D3 chart in each. Starts on
// DOMContentLoaded. Scans on htmx:afterSwap and on each DOM insertion.
// Redraws on resize and on data-d3-* changes. Frees a chart when its
// element leaves the document. One element owns at most one chart.
//
// No eval, no innerHTML, no style attributes in markup: styles go through
// the CSSOM, so the strict Autumn CSP allows this file.
(function () {
  "use strict";

  // A second copy of this file (for example from an htmx swap of the head)
  // must not start a second runtime. A Symbol mark, not `window.AutumnD3`:
  // an element with id "AutumnD3" also makes that name truthy.
  const MARK = Symbol.for("autumn-plugin-d3");
  if (window[MARK]) return;

  const d3 = window.d3;
  const P = window.AutumnD3Parse;
  if (!d3 || !P) {
    console.error("autumn-plugin-d3: load d3.min.js and parse.js before init.js (use d3_script())");
    return;
  }

  Object.defineProperty(window, MARK, { value: true });

  const VERSION = "0.1.0";
  /** Largest d3-format width. A huge width freezes the page. */
  const MAX_FORMAT_WIDTH = 64;
  /** Longest category label on a vertical axis before it is cut. */
  const MAX_LABEL = 24;
  /** Most refresh back-off after failures. */
  const MAX_BACKOFF_MS = 300_000;
  const { ATTR } = P;
  const SELECTOR = `[${ATTR.kind}]`;
  const WATCHED = Object.values(ATTR).filter((name) => name !== ATTR.state);
  const PALETTE = 8;
  const DAY_MS = 86_400_000;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const defaultFormat = d3.format(",.6~r");
  const percent = d3.format(".0%");
  const formatDay = d3.utcFormat("%Y-%m-%d");
  const formatMinute = d3.utcFormat("%Y-%m-%d %H:%M");
  const CURVES = {
    linear: d3.curveLinear,
    monotone: d3.curveMonotoneX,
    step: d3.curveStep,
    natural: d3.curveNatural,
  };

  /** Live charts: element → state. */
  const live = new Map();
  /** Custom kinds: name → draw function. */
  const registry = new Map();

  // ---------------------------------------------------------------- utils

  /** Sets the lifecycle state attribute (`loading`, `ready`, …). */
  const setState = (el, value) => el.setAttribute(ATTR.state, value);

  /** Fires a bubbling event on `el`. */
  const emit = (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));

  /** A d3-format function for `spec`. A bad spec gives the default. */
  function makeFormat(spec) {
    if (!spec) return null;
    try {
      if (d3.formatSpecifier(spec).width > MAX_FORMAT_WIDTH) throw new RangeError("width");
      return d3.format(spec);
    } catch {
      console.warn(`autumn-plugin-d3: bad format "${spec}", using the default`);
      return null;
    }
  }

  /** Formats Unix milliseconds as a UTC date (and time when not midnight). */
  const formatTime = (ms) => (ms % DAY_MS === 0 ? formatDay : formatMinute)(new Date(ms));

  /** Table form of Unix ms: the same text as the Rust fallback table. */
  const formatIso = d3.utcFormat("%Y-%m-%dT%H:%M:%SZ");
  const tableTime = (ms) => (ms % DAY_MS === 0 ? formatDay(new Date(ms)) : ms % 1000 === 0 ? formatIso(new Date(ms)) : d3.isoFormat(new Date(ms)));

  /** Table form of a number: missing values are a dash. */
  const tableNumber = (v) => (v === null ? "—" : String(Object.is(v, -0) ? 0 : v));

  /** Cuts a long label. The table and tooltip keep the full text. */
  const cut = (label) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label);

  /** A unique id for hint elements. */
  let nextId = 0;

  /** Transition time for a draw, after the reduced-motion rule. */
  function effectiveDuration(state) {
    return reducedMotion.matches && !state.options.reducedAnimate ? 0 : state.options.duration;
  }

  /**
   * A transition on `sel`. When `duration` is zero, it stops running
   * transitions and returns `sel`, so a later transition cannot undo it.
   */
  const tx = (sel, duration) => (duration > 0 ? sel.transition().duration(duration) : sel.interrupt());

  /** The update part of a join: a mark that was fading out comes back. */
  const revive = (sel) => sel.interrupt().style("opacity", null);

  /** Removes `sel`, after a fade when `duration` is not zero. */
  function exit(sel, duration) {
    if (duration > 0) sel.transition().duration(duration).style("opacity", 0).remove();
    else sel.remove();
  }

  /** Sets mark class `cls`, series class `d3-sN`, and a color override. */
  function paint(sel, cls, options, index) {
    sel
      .attr("class", (d, i) => `${cls} d3-s${index(d, i) % PALETTE}`)
      .style("--d3-c", (d, i) => options.colors[index(d, i)] ?? null);
  }

  /** The child of `parent` with classes `cls` (space-separated), made on first use. */
  function child(parent, tag, cls) {
    let sel = parent.select(`:scope > .${cls.split(" ").join(".")}`);
    if (sel.empty()) sel = parent.append(tag).attr("class", cls);
    return sel;
  }

  /** A path for a bar with a 4px rounded data end, square at the base. */
  function barPath(horizontal, a0, a1, base, end) {
    const r = Math.max(0, Math.min(4, Math.abs(end - base), (a1 - a0) / 2));
    const s = end < base ? 1 : -1;
    if (!horizontal) {
      return `M${a0},${base}V${end + s * r}Q${a0},${end} ${a0 + r},${end}H${a1 - r}Q${a1},${end} ${a1},${end + s * r}V${base}Z`;
    }
    return `M${base},${a0}H${end + s * r}Q${end},${a0} ${end},${a0 + r}V${a1 - r}Q${end},${a1} ${end + s * r},${a1}H${base}Z`;
  }

  /** The largest bar thickness, from the `--d3-bar-max` CSS property. */
  function barMax(el) {
    const value = Number.parseFloat(getComputedStyle(el).getPropertyValue("--d3-bar-max"));
    return Number.isFinite(value) && value > 0 ? value : 24;
  }

  // --------------------------------------------------------------- frame

  /**
   * Draws the axes, the grid, and the axis titles. `value` is the value
   * scale, `other` the category or x scale; `horizontal` puts `value` on
   * x. `otherAxis(axis, n)` configures the `other` axis. `valueFormat` is
   * the tick format of the value axis, or null for the scale default.
   * Returns the inner box `{ left, right, top, bottom }`.
   */
  function frame(ctx, { horizontal, value, other, otherAxis, valueFormat }) {
    const { svg, width, height, options } = ctx;
    const titles = [];
    if (options.xLabel) titles.push({ cls: "x", text: options.xLabel });
    if (options.yLabel) titles.push({ cls: "y", text: options.yLabel });
    // x title goes under the bottom axis; y title beside the left axis.
    const bottomTitle = horizontal ? options.yLabel : options.xLabel;
    const leftTitle = horizontal ? options.xLabel : options.yLabel;
    const box = { top: 12, right: 16, bottom: 28 + (bottomTitle ? 20 : 0), left: 0 };

    const leftScale = horizontal ? other : value;
    const bottomScale = horizontal ? value : other;
    leftScale.range(horizontal ? [box.top, height - box.bottom] : [height - box.bottom, box.top]);
    const yTicks = Math.max(2, Math.floor((height - box.top - box.bottom) / 40));
    const valueAxis = (axis, n) => (valueFormat ? axis.ticks(n).tickFormat(valueFormat) : axis.ticks(n));
    const leftAxis = horizontal ? otherAxis(d3.axisLeft(leftScale)) : valueAxis(d3.axisLeft(leftScale), yTicks);
    const left = child(svg, "g", "d3-axis d3-axis-y").call(leftAxis);
    if (horizontal && other.step) thin(left, other.step(), false);
    box.left = Math.ceil(left.node().getBBox().width) + 10 + (leftTitle ? 20 : 0);
    left.attr("transform", `translate(${box.left},0)`);

    bottomScale.range([box.left, width - box.right]);
    const xTicks = Math.max(2, Math.floor((width - box.left - box.right) / 80));
    const bottomAxis = horizontal ? valueAxis(d3.axisBottom(bottomScale), xTicks) : otherAxis(d3.axisBottom(bottomScale), xTicks);
    const bottom = child(svg, "g", "d3-axis d3-axis-x").attr("transform", `translate(0,${height - box.bottom})`).call(bottomAxis);
    if (!horizontal && other.step) thin(bottom, other.step(), true);

    // Value grid: hairlines across the plot at the value ticks.
    const grid = horizontal
      ? d3.axisBottom(value).ticks(xTicks).tickSize(-(height - box.top - box.bottom)).tickFormat("")
      : d3.axisLeft(value).ticks(yTicks).tickSize(-(width - box.left - box.right)).tickFormat("");
    child(svg, "g", "d3-grid")
      .attr("transform", horizontal ? `translate(0,${height - box.bottom})` : `translate(${box.left},0)`)
      .call(grid)
      .lower();

    const at = {
      x: [(box.left + width - box.right) / 2, height - 6, 0],
      y: [-(box.top + height - box.bottom) / 2, 14, -90],
    };
    const place = (t) => (t.cls === "x") !== horizontal ? at.x : at.y;
    svg
      .selectAll(":scope > .d3-axis-title")
      .data(titles, (t) => t.cls)
      .join("text")
      .attr("class", "d3-axis-title")
      .attr("text-anchor", "middle")
      .attr("x", (t) => place(t)[0])
      .attr("y", (t) => place(t)[1])
      .attr("transform", (t) => (place(t)[2] ? `rotate(${place(t)[2]})` : null))
      .text((t) => t.text);
    return { left: box.left, right: width - box.right, top: box.top, bottom: height - box.bottom };
  }

  /**
   * Hides band axis labels that would overlap: keeps every n-th tick.
   * `across` is true when labels sit side by side (a bottom axis).
   */
  function thin(axis, step, across) {
    const ticks = axis.selectAll(".tick").style("display", null);
    let need = 0;
    ticks.select("text").each(function () {
      const b = this.getBBox();
      need = Math.max(need, across ? b.width : b.height);
    });
    const every = Math.max(1, Math.ceil((need + 6) / step));
    if (every > 1) ticks.style("display", (_, i) => (i % every === 0 ? null : "none"));
  }

  /** Domain of `values` widened by `min`/`max` options. */
  function valueDomain(values, options, includeZero, log) {
    let list = values.filter((v) => v !== null && (!log || v > 0));
    if (options.yMin !== null && (!log || options.yMin > 0)) list.push(options.yMin);
    if (options.yMax !== null && (!log || options.yMax > 0)) list.push(options.yMax);
    if (includeZero && !log) list.push(0);
    let [lo, hi] = d3.extent(list);
    if (lo === undefined) [lo, hi] = log ? [1, 10] : [0, 1];
    if (lo === hi) [lo, hi] = log ? [lo / 10, hi * 10] : [lo - 1, hi + 1];
    return [lo, hi];
  }

  // -------------------------------------------------------------- kinds

  /** Bar chart. Returns the interaction items. */
  function drawBar(ctx) {
    const { svg, options, data, duration, el } = ctx;
    const horizontal = options.horizontal;
    const value = d3.scaleLinear().domain(valueDomain(data.map((d) => d.value), options, true, false)).nice();
    const band = d3.scaleBand().domain(data.map((d) => d.key)).padding(0.2);
    const labelOf = new Map(data.map((d) => [d.key, d.label]));
    const tickLabel = (key) => (horizontal ? cut(labelOf.get(key)) : labelOf.get(key));
    frame(ctx, { horizontal, value, other: band, otherAxis: (axis) => axis.tickSizeOuter(0).tickFormat(tickLabel), valueFormat: ctx.valueFormat });
    const thick = Math.min(band.bandwidth(), barMax(el));
    const offset = (band.bandwidth() - thick) / 2;
    const zero = value(0);
    const rows = data.filter((d) => d.value !== null);
    const path = (d, v) => {
      const a0 = band(d.key) + offset;
      return barPath(horizontal, a0, a0 + thick, zero, value(v));
    };
    const marks = child(svg, "g", "d3-marks");
    const bars = marks
      .selectAll("path.d3-bar")
      .data(rows, (d) => d.key)
      .join(
        (enter) => enter.append("path").attr("d", (d) => path(d, 0)),
        revive,
        (old) => exit(old, duration),
      );
    paint(bars, "d3-bar", options, () => 0);
    tx(bars, duration).attr("d", (d) => path(d, d.value));
    const barNode = new Map();
    bars.each(function (d) {
      barNode.set(d.key, this);
    });
    return rows.map((d) => {
      const center = band(d.key) + band.bandwidth() / 2;
      const end = value(d.value);
      return {
        x: horizontal ? end : center,
        y: horizontal ? center : Math.min(end, zero),
        axis: center,
        text: `${d.label}: ${ctx.format(d.value)}`,
        mark: barNode.get(d.key),
      };
    });
  }

  /** Line, area, and scatter charts. Returns the interaction items. */
  function drawXy(ctx) {
    const { svg, options, data, duration, kind } = ctx;
    const time = options.xScale === "time";
    const xLog = options.xScale === "log";
    const yLog = options.yScale === "log";
    // A log scale drops values that are not positive.
    const series = data.map((s) => ({
      name: s.name,
      key: s.key,
      points: s.points
        .filter((p) => !xLog || p[0] > 0)
        .map(([x, y]) => [x, yLog && y !== null && y <= 0 ? null : y]),
    }));
    const xs = series.flatMap((s) => s.points.map((p) => p[0]));
    const ys = series.flatMap((s) => s.points.map((p) => p[1]));
    let [x0, x1] = d3.extent(xs);
    if (x0 === undefined) [x0, x1] = xLog ? [1, 10] : [0, 1];
    if (x0 === x1) [x0, x1] = xLog ? [x0 / 10, x1 * 10] : time ? [x0 - DAY_MS, x1 + DAY_MS] : [x0 - 1, x1 + 1];
    const x = (time ? d3.scaleUtc() : xLog ? d3.scaleLog() : d3.scaleLinear()).domain([x0, x1]);
    const y = (yLog ? d3.scaleLog() : d3.scaleLinear()).domain(valueDomain(ys, options, kind === "area", yLog)).nice();
    const xFormat = !time && makeFormat(options.xFormat);
    const box = frame(ctx, {
      horizontal: false,
      value: y,
      other: x,
      otherAxis: (axis, n) => (xFormat ? axis.ticks(n).tickFormat(xFormat) : axis.ticks(n)),
      valueFormat: ctx.valueFormat,
    });
    const marks = child(svg, "g", "d3-marks");
    const defined = (p) => p[1] !== null;
    const curve = CURVES[options.curve];
    const line = d3.line().defined(defined).curve(curve).x((p) => x(p[0])).y((p) => y(p[1]));
    const index = new Map(series.map((s, i) => [s.key, i]));
    const colorOf = (s) => index.get(s.key);

    if (kind === "area") {
      const base = y(yLog ? y.domain()[0] : Math.max(0, y.domain()[0]));
      const area = d3.area().defined(defined).curve(curve).x((p) => x(p[0])).y0(base).y1((p) => y(p[1]));
      const fills = marks
        .selectAll("path.d3-area")
        .data(series, (s) => s.key)
        .join((enter) => enter.append("path").style("opacity", 0), revive, (old) => exit(old, duration));
      paint(fills, "d3-area", options, colorOf);
      tx(fills, duration).style("opacity", 1).attr("d", (s) => area(s.points));
    }
    if (kind !== "scatter") {
      const lines = marks
        .selectAll("path.d3-line")
        .data(series, (s) => s.key)
        .join((enter) => enter.append("path").style("opacity", 0), revive, (old) => exit(old, duration));
      paint(lines, "d3-line", options, colorOf);
      tx(lines, duration).style("opacity", 1).attr("d", (s) => line(s.points));
    }
    const showDots = kind === "scatter" || options.dots;
    const dotData = showDots
      ? series.flatMap((s) => s.points.flatMap((p, j) => (defined(p) ? [{ key: `${s.key}\u0001${j}`, s, p }] : [])))
      : [];
    const radius = kind === "scatter" ? options.radius : 4;
    const dots = marks
      .selectAll("circle.d3-dot")
      .data(dotData, (d) => d.key)
      .join((enter) => enter.append("circle").attr("r", 0).attr("cx", (d) => x(d.p[0])).attr("cy", (d) => y(d.p[1])), revive, (old) => exit(old, duration))
      .raise();
    paint(dots, "d3-dot", options, (d) => colorOf(d.s));
    const dotNode = new Map();
    dots.each(function (d) {
      dotNode.set(d.key, this);
    });
    tx(dots, duration).attr("r", radius).attr("cx", (d) => x(d.p[0])).attr("cy", (d) => y(d.p[1]));

    const fx = (v) => (time ? formatTime(v) : (xFormat || defaultFormat)(v));
    const fy = (v) => (v === null ? "—" : ctx.format(v));
    if (kind === "scatter") {
      return dotData
        .slice()
        .sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1])
        .map((d) => ({ x: x(d.p[0]), y: y(d.p[1]), text: `${d.s.name} · ${fx(d.p[0])}: ${fy(d.p[1])}`, mark: dotNode.get(d.key) }));
    }
    // Line and area: one item per x value, with every series.
    const byX = d3.group(series.flatMap((s) => s.points.map((p) => ({ s, p }))), (d) => d.p[0]);
    return [...byX.keys()].sort((a, b) => a - b).map((xv) => {
      const values = series.map((s) => [s.name, s.points.find((p) => p[0] === xv)?.[1] ?? null]);
      const top = d3.min(values, ([, v]) => (v === null ? undefined : y(v)));
      return {
        x: x(xv),
        y: top ?? box.top,
        axis: x(xv),
        crosshair: [box.top, box.bottom],
        text: [fx(xv), ...values.map(([name, v]) => `${name}: ${fy(v)}`)].join(" · "),
      };
    });
  }

  /** Pie and donut chart. Returns the interaction items. */
  function drawPie(ctx) {
    const { svg, options, data, duration, width, height } = ctx;
    const rows = data.filter((d) => d.value !== null && d.value > 0);
    const total = d3.sum(rows, (d) => d.value);
    const outer = Math.max(0, Math.min(width, height) / 2 - 8);
    const inner = outer * options.inner;
    const pie = d3.pie().sort(null).value((d) => d.value).padAngle(rows.length > 1 && outer > 0 ? 2 / outer : 0);
    const arc = d3.arc().innerRadius(inner).outerRadius(outer);
    const arcs = pie(rows);
    const index = new Map(data.map((d, i) => [d.key, i]));
    const marks = child(svg, "g", "d3-marks").attr("transform", `translate(${width / 2},${height / 2})`);
    const slices = marks
      .selectAll("path.d3-arc")
      .data(arcs, (a) => a.data.key)
      .join(
        (enter) => enter.append("path").each(function (a) {
          this._current = { startAngle: a.startAngle, endAngle: a.startAngle, padAngle: a.padAngle };
        }),
        revive,
        (old) => exit(old, duration),
      );
    paint(slices, "d3-arc", options, (a) => index.get(a.data.key));
    const sliceNode = new Map();
    slices.each(function (a) {
      sliceNode.set(a.data.key, this);
    });
    if (duration > 0) {
      slices
        .transition()
        .duration(duration)
        .attrTween("d", function (a) {
          const interpolate = d3.interpolate(this._current, a);
          this._current = a;
          return (t) => arc(interpolate(t));
        });
    } else {
      slices.interrupt().attr("d", arc).each(function (a) {
        this._current = a;
      });
    }
    return arcs.map((a) => {
      const [cx, cy] = arc.centroid(a);
      return {
        x: cx + width / 2,
        y: cy + height / 2,
        angle: [a.startAngle, a.endAngle],
        ring: [inner, outer],
        text: `${a.data.label}: ${ctx.format(a.data.value)} (${percent(a.data.value / total)})`,
        mark: sliceNode.get(a.data.key),
      };
    });
  }

  const BUILT_IN = { bar: drawBar, line: drawXy, area: drawXy, scatter: drawXy, pie: drawPie };

  // ------------------------------------------------------- interaction

  /** The item nearest to the pointer at (px, py), or -1. */
  function pick(state, px, py) {
    const { items, kind } = state;
    if (items.length === 0) return -1;
    if (kind.name === "pie") {
      const { width, height } = state.size;
      const dx = px - width / 2;
      const dy = py - height / 2;
      const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
      const r = Math.hypot(dx, dy);
      const [inner, outer] = items[0].ring;
      if (r < inner || r > outer) return -1;
      return items.findIndex((item) => angle >= item.angle[0] && angle <= item.angle[1]);
    }
    if (kind.name === "scatter") return d3.leastIndex(items, (item) => Math.hypot(item.x - px, item.y - py));
    const along = state.kind.name === "bar" && state.options.horizontal ? py : px;
    return d3.leastIndex(items, (item) => Math.abs(item.axis - along));
  }

  /** Shows item `i`: tooltip, active mark, and crosshair. */
  function show(state, i) {
    const item = state.items[i];
    if (!item) return hide(state);
    state.active = i;
    const tip = state.tooltip;
    tip.textContent = item.text;
    tip.hidden = false;
    if (state.live.textContent !== item.text) state.live.textContent = item.text;
    // Keep the box inside the plot: center it on the item, above it, or
    // below it when there is no room above.
    const { width, height } = state.size;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(0, Math.min(width - w, item.x - w / 2));
    const above = item.y - h - 10;
    const top = above >= 0 ? above : Math.max(0, Math.min(height - h, item.y + 10));
    tip.style.setProperty("left", `${left}px`);
    tip.style.setProperty("top", `${top}px`);
    const svg = d3.select(state.svg);
    svg.selectAll(".d3-active").classed("d3-active", false);
    if (item.mark) d3.select(item.mark).classed("d3-active", true);
    const cross = child(svg, "line", "d3-crosshair");
    if (item.crosshair) cross.attr("x1", item.x).attr("x2", item.x).attr("y1", item.crosshair[0]).attr("y2", item.crosshair[1]).attr("display", null);
    else cross.attr("display", "none");
  }

  /** Hides the tooltip, the active mark, and the crosshair. */
  function hide(state) {
    if (!state.tooltip) return;
    state.tooltip.hidden = true;
    const svg = d3.select(state.svg);
    svg.selectAll(".d3-active").classed("d3-active", false);
    svg.select(".d3-crosshair").attr("display", "none");
  }

  const KEYS = {
    ArrowRight: (i) => i + 1,
    ArrowDown: (i) => i + 1,
    ArrowLeft: (i) => i - 1,
    ArrowUp: (i) => i - 1,
    Home: () => 0,
    End: (_, n) => n - 1,
  };

  /** Adds pointer and keyboard listeners to the chart SVG. */
  function listen(state) {
    const svg = state.svg;
    svg.addEventListener("pointermove", (event) => {
      const [px, py] = d3.pointer(event, svg);
      const i = pick(state, px, py);
      if (i < 0) hide(state);
      else show(state, i);
    });
    svg.addEventListener("pointerleave", () => {
      state.active = null;
      hide(state);
    });
    svg.addEventListener("focus", () => show(state, state.active ?? 0));
    svg.addEventListener("blur", () => hide(state));
    svg.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return hide(state);
      const move = KEYS[event.key];
      if (!move || state.items.length === 0) return;
      event.preventDefault();
      const n = state.items.length;
      show(state, Math.max(0, Math.min(n - 1, move(state.active ?? 0, n))));
    });
  }

  // --------------------------------------------------------- lifecycle

  /** Makes the plot box, SVG, and tooltip on first use. */
  function ensurePlot(state) {
    const { el, options, kind } = state;
    if (!state.plot) {
      const plot = document.createElement("div");
      plot.className = "d3-plot";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("role", "img");
      // The visual tooltip is for sighted users. Screen readers hear the
      // live region, which stays in the tree so the first change speaks.
      const tooltip = document.createElement("div");
      tooltip.className = "d3-tooltip";
      tooltip.setAttribute("aria-hidden", "true");
      tooltip.hidden = true;
      const live = document.createElement("div");
      live.className = "d3-live";
      live.setAttribute("role", "status");
      const hint = document.createElement("span");
      hint.className = "d3-hint";
      hint.id = `d3-hint-${(nextId += 1)}`;
      hint.textContent = "Use the arrow keys to read the values.";
      plot.append(svg, tooltip, live, hint);
      const caption = el.firstElementChild?.tagName === "FIGCAPTION" ? el.firstElementChild : null;
      if (caption) caption.after(plot);
      else el.prepend(plot);
      Object.assign(state, { plot, svg, tooltip, live, hint });
      listen(state);
      state.resize = new ResizeObserver(() => {
        const box = plot.getBoundingClientRect();
        if (state.ready && box.width > 0 && (Math.round(box.width) !== state.size.width || Math.round(box.height) !== state.size.height)) {
          draw(state, false);
        }
      });
      state.resize.observe(plot);
    }
    state.plot.style.setProperty("aspect-ratio", options.aspect === null ? null : String(options.aspect));
    const caption = el.querySelector(":scope > figcaption");
    state.name = options.label ?? caption?.textContent.trim() ?? `${kind.name} chart`;
    state.svg.setAttribute("aria-label", state.name);
  }

  /** Draws (or redraws) the legend after the plot. */
  function drawLegend(state) {
    const { kind, data, options } = state;
    const names = !Array.isArray(data) || !kind.builtIn ? [] : data.map((d) => ({ key: d.key, text: d.label ?? d.name }));
    const show = kind.builtIn && kind.name !== "bar" && (options.legend ?? names.length >= 2);
    if (!show) {
      state.legend?.remove();
      state.legend = null;
      return;
    }
    if (!state.legend) {
      state.legend = document.createElement("ul");
      state.legend.className = "d3-legend";
      // list-style: none drops list semantics in Safari.
      state.legend.setAttribute("role", "list");
      state.plot.after(state.legend);
    }
    const items = d3
      .select(state.legend)
      .selectAll("li")
      .data(names, (n) => n.key)
      .join((enter) => {
        const li = enter.append("li").attr("role", "listitem");
        li.append("span").attr("class", "d3-swatch").attr("aria-hidden", "true");
        li.append("span").attr("class", "d3-legend-label");
        return li;
      });
    items.select(".d3-legend-label").text((n) => n.text);
    items.select(".d3-swatch").each(function (_, i) {
      this.setAttribute("class", `d3-swatch d3-s${i % PALETTE}`);
      this.style.setProperty("--d3-c", options.colors[i] ?? null);
    });
  }

  /** Rewrites the data table for the current data (built-in kinds). */
  function drawTable(state) {
    const { el, kind, data, options } = state;
    const wrap = el.querySelector(":scope > .d3-table");
    if (!wrap || !kind.builtIn || state.tableData === data) return;
    state.tableData = data;
    const time = options.xScale === "time";
    const categories = kind.shape === "categories";
    const head = categories ? [options.xLabel ?? "Label", options.yLabel ?? "Value"] : ["Series", options.xLabel ?? "x", options.yLabel ?? "Value"];
    const rows = categories
      ? data.map((d) => [d.label, tableNumber(d.value)])
      : data.flatMap((s) => s.points.map(([x, y]) => [s.name, time ? tableTime(x) : tableNumber(x), tableNumber(y)]));
    const table = d3.create("table");
    if (state.name && state.name !== `${kind.name} chart`) table.append("caption").text(state.name);
    table.append("thead").append("tr").selectAll("th").data(head).join("th").attr("scope", "col").text((t) => t);
    const tr = table.append("tbody").selectAll("tr").data(rows).join("tr");
    tr.selectAll(":scope > *")
      .data((row) => row)
      .join((enter) => enter.append((_, i) => document.createElement(i === 0 ? "th" : "td")))
      .attr("scope", (_, i) => (i === 0 ? "row" : null))
      .text((t) => t);
    wrap.replaceChildren(table.node());
  }

  /** Shows "No data" when a built-in chart has nothing to show. */
  function drawEmpty(state) {
    const svg = d3.select(state.svg);
    const empty = state.kind.builtIn && state.items.length === 0;
    svg.select(":scope > .d3-empty").remove();
    if (empty) {
      svg.append("text").attr("class", "d3-empty").attr("text-anchor", "middle").attr("x", state.size.width / 2).attr("y", state.size.height / 2).text("No data");
      state.svg.setAttribute("aria-label", `${state.name}. No data`);
    }
    // A tab stop only when the keys can read something.
    if (state.items.length > 0) {
      state.svg.setAttribute("tabindex", "0");
      state.svg.setAttribute("aria-describedby", state.hint.id);
    } else {
      state.svg.removeAttribute("tabindex");
      state.svg.removeAttribute("aria-describedby");
    }
  }

  /** Warns once when a chart has more series than palette colors. */
  function warnPalette(state) {
    const n = Array.isArray(state.data) && state.kind.builtIn && state.kind.name !== "bar" ? state.data.length : 0;
    if (n > PALETTE && !state.warned) {
      state.warned = true;
      console.warn(`autumn-plugin-d3: ${n} series, but the palette has ${PALETTE} colors; colors repeat`);
    }
  }

  /** Draws the chart. `animate` uses the transition time. */
  function draw(state, animate) {
    const { el, kind, options } = state;
    if (state.destroyed) return;
    try {
      ensurePlot(state);
      setState(el, "ready");
      const box = state.plot.getBoundingClientRect();
      state.size = { width: Math.round(box.width), height: Math.round(box.height) };
      const { width, height } = state.size;
      const svg = d3.select(state.svg).attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);
      const valueFormat = makeFormat(options.format);
      const ctx = {
        el,
        d3,
        svg,
        width,
        height,
        kind: kind.name,
        data: state.data,
        options,
        duration: animate ? effectiveDuration(state) : 0,
        valueFormat,
        format: valueFormat ?? defaultFormat,
        color: (i) => `var(--d3-color-${(i % PALETTE) + 1})`,
      };
      if (kind.builtIn) {
        state.items = BUILT_IN[kind.name](ctx);
      } else {
        svg.selectAll("*").remove();
        registry.get(kind.name)(ctx);
        state.items = [];
      }
      drawLegend(state);
      drawEmpty(state);
      drawTable(state);
      warnPalette(state);
      if (state.active !== null && !state.tooltip.hidden) show(state, Math.min(state.active, state.items.length - 1));
      const first = !state.ready;
      state.ready = true;
      if (first) emit(el, "d3:ready", state.handle);
      emit(el, "d3:render", state.handle);
    } catch (error) {
      fail(state, error);
    }
  }

  /** Reports an error. Before the first draw, the fallback stays. */
  function fail(state, error) {
    if (!state.ready) {
      removePlot(state);
      setState(state.el, "error");
    }
    console.warn(`autumn-plugin-d3: #${state.el.id || state.kind?.name || "chart"}: ${error.message}`);
    emit(state.el, "d3:error", { error });
  }

  /** Removes the plot and the legend. */
  function removePlot(state) {
    state.resize?.disconnect();
    state.plot?.remove();
    state.legend?.remove();
    Object.assign(state, { plot: null, svg: null, tooltip: null, live: null, hint: null, legend: null, resize: null });
  }

  /** Loads `data-d3-src`, then schedules the next refresh. */
  async function load(state) {
    if (state.destroyed) return;
    const gen = state.gen;
    const url = P.sameOrigin(state.options.src, location.href);
    if (!url) return fail(state, new Error(`data-d3-src must have the same origin as the page: ${state.options.src}`));
    const controller = new AbortController();
    state.abort = controller;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin", signal: controller.signal });
      if (response.redirected && !P.sameOrigin(response.url, location.href)) {
        throw new Error(`data-d3-src redirected to another origin; it must have the same origin as the page`);
      }
      if (!response.ok) throw new Error(`data-d3-src: HTTP ${response.status}`);
      const text = await response.text();
      if (gen !== state.gen) return;
      state.data = P.parseData(state.kind, text);
      state.failures = 0;
      draw(state, true);
    } catch (error) {
      if (gen !== state.gen) return;
      state.failures += 1;
      fail(state, error);
    }
    if (gen === state.gen && state.options.refresh !== null) {
      // Back off after failures: twice the wait per failure, up to a cap.
      const wait = Math.min(state.options.refresh * 2 ** state.failures, Math.max(state.options.refresh, MAX_BACKOFF_MS));
      state.timer = setTimeout(() => refresh(state), wait);
    }
  }

  /** Runs a refresh, or waits for the page to show again. */
  function refresh(state) {
    if (document.hidden) state.waiting = true;
    else load(state);
  }

  /** Reads the options and data, then draws or loads. */
  function start(state) {
    const { el, kind } = state;
    // A new start owns the data: stop the old request and refresh timer.
    state.gen += 1;
    state.abort?.abort();
    clearTimeout(state.timer);
    Object.assign(state, { waiting: false, failures: 0 });
    state.options = P.readOptions((name) => el.getAttribute(name));
    if (!kind) return fail(state, new Error(`unknown chart kind "${el.getAttribute(ATTR.kind)}"`));
    if (!kind.builtIn && !registry.has(kind.name)) return setState(el, "pending");
    const inline = el.getAttribute(ATTR.data);
    if (inline === null && !state.options.src) return fail(state, new Error("no data: set data-d3-data or data-d3-src"));
    if (inline !== null) {
      try {
        state.data = P.parseData(kind, inline);
      } catch (error) {
        return fail(state, error);
      }
      draw(state, true);
    } else {
      setState(el, "loading");
    }
    if (state.options.src) load(state);
  }

  /** The public handle of a chart (`el.autumnD3`). */
  function makeHandle(state) {
    return Object.freeze({
      el: state.el,
      kind: state.kind?.name ?? null,
      d3,
      get svg() {
        return state.svg;
      },
      get data() {
        return state.data;
      },
      get options() {
        return state.options;
      },
      get duration() {
        return effectiveDuration(state);
      },
      get destroyed() {
        return state.destroyed;
      },
      /** Draws again with the current data, without transitions. */
      render() {
        draw(state, false);
      },
      /** Sets new data (JSON text or a value) and draws it. Throws on bad data. */
      update(data) {
        if (state.destroyed) throw new Error("autumn-plugin-d3: the chart is destroyed");
        state.data = P.parseData(state.kind, data);
        draw(state, true);
      },
      /** Frees the chart and removes its plot. */
      destroy() {
        dispose(state);
      },
    });
  }

  /** Starts a chart on `el`, unless it has one. */
  function init(el) {
    if (live.has(el)) return;
    const state = {
      el,
      kind: P.parseKind(el.getAttribute(ATTR.kind)),
      data: null,
      options: null,
      items: [],
      active: null,
      name: null,
      failures: 0,
      waiting: false,
      warned: false,
      tableData: null,
      size: { width: 0, height: 0 },
      ready: false,
      destroyed: false,
      gen: 0,
      plot: null,
      svg: null,
      tooltip: null,
      live: null,
      hint: null,
      legend: null,
      resize: null,
      abort: null,
      timer: null,
    };
    state.handle = makeHandle(state);
    live.set(el, state);
    el.autumnD3 = state.handle;
    start(state);
  }

  /** Frees a chart: observers, timers, requests, and (if attached) its DOM. */
  function dispose(state) {
    const { el } = state;
    state.destroyed = true;
    state.gen += 1;
    state.abort?.abort();
    clearTimeout(state.timer);
    removePlot(state);
    live.delete(el);
    if (el.autumnD3 === state.handle) delete el.autumnD3;
    el.removeAttribute(ATTR.state);
  }

  /** Starts every chart in `root` (an element or the document). */
  function scan(root = document) {
    if (root.matches?.(SELECTOR)) init(root);
    root.querySelectorAll?.(SELECTOR).forEach(init);
  }

  /** Handles DOM changes: new charts, removed charts, attribute changes. */
  function onMutations(records) {
    const restart = new Set();
    const update = new Set();
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
        continue;
      }
      const el = record.target;
      if (!live.has(el)) {
        if (el.hasAttribute(ATTR.kind)) init(el);
      } else if (record.attributeName === ATTR.data) {
        update.add(el);
      } else {
        restart.add(el);
      }
    }
    for (const state of [...live.values()]) {
      if (!state.el.isConnected) dispose(state);
    }
    for (const el of restart) {
      const state = live.get(el);
      if (!state) continue;
      dispose(state);
      if (el.hasAttribute(ATTR.kind)) init(el);
    }
    for (const el of update) {
      const state = live.get(el);
      if (!state || restart.has(el)) continue;
      const text = el.getAttribute(ATTR.data);
      if (text === null || !state.ready) {
        dispose(state);
        init(el);
        continue;
      }
      try {
        state.data = P.parseData(state.kind, text);
        draw(state, true);
      } catch (error) {
        fail(state, error);
      }
    }
  }

  /** Registers a custom chart kind. */
  function register(name, draw) {
    const kind = P.parseKind(name);
    if (!kind || kind.builtIn || kind.name !== name) throw new TypeError(`AutumnD3.register: bad kind name "${name}"`);
    if (typeof draw !== "function") throw new TypeError("AutumnD3.register: draw must be a function");
    registry.set(name, draw);
    for (const state of live.values()) {
      if (state.kind?.name === name && !state.ready) start(state);
    }
  }

  window.AutumnD3 = Object.freeze({
    version: VERSION,
    register,
    scan,
    get: (el) => live.get(el)?.handle ?? null,
  });

  function boot() {
    scan(document);
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED,
    });
    document.addEventListener("htmx:afterSwap", (event) => scan(event.target));
    // Escape hides every tooltip, also one that a hover opened (WCAG 1.4.13).
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") live.forEach(hide);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      for (const state of live.values()) {
        if (state.waiting) {
          state.waiting = false;
          load(state);
        }
      }
    });
  }

  // Deferred scripts run before DOMContentLoaded. Wait for it, so page
  // scripts after this one can register kinds and listen for d3:ready.
  const nav = performance.getEntriesByType?.("navigation")[0];
  if (document.readyState === "loading" || (document.readyState === "interactive" && !(nav?.domContentLoadedEventStart > 0))) {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
