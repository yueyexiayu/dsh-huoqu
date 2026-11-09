import test from "node:test";
import assert from "node:assert/strict";
import { materializeMhtml, htmlToMhtml, buildMhtml, parseMhtml } from "../lib/archive.js";

const base = "https://fixture.example/";

test("HTML and MHTML copies remove active content and carry a restrictive CSP", () => {
  const input = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=file:///tmp/synthetic">
    <script>fetch('file:///tmp/synthetic')</script><link rel="modulepreload" href="/app.js"></head>
    <body onload="bad()"><img src="/missing" onerror=bad()><a href="java&#x09;script:bad()" ping="/action">X</a>
    <iframe srcdoc="&lt;script&gt;bad()&lt;/script&gt;" src="file:///tmp/synthetic"></iframe>
    <object data="/action"></object><embed src="/action"><form action="/action"><button formaction="/action">Y</button></form>
    <svg><set attributeName="href" to="javascript:bad()"></set></svg></body></html>`;
  const materialized = materializeMhtml(htmlToMhtml(input, base));
  for (const html of [materialized.html, parseMhtml(buildMhtml(materialized, base)).main.text]) {
    assert.doesNotMatch(html, /<(?:script|iframe|object|embed|form|set)\b|\son(?:load|error)=|\s(?:srcdoc|formaction|ping)=|javascript:|file:\/\/\/tmp|http-equiv="refresh"/i);
    assert.match(html, /script-src 'none'/);
    assert.match(html, /form-action 'none'/);
    assert.equal(/style-src ([^;]+)/.exec(html)?.[1], "'unsafe-inline' file: cid:", "data: stylesheets must not bypass URL rewriting through nested imports");
    assert.match(html, /<button>Y<\/button>/);
  }
});

test("SVG assets strip slash-delimited events, scripts and executable URLs", () => {
  const svg = '<svg/onload="bad()"><script>bad()</script><a href="javascript&colon;bad()">x</a><foreignObject><iframe srcdoc="x"></iframe></foreignObject><rect width="8" height="8"/></svg>';
  const result = materializeMhtml(htmlToMhtml('<img src="/icon.svg">', base), [
    { url: `${base}icon.svg`, mime: "image/svg+xml", bytes: Buffer.from(svg) },
  ]);
  const saved = result.assets[0].bytes.toString();
  assert.doesNotMatch(saved, /onload|<script|javascript|foreignObject|iframe|bad\(\)/i);
  assert.match(saved, /<rect width="8" height="8"\/>/);
});

test("unarchived file URLs cannot leak local image or stylesheet contents", () => {
  const result = materializeMhtml(htmlToMhtml('<img src="file:///tmp/synthetic"><div style="background:url(file:///tmp/synthetic)"></div>', base));
  assert.doesNotMatch(result.html, /file:\/\/\/tmp/);
});

test("resource extensions follow verified MIME instead of an active URL suffix", () => {
  const result = materializeMhtml(htmlToMhtml('<img src="/asset.html"><a href="/asset.html">open</a>', base), [{
    url: `${base}asset.html`,
    mime: "image/png",
    bytes: Buffer.from('<script>document.body.dataset.executed="YES"</script>'),
  }]);
  assert.equal(result.assets[0].name, "001-asset.png");
  assert.match(result.html, /<a href="\.\/assets\/001-asset\.png">open<\/a>/);
  assert.doesNotMatch(result.html, /\.html/);

  const xml = materializeMhtml(htmlToMhtml('<img src="/active.xml">', base), [{
    url: `${base}active.xml`, mime: "application/xml", bytes: Buffer.from("<html><script>bad()</script></html>"),
  }]);
  assert.equal(xml.assets[0].name, "001-active.bin");
});

test("persisted MHTML locations redact common credential query parameters", () => {
  const materialized = materializeMhtml(htmlToMhtml("<p>secret-safe archive</p>", `${base}page?token=top-secret&view=1`));
  const archive = buildMhtml(materialized, `${base}page?token=top-secret&view=1`);
  assert.doesNotMatch(archive, /top-secret/);
  assert.match(archive, /token=REDACTED/);
  assert.match(archive, /view=1/);
});
