import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

// Decode Chrome's 8-bit RGB/RGBA screenshot rows independently of the archive code.
function pngPixel(png, x, y) {
  const width = png.readUInt32BE(16);
  assert.equal(png[24], 8);
  assert.ok([2, 6].includes(png[25]));
  const channels = png[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const at = row * (stride + 1);
    const filter = raw[at];
    assert.ok(filter <= 4);
    const decoded = Buffer.alloc(stride);
    for (let col = 0; col < stride; col++) {
      const left = col >= channels ? decoded[col - channels] : 0;
      const above = previous[col];
      const corner = col >= channels ? previous[col - channels] : 0;
      const p = left + above - corner;
      const distances = [Math.abs(p - left), Math.abs(p - above), Math.abs(p - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : corner;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      decoded[col] = (raw[at + 1 + col] + predictor) & 255;
    }
    previous = decoded;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

// Real isolated Chrome; no file-origin relaxations and no user browser session.
// Keep temporary captures as reproducible before/after pixel and network evidence.
for (const snapshotFailure of [false, true]) for (const rejectStyles of [false, true]) test(`isolated Chrome (${snapshotFailure ? "DOM fallback" : "MHTML snapshot"}): external SVG paint ${rejectStyles ? "rejects stylesheet promotion without global pollution" : "renders identically in offline file HTML"}`,  { skip: process.env.HUOQU_BROWSER_TESTS !== "1", timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huoqu-svg-paint-browser-"));
  // A fresh module URL per case prevents a cached CDP hook from selecting the wrong mode.
  const captureUrl = new URL(`../lib/capture.js?svg-paint=${snapshotFailure}-${rejectStyles}`, import.meta.url).href;
  const browserUrl = new URL("../../chrome/lib/browser.js", import.meta.url).href;
  const injected = "const cdp = new ChromeDevTools(socket);";
  const sendHook = `${injected} const originalSend = cdp.send.bind(cdp); cdp.send = (method, ...args) => method === 'Page.captureSnapshot' && ${snapshotFailure} ? Promise.reject(new Error('Synthetic SVG snapshot failure')) : originalSend(method, ...args);`;
  const hook = registerHooks({ load(url, context, next) {
    if (url === browserUrl) return { format: "module", shortCircuit: true, source: "export async function openCaptureSession() { throw new Error('Isolated regression browser only'); }" };
    const result = next(url, context);
    if (url !== captureUrl) return result;
    const source = String(result.source);
    assert.ok(source.includes(injected), "snapshot failure injection must target the real isolated CDP connection");
    return { ...result, source: source.replace(injected, sendHook) };
  } });
  const server = createServer((req, res) => {
    if (req.url === "/paint.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      const stylesheet = rejectStyles ? '<style>body{background:red!important}rect{fill:red!important}</style>' : '';
      res.end(`<svg xmlns="http://www.w3.org/2000/svg">${stylesheet}<defs><linearGradient id="base"><stop stop-color="#25816a"/><stop offset="1" stop-color="#8fd3b0"/></linearGradient><linearGradient id="jade" href="#base"/></defs></svg>`);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css"); res.end('.external{fill:url(/paint.svg#jade)}');
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html><head><title>SVG paint browser regression</title><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:white}svg{display:block}.embedded{fill:url(/paint.svg#jade)}</style></head><body><p>SVG paint offline pixel regression — captured definitions must remain visible. This controlled test verifies a linear gradient shared by attributes, inline styles, embedded style rules and an external stylesheet. The source and both static offline previews must show the same four jade gradient rectangles without granting local file access or enabling JavaScript. Each rectangle deliberately uses the same external gradient by a different reference path, and the existing collision ID must not shadow any imported definition.</p><div id="huoqu-svg-1-1"></div><svg width="640" height="200"><rect x="0" width="150" height="150" fill="url(/paint.svg#jade)"/><rect x="160" width="150" height="150" style="fill:url(/paint.svg#jade)"/><rect x="320" width="150" height="150" class="embedded"/><rect x="480" width="150" height="150" class="external"/></svg></body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { capturePage } = await import(captureUrl);
    const result = await capturePage({ url: `http://127.0.0.1:${server.address().port}/`, output_dir: path.join(dir, "capture"), width: 800, height: 600, wait_seconds: 0 });
    const report = JSON.parse(await readFile(path.join(dir, "capture/report.json"), "utf8"));
    const source = await readFile(path.join(dir, "capture/source.png"));
    const local = await readFile(path.join(dir, "capture/local.png"));
    const archive = await readFile(path.join(dir, "capture/archive-preview.png"));
    const sourcePixels = [25, 185, 345, 505].map(x => pngPixel(source, x, 150));
    const localPixels = [25, 185, 345, 505].map(x => pngPixel(local, x, 150));
    console.log(JSON.stringify({ evidence: dir, snapshotFailure, rejectStyles, status: result.status, engine: report.browser.engine, network: report.offlineValidation, sourcePixels, localPixels, background: { source: pngPixel(source, 700, 500), local: pngPixel(local, 700, 500), archive: pngPixel(archive, 700, 500) }, sourceLocalPixelsIdentical: source.equals(local), sourceArchivePixelsIdentical: source.equals(archive) }));
    if (snapshotFailure) assert.match(result.warnings.join("\n"), /Synthetic SVG snapshot failure/, "fallback must actually bypass Page.captureSnapshot");
    else assert.doesNotMatch(result.warnings.join("\n"), /Synthetic SVG snapshot failure/);
    for (const [red, green, blue] of sourcePixels) assert.ok(green > red + 40 && green > blue, "live source must actually paint all four green gradients");
    if (rejectStyles) {
      assert.equal(result.status, "partial", "refused SVG promotion must not masquerade as completed");
      assert.ok(report.offlineValidation.networkFailures.some(f => f.url.includes("paint.svg")));
      for (const image of [source, local, archive]) assert.deepEqual(pngPixel(image, 700, 500), [255, 255, 255], "SVG body selector must not recolor host document");
      for (const image of [local, archive]) assert.notDeepEqual(pngPixel(image, 25, 150), [255, 0, 0], "SVG rect selector must not recolor host SVG");
      const html = await readFile(path.join(dir, "capture/index.html"), "utf8");
      assert.doesNotMatch(html, /background:red|fill:red/);
      assert.match(html, /paint.svg#jade/);
      return;
    }
    assert.deepEqual(report.offlineValidation.networkFailures, [], "file HTML must not request external SVG paint");
    assert.deepEqual(report.offlineValidation.archiveNetworkFailures, []);
    assert.equal(result.status, "completed");
    assert.ok(local.equals(source), "offline file HTML must be byte-identical to live source screenshot, not only have matching DOM/CSS");
    assert.ok(archive.equals(source), "MHTML must preserve the same pixels");
  } finally {
    hook.deregister();
    await new Promise(resolve => server.close(resolve));
  }
});
