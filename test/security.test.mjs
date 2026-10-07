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
