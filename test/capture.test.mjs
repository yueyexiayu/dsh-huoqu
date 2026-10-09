import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import vm from "node:vm";

// Exercise the existing transaction directly without starting a browser.
import { capturePage, createOutputStage, finalizeStage } from "../lib/capture.js";

async function temporaryDirectory(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "huoqu-capture-test-"));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function previousCapture(dir) {
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "old.css"), "original asset");
  await fs.writeFile(path.join(dir, "index.html"), "original page");
  await fs.writeFile(path.join(dir, "index.mhtml"), "original archive");
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ sourceUrl: "https://example.test/", resources: [{ path: "assets/old.css" }] }));
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({
    source: { url: "https://example.test/" }, capturedAt: new Date().toISOString(),
    archive: { path: "index.mhtml" }, localCopy: { htmlPath: "index.html" }, offlineValidation: { result: "passed" },
  }));
}

test("capture rejects an ordinary website directory even when its filenames match", async () => {
  await temporaryDirectory(async (dir) => {
    await fs.mkdir(path.join(dir, "assets"));
    await fs.writeFile(path.join(dir, "index.html"), "user website");
    await assert.rejects(createOutputStage(dir), /归属|huoqu/);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "user website");
  });
});

test("failed promotion restores previous page and nonempty assets", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const stage = await createOutputStage(dir);
    await fs.mkdir(path.join(stage, "assets"));
    await fs.writeFile(path.join(stage, "assets", "new.css"), "replacement asset");
    await fs.writeFile(path.join(stage, "index.html"), "replacement page");
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (from === path.join(stage, "index.html")) throw new Error("injected promotion failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(finalizeStage(stage, dir), /injected promotion failure/); }
    finally { fs.rename = originalRename; syncBuiltinESMExports(); }
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "original page");
    assert.deepEqual(await fs.readdir(path.join(dir, "assets")), ["old.css"]);
    assert.equal(await fs.readFile(path.join(dir, "assets", "old.css"), "utf8"), "original asset");
  });
});

test("rollback failure retains old assets in the named recovery directory", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const stage = await createOutputStage(dir);
    await fs.mkdir(path.join(stage, "assets"));
    await fs.writeFile(path.join(stage, "assets", "new.css"), "new");
    await fs.writeFile(path.join(stage, "index.html"), "new");
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (from === path.join(stage, "index.html")) throw new Error("injected promotion failure");
      if (from.includes(".huoqu-replaced-") && path.basename(from) === "assets") throw new Error("injected rollback failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(finalizeStage(stage, dir), /回滚失败，旧文件保留于/); }
    finally { fs.rename = originalRename; syncBuiltinESMExports(); }
    const backup = (await fs.readdir(dir)).find((name) => name.startsWith(".huoqu-replaced-"));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(dir, backup, "assets", "old.css"), "utf8"), "original asset");
  });
});

test("capture rejects symlinks and unlisted files inside previous assets", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    await fs.symlink(path.join(dir, "index.html"), path.join(dir, "assets", "old.css.tmp"));
    await assert.rejects(createOutputStage(dir), /归属/);
    await fs.rm(path.join(dir, "assets", "old.css.tmp"));
    await fs.writeFile(path.join(dir, "assets", "notes.txt"), "unrelated user data");
    await assert.rejects(createOutputStage(dir), /归属/);
  });
});

test("capture allows empty directories and leaves Finder metadata unchanged", async () => {
  await temporaryDirectory(async (dir) => {
    await fs.writeFile(path.join(dir, ".DS_Store"), "Finder metadata");
    const stage = await createOutputStage(dir);
    await fs.writeFile(path.join(stage, "index.html"), "captured page");
    await finalizeStage(stage, dir);
    assert.equal(await fs.readFile(path.join(dir, ".DS_Store"), "utf8"), "Finder metadata");
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "captured page");
  });
});

test("cancelled capture rejects without creating or modifying the requested output", async () => {
  await temporaryDirectory(async (dir) => {
    const output = path.join(dir, "not-created");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(capturePage({ url: "https://example.test/", output_dir: output }, controller.signal), /cancelled/);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("output guard denies directory creation before any mutation", async () => {
  await temporaryDirectory(async (dir) => {
    const output = path.join(dir, "denied");
    const access = { assertWrite: async (...paths) => {
      assert.deepEqual(paths, [output]);
      throw new Error("POLICY_DENIED");
    } };
    await assert.rejects(createOutputStage(output, access), /POLICY_DENIED/);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("transaction guards both rename endpoints and policy rejection restores old files", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const stage = await createOutputStage(dir);
    await fs.writeFile(path.join(stage, "index.html"), "new page");
    const checks = [];
    const access = { assertWrite: async (...paths) => {
      checks.push(paths);
      if (paths[0] === path.join(stage, "index.html")) throw new Error("PROMOTION_POLICY_DENIED");
    } };
    await assert.rejects(finalizeStage(stage, dir, access), /PROMOTION_POLICY_DENIED/);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "original page");
    assert.ok(checks.some(([from, to]) => from === path.join(dir, "index.html") && to?.includes(".huoqu-replaced-")));
    assert.ok(checks.some(([from, to]) => from.includes(".huoqu-replaced-") && to === path.join(dir, "index.html")));
    assert.ok(checks.some(([from, to]) => from === path.join(stage, "index.html") && to === path.join(dir, "index.html")));
  });
});

// Import the actual capture implementation; substitute only browser I/O and
// rendering waits, keeping capturePage, cleanup, filesystem and locks intact.
async function captureHarness() {
  const moduleUrl = new URL("../lib/capture.js", import.meta.url);
  const source = (await fs.readFile(moduleUrl, "utf8")).replace(/from "(\.\.?\/[^\"]+)"/g,
    (_, relative) => `from ${JSON.stringify(new URL(relative, moduleUrl).href)}`);
  const hooks = `\nexport { openChrome, stopChrome, OUTPUT_LOCKS, readDocumentHtml };
    export function useLaunch(reserve) {
      chromePath = async () => '/fixture/chrome';
      reservePort = reserve;
      delay = async () => {};
    }
    export function useBrowser(browser) {
      openBrowser = async () => browser;
      delay = async () => {};
      settlePage = async () => ({ scrollHeight: 100, scrollSteps: 1 });
      waitForNetworkQuiet = async () => {};
    }
    export function useResolver(fn) { resolveHostname = fn; }`;
  return import(`data:text/javascript;base64,${Buffer.from(source + hooks).toString("base64")}#${Math.random()}`);
}

for (const size of ["short", "chunked"]) {
  for (const [label, doctype, declaration, prefix] of [
    ["HTML5", { name: "html", publicId: "", systemId: "" }, "<!DOCTYPE html>", "<!DOCTYPE html>\n"],
    ["traditional PUBLIC/SYSTEM", { name: "html", publicId: "-//W3C//DTD HTML 4.01 Transitional//EN", systemId: "http://www.w3.org/TR/html4/loose.dtd" },
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">\n'],
    ["absent DOCTYPE", null, "", ""],
  ]) {
    test(`readDocumentHtml preserves ${label} on the ${size} path`, async () => {
      const mod = await captureHarness();
      const html = `<html><body>${size === "chunked" ? "Large page boundary content. ".repeat(14000) : "A meaningful small document."}</body></html>`;
      const expected = prefix + html;
      const expressions = [];
      let serializations = 0;
      const context = vm.createContext({
        document: { doctype, documentElement: { outerHTML: html } },
        XMLSerializer: class {
          serializeToString(node) {
            assert.equal(node, doctype);
            assert.notEqual(node, null);
            serializations++;
            return declaration;
          }
        },
      });
      const cdp = {
        async send(method, params, sessionId) {
          assert.equal(method, "Runtime.evaluate");
          assert.equal(sessionId, "doctype-fixture");
          expressions.push(params.expression);
          return { result: { value: vm.runInContext(params.expression, context) } };
        },
      };
      const actual = await mod.readDocumentHtml(cdp, "doctype-fixture");
      assert.equal(actual.length, expected.length, "serialized output must include exactly the original declaration");
      assert.equal(actual, expected);
      assert.equal((actual.match(/<!DOCTYPE/g) || []).length, doctype ? 1 : 0);
      assert.equal(serializations > 0, doctype !== null);
      assert.equal(expressions.length, size === "chunked" ? 1 + Math.ceil(expected.length / 180000) : 2);
    });
  }
}

function fixtureBrowser({ closeError, navigationError, html = `<html><body>${"Fixture content. ".repeat(100)}</body></html>`, mode = "extension", snapshot = "", summary: summaryOverrides = {}, responses = [] } = {}) {
  const state = { closes: 0, navigations: 0, stopped: 0 };
  const listeners = new Set();
  const browser = {
    mode,
    close: async () => { state.closes++; if (closeError) throw new Error(closeError); },
    cdp: {
      close: async () => { state.closes++; if (closeError) throw new Error(closeError); },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      waitForEvent: async () => ({}),
      send: async (method, params) => {
        if (method === "Target.createTarget") return { targetId: "fixture" };
        if (method === "Target.attachToTarget") return { sessionId: "fixture" };
        if (method === "Target.closeTarget") throw new Error("unsupported by extension");
        if (method === "Page.stopLoading") { state.stopped++; return {}; }
        if (method === "Page.navigate") {
          state.navigations++;
          if (navigationError) throw new Error(navigationError);
          for (const event of responses) for (const listener of listeners) listener({ sessionId: "fixture", ...event });
        }
        if (method === "Page.captureSnapshot") return { data: snapshot };
        if (method === "Page.captureScreenshot") return { data: Buffer.from("fixture image").toString("base64") };
        if (method === "Runtime.evaluate") {
          const summary = { url: "https://example.test/", title: "Fixture", viewport: { width: 1440, height: 1000 },
            document: { width: 1440, height: 1000, htmlBytes: html.length, textLength: html.replace(/<[^>]*>/g, "").length },
            images: [], stylesheets: [], scripts: 0, ...summaryOverrides };
          return { result: { value: params.expression.includes("textSample:") ? summary : html } };
        }
        return {};
      },
    },
  };
  return { browser, state };
}

function smallSnapshot(body, type = "text/html") {
  return `Content-Type: multipart/related; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: ${type}\r\nContent-Location: https://example.test/\r\n\r\n${body}\r\n--fixture--\r\n`;
}

for (const mode of ["extension", "headless"]) {
  test(`meaningful short HTML and small MHTML complete through ${mode} capture`, async () => {
    await temporaryDirectory(async (dir) => {
      const html = "<html><body>A small page with enough meaningful text to archive.</body></html>";
      const snapshot = smallSnapshot(html);
      assert.ok(Buffer.byteLength(snapshot) < 1000);
      const mod = await captureHarness();
      const { browser, state } = fixtureBrowser({ mode, html, snapshot });
      mod.useBrowser(browser);
      const result = await mod.capturePage({ url: "https://example.test/", output_dir: dir });
      assert.equal(result.status, "completed");
      assert.match(await fs.readFile(path.join(dir, "index.html"), "utf8"), /enough meaningful text/);
      const report = JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8"));
      assert.equal(report.offlineValidation.result, "passed");
      assert.ok(report.archive.bytes < 1000);
      assert.equal(state.navigations, 3);
      assert.equal(mod.OUTPUT_LOCKS.size, 0);
    });
  });
}

for (const [label, options, error] of [
  ["blank source", { html: "<html><body></body></html>" }, /未加载出可用内容/],
  ["challenge source", { summary: { title: "Just a moment..." } }, /人机验证/],
  ["denied source", { html: "<html><body>Access Denied for this resource.</body></html>", summary: { title: "Access Denied" } }, /拒绝/],
  ["non-HTTP source", { summary: { url: "file:///fixture.html" } }, /非网页地址/],
  ["malformed snapshot", { mode: "headless", snapshot: "not MHTML" }, /invalid MHTML/],
  ["snapshot without boundary", { mode: "headless", snapshot: "Content-Type: multipart/related\r\n\r\nbody" }, /boundary is missing/],
  ["snapshot without parts", { mode: "headless", snapshot: "Content-Type: multipart/related; boundary=fixture\r\n\r\n--fixture--\r\n" }, /no MIME parts/],
  ["snapshot without HTML", { mode: "headless", snapshot: smallSnapshot("plain text", "text/plain") }, /HTML page part/],
  ["empty HTML snapshot", { mode: "headless", snapshot: smallSnapshot("") }, /有效页面 HTML/],
  ["whitespace HTML snapshot", { mode: "headless", snapshot: smallSnapshot(" \r\n\t ") }, /有效页面 HTML/],
  ["empty snapshot and empty fallback", { mode: "headless", snapshot: "", html: "", summary: { document: { htmlBytes: 1500, textLength: 100 } } }, /有效页面 HTML/],
]) {
  test(`capture refuses ${label} without promoting output`, async () => {
    await temporaryDirectory(async (dir) => {
      const mod = await captureHarness();
      mod.useBrowser(fixtureBrowser(options).browser);
      await assert.rejects(mod.capturePage({ url: "https://example.test/", output_dir: dir }), error);
      assert.deepEqual(await fs.readdir(dir), []);
      assert.equal(mod.OUTPUT_LOCKS.size, 0);
    });
  });
}

test("cleanup failure rejects a fully rendered capture before report or promotion and releases its lock", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const mod = await captureHarness();
    const { browser, state } = fixtureBrowser({ closeError: "CLOSE_REJECTED" });
    mod.useBrowser(browser);
    await assert.rejects(mod.capturePage({ url: "https://example.test/", output_dir: dir }), /CLOSE_REJECTED/);
    assert.equal(state.navigations, 3, "source and both previews ran before cleanup");
    assert.equal(state.closes, 1);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "original page");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8")).status, undefined);
    assert.ok(!(await fs.readdir(dir)).some((name) => name.startsWith(".huoqu-")));
    assert.equal(mod.OUTPUT_LOCKS.size, 0);
    const retry = fixtureBrowser();
    mod.useBrowser(retry.browser);
    const result = await mod.capturePage({ url: "https://example.test/", output_dir: dir });
    assert.equal(result.status, "completed");
    assert.equal(retry.state.closes, 1);
  });
});

test("capture error and browser cleanup error both survive, with stage and lock released", async () => {
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const { browser, state } = fixtureBrowser({ navigationError: "SOURCE_FAILED", closeError: "CLOSE_FAILED" });
    mod.useBrowser(browser);
    await assert.rejects(mod.capturePage({ url: "https://example.test/", output_dir: dir }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /SOURCE_FAILED/);
      assert.match(error.message, /CLOSE_FAILED/);
      assert.equal(error.cause.message, "SOURCE_FAILED");
      return true;
    });
    assert.equal(state.closes, 1);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(mod.OUTPUT_LOCKS.size, 0);
  });
});

test("Chrome termination timeout rejects and preserves a profile still used by its process", async () => {
  await temporaryDirectory(async (profile) => {
    const mod = await captureHarness();
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 12345;
    const signals = [];
    child.kill = (signal) => { signals.push(signal); return false; };
    await fs.writeFile(path.join(profile, "sentinel"), "preserved");
    const originalKill = process.kill;
    process.kill = (_pid, signal) => { signals.push(signal); return false; };
    try {
      await assert.rejects(mod.stopChrome({ child, profile }), (error) => {
        assert.match(error.message, /退出超时/);
        assert.ok(error.message.includes(profile));
        return true;
      });
    } finally { process.kill = originalKill; }
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(await fs.readFile(path.join(profile, "sentinel"), "utf8"), "preserved");
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("error"), 0);
  });
});

for (const failure of ["reserve", "spawn-sync", "spawn-event"]) {
  test(`Chrome startup ${failure} failure is reported and its unused profile removed`, async () => {
    await temporaryDirectory(async (dir) => {
      const mod = await captureHarness();
      const originalTmpdir = os.tmpdir;
      const originalSpawn = childProcess.spawn;
      const originalFetch = globalThis.fetch;
      const eventErrors = [];
      let createdProfile = false;
      os.tmpdir = () => dir;
      childProcess.spawn = () => {
        if (failure === "spawn-sync") throw new Error("SPAWN_SYNC_FAILED");
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => { throw new Error("must not signal a child without a PID"); };
        queueMicrotask(() => {
          try { child.emit("error", new Error("SPAWN_EVENT_FAILED")); }
          catch (error) { eventErrors.push(error); }
        });
        return child;
      };
      globalThis.fetch = async () => ({ ok: false });
      syncBuiltinESMExports();
      mod.useLaunch(async () => {
        createdProfile = (await fs.readdir(dir)).some((name) => name.startsWith("dsh-huoqu-chrome-"));
        if (failure === "reserve") throw new Error("RESERVE_FAILED");
        return 12345;
      });
      try {
        const expected = { reserve: /RESERVE_FAILED/, "spawn-sync": /SPAWN_SYNC_FAILED/, "spawn-event": /SPAWN_EVENT_FAILED/ }[failure];
        await assert.rejects(mod.openChrome({}), expected);
        assert.equal(createdProfile, true, "failure happens after profile creation");
        assert.deepEqual(eventErrors, [], "spawn error must have an immediate listener");
        assert.deepEqual(await fs.readdir(dir), [], "failed startup must remove the unused profile");
      } finally {
        os.tmpdir = originalTmpdir;
        childProcess.spawn = originalSpawn;
        globalThis.fetch = originalFetch;
        syncBuiltinESMExports();
      }
    });
  });
}

test("capture refuses a public URL redirected to a private host and deletes the stage", async () => {
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const { browser, state } = fixtureBrowser({ summary: { url: "http://169.254.169.254/latest/meta-data/" } });
    mod.useBrowser(browser);
    await assert.rejects(mod.capturePage({ url: "https://example.test/", output_dir: dir }), /private\/local/);
    assert.equal(state.navigations, 1);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(mod.OUTPUT_LOCKS.size, 0);
  });
});

test("capture refuses a public name that resolves to a private address before navigation", async () => {
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const { browser, state } = fixtureBrowser();
    mod.useBrowser(browser);
    mod.useResolver(async () => [{ address: "10.0.0.8", family: 4 }]);
    await assert.rejects(mod.capturePage({ url: "https://rebind.example/", output_dir: dir }), /private\/local/);
    assert.equal(state.navigations, 0);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(mod.OUTPUT_LOCKS.size, 0);
  });
});

test("capture allows an explicitly requested private host and rejects a different final host", async () => {
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const allowed = fixtureBrowser({ summary: { url: "http://127.0.0.1/" } });
    mod.useBrowser(allowed.browser);
    const result = await mod.capturePage({ url: "http://127.0.0.1/", output_dir: dir });
    assert.equal(result.status, "completed");
    assert.equal(allowed.state.navigations, 3);
  });
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const redirected = fixtureBrowser({ summary: { url: "http://localhost/" } });
    mod.useBrowser(redirected.browser);
    await assert.rejects(mod.capturePage({ url: "http://127.0.0.1/", output_dir: dir }), /private\/local/);
    assert.equal(redirected.state.navigations, 1);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("a private remote address for a different host aborts before promotion", async () => {
  await temporaryDirectory(async (dir) => {
    const mod = await captureHarness();
    const { browser, state } = fixtureBrowser({
      responses: [{
        method: "Network.responseReceived",
        params: { requestId: "1", response: { url: "http://169.254.169.254/latest/meta-data/", remoteIPAddress: "169.254.169.254" } },
      }],
    });
    mod.useBrowser(browser);
    await assert.rejects(mod.capturePage({ url: "https://example.test/", output_dir: dir }), /private\/local/);
    assert.equal(state.navigations, 1);
    assert.equal(state.stopped, 1);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(mod.OUTPUT_LOCKS.size, 0);
  });
});
