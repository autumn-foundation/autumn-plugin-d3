// E2E: the demo app draws every chart with no errors.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { start, until } from "./harness.mjs";

let app;
before(async () => {
  app = await start({ example: "d3_demo", ready: "/" });
});
after(async () => {
  await app?.close();
});

test("demo: all charts draw, the htmx swap works, the live chart refreshes", async () => {
  const page = await app.open("/", { viewport: { width: 1200, height: 900 } });
  await until(page, () => {
    const charts = [...document.querySelectorAll("[data-d3]")];
    return charts.length === 7 && charts.every((c) => c.getAttribute("data-d3-state") === "ready");
  });
  assert.equal(await page.locator("#sales .d3-bar").count(), 12);
  await page.click("text=2025");
  await until(page, () => document.querySelector("#sales svg")?.getAttribute("aria-label") === "Monthly sales, 2025");
  const live = () => page.evaluate(() => document.querySelector('[data-d3-src="/api/live.json"]').autumnD3.data[0].points[0][0]);
  const first = await live();
  await until(page, (first) => document.querySelector('[data-d3-src="/api/live.json"]').autumnD3.data[0].points[0][0] > first, first, 6000);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(page.errors, []);
});
