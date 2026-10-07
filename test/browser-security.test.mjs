import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Opt in: runs a real isolated Chrome, never the user's logged-in browser.
// HUOQU_BROWSER_TESTS=1 node --test test/browser-security.test.mjs
const enabled = process.env.HUOQU_BROWSER_TESTS === "1";
test("isolated Chrome: no business clicks, no local file read, including live-HTML fallback", { skip: !enabled, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huoqu-browser-security-"));
  const sentinel = "HUOQU_HARMLESS_FILE_SENTINEL_ONLY";
  const sentinelPath = path.join(dir, "sentinel.txt");
  await writeFile(sentinelPath, sentinel);
  let requests = 0;
  let snapshotFailure = false;
  const captureUrl = new URL("../lib/capture.js", import.meta.url).href;
  const browserUrl = new URL("../../chrome/lib/browser.js", import.meta.url).href;
  const injected = "const cdp = new ChromeDevTools(socket);";
  const sendHook = "const cdp = new ChromeDevTools(socket); const originalSend = cdp.send.bind(cdp); cdp.send = (method, ...args) => method === 'Page.captureSnapshot' && globalThis.__huoquSnapshotFailure ? Promise.reject(new Error('Synthetic snapshot failure')) : originalSend(method, ...args);";
  const hook = registerHooks({
    load(url, context, next) {
      if (url === browserUrl) return { format: "module", shortCircuit: true, source: "export async function openCaptureSession() { throw new Error('Synthetic isolation: companion disabled'); }" };
      const result = next(url, context);
      if (url !== captureUrl) return result;
      const source = String(result.source);
      assert.ok(source.includes(injected), "snapshot failure injection must target the real CDP connection");
      return { ...result, source: source.replace(injected, sendHook)
        .replace('scripts: Array.from(document.scripts || []).length,', 'scripts: Array.from(document.scripts || []).length, dataStylesheetColor: getComputedStyle(document.body).backgroundColor,')
        .replace('scriptCountAtCapture: sourcePage.scripts,', 'scriptCountAtCapture: sourcePage.scripts, dataStylesheetColor: sourcePage.dataStylesheetColor,')
        .replace('document: localPage.document,', 'document: localPage.document, dataStylesheetColor: localPage.dataStylesheetColor,')
        .replace('document: archivePage.document,', 'document: archivePage.document, dataStylesheetColor: archivePage.dataStylesheetColor,') };
    },
  });
  const server = createServer((req, res) => {
    if (req.url === "/confirm") { requests += 1; res.end("ok"); return; }
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(`<!doctype html><html><head><title>Safe capture fixture</title>${req.url === '/nested-style' ? `<style>@import url("data:text/css;base64,${Buffer.from('body { background-color: rgb(1, 2, 3); }').toString('base64')}");</style>` : ''}</head><body>
      <h1>Harmless capture security regression</h1><p>${"Visible synthetic content for offline validation. ".repeat(50)}</p>
      <button class="next_btn" onclick="fetch('/confirm',{method:'POST'})">Business operation</button>
      <script>if(location.protocol==='file:')fetch(${JSON.stringify(pathToFileURL(sentinelPath).href)}).then(r=>r.text()).then(t=>document.title=t);</script>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==" onload="if(location.protocol==='file:')document.title='HANDLER_EXECUTED'">
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { capturePage } = await import(captureUrl);
    for (snapshotFailure of [false, true]) for (const nestedStyle of [false, true]) {
      globalThis.__huoquSnapshotFailure = snapshotFailure;
      const outputDir = path.join(dir, `${snapshotFailure ? "fallback" : "snapshot"}-${nestedStyle ? "nested-style" : "safe"}`);
      const result = await capturePage({ url: `http://127.0.0.1:${server.address().port}/${nestedStyle ? "nested-style" : ""}`, output_dir: outputDir, wait_seconds: 0 });
      const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
      const html = await readFile(result.indexHtml, "utf8");
      assert.equal(requests, 0, "capture must not click business buttons");
      if (nestedStyle) {
        assert.equal(report.sourcePage.dataStylesheetColor, "rgb(1, 2, 3)", "fixture must exercise a real data stylesheet online");
        assert.equal(result.status, "partial", "blocked resource must remain visible as partial, not completed");
      } else {
        assert.equal(result.status, "completed", "safe fixture must still capture and validate successfully");
      }
      for (const preview of [report.localCopy.preview, report.archivePreview]) {
        assert.equal(typeof preview.dataStylesheetColor, "string", "offline computed style must be observed, not missing");
        assert.notEqual(preview.dataStylesheetColor, "rgb(1, 2, 3)", "offline CSP must block nested data stylesheets");
        assert.equal(preview.title, "Safe capture fixture", "each offline preview must not execute file-read or event-handler payload");
      }
      assert.doesNotMatch(html, /<script\b|\son(?:click|load)\s*=/i);
      assert.ok(!html.includes(sentinel), "no local file bytes may enter the capture");
      if (snapshotFailure) assert.match(result.warnings.join("\n"), /Synthetic snapshot failure/);
      console.log(JSON.stringify({ mode: snapshotFailure ? "live-html-fallback" : "mhtml-snapshot", nestedStyle, status: result.status, businessRequests: requests, localTitle: report.localCopy.preview.title, offlineStyle: report.localCopy.preview.dataStylesheetColor }));
    }
  } finally {
    hook.deregister();
    delete globalThis.__huoquSnapshotFailure;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
