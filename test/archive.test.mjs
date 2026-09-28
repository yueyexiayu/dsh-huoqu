import test from "node:test";
import assert from "node:assert/strict";
import { buildMhtml, htmlToMhtml, materializeMhtml, parseMhtml, rewriteCss, rewriteHtml } from "../lib/archive.js";

const fixture = [
  "From: <Saved by Blink>",
  "Snapshot-Content-Location: https://example.test/",
  "MIME-Version: 1.0",
  "Content-Type: multipart/related; boundary=\"boundary-1\"",
  "",
  "--boundary-1",
  "Content-Type: text/html; charset=\"utf-8\"",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Location: https://example.test/",
  "",
  "<!doctype html><html><head><link rel=\"stylesheet\" href=\"https://example.test/css/site.css\"></head><body><img src=\"https://example.test/img/logo.png\"><script>bad()</script><a href=\"/about\">About</a></body></html>",
  "--boundary-1",
  "Content-Type: text/css; charset=\"utf-8\"",
  "Content-Transfer-Encoding: quoted-printable",
  "Content-Location: https://example.test/css/site.css",
  "",
  "body { background: url(../img/logo.png); }",
  "--boundary-1",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-Location: https://example.test/img/logo.png",
  "",
  "aGVsbG8=",
  "--boundary-1--",
  "",
].join("\r\n");

test("parseMhtml reads the root HTML and decoded MIME resources", () => {
  const parsed = parseMhtml(fixture);
  assert.equal(parsed.snapshotLocation, "https://example.test/");
  assert.equal(parsed.main.contentType, "text/html");
  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.parts[2].bytes.toString("utf8"), "hello");
});

test("materializeMhtml rewrites CSS and localizes captured resources", () => {
  const result = materializeMhtml(fixture);
  assert.match(result.html, /href="\.\/assets\//);
  assert.match(result.html, /src="\.\/assets\//);
  assert.doesNotMatch(result.html, /<script/);
  const css = result.assets.find((asset) => asset.mime === "text/css");
  assert.ok(css);
  assert.match(css.bytes.toString("utf8"), /url\("\d+-logo\.png"\)/);
  assert.equal(result.resourceCount, 2);
  assert.deepEqual(result.externalReferences, []);
});

test("rewriteCss resolves protocol-relative URLs stored with HTML quotes", () => {
  const css = rewriteCss('background-image: url(&quot;//cdn.example.test/a.jpg&quot;)', "http://www.sdhhtc.com/h-col-104.html", new Map(), "");
  assert.match(css, /https:\/\/cdn\.example\.test\/a\.jpg/);
  assert.doesNotMatch(css, /sdhhtc\.com\/&quot;/);
});

test("rewriteCss resolves relative URLs against the stylesheet location", () => {
  const map = new Map([["https://example.test/img/a.png", "a.png"]]);
  assert.equal(
    rewriteCss(".x { background: url(../img/a.png) }", "https://example.test/css/main.css", map, ""),
    '.x { background: url("a.png") }',
  );
});

test("rewriteHtml preserves navigation links as absolute source URLs", () => {
  const html = rewriteHtml('<a href="/about">About</a>', "https://example.test/", new Map());
  assert.match(html, /<a href="https:\/\/example\.test\/about">About<\/a>/);
});

test("rewriteHtml removes a self-referential video source from the static copy", () => {
  const html = rewriteHtml('<video src="https://example.test/"></video>', "https://example.test/", new Map());
  assert.match(html, /<video><\/video>/);
  assert.doesNotMatch(html, /src="https:\/\/example\.test\/"/);
});

test("materializeMhtml localizes fetched resources referenced by CSS", () => {
  const withFont = fixture.replace(
    "body { background: url(../img/logo.png); }",
    "body { background: url(../img/logo.png); } @font-face { font-family: test; src: url(../font/test.woff2); }",
  );
  const result = materializeMhtml(withFont, [{
    url: "https://example.test/font/test.woff2",
    finalUrl: "https://example.test/font/test.woff2",
    mime: "font/woff2",
    bytes: Buffer.from("font-bytes"),
  }]);
  const css = result.assets.find((asset) => asset.mime === "text/css");
  assert.match(css.bytes.toString("utf8"), /url\("\d+-test\.woff2"\)/);
  assert.equal(result.resourceCount, 3);
  assert.deepEqual(result.externalReferences, []);
});

test("rewriteHtml stacks vertical slides so content below the first screen stays reachable", () => {
  const html = rewriteHtml("<head></head><body><div class=\"swiper-container-vertical\"><div class=\"swiper-wrapper\" style=\"transform:translate3d(0,-1000px,0)\"><div class=\"swiper-slide\">第一屏</div><div class=\"swiper-slide\">新闻中心</div></div></div></body>", "https://example.test/", new Map());
  assert.match(html, /id="huoqu-unfold"/);
  assert.match(html, /transform: none !important/);
  assert.match(html, /flex-direction: column !important/);
  assert.match(html, /新闻中心/);
});

test("buildMhtml packages rewritten HTML, stylesheets and assets as a self-contained archive", () => {
  const materialized = materializeMhtml(fixture);
  const archive = buildMhtml(materialized, "https://example.test/");
  assert.match(archive, /Content-ID: <huoqu-1>/);
  assert.match(parseMhtml(archive).main.text, /cid:huoqu-/);
  const reopened = materializeMhtml(archive);
  assert.equal(reopened.resourceCount, materialized.resourceCount);
  assert.deepEqual(reopened.externalReferences, []);
  assert.doesNotMatch(reopened.html, /<script/);
});

test("htmlToMhtml keeps the live document when the browser snapshot cannot cross the extension bridge", () => {
  const archive = htmlToMhtml("<html><head></head><body>昊华搪瓷</body></html>", "http://www.sdhhtc.com/");
  const parsed = materializeMhtml(archive);
  assert.match(parsed.html, /昊华搪瓷/);
  assert.equal(parsed.sourceUrl, "http://www.sdhhtc.com/");
});
