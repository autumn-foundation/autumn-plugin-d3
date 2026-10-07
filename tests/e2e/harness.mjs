// E2E harness: starts the e2e_fixture app and a headless Chromium.
//
// The fixture binary must exist: `cargo build --example e2e_fixture`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";

/** Path of a built example binary. */
const binary = (name) => new URL(`../../target/debug/examples/${name}`, import.meta.url).pathname;

/** Returns a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Polls `url` until it answers. */
async function waitForHttp(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fixture did not start: ${url}`);
}

/**
 * Merges V8 block coverage of plugin files. A byte counts as run when the
 * innermost range that holds it has a count above zero, in any page.
 */
const coverage = new Map(); // file name → { source, run: Uint8Array }

function addCoverage(entries) {
  for (const entry of entries) {
    const name = entry.url.match(/\/static\/_plugins\/d3\/([a-z]+)(?:\.[0-9a-f]{8})?\.js$/i)?.[1];
    if (!name || !["init", "parse"].includes(name) || !entry.source) continue;
    const file = coverage.get(name) ?? { source: entry.source, run: new Uint8Array(entry.source.length) };
    coverage.set(name, file);
    const local = new Int8Array(entry.source.length).fill(-1);
    // Outer ranges first; inner ranges overwrite them.
    const ranges = entry.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) local.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    local.forEach((v, i) => v === 1 && (file.run[i] = 1));
  }
}

/**
 * Strict line coverage of a plugin file: `{ percent, uncovered }`. A code
 * line counts as run only when every non-space byte on it ran. Comment and
 * closing-bracket lines do not count.
 */
export function lineCoverage(name) {
  const file = coverage.get(name);
  if (!file) return null;
  let offset = 0;
  let code = 0;
  let inComment = false;
  const uncovered = [];
  file.source.split("\n").forEach((line, index) => {
    const text = line.trim();
    const comment = inComment || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
    if (text.startsWith("/*")) inComment = !text.includes("*/");
    else if (inComment && text.includes("*/")) inComment = false;
    if (text !== "" && !comment && !/^[})\];,]+$/.test(text)) {
      code += 1;
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== " " && !file.run[offset + i]) {
          uncovered.push(index + 1);
          break;
        }
      }
    }
    offset += line.length + 1;
  });
  return { percent: (100 * (code - uncovered.length)) / code, uncovered };
}

/** Records events, CSP violations, and errors in every page. */
const RECORDER = () => {
  window.__events = [];
  window.__csp = [];
  window.__warnings = [];
  window.__details = [];
  for (const type of ["d3:ready", "d3:error", "d3:render"]) {
    document.addEventListener(type, (e) => {
      window.__events.push([type, e.target.id]);
      window.__details.push(type === "d3:error" ? String(e.detail?.error?.message) : e.detail === e.target.autumnD3);
    }, true);
  }
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  const warn = console.warn.bind(console);
  console.warn = (...args) => {
    window.__warnings.push(args.map(String).join(" "));
    warn(...args);
  };
};

/**
 * Starts an example app (default: the fixture) and the browser. `env` adds
 * environment variables. `example` names the binary; `ready` is a path
 * that answers when the app is up.
 * The harness writes `toml` to `autumn.toml` in a temp dir
 * (AUTUMN_MANIFEST_DIR).
 * Returns `{ base, open, close }`.
 */
export async function start({ env = {}, toml = null, example = "e2e_fixture", ready = "/bar" } = {}) {
  const BINARY = binary(example);
  if (toml !== null) {
    const dir = mkdtempSync(join(tmpdir(), "d3-e2e-"));
    writeFileSync(join(dir, "autumn.toml"), toml);
    env = { ...env, AUTUMN_MANIFEST_DIR: dir };
  }
  if (!existsSync(BINARY)) {
    throw new Error(`missing ${BINARY}: run cargo build --example ${example}`);
  }
  const port = await freePort();
  const child = spawn(BINARY, [], {
    env: { ...process.env, AUTUMN_SERVER__PORT: String(port), AUTUMN_SERVER__HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForHttp(`${base}${ready}`, child);
    browser = await chromium.launch();
  } catch (error) {
    // Kill the fixture, or it keeps the test process alive.
    child.kill();
    throw new Error(`${error.message}\n${stderr}`);
  }
  const contexts = [];
  const pages = [];

  /**
   * Opens `path` in a fresh context. Options: Playwright context options,
   * plus `init` (a function to run before page scripts). The default
   * context asks for reduced motion, so charts draw without transitions.
   */
  async function open(path, { init, ...options } = {}) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce", ...options });
    contexts.push(context);
    const page = await context.newPage();
    if (options.javaScriptEnabled !== false) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      pages.push(page);
    }
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(RECORDER);
    if (init) await page.addInitScript(init);
    await page.goto(`${base}${path}`);
    page.errors = errors;
    return page;
  }

  async function close() {
    for (const page of pages) {
      if (!page.isClosed()) addCoverage(await page.coverage.stopJSCoverage().catch(() => []));
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    child.kill();
  }

  return { base, open, close };
}

/** Waits `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn(arg)` in the page until it returns a truthy value. It polls
 * from Node: the page CSP blocks the `eval` that `page.waitForFunction`
 * needs.
 */
export async function until(page, fn, arg, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg).catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${fn}`);
    await sleep(25);
  }
}

/** Waits until `#id` has `data-d3-state` equal to `state`. */
export function waitState(page, id, state, timeout) {
  return until(
    page,
    ([id, state]) => document.getElementById(id)?.getAttribute("data-d3-state") === state,
    [id, state],
    timeout,
  );
}
