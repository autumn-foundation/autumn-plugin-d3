// E2E: the plugin works under the default CSP and under nonce mode.
// In nonce mode `style-src` and `script-src` allow 'self' + nonce only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { start, waitState } from "./harness.mjs";

let app;
before(async () => {
  // autumn-web 0.8.0 does not read AUTUMN_SECURITY__HEADERS__CSP_NONCE__ENABLED,
  // so use autumn.toml.
  app = await start({ toml: "[security.headers.csp_nonce]\nenabled = true\n" });
});
after(async () => {
  await app?.close();
});

test("nonce mode: the CSP is strict and every chart kind draws", async () => {
  const response = await fetch(`${app.base}/bar`);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.match(csp, /style-src 'self' 'nonce-/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

  for (const [path, ids] of [
    ["/bar", ["chart"]],
    ["/line", ["chart"]],
    ["/scatter", ["chart"]],
    ["/pie", ["chart"]],
    ["/options", ["wide", "animated"]],
    ["/custom", ["chart"]],
    ["/remote", ["chart"]],
  ]) {
    const page = await app.open(path, { reducedMotion: "no-preference" });
    for (const id of ids) await waitState(page, id, "ready");
    // Hover a chart: the tooltip position is a CSSOM write.
    const box = await page.locator(`#${ids[0]} svg`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual(await page.evaluate(() => window.__csp), [], `${path}: no CSP violations`);
    assert.deepEqual(page.errors, [], `${path}: no page errors`);
  }
});
