// Unit tests for assets/parse.js. Run: npm run test:unit
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const P = require("../../assets/parse.js");

/** An attribute getter over a plain object. */
const getter = (attrs) => (name) => (name in attrs ? attrs[name] : null);

describe("ATTR and KINDS", () => {
  test("names match the Rust builder", () => {
    assert.equal(P.ATTR.kind, "data-d3");
    assert.equal(P.ATTR.data, "data-d3-data");
    assert.equal(P.ATTR.state, "data-d3-state");
    assert.deepEqual(P.KINDS, ["bar", "line", "area", "scatter", "pie"]);
  });

  test("ATTR values are unique data-d3 names", () => {
    const values = Object.values(P.ATTR);
    assert.equal(new Set(values).size, values.length);
    for (const v of values) assert.match(v, /^data-d3(-[a-z]+)*$/);
  });
});

describe("parseKind", () => {
  test("built-in and custom kinds", () => {
    assert.deepEqual(P.parseKind("bar"), { name: "bar", builtIn: true, shape: "categories" });
    assert.deepEqual(P.parseKind("pie"), { name: "pie", builtIn: true, shape: "categories" });
    assert.deepEqual(P.parseKind("line"), { name: "line", builtIn: true, shape: "series" });
    assert.deepEqual(P.parseKind(" area "), { name: "area", builtIn: true, shape: "series" });
    assert.deepEqual(P.parseKind("tree-map2"), { name: "tree-map2", builtIn: false, shape: "any" });
  });

  test("bad names are null", () => {
    for (const bad of [null, "", "Bar", "1a", "a b", "a_b", "a".repeat(65), "__proto__"]) {
      assert.equal(P.parseKind(bad), null, String(bad));
    }
  });
});

describe("parseCategories", () => {
  test("objects and pairs", () => {
    assert.deepEqual(P.parseCategories([{ label: "a", value: 1 }, ["b", 2.5], { label: 3, value: null }]), [
      { label: "a", value: 1, key: "a" },
      { label: "b", value: 2.5, key: "b" },
      { label: "3", value: null, key: "3" },
    ]);
  });

  test("non-finite and non-number values are null", () => {
    const out = P.parseCategories([{ label: "a", value: "7" }, { label: "b", value: Infinity }, { label: "c" }]);
    assert.deepEqual(out.map((d) => d.value), [null, null, null]);
  });

  test("bad shapes throw", () => {
    assert.throws(() => P.parseCategories({}), /array/);
    assert.throws(() => P.parseCategories([42]), /item 1/);
    assert.throws(() => P.parseCategories([{ value: 1 }]), /item 1 has no label/);
    assert.deepEqual(
      P.parseCategories([["a", 1], ["a", 2], ["a", 3]]).map((d) => d.key),
      ["a", "a\u00002", "a\u00003"],
      "repeated labels get unique keys",
    );
  });
});

describe("parseSeries", () => {
  test("pairs, objects, gaps, and dates", () => {
    const out = P.parseSeries([
      { name: "s", points: [[1, 2], { x: 2, y: null }, [3, "x"], [null, 4], ["2026-01-01", 5], ["nope", 6]] },
      { points: [] },
    ]);
    assert.deepEqual(out, [
      { name: "s", points: [[1, 2], [2, null], [3, null], [Date.UTC(2026, 0, 1), 5]], key: "s" },
      { name: "Series 2", points: [], key: "Series 2" },
    ]);
  });

  test("numeric strings are numbers; ISO strings without a zone are UTC", () => {
    const out = P.parseSeries([{ name: "s", points: [["3", 1], ["12.5", 2], ["2026-01-02T06:00", 3], ["2026-01-02T06:00+02:00", 4], ["March 3", 5]] }]);
    assert.deepEqual(out[0].points, [
      [3, 1],
      [12.5, 2],
      [Date.UTC(2026, 0, 2, 4), 4],
      [Date.UTC(2026, 0, 2, 6), 3],
    ]);
  });

  test("points are sorted by x", () => {
    assert.deepEqual(P.parseSeries([{ name: "s", points: [[3, 1], [1, 2]] }])[0].points, [[1, 2], [3, 1]]);
  });

  test("bad shapes throw", () => {
    assert.throws(() => P.parseSeries("x"), /array/);
    assert.throws(() => P.parseSeries([1]), /series 1/);
    assert.throws(() => P.parseSeries([{ name: "a", points: 1 }]), /series 1 points/);
    assert.throws(() => P.parseSeries([{ name: "a", points: [7] }]), /series 1 point 1/);
    assert.deepEqual(P.parseSeries([{ name: "a", points: [] }, { name: "a", points: [] }]).map((s) => s.key), ["a", "a\u00002"]);
  });
});

describe("parseData", () => {
  test("parses JSON text by shape", () => {
    assert.deepEqual(P.parseData({ shape: "categories" }, '[["a",1]]'), [{ label: "a", value: 1, key: "a" }]);
    assert.deepEqual(P.parseData({ shape: "series" }, '[{"name":"s","points":[]}]'), [{ name: "s", points: [], key: "s" }]);
    assert.deepEqual(P.parseData({ shape: "any" }, '{"k":1}'), { k: 1 });
    assert.deepEqual(P.parseData({ shape: "any" }, { k: 2 }), { k: 2 }, "objects pass through");
  });

  test("bad JSON throws a clear error", () => {
    assert.throws(() => P.parseData({ shape: "categories" }, "[1,"), /data is not valid JSON/);
  });
});

describe("number and flag parsers", () => {
  test("parseNumber", () => {
    assert.equal(P.parseNumber("2.5"), 2.5);
    assert.equal(P.parseNumber(" -1 "), -1);
    for (const bad of [null, "", "x", "Infinity", "NaN", "1e999"]) assert.equal(P.parseNumber(bad), null, String(bad));
    assert.equal(P.parseNumber("5", 0, 3), 3, "clamps high");
    assert.equal(P.parseNumber("-5", 0, 3), 0, "clamps low");
  });

  test("parseBool", () => {
    assert.equal(P.parseBool("true"), true);
    assert.equal(P.parseBool(""), true, "a bare attribute is true");
    assert.equal(P.parseBool("false"), false);
    assert.equal(P.parseBool(null), null);
    assert.equal(P.parseBool("maybe"), null);
  });

  test("parseColors keeps valid hex colors only", () => {
    assert.deepEqual(P.parseColors(" #fff #A0b1C2 red #12 url(x) #123456 "), ["#fff", "#A0b1C2", "#123456"]);
    assert.deepEqual(P.parseColors(null), []);
    assert.equal(P.parseColors(Array(20).fill("#000").join(" ")).length, 16);
  });

  test("parseChoice", () => {
    assert.equal(P.parseChoice("log", ["linear", "log"], "linear"), "log");
    assert.equal(P.parseChoice("nope", ["linear", "log"], "linear"), "linear");
    assert.equal(P.parseChoice(null, ["linear"], "linear"), "linear");
  });
});

describe("sameOrigin", () => {
  const base = "https://app.test/page";
  test("accepts same-origin URLs", () => {
    assert.equal(P.sameOrigin("/api/x.json", base), "https://app.test/api/x.json");
    assert.equal(P.sameOrigin("api?y=1", base), "https://app.test/api?y=1");
  });

  test("rejects other origins and schemes", () => {
    for (const bad of ["https://evil.test/x", "//evil.test/x", "javascript:alert(1)", "data:,[]", "http://app.test/x", "http://[", null, ""]) {
      assert.equal(P.sameOrigin(bad, base), null, String(bad));
    }
  });
});

describe("readOptions", () => {
  test("defaults", () => {
    assert.deepEqual(P.readOptions(getter({})), {
      label: null,
      xLabel: null,
      yLabel: null,
      format: null,
      xFormat: null,
      colors: [],
      aspect: null,
      duration: 400,
      reducedAnimate: false,
      legend: null,
      src: null,
      refresh: null,
      xScale: "linear",
      yScale: "linear",
      curve: "linear",
      horizontal: false,
      inner: 0,
      dots: false,
      radius: 4,
      yMin: null,
      yMax: null,
    });
  });

  test("reads and clamps every attribute", () => {
    const o = P.readOptions(
      getter({
        "data-d3-label": "Sales",
        "data-d3-x-label": "Month",
        "data-d3-y-label": "USD",
        "data-d3-format": "$,.0f",
        "data-d3-x-format": ".1f",
        "data-d3-colors": "#f00 #0f0",
        "data-d3-aspect": "50",
        "data-d3-duration": "99999",
        "data-d3-reduced": "animate",
        "data-d3-legend": "false",
        "data-d3-src": "/api/s",
        "data-d3-refresh": "10",
        "data-d3-x-scale": "time",
        "data-d3-y-scale": "log",
        "data-d3-curve": "monotone",
        "data-d3-horizontal": "true",
        "data-d3-inner": "2",
        "data-d3-dots": "",
        "data-d3-radius": "0",
        "data-d3-y-min": "-5",
        "data-d3-y-max": "x",
      }),
    );
    assert.deepEqual(o, {
      label: "Sales",
      xLabel: "Month",
      yLabel: "USD",
      format: "$,.0f",
      xFormat: ".1f",
      colors: ["#f00", "#0f0"],
      aspect: 10,
      duration: 10000,
      reducedAnimate: true,
      legend: false,
      src: "/api/s",
      refresh: 1000,
      xScale: "time",
      yScale: "log",
      curve: "monotone",
      horizontal: true,
      inner: 0.95,
      dots: true,
      radius: 1,
      yMin: -5,
      yMax: null,
    });
  });

  test("time is not a y scale, and refresh rounds to whole ms", () => {
    const o = P.readOptions(getter({ "data-d3-y-scale": "time", "data-d3-refresh": "1500.7" }));
    assert.equal(o.yScale, "linear");
    assert.equal(o.refresh, 1501);
  });
});

describe("browser global", () => {
  test("without CommonJS, parse.js sets self.AutumnD3Parse", async () => {
    const { readFileSync } = await import("node:fs");
    const vm = await import("node:vm");
    const source = readFileSync(new URL("../../assets/parse.js", import.meta.url), "utf8");
    const sandbox = { self: {} };
    vm.runInNewContext(source, sandbox);
    assert.deepEqual(Object.keys(sandbox.self), ["AutumnD3Parse"]);
    assert.equal(typeof sandbox.self.AutumnD3Parse.readOptions, "function");
  });
});
