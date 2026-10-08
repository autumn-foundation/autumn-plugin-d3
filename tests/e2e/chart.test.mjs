// Browser E2E tests: real Chromium, real SVG.
// Run: cargo build --example e2e_fixture && npm run test:e2e
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { lineCoverage, sleep, start, until, waitState } from "./harness.mjs";

/** Minimum line coverage of init.js over this suite. */
const MIN_INIT_COVERAGE = 95;

let app;
before(async () => {
  app = await start();
});
after(async () => {
  await app?.close();
  if (process.env.E2E_SKIP_COVERAGE) return; // Filtered dev runs.
  const init = lineCoverage("init");
  console.log(`init.js line coverage: ${init?.percent.toFixed(1)}% (uncovered lines: ${init?.uncovered.join(", ")})`);
  assert.ok(init && init.percent >= MIN_INIT_COVERAGE, `init.js coverage ${init?.percent} < ${MIN_INIT_COVERAGE}`);
});

/** Fails on any CSP violation or page error. */
async function assertClean(page) {
  assert.deepEqual(await page.evaluate(() => window.__csp), [], "no CSP violations");
  assert.deepEqual(page.errors, [], "no page errors");
}

/** Geometry of the elements that match `selector` inside `#id`. */
function boxes(page, id, selector) {
  return page.evaluate(
    ([id, selector]) =>
      [...document.getElementById(id).querySelectorAll(selector)].map((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }),
    [id, selector],
  );
}

/** Text of the elements that match `selector` inside `#id`. */
function texts(page, id, selector) {
  return page.evaluate(
    ([id, selector]) => [...document.getElementById(id).querySelectorAll(selector)].map((el) => el.textContent),
    [id, selector],
  );
}

/** Events recorded for `#id`, by type. */
async function events(page, id, type) {
  const all = await page.evaluate(() => window.__events);
  return all.filter(([t, target]) => t === type && target === id).length;
}

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

describe("bar charts", () => {
  test("bars, axes, labels, events, and a hidden table", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const bars = await boxes(page, "chart", ".d3-bar");
    assert.equal(bars.length, 3);
    // Apples 30, Pears 60, Plums 15: heights follow the values.
    assert.ok(near(bars[1].height, 2 * bars[0].height), JSON.stringify(bars));
    assert.ok(near(bars[0].height, 2 * bars[2].height), JSON.stringify(bars));
    assert.ok(bars.every((b) => b.width <= 24.5), "bar width is capped");
    // All bars stand on one baseline.
    assert.ok(near(bars[0].y + bars[0].height, bars[1].y + bars[1].height));
    assert.deepEqual(await texts(page, "chart", ".d3-axis-x .tick text"), ["Apples", "Pears", "Plums"]);
    assert.deepEqual(await texts(page, "chart", ".d3-axis-title"), ["Fruit", "Units"]);
    const svg = page.locator("#chart svg");
    assert.equal(await svg.getAttribute("role"), "img");
    assert.equal(await svg.getAttribute("aria-label"), "Fruit sold");
    assert.equal(await page.locator("#chart > .d3-plot").count(), 1);
    assert.equal(await page.locator("#chart .d3-legend").count(), 0, "one series: no legend");
    assert.ok(await page.locator("#chart figcaption").isVisible());
    const table = await page.locator("#chart .d3-table").boundingBox();
    assert.ok(table.width <= 1 && table.height <= 1, `table is visually hidden: ${JSON.stringify(table)}`);
    assert.equal(await events(page, "chart", "d3:ready"), 1);
    assert.deepEqual(await page.evaluate(() => window.__details), [true, true], "detail is the handle");
    assert.deepEqual(await page.evaluate(() => window.__lateReady), ["chart"], "late page scripts get d3:ready");
    assert.equal(await page.evaluate(() => document.getElementById("chart").autumnD3.d3 === window.d3), true);
    await assertClean(page);
  });

  test("horizontal bars and negative values", async () => {
    const page = await app.open("/horizontal");
    await waitState(page, "chart", "ready");
    await waitState(page, "signed", "ready");
    const bars = await boxes(page, "chart", ".d3-bar");
    assert.ok(near(bars[1].width, 2 * bars[0].width), JSON.stringify(bars));
    assert.ok(bars.every((b) => b.height <= 24.5));
    assert.deepEqual(await texts(page, "chart", ".d3-axis-y .tick text"), ["Apples", "Pears", "Plums"]);
    const ticks = await texts(page, "chart", ".d3-axis-x .tick text");
    assert.ok(ticks.every((t) => /^[\d,]+$/.test(t)), `integer format: ${ticks}`);
    // Up 10, Down -5, None: no bar for the missing value.
    const signed = await boxes(page, "signed", ".d3-bar");
    assert.equal(signed.length, 2);
    assert.ok(near(signed[0].y + signed[0].height, signed[1].y), "the negative bar hangs below the zero line");
    assert.ok(near(signed[0].height, 2 * signed[1].height));
    await assertClean(page);
  });
});

describe("xy charts", () => {
  test("line: series, gaps, dots, time axis, legend", async () => {
    const page = await app.open("/line");
    await waitState(page, "chart", "ready");
    const paths = await page.locator("#chart .d3-line").evaluateAll((els) => els.map((e) => e.getAttribute("d")));
    assert.equal(paths.length, 2);
    assert.equal(paths[1].match(/M/g).length, 2, `the missing App value makes a gap: ${paths[1]}`);
    assert.equal(await page.locator("#chart .d3-dot").count(), 5, "a dot per defined point");
    assert.deepEqual(await texts(page, "chart", ".d3-legend li"), ["Web", "App"]);
    const ticks = await texts(page, "chart", ".d3-axis-x .tick text");
    assert.ok(ticks.some((t) => /Jan|0[1-3]/.test(t)), `time ticks: ${ticks}`);
    await waitState(page, "solo", "ready");
    assert.equal(await page.locator("#solo .d3-legend").count(), 0);
    const solo = await texts(page, "solo", ".d3-axis-y .tick text");
    assert.ok(solo.length > 0, "log axis has ticks");
    await assertClean(page);
  });

  test("area: a fill and a line per series", async () => {
    const page = await app.open("/area");
    await waitState(page, "chart", "ready");
    assert.equal(await page.locator("#chart .d3-area").count(), 2);
    assert.equal(await page.locator("#chart .d3-line").count(), 2);
    await assertClean(page);
  });

  test("scatter: dots, radius, and color override", async () => {
    const page = await app.open("/scatter");
    await waitState(page, "chart", "ready");
    const dots = page.locator("#chart .d3-dot");
    assert.equal(await dots.count(), 4);
    assert.equal(await dots.first().getAttribute("r"), "6");
    const fills = await dots.evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
    assert.deepEqual(fills, ["rgb(255, 0, 0)", "rgb(255, 0, 0)", "rgb(255, 0, 0)", "rgb(0, 0, 255)"]);
    const ticks = await texts(page, "chart", ".d3-axis-x .tick text");
    assert.ok(ticks.every((t) => /^\d\.\d$/.test(t)), `x format: ${ticks}`);
    await assertClean(page);
  });
});

describe("pie charts", () => {
  test("donut slices, legend, square plot", async () => {
    const page = await app.open("/pie");
    await waitState(page, "chart", "ready");
    assert.equal(await page.locator("#chart .d3-arc").count(), 3);
    assert.deepEqual(await texts(page, "chart", ".d3-legend li"), ["Apples", "Pears", "Plums"]);
    const plot = await page.locator("#chart .d3-plot").boundingBox();
    assert.ok(near(plot.width, plot.height), JSON.stringify(plot));
    // The donut hole: the center is not on a slice.
    const hit = await page.evaluate(() => {
      const b = document.querySelector("#chart svg").getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.classList.contains("d3-arc");
    });
    assert.equal(hit, false);
    await waitState(page, "plain", "ready");
    assert.equal(await page.locator("#plain .d3-legend").count(), 0, "legend(false)");
    await assertClean(page);
  });
});

describe("declarative markup", () => {
  test("hand-written attributes draw charts", async () => {
    const page = await app.open("/handwritten");
    await waitState(page, "chart", "ready");
    await waitState(page, "plain", "ready");
    assert.equal(await page.locator("#chart .d3-bar").count(), 2);
    assert.equal(await page.locator("#chart svg").getAttribute("aria-label"), "Hand");
    assert.equal(await page.locator("#plain .d3-line").count(), 1);
    assert.equal(await page.locator("#plain svg").getAttribute("aria-label"), "line chart");
    await assertClean(page);
  });

  test("a chart inserted later draws; a removed chart is freed", async () => {
    const page = await app.open("/handwritten");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => {
      const fig = document.createElement("figure");
      fig.id = "added";
      fig.setAttribute("data-d3", "bar");
      fig.setAttribute("data-d3-data", '[["x", 3]]');
      document.body.append(fig);
    });
    await waitState(page, "added", "ready");
    await page.evaluate(() => {
      window.__added = document.getElementById("added").autumnD3;
      document.getElementById("added").remove();
    });
    await until(page, () => window.__added.destroyed);
    await assertClean(page);
  });

  test("attribute changes update and rebuild the chart", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const renders = await events(page, "chart", "d3:render");
    await page.evaluate(() => document.getElementById("chart").setAttribute("data-d3-data", '[["Apples", 60], ["Kiwis", 30]]'));
    await until(page, () => document.querySelectorAll("#chart .d3-bar").length === 2);
    assert.deepEqual(await texts(page, "chart", ".d3-axis-x .tick text"), ["Apples", "Kiwis"]);
    assert.equal(await page.locator("#chart .d3-axis-x").count(), 1, "a redraw reuses the axis");
    assert.ok((await events(page, "chart", "d3:render")) > renders);
    assert.equal(await events(page, "chart", "d3:ready"), 1, "an update is not a new chart");
    await page.evaluate(() => document.getElementById("chart").setAttribute("data-d3-horizontal", "true"));
    await until(page, () => document.querySelectorAll("#chart .d3-axis-y .tick text")[0]?.textContent === "Apples");
    await page.evaluate(() => document.getElementById("chart").setAttribute("data-d3", "pie"));
    await until(page, () => document.querySelectorAll("#chart .d3-arc").length === 2);
    assert.equal(await page.locator("#chart .d3-plot").count(), 1, "one plot after a rebuild");
    await assertClean(page);
  });

  test("the chart redraws when its box changes size", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const width = () => page.evaluate(() => Number(document.querySelector("#chart svg").getAttribute("width")));
    assert.ok(near(await width(), 600, 2));
    await page.evaluate(() => document.getElementById("chart").style.setProperty("width", "300px"));
    await until(page, () => Number(document.querySelector("#chart svg").getAttribute("width")) === 300);
    const bars = await boxes(page, "chart", ".d3-bar");
    assert.ok(bars.every((b) => b.x + b.width <= 16 + 300), "bars fit the new width");
    await assertClean(page);
  });

  test("htmx swaps start new charts and free old ones", async () => {
    const page = await app.open("/swap");
    await waitState(page, "first", "ready");
    await page.evaluate(() => (window.__first = document.getElementById("first").autumnD3));
    await page.click("#next");
    await waitState(page, "second", "ready");
    assert.equal(await page.locator("#second .d3-arc").count(), 3);
    await until(page, () => window.__first.destroyed);
    await assertClean(page);
  });
});

describe("failures", () => {
  test("each bad chart fails alone and keeps its fallback", async () => {
    const page = await app.open("/bad");
    await waitState(page, "good", "ready");
    for (const id of ["json", "shape", "kind", "nodata"]) await waitState(page, id, "error");
    const errors = await page.evaluate(() => window.__events.filter(([t]) => t === "d3:error").map(([, id]) => id));
    assert.deepEqual(errors.sort(), ["json", "kind", "nodata", "shape"]);
    const messages = await page.evaluate(() => window.__details.filter((d) => typeof d === "string"));
    assert.ok(messages.some((m) => /not valid JSON/.test(m)), messages.join("; "));
    assert.ok(messages.some((m) => /points must be an array/.test(m)), messages.join("; "));
    assert.ok(messages.some((m) => /unknown chart kind/.test(m)), messages.join("; "));
    assert.ok(messages.some((m) => /no data/.test(m)), messages.join("; "));
    assert.ok(await page.locator("#json .d3-table").isVisible(), "fallback stays visible");
    assert.equal(await page.locator("#chart .d3-axis-x").count(), 0);
    assert.equal(await page.locator("#json .d3-plot").count(), 0, "no empty plot");
    await waitState(page, "format", "ready");
    assert.ok((await texts(page, "format", ".d3-axis-y .tick text")).length > 0, "bad format uses the default");
    await waitState(page, "wide-format", "ready");
    const longest = await page.evaluate(() => Math.max(...[...document.querySelectorAll("#wide-format text")].map((t) => t.textContent.length)));
    assert.ok(longest < 100, `a huge format width falls back to the default: ${longest}`);
    assert.deepEqual(page.errors, []);
  });
});

describe("remote data", () => {
  test("data-d3-src loads same-origin JSON", async () => {
    const page = await app.open("/remote");
    await waitState(page, "chart", "ready");
    assert.equal(await page.locator("#chart .d3-bar").count(), 3);
    await until(page, () => document.querySelectorAll("#both .d3-bar").length === 3);
    await assertClean(page);
  });

  test("bad sources fail without a cross-origin request", async () => {
    const requests = [];
    const page = await app.open("/remote-bad", { onRequest: (url) => requests.push(url) });
    for (const id of ["missing", "cross", "html"]) await waitState(page, id, "error");
    assert.ok(requests.some((u) => u.includes("/data/missing.json")), "the recorder sees the page requests");
    const messages = await page.evaluate(() => window.__details.filter((d) => typeof d === "string"));
    assert.ok(messages.some((m) => /HTTP 404/.test(m)), messages.join("; "));
    assert.ok(messages.some((m) => /same origin/.test(m)), messages.join("; "));
    assert.ok(messages.some((m) => /JSON/.test(m)), messages.join("; "));
    assert.ok(!requests.some((u) => u.includes("example.com")), requests.join(" "));
  });

  test("refresh loads the data again, and stops on removal", async () => {
    const page = await app.open("/live");
    await waitState(page, "chart", "ready");
    const first = await page.evaluate(() => document.getElementById("chart").autumnD3.data[0].points[0][1]);
    await until(page, (first) => document.getElementById("chart").autumnD3.data[0].points[0][1] > first, first, 5000);
    let fetches = 0;
    page.on("request", (r) => r.url().includes("/data/live.json") && (fetches += 1));
    await page.evaluate(() => document.getElementById("chart").remove());
    await sleep(2500);
    assert.ok(fetches <= 1, `no polling after removal: ${fetches}`);
    await assertClean(page);
  });
});

describe("custom kinds", () => {
  test("registered kinds draw; late kinds wait; errors stay local", async () => {
    const page = await app.open("/custom");
    await waitState(page, "chart", "ready");
    assert.equal(await page.locator("#chart .custom-dot").count(), 3);
    assert.equal(await page.locator("#chart svg").getAttribute("aria-label"), "Dots");
    await waitState(page, "late", "pending");
    await waitState(page, "broken", "error");
    await page.evaluate(() =>
      window.AutumnD3.register("late", (ctx) => {
        ctx.svg.append("rect").attr("class", "late-mark").attr("width", ctx.width).attr("height", ctx.height);
      }),
    );
    await waitState(page, "late", "ready");
    assert.equal(await page.locator("#late .late-mark").count(), 1);
    const thrown = await page.evaluate(() =>
      [
        () => window.AutumnD3.register("bar", () => {}),
        () => window.AutumnD3.register("Bad Name", () => {}),
        () => window.AutumnD3.register("ok", 1),
      ].map((f) => {
        try {
          f();
          return null;
        } catch (error) {
          return error.name;
        }
      }),
    );
    assert.deepEqual(thrown, ["TypeError", "TypeError", "TypeError"]);
    assert.deepEqual(page.errors, []);
  });
});

describe("interaction", () => {
  test("hover and keys show a tooltip for bars", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const [, pears] = await boxes(page, "chart", ".d3-bar");
    await page.mouse.move(pears.x + pears.width / 2, pears.y + pears.height / 2);
    const tip = page.locator("#chart .d3-tooltip");
    await until(page, () => !document.querySelector("#chart .d3-tooltip").hidden);
    assert.equal(await tip.textContent(), "Pears: 60");
    assert.equal(await page.locator("#chart .d3-bar.d3-active").count(), 1);
    await page.mouse.move(1, 1);
    await until(page, () => document.querySelector("#chart .d3-tooltip").hidden);
    await page.focus("#chart svg");
    assert.equal(await tip.textContent(), "Apples: 30", "focus shows the first item");
    await page.keyboard.press("ArrowRight");
    assert.equal(await tip.textContent(), "Pears: 60");
    await page.keyboard.press("End");
    assert.equal(await tip.textContent(), "Plums: 15");
    await page.keyboard.press("ArrowRight");
    assert.equal(await tip.textContent(), "Plums: 15", "stays at the end");
    await page.keyboard.press("Home");
    assert.equal(await tip.textContent(), "Apples: 30");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tip.textContent(), "Apples: 30", "stays at the start");
    await page.keyboard.press("Escape");
    assert.equal(await tip.isHidden(), true);
    // Screen readers hear a separate live region; the visual box is hidden from them.
    assert.equal(await tip.getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#chart .d3-live").getAttribute("role"), "status");
    await assertClean(page);
  });

  test("line tooltips list every series at the x position", async () => {
    const page = await app.open("/line");
    await waitState(page, "chart", "ready");
    await page.focus("#chart svg");
    await page.keyboard.press("ArrowRight");
    const tip = page.locator("#chart .d3-tooltip");
    assert.equal(await tip.textContent(), "2026-01-02 · Web: 20 · App: —");
    // A vertical line has an empty box, so check the display attribute.
    const crosshair = () => page.locator("#chart .d3-crosshair").getAttribute("display");
    assert.equal(await crosshair(), null);
    const svg = await page.locator("#chart svg").boundingBox();
    await page.mouse.move(svg.x + svg.width - 20, svg.y + svg.height / 2);
    await until(page, () => document.querySelector("#chart .d3-tooltip").textContent.startsWith("2026-01-03"));
    await page.locator("#chart svg").blur();
    await page.mouse.move(1, 1);
    await until(page, () => document.querySelector("#chart .d3-tooltip").hidden);
    assert.equal(await crosshair(), "none");
    await assertClean(page);
  });

  test("pie and scatter tooltips", async () => {
    const page = await app.open("/pie");
    await waitState(page, "chart", "ready");
    await page.focus("#chart svg");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#chart .d3-tooltip").textContent(), "Pears: 60 (57%)");
    const scatter = await app.open("/scatter");
    await waitState(scatter, "chart", "ready");
    await scatter.focus("#chart svg");
    assert.equal(await scatter.locator("#chart .d3-tooltip").textContent(), "A · 1.0: 1");
  });
});

describe("motion and options", () => {
  test("reduced motion turns transitions off unless the chart opts in", async () => {
    const reduce = await app.open("/options");
    await waitState(reduce, "still", "ready");
    const duration = (page, id) => page.evaluate((id) => document.getElementById(id).autumnD3.duration, id);
    assert.equal(await duration(reduce, "wide"), 0);
    assert.equal(await duration(reduce, "animated"), 600);
    const motion = await app.open("/options", { reducedMotion: "no-preference" });
    await waitState(motion, "still", "ready");
    assert.equal(await duration(motion, "wide"), 400);
    assert.equal(await duration(motion, "still"), 0);
    // A transition runs: right after the first draw the bar is not yet full.
    await until(motion, () => document.querySelectorAll("#animated .d3-bar").length === 3);
    const early = (await boxes(motion, "animated", ".d3-bar"))[1].height;
    await sleep(900);
    const bars = await boxes(motion, "animated", ".d3-bar");
    assert.ok(early < bars[1].height * 0.95, `bars grow: ${early} then ${bars[1].height}`);
    assert.ok(near(bars[1].height, 2 * bars[0].height), "transitions end at the data");
    await assertClean(motion);
  });

  test("aspect, domain, legend, and table options", async () => {
    const page = await app.open("/options");
    await waitState(page, "wide", "ready");
    const plot = await page.locator("#wide .d3-plot").boundingBox();
    assert.ok(near(plot.width / plot.height, 4, 0.05), JSON.stringify(plot));
    const ticks = (await texts(page, "wide", ".d3-axis-y .tick text")).map((t) => Number(t.replace(/,/g, "")));
    assert.equal(Math.max(...ticks), 200, `y_max: ${ticks}`);
    await waitState(page, "nolegend", "ready");
    assert.equal(await page.locator("#nolegend .d3-legend").count(), 0);
    await waitState(page, "visible-table", "ready");
    assert.ok((await page.locator("#visible-table .d3-table").boundingBox()).height > 20, "d3-show-table");
  });

  test("empty data draws empty charts", async () => {
    const page = await app.open("/empty");
    for (const id of ["bar", "line", "pie"]) await waitState(page, id, "ready");
    assert.equal(await page.locator("#bar .d3-bar").count(), 0);
    assert.equal(await page.locator("#pie .d3-arc").count(), 0);
    await page.focus("#bar svg");
    assert.equal(await page.locator("#bar .d3-tooltip").isHidden(), true);
    await assertClean(page);
  });

  test("without JavaScript, the table shows", async () => {
    const page = await app.open("/bar", { javaScriptEnabled: false });
    const box = await page.locator("#chart .d3-table").boundingBox();
    assert.ok(box.height > 40, JSON.stringify(box));
    assert.equal(await page.locator("#chart .d3-plot").count(), 0);
  });
});

describe("handle", () => {
  test("update, render, and destroy", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["Solo", 5]]));
    assert.equal(await page.locator("#chart .d3-bar").count(), 1);
    const bad = await page.evaluate(() => {
      try {
        document.getElementById("chart").autumnD3.update({});
        return null;
      } catch (error) {
        return error.message;
      }
    });
    assert.match(bad, /array/);
    await page.evaluate(() => document.getElementById("chart").autumnD3.render());
    assert.equal(await page.locator("#chart .d3-bar").count(), 1);
    assert.equal(await page.evaluate(() => window.AutumnD3.get(document.getElementById("chart"))?.kind), "bar");
    await page.evaluate(() => document.getElementById("chart").autumnD3.destroy());
    assert.equal(await page.locator("#chart .d3-plot").count(), 0);
    assert.equal(await page.locator("#chart").getAttribute("data-d3-state"), null);
    assert.equal(await page.evaluate(() => window.AutumnD3.get(document.getElementById("chart"))), null);
    // scan() starts it again.
    await page.evaluate(() => window.AutumnD3.scan());
    await waitState(page, "chart", "ready");
    assert.equal(await page.evaluate(() => typeof window.AutumnD3.version), "string");
    await assertClean(page);
  });
});

describe("edge cases", () => {
  test("log scales, times, missing values, and size tokens", async () => {
    const page = await app.open("/edge");
    for (const id of ["log", "logarea", "emptylog", "xlog", "hours", "single", "allmissing", "ties", "fat", "badmax", "captioned"]) {
      await waitState(page, id, "ready");
    }
    // The log line drops -1 and keeps the y_min and y_max range.
    const log = await page.evaluate(() => document.querySelector("#log .d3-line").getAttribute("d"));
    assert.equal(log.match(/M/g).length, 1, log);
    assert.ok((await texts(page, "log", ".d3-axis-y .tick text")).length > 0);
    assert.equal(await page.locator("#xlog .d3-dot").count(), 1, "x log drops x = 0");
    await page.focus("#hours svg");
    assert.equal(await page.locator("#hours .d3-tooltip").textContent(), "2026-01-01 06:00 · s: 1");
    await page.focus("#allmissing svg");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator("#allmissing .d3-tooltip").textContent(), "2 · a: — · b: —");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("a");
    assert.equal(await page.locator("#allmissing .d3-tooltip").textContent(), "1 · a: 1 · b: 2");
    await page.focus("#ties svg");
    assert.equal(await page.locator("#ties .d3-tooltip").textContent(), "s · 1: 1");
    assert.ok(near((await boxes(page, "fat", ".d3-bar"))[0].width, 40), "--d3-bar-max");
    assert.ok(near((await boxes(page, "badmax", ".d3-bar"))[0].width, 24), "a bad --d3-bar-max gives 24");
    assert.equal(await page.locator("#captioned svg").getAttribute("aria-label"), "From the caption");
    await waitState(page, "captioned", "ready");
    assert.equal(await page.locator(".noid").getAttribute("data-d3-state"), "error");
    assert.deepEqual(page.errors, []);
  });

  test("pointer outside marks and on empty charts hides the tooltip", async () => {
    const page = await app.open("/pie");
    await waitState(page, "chart", "ready");
    const svg = await page.locator("#chart svg").boundingBox();
    await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
    assert.equal(await page.locator("#chart .d3-tooltip").isHidden(), true, "the donut hole has no slice");
    await page.mouse.move(svg.x + svg.width / 2, svg.y + 30);
    await until(page, () => !document.querySelector("#chart .d3-tooltip").hidden);
    const empty = await app.open("/empty");
    await waitState(empty, "bar", "ready");
    const box = await empty.locator("#bar svg").boundingBox();
    await empty.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await empty.focus("#bar svg");
    await empty.keyboard.press("ArrowRight");
    assert.equal(await empty.locator("#bar .d3-tooltip").isHidden(), true);
  });

  test("redraws keep the tooltip on a valid item; legends follow the data", async () => {
    const page = await app.open("/line");
    await waitState(page, "chart", "ready");
    await page.focus("#chart svg");
    await page.keyboard.press("End");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([{ name: "Web", points: [[0, 1]] }]));
    assert.equal(await page.locator("#chart .d3-tooltip").textContent(), "1970-01-01 · Web: 1");
    assert.equal(await page.locator("#chart .d3-legend").count(), 0, "one series: the legend goes");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([{ name: "a", points: [] }, { name: "b", points: [] }]));
    assert.equal(await page.locator("#chart .d3-legend").count(), 1);
    await page.evaluate(() => document.getElementById("chart").autumnD3.destroy());
    assert.equal(await page.locator("#chart .d3-legend").count(), 0, "destroy removes the legend");
  });

  test("pie and bar transitions run when motion is allowed", async () => {
    const page = await app.open("/pie", { reducedMotion: "no-preference" });
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["Apples", 1], ["Kiwis", 1]]));
    assert.ok((await page.locator("#chart .d3-arc").count()) > 2, "old slices are still fading");
    await sleep(800);
    assert.deepEqual(await texts(page, "chart", ".d3-legend li"), ["Apples", "Kiwis"]);
    assert.equal(await page.locator("#chart .d3-arc").count(), 2, "old slices fade out");
    await assertClean(page);
  });

  test("bad data after the first draw keeps the chart", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").setAttribute("data-d3-data", "{oops"));
    await until(page, () => window.__events.some(([t]) => t === "d3:error"));
    assert.equal(await page.locator("#chart").getAttribute("data-d3-state"), "ready");
    assert.equal(await page.locator("#chart .d3-bar").count(), 3);
  });

  test("attributes added later, and many changes in one tick", async () => {
    const page = await app.open("/handwritten");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.id = "late";
      div.setAttribute("data-d3-data", '[["x", 1]]');
      document.body.append(div);
    });
    await sleep(50);
    await page.evaluate(() => document.getElementById("late").setAttribute("data-d3", "bar"));
    await waitState(page, "late", "ready");
    await page.evaluate(() => {
      const el = document.getElementById("chart");
      el.setAttribute("data-d3-data", '[{"label":"p","value":2}]');
      el.setAttribute("data-d3", "pie");
    });
    await until(page, () => document.querySelectorAll("#chart .d3-arc").length === 1);
    await page.evaluate(() => {
      const el = document.getElementById("chart");
      el.setAttribute("data-d3-label", "x");
      el.removeAttribute("data-d3");
    });
    await until(page, () => !document.getElementById("chart").autumnD3);
    assert.equal(await page.locator("#chart .d3-plot").count(), 0);
    await assertClean(page);
  });

  test("a chart removed while its data loads makes no error", async () => {
    const page = await app.open("/slow");
    await waitState(page, "chart", "loading");
    await page.evaluate(() => {
      // Events from a detached element do not reach the document: listen on
      // the elements themselves.
      window.__detached = [];
      window.__handles = [];
      for (const id of ["chart", "inline"]) {
        const el = document.getElementById(id);
        el.addEventListener("d3:error", () => window.__detached.push(id));
        el.addEventListener("d3:render", () => window.__detached.push(`${id} render`));
        window.__handles.push(el.autumnD3);
        el.remove();
      }
    });
    await sleep(1200);
    assert.deepEqual(await page.evaluate(() => window.__detached), [], "no error and no draw after removal");
    assert.deepEqual(await page.evaluate(() => window.__handles.map((h) => h.destroyed)), [true, true]);
    assert.deepEqual(page.errors, []);
  });

  test("init.js without d3.min.js reports the load order", async () => {
    const page = await app.open("/no-d3");
    await until(page, () => document.readyState === "complete");
    await sleep(50);
    assert.ok(page.errors.some((e) => e.includes("load d3.min.js and parse.js before init.js")), page.errors.join("; "));
  });
});

describe("review regressions", () => {
  test("a resize during a transition wins over the transition", async () => {
    const page = await app.open("/bar", { reducedMotion: "no-preference" });
    await waitState(page, "chart", "ready");
    await sleep(500);
    await page.evaluate(() => {
      const el = document.getElementById("chart");
      el.setAttribute("data-d3-duration", "1500");
    });
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["Apples", 10], ["Pears", 20], ["Plums", 40]]));
    await page.evaluate(() => document.getElementById("chart").style.setProperty("width", "300px"));
    await sleep(1800);
    const bars = await boxes(page, "chart", ".d3-bar");
    assert.ok(bars.every((b) => b.x + b.width <= 16 + 300), `bars fit the new width: ${JSON.stringify(bars)}`);
  });

  test("a mark that comes back during its fade is fully opaque", async () => {
    const page = await app.open("/bar", { reducedMotion: "no-preference" });
    await waitState(page, "chart", "ready");
    await sleep(500);
    const handle = () => document.getElementById("chart").autumnD3;
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["Apples", 30], ["Plums", 15]]));
    await sleep(150);
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["Apples", 30], ["Pears", 60], ["Plums", 15]]));
    await sleep(700);
    const opacity = await page.evaluate(() => [...document.querySelectorAll("#chart .d3-bar")].map((b) => getComputedStyle(b).opacity));
    assert.deepEqual(opacity, ["1", "1", "1"]);
    void handle;
  });

  test("scatter points with the same x keep their own dots", async () => {
    const page = await app.open("/scatter");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([{ name: "s", points: [[1, 1], [1, 5], [2, 3]] }]));
    assert.equal(await page.locator("#chart .d3-dot").count(), 3);
    await page.focus("#chart svg");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#chart .d3-tooltip").textContent(), "s · 1.0: 5");
    const active = await page.evaluate(() => document.querySelector("#chart .d3-dot.d3-active")?.getBoundingClientRect().y);
    const top = await page.evaluate(() => Math.min(...[...document.querySelectorAll("#chart .d3-dot")].map((d) => d.getBoundingClientRect().y)));
    assert.ok(near(active, top), "the dot at y = 5 is active");
  });

  test("a destroyed chart stays destroyed", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const message = await page.evaluate(() => {
      const h = document.getElementById("chart").autumnD3;
      h.destroy();
      h.render();
      try {
        h.update([["x", 1]]);
        return null;
      } catch (error) {
        return error.message;
      }
    });
    assert.match(message, /destroyed/);
    assert.equal(await page.locator("#chart .d3-plot").count(), 0);
    assert.equal(await page.locator("#chart").getAttribute("data-d3-state"), null);
  });

  test("registering a kind twice keeps one refresh loop, which stops on removal", async () => {
    const page = await app.open("/handwritten");
    await waitState(page, "chart", "ready");
    let fetches = 0;
    page.on("request", (r) => r.url().includes("/data/live.json") && (fetches += 1));
    await page.evaluate(() => {
      const fig = document.createElement("figure");
      fig.id = "twice";
      fig.setAttribute("data-d3", "twice");
      fig.setAttribute("data-d3-src", "/data/live.json");
      fig.setAttribute("data-d3-refresh", "1000");
      document.body.append(fig);
    });
    await sleep(100);
    await page.evaluate(() => {
      window.AutumnD3.register("twice", () => {});
      window.AutumnD3.register("twice", () => {});
    });
    await sleep(3500);
    assert.ok(fetches <= 5, `one loop: ${fetches} fetches in 3.5 s`);
    await page.evaluate(() => document.getElementById("twice").remove());
    await sleep(200);
    const after = fetches;
    await sleep(2500);
    assert.equal(fetches, after, "no fetches after removal");
  });

  test("a second copy of init.js does not draw charts twice", async () => {
    const page = await app.open("/handwritten");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = document.querySelector('script[src*="/_plugins/d3/init."]').src;
      document.head.append(script);
    });
    await sleep(300);
    await page.evaluate(() => {
      const fig = document.createElement("figure");
      fig.id = "added";
      fig.setAttribute("data-d3", "bar");
      fig.setAttribute("data-d3-data", '[["x", 3]]');
      document.body.append(fig);
    });
    await waitState(page, "added", "ready");
    await sleep(100);
    assert.equal(await page.locator("#added .d3-plot").count(), 1);
  });
});

describe("accessibility review", () => {
  /** Rows of the data table in `#id`, as arrays of cell text. */
  const rows = (page, id) =>
    page.evaluate((id) => [...document.querySelectorAll(`#${id} .d3-table tbody tr`)].map((tr) => [...tr.children].map((c) => c.textContent)), id);

  test("the data table follows loaded and updated data", async () => {
    const page = await app.open("/remote");
    await waitState(page, "chart", "ready");
    assert.deepEqual(await rows(page, "chart"), [["Apples", "30"], ["Pears", "60"], ["Plums", "15"]]);
    await until(page, () => document.querySelectorAll("#both .d3-bar").length === 3);
    assert.deepEqual((await rows(page, "both")).map((r) => r[0]), ["Apples", "Pears", "Plums"]);
    await page.evaluate(() => document.getElementById("chart").setAttribute("data-d3-data", '[["Kiwis", 5]]'));
    await until(page, () => document.querySelector("#chart .d3-table tbody tr th")?.textContent === "Kiwis");
    const line = await app.open("/line");
    await waitState(line, "chart", "ready");
    await line.evaluate(() => document.getElementById("chart").autumnD3.update([{ name: "N", points: [[0, 2]] }]));
    assert.deepEqual(await rows(line, "chart"), [["N", "1970-01-01", "2"]]);
    assert.equal(await line.locator("#chart .d3-table caption").textContent(), "Visits");
  });

  test("dark theme gives the tooltip a dark surface", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.focus("#chart svg");
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector("#chart .d3-tooltip")).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    assert.ok(r + g + b < 3 * 80, `dark tooltip background: ${bg}`);
  });

  test("the tooltip stays inside the plot", async () => {
    const page = await app.open("/line");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").style.setProperty("width", "220px"));
    await until(page, () => Number(document.querySelector("#chart svg").getAttribute("width")) === 220);
    await page.focus("#chart svg");
    for (const key of ["Home", "End"]) {
      await page.keyboard.press(key);
      const plot = await page.locator("#chart .d3-plot").boundingBox();
      const tip = await page.locator("#chart .d3-tooltip").boundingBox();
      assert.ok(tip.x >= plot.x - 1 && tip.x + tip.width <= plot.x + plot.width + 1, `${key}: ${JSON.stringify({ plot, tip })}`);
      assert.ok(tip.y >= plot.y - 1, `${key}: not above the plot: ${JSON.stringify({ plot, tip })}`);
    }
  });

  test("keyboard hint, live region, Escape, and no tab stop without items", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    const hint = await page.evaluate(() => {
      const id = document.querySelector("#chart svg").getAttribute("aria-describedby");
      return document.getElementById(id)?.textContent;
    });
    assert.match(hint, /arrow keys/);
    await page.focus("#chart svg");
    assert.equal(await page.locator("#chart .d3-live").textContent(), "Apples: 30");
    const [bar] = await boxes(page, "chart", ".d3-bar");
    await page.locator("#chart svg").blur();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await until(page, () => !document.querySelector("#chart .d3-tooltip").hidden);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#chart .d3-tooltip").isHidden(), true, "Escape hides a hover tooltip");
    const empty = await app.open("/empty");
    await waitState(empty, "bar", "ready");
    assert.equal(await empty.locator("#bar svg").getAttribute("tabindex"), null);
    const custom = await app.open("/custom");
    await waitState(custom, "chart", "ready");
    assert.equal(await custom.locator("#chart svg").getAttribute("tabindex"), null);
  });

  test("empty charts say so", async () => {
    const page = await app.open("/empty");
    for (const id of ["bar", "pie"]) {
      await waitState(page, id, "ready");
      assert.equal(await page.locator(`#${id} .d3-empty`).textContent(), "No data");
      assert.match(await page.locator(`#${id} svg`).getAttribute("aria-label"), /No data$/);
    }
    const bar = await app.open("/bar");
    await waitState(bar, "chart", "ready");
    assert.equal(await bar.locator("#chart .d3-empty").count(), 0);
  });

  test("dense band axes thin their labels; axis text is 12px", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#chart .d3-axis-x text")).fontSize), "12px");
    await page.evaluate(() => {
      const el = document.getElementById("chart");
      el.style.setProperty("width", "300px");
      el.autumnD3.update(Array.from({ length: 30 }, (_, i) => [`Label ${i + 1}`, i + 1]));
    });
    await until(page, () => document.querySelectorAll("#chart .d3-bar").length === 30);
    await until(page, () => Number(document.querySelector("#chart svg").getAttribute("width")) === 300);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll("#chart .d3-axis-x .tick")]
        .filter((t) => getComputedStyle(t).display !== "none")
        .map((t) => t.getBoundingClientRect()),
    );
    assert.ok(labels.length < 30 && labels.length > 1, `thinned: ${labels.length}`);
    for (let i = 1; i < labels.length; i += 1) assert.ok(labels[i].x >= labels[i - 1].x + labels[i - 1].width, "no overlap");
  });

  test("more than 8 series warns; legends are lists; forced colors keep swatches", async () => {
    const page = await app.open("/line", { forcedColors: "active" });
    await waitState(page, "chart", "ready");
    assert.equal(await page.locator("#chart .d3-legend").getAttribute("role"), "list");
    const swatch = await page.evaluate(() => getComputedStyle(document.querySelector("#chart .d3-swatch")).backgroundColor);
    assert.equal(swatch, "rgb(42, 120, 214)", "slot 1 color in forced colors");
    await page.evaluate(() =>
      document.getElementById("chart").autumnD3.update(Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, points: [[0, i]] }))),
    );
    assert.ok((await page.evaluate(() => window.__warnings)).some((w) => /9 series/.test(w)));
  });
});

describe("security review", () => {
  test("an element with id AutumnD3 does not stop the runtime", async () => {
    const page = await app.open("/clobber");
    await waitState(page, "chart", "ready");
    assert.equal(await page.evaluate(() => typeof window.AutumnD3.register), "function");
  });

  test("data-d3-src fails on a cross-origin redirect; failures back off", async () => {
    let fetches = 0;
    const page = await app.open("/remote-redirect", { onRequest: (url) => url.includes("/data/missing.json") && (fetches += 1) });
    await waitState(page, "chart", "error");
    await waitState(page, "failing", "error");
    await sleep(3500);
    assert.ok(fetches <= 2, `backoff after failures: ${fetches} fetches in 3.5 s`);
  });

  test("refresh pauses while the page is hidden", async () => {
    const page = await app.open("/live", {
      init: () => {
        window.__hidden = false;
        Object.defineProperty(Document.prototype, "hidden", { get: () => window.__hidden, configurable: true });
      },
    });
    await waitState(page, "chart", "ready");
    let fetches = 0;
    page.on("request", (r) => r.url().includes("/data/live.json") && (fetches += 1));
    await page.evaluate(() => (window.__hidden = true));
    await sleep(2500);
    assert.ok(fetches <= 1, `no refresh while hidden: ${fetches}`);
    const before = fetches;
    await page.evaluate(() => {
      window.__hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(600);
    assert.ok(fetches > before, "refresh resumes when visible");
  });
});

describe("test review", () => {
  test("a refresh that fails after the first draw keeps the chart and keeps polling", async () => {
    const page = await app.open("/live");
    await waitState(page, "chart", "ready");
    // Route the next requests to a 500 answer.
    await page.route("**/data/live.json", (route) => route.fulfill({ status: 500, body: "no" }));
    await until(page, () => window.__events.some(([t]) => t === "d3:error"), undefined, 5000);
    assert.equal(await page.locator("#chart").getAttribute("data-d3-state"), "ready");
    assert.equal(await page.locator("#chart .d3-line").count(), 1);
    await page.unroute("**/data/live.json");
    const renders = await events(page, "chart", "d3:render");
    await until(page, (n) => window.__events.filter(([t]) => t === "d3:render").length > n, renders, 6000);
  });

  test("dark color scheme uses the dark palette steps", async () => {
    const page = await app.open("/line", { colorScheme: "dark" });
    await waitState(page, "chart", "ready");
    const stroke = await page.evaluate(() => getComputedStyle(document.querySelector("#chart .d3-line")).stroke);
    assert.equal(stroke, "rgb(57, 135, 229)", "dark slot 1 is #3987e5");
    const light = await app.open("/line", { colorScheme: "light" });
    await waitState(light, "chart", "ready");
    assert.equal(await light.evaluate(() => getComputedStyle(document.querySelector("#chart .d3-line")).stroke), "rgb(42, 120, 214)");
  });

  test("repeated labels draw as separate bars", async () => {
    const page = await app.open("/bar");
    await waitState(page, "chart", "ready");
    await page.evaluate(() => document.getElementById("chart").autumnD3.update([["a", 1], ["a", 2]]));
    assert.equal(await page.locator("#chart .d3-bar").count(), 2);
    assert.deepEqual(await texts(page, "chart", ".d3-axis-x .tick text"), ["a", "a"]);
    await assertClean(page);
  });
});
