import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMhtml } from '../lib/archive.js';

const enabled = process.env.HUOQU_BROWSER_TESTS === '1';
for (const fallback of [false, true]) for (const standards of [false, true]) {
  test(`isolated Chrome: meaningful short page, ${fallback ? 'DOM fallback' : 'snapshot'}, ${standards ? 'standards' : 'quirks'}`, { skip: !enabled, timeout: 120000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'huoqu-short-page-browser-'));
    const captureUrl = new URL(`../lib/capture.js?short-page=${fallback}-${standards}`, import.meta.url).href;
    const browserUrl = new URL('../../chrome/lib/browser.js', import.meta.url).href;
    const injected = 'const cdp = new ChromeDevTools(socket);';
    const hook = registerHooks({
      load(url, context, next) {
        if (url === browserUrl) return { format: 'module', shortCircuit: true, source: "export async function openCaptureSession() { throw new Error('Isolated short-page regression only'); }" };
        const result = next(url, context);
        if (!fallback || url !== captureUrl) return result;
        const source = String(result.source);
        assert.ok(source.includes(injected), 'snapshot failure must target the real CDP connection');
        return { ...result, source: source.replace(injected, `${injected} const originalSend = cdp.send.bind(cdp); cdp.send = (method, ...args) => method === 'Page.captureSnapshot' ? Promise.reject(new Error('Synthetic short-page snapshot failure')) : originalSend(method, ...args);`) };
      },
    });
    const html = `${standards ? '<!doctype html>' : ''}<html><head><meta charset="utf-8"><title>Meaningful compact page</title></head><body><p>CONTROLLED_SHORT_PAGE_VALID_TEXT — This compact, meaningful page must complete its offline checks. It has no missing image, challenge, script, active embed or inaccessible resource. Its static HTML stays below one thousand characters.</p></body></html>`;
    assert.ok(html.length < 1000);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { capturePage } = await import(captureUrl);
      const result = await capturePage({ url: `http://127.0.0.1:${server.address().port}/short`, output_dir: path.join(dir, 'capture'), width: 800, height: 600, wait_seconds: 0 });
      const report = JSON.parse(await readFile(path.join(result.outputDir, 'report.json'), 'utf8'));
      assert.equal(result.status, 'completed');
      assert.ok(report.sourcePage.document.htmlBytes < 1000);
      assert.ok(report.sourcePage.document.textLength > 20);
      for (const key of ['networkFailures', 'archiveNetworkFailures', 'htmlIssues', 'archiveIssues']) assert.deepEqual(report.offlineValidation[key], []);
      const local = await readFile(result.indexHtml, 'utf8');
      const archived = parseMhtml(await readFile(result.archiveMhtml, 'utf8')).main.text;
      for (const document of [local, archived]) {
        assert.match(document, /CONTROLLED_SHORT_PAGE_VALID_TEXT/);
        assert.equal(/^\s*<!doctype html>/i.test(document), standards, 'source document mode must be retained');
      }
      const source = await readFile(path.join(result.outputDir, 'source.png'));
      assert.ok(source.equals(await readFile(path.join(result.outputDir, 'local.png'))), 'short-page HTML layout must match source');
      assert.ok(source.equals(await readFile(path.join(result.outputDir, 'archive-preview.png'))), 'short-page MHTML layout must match source');
      if (fallback) assert.ok(report.warnings.some(warning => warning.includes('Synthetic short-page snapshot failure')));
    } finally {
      hook.deregister();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
