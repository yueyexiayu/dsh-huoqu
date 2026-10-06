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
  assert.match(result.html, /<script>bad\(\)<\/script>/);
  const css = result.assets.find((asset) => asset.mime === "text/css");
  assert.ok(css);
  assert.match(css.bytes.toString("utf8"), /url\("\d+-logo\.png"\)/);
  assert.equal(result.resourceCount, 2);
  assert.deepEqual(result.externalReferences, []);
});

test("rewriteCss resolves protocol-relative URLs stored with HTML quotes", () => {
  const css = rewriteCss('background-image: url(&quot;//cdn.example.test/a.jpg&quot;)', "http://www.sdhhtc.com/h-col-104.html", new Map(), "");
  assert.match(css, /http:\/\/cdn\.example\.test\/a\.jpg/);
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
  const html = rewriteHtml("<head></head><body><div class=\"swiper-container-vertical\"><div class=\"swiper-wrapper\" style=\"transform:translate3d(0,-1000px,0)\"><div class=\"swiper-slide\">第一屏</div><div class=\"swiper-slide\">新闻中心</div></div></div><script src=\"https://cdn.example.test/app.js\"></script></body>", "https://example.test/", new Map(), { unfold: true });
  assert.match(html, /<script src="https:\/\/cdn\.example\.test\/app\.js"/);
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
  assert.match(reopened.html, /<script>bad\(\)<\/script>/);
});

test("htmlToMhtml keeps the live document when the browser snapshot cannot cross the extension bridge", () => {
  const archive = htmlToMhtml("<html><head></head><body>昊华搪瓷</body></html>", "http://www.sdhhtc.com/");
  const parsed = materializeMhtml(archive);
  assert.match(parsed.html, /昊华搪瓷/);
  assert.equal(parsed.sourceUrl, "http://www.sdhhtc.com/");
});

test("srcset retains a data URL and localizes the following candidate", () => {
  const map = new Map([["https://example.test/high.png", "high.png"]]);
  assert.equal(rewriteHtml('<img srcset="data:image/png;base64,aGVsbG8= 1x, /high.png 2x">', "https://example.test/", map),
    '<img srcset="data:image/png;base64,aGVsbG8= 1x, ./assets/high.png 2x">');
});

test("localized SVG references retain their fragment identifiers", () => {
  const map = new Map([["https://example.test/sprite.svg", "sprite.svg"]]);
  assert.equal(rewriteHtml('<svg><use xlink:href="/sprite.svg#logo"></use></svg>', "https://example.test/", map),
    '<svg><use xlink:href="./assets/sprite.svg#logo"></use></svg>');
  assert.equal(rewriteCss('filter:url(/sprite.svg#filter)', "https://example.test/", map), 'filter:url("./assets/sprite.svg#filter")');
});

test("the first base href resolves HTML, inline CSS and navigation before removing base tags", () => {
  const map = new Map([["https://cdn.example.test/static/a.png", "a.png"]]);
  const html = rewriteHtml('<head><base href="//cdn.example.test/static/"><base href="/ignored/"></head><img src=a.png><div style="background:url(a.png)"></div><a href="next">Next</a>', "https://example.test/page", map);
  assert.match(html, /src="\.\/assets\/a.png"/);
  assert.match(html, /background:url\(&quot;\.\/assets\/a.png&quot;\)/);
  assert.match(html, /href="https:\/\/cdn.example.test\/static\/next"/);
  assert.doesNotMatch(html, /<base/);
});

test("resource discovery includes inline CSS, iframe HTML and SVG dependencies but excludes navigation", () => {
  const root = '<html><head><style>@import "/theme.css";</style></head><body style="background:url(/background.png)"><iframe src="/frame.html"></iframe><svg><use href="/sprite.svg#symbol"></use></svg><a href="/about">About</a></body></html>';
  const captured = materializeMhtml(htmlToMhtml(root, "https://example.test/"), [{
    url: "https://example.test/frame.html", mime: "text/html", bytes: Buffer.from('<img src="/inside.png"><div style="background:url(/inside-bg.png)"></div>'),
  }]);
  assert.deepEqual(new Set(captured.externalReferences), new Set([
    "https://example.test/theme.css", "https://example.test/background.png", "https://example.test/sprite.svg#symbol", "https://example.test/inside.png", "https://example.test/inside-bg.png",
  ]));
});

test("rewriting does not alter attribute-looking text inside scripts or comments", () => {
  const html = '<script>const text = \'src="/keep"\';</script><!-- <img src="/comment"> --><img src="/real">';
  const result = rewriteHtml(html, "https://example.test/", new Map());
  assert.match(result, /const text = 'src="\/keep"'/);
  assert.match(result, /<!-- <img src="\/comment"> -->/);
  assert.match(result, /<img src="https:\/\/example.test\/real">/);
  assert.deepEqual(materializeMhtml(htmlToMhtml(html, "https://example.test/")).externalReferences, ["https://example.test/real"]);
});

test("MHTML rewrites nested HTML and srcset resources to cid references", () => {
  const materialized = {
    html: '<iframe src="./assets/frame.html"></iframe><img srcset="./assets/a.png 1x, ./assets/b.png 2x">',
    assets: [
      { name: "frame.html", mime: "text/html", url: "https://example.test/frame", bytes: Buffer.from('<img src="a.png"><svg><use href="sprite.svg#logo"></use></svg>') },
      { name: "a.png", mime: "image/png", url: "https://example.test/a.png", bytes: Buffer.from("a") },
      { name: "b.png", mime: "image/png", url: "https://example.test/b.png", bytes: Buffer.from("b") },
      { name: "sprite.svg", mime: "image/svg+xml", url: "https://example.test/sprite.svg", bytes: Buffer.from('<svg id="logo"></svg>') },
    ],
  };
  const parsed = parseMhtml(buildMhtml(materialized, "https://example.test/"));
  assert.match(parsed.main.text, /srcset="cid:huoqu-2 1x, cid:huoqu-3 2x"/);
  const frame = parsed.parts.find((part) => part.id === "huoqu-1");
  assert.match(frame.text, /src="cid:huoqu-2"/);
  assert.match(frame.text, /href="cid:huoqu-4#logo"/);
});

test("MHTML decodes declared legacy charsets and normalizes saved HTML to UTF-8", () => {
  const bytes = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);
  const source = htmlToMhtml("placeholder", "https://example.test/")
    .replace('charset="utf-8"', 'charset="windows-1252"')
    .replace(Buffer.from("placeholder").toString("base64"), bytes.toString("base64"));
  const result = materializeMhtml(source);
  assert.match(result.html, /café/);
  assert.match(result.html, /charset="utf-8"/);
  const css = materializeMhtml(htmlToMhtml('<link rel="stylesheet" href="/style.css">', "https://example.test/"), [{
    url: "https://example.test/style.css", mime: "text/css; charset=windows-1252", bytes: Buffer.concat([Buffer.from('/* caf'), Buffer.from([0xe9]), Buffer.from(' */')]),
  }]).assets[0];
  assert.match(css.bytes.toString("utf8"), /café/);
});

test("external SVG use and feImage inline captured targets without colliding IDs", () => {
  const page = '<html><body><div id="logo"></div><svg><use href="/one.svg#logo"></use><use href="/two.svg#logo"></use><filter id="preview"><feImage href="/one.svg"></feImage></filter></svg></body></html>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><linearGradient id="paint"><stop stop-color="#285fd3"></stop></linearGradient></defs><rect id="logo" width="120" height="80" fill="url(#paint)"></rect></svg>';
  const saved = materializeMhtml(htmlToMhtml(page, "https://example.test/"), [
    { url: "https://example.test/one.svg", mime: "image/svg+xml", bytes: Buffer.from(svg) },
    { url: "https://example.test/two.svg", mime: "image/svg+xml", bytes: Buffer.from(svg) },
  ]);
  const uses = [...saved.html.matchAll(/<use href="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(uses.length, 2);
  assert.ok(uses.every((href) => href.startsWith("#") && href !== "#logo"));
  assert.notEqual(uses[0], uses[1]);
  for (const href of uses) assert.ok(saved.html.includes(`id="${href.slice(1)}"`));
  assert.match(saved.html, /<feImage href="#/);
  assert.doesNotMatch(saved.html, /<(?:use|feImage)[^>]*href="[^#]/);
  assert.equal([...saved.html.matchAll(/id="logo"/g)].length, 1);
  const ids = [...saved.html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of saved.html.matchAll(/fill="url\(#([^\)]+)\)"/g)) assert.ok(ids.includes(match[1]));
  const mhtml = parseMhtml(buildMhtml(saved, "https://example.test/")).main.text;
  for (const href of uses) assert.ok(mhtml.includes(`href="${href}"`));
});

test("inlined SVG resources keep their original URL base and localize dependencies", () => {
  const saved = materializeMhtml(htmlToMhtml('<svg><use href="/icons/sprite.svg#logo"></use></svg>', "https://example.test/page"), [
    { url: "https://example.test/icons/sprite.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g id="logo"><image href="../img/a.png"></image></g></svg>') },
    { url: "https://example.test/img/a.png", mime: "image/png", bytes: Buffer.from("png") },
  ]);
  assert.match(saved.html, /<image href="\.\/assets\/\d+-a.png"/);
  assert.deepEqual(saved.externalReferences, []);
  const mhtml = parseMhtml(buildMhtml(saved, "https://example.test/")).main.text;
  assert.match(mhtml, /<image href="cid:huoqu-2"/);
});

test("inlined SVG rewrites absolute same-SVG references and leaves unsupported targets visible", () => {
  const page = '<svg><use href="/icons.svg#logo"></use><use href="/icons.svg#missing"></use><use href="/scripted.svg#logo"></use></svg>';
  const saved = materializeMhtml(htmlToMhtml(page, "https://example.test/"), [
    { url: "https://example.test/icons.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg><defs><rect id="shape" width="120" height="80"/></defs><g id="logo"><use href="https://example.test/icons.svg#shape"></use></g></svg>') },
    { url: "https://example.test/scripted.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg><rect id="logo"/><script>adjust()</script></svg>') },
  ]);
  assert.match(saved.html, /href="\.\/assets\/\d+-icons.svg#missing"/);
  assert.match(saved.html, /href="\.\/assets\/\d+-scripted.svg#logo"/);
  assert.doesNotMatch(saved.html, /href="\.\/assets\/\d+-icons.svg#shape"/);
  assert.match(saved.html, /<g id="huoqu-svg-[^"]+"><use href="#huoqu-svg-/);
  assert.doesNotMatch(saved.html, /adjust\(\)/);
});

test("redirected resources reuse a captured final URL and retain requested URL aliases", () => {
  const saved = materializeMhtml(htmlToMhtml('<img src="/final.png"><img src="/redirect.png">', "https://example.test/"), [
    { url: "https://example.test/final.png", mime: "image/png", bytes: Buffer.from("png") },
    { url: "https://example.test/redirect.png", finalUrl: "https://example.test/final.png", mime: "image/png", bytes: Buffer.from("png") },
  ]);
  assert.equal(saved.resourceCount, 1);
  assert.equal(saved.html, '<meta charset="utf-8"><img src="./assets/001-final.png"><img src="./assets/001-final.png">');
  assert.deepEqual(saved.externalReferences, []);
});

test("image-set string URLs are discovered, localized and packaged without rewriting MIME strings", () => {
  const html = '<style>.hero{background:image-set("/small.png" 1x type("image/png"), url(/large.png) 2x);mask-image:-webkit-image-set("/mask.png" 1x)}</style>';
  const initial = materializeMhtml(htmlToMhtml(html, "https://example.test/"));
  assert.deepEqual(new Set(initial.externalReferences), new Set([
    "https://example.test/small.png", "https://example.test/large.png", "https://example.test/mask.png",
  ]));
  const saved = materializeMhtml(htmlToMhtml(html, "https://example.test/"), ["small", "large", "mask"].map((name) => ({
    url: `https://example.test/${name}.png`, mime: "image/png", bytes: Buffer.from(name),
  })));
  assert.match(saved.html, /image-set\("\.\/assets\/001-small.png" 1x type\("image\/png"\), url\("\.\/assets\/002-large.png"\) 2x\)/);
  assert.match(saved.html, /-webkit-image-set\("\.\/assets\/003-mask.png" 1x\)/);
  assert.deepEqual(saved.externalReferences, []);
  const archiveHtml = parseMhtml(buildMhtml(saved, "https://example.test/")).main.text;
  assert.match(archiveHtml, /image-set\("cid:huoqu-1" 1x type\("image\/png"\), url\("cid:huoqu-2"\) 2x\)/);
  assert.match(archiveHtml, /-webkit-image-set\("cid:huoqu-3" 1x\)/);
  assert.equal(rewriteCss('content:"image-set(\\"/literal.png\\" 1x)";/* image-set("/comment.png" 1x) */', "https://example.test/", new Map()),
    'content:"image-set(\\"/literal.png\\" 1x)";/* image-set("/comment.png" 1x) */');
});

test("standalone SVG dependencies are discovered, localized and rewritten to MHTML cid URLs", () => {
  const html = '<object data="/icons/visual.svg" type="image/svg+xml"></object>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{background:image-set("../picture.png" 1x)}</style><image href="../picture.png"/><rect filter="url(../effects.svg#blur)"/></svg>';
  const resources = [{ url: "https://example.test/icons/visual.svg", mime: "image/svg+xml", bytes: Buffer.from(svg) }];
  const initial = materializeMhtml(htmlToMhtml(html, "https://example.test/"), resources);
  assert.deepEqual(new Set(initial.externalReferences), new Set(["https://example.test/picture.png", "https://example.test/effects.svg#blur"]));
  const saved = materializeMhtml(htmlToMhtml(html, "https://example.test/"), resources.concat([
    { url: "https://example.test/picture.png", mime: "image/png", bytes: Buffer.from("png") },
    { url: "https://example.test/effects.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg><filter id="blur"/></svg>') },
  ]));
  const localSvg = saved.assets[0].bytes.toString("utf8");
  assert.match(localSvg, /href="002-picture.png"/);
  assert.match(localSvg, /filter="url\(&quot;003-effects.svg#blur&quot;\)"/);
  assert.doesNotMatch(localSvg, /https:\/\/example\.test|<meta/);
  assert.deepEqual(saved.externalReferences, []);
  const archiveSvg = parseMhtml(buildMhtml(saved, "https://example.test/")).parts.find((part) => part.id === "huoqu-1").text;
  assert.match(archiveSvg, /href="cid:huoqu-2"/);
  assert.match(archiveSvg, /filter="url\(&quot;cid:huoqu-3#blur&quot;\)"/);
});

test("SVG presentation URL attributes are discovered and localized in the main page", () => {
  const html = '<svg><rect fill="url(/effects.svg#paint)" clip-path="url(/effects.svg#clip)" stroke="url(#local)"/></svg>';
  const initial = materializeMhtml(htmlToMhtml(html, "https://example.test/"));
  assert.deepEqual(new Set(initial.externalReferences), new Set(["https://example.test/effects.svg#paint", "https://example.test/effects.svg#clip"]));
  const saved = materializeMhtml(htmlToMhtml(html, "https://example.test/"), [{
    url: "https://example.test/effects.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg><linearGradient id="paint"/><clipPath id="clip"/></svg>'),
  }]);
  assert.match(saved.html, /fill="url\(&quot;\.\/assets\/001-effects.svg#paint&quot;\)"/);
  assert.match(saved.html, /clip-path="url\(&quot;\.\/assets\/001-effects.svg#clip&quot;\)"/);
  assert.match(saved.html, /stroke="url\(&quot;#local&quot;\)"/);
  assert.deepEqual(saved.externalReferences, []);
  const archiveHtml = parseMhtml(buildMhtml(saved, "https://example.test/")).main.text;
  assert.match(archiveHtml, /fill="url\(&quot;cid:huoqu-1#paint&quot;\)"/);
});

test("image-set decodes CSS string escapes and preserves unchanged data URLs", () => {
  const map = new Map([["https://example.test/small.png", "small.png"], ["https://example.test/other%20image.png", "other.png"]]);
  assert.equal(rewriteCss('image-set("/sm\\61 ll.png" 1x, \'/other\\ image.png\' 2x)', "https://example.test/", map),
    'image-set("./assets/small.png" 1x, \'./assets/other.png\' 2x)');
  const data = 'image-set("data:image/svg+xml,<svg id=\\"x\\"/>" 1x)';
  assert.equal(rewriteCss(data, "https://example.test/", map), data);
});
