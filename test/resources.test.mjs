import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { htmlToMhtml, materializeMhtml } from "../lib/archive.js";

// Expose real private functions in memory, without copying their implementation.
const moduleUrl = new URL("../lib/capture.js", import.meta.url);
const source = (await readFile(moduleUrl, "utf8")).replace(/from "(\.\/[^\"]+)"/g,
  (_all, relative) => `from ${JSON.stringify(new URL(relative, moduleUrl).href)}`);
const { fetchExtraResource, completeExternalResources, readResponseLimited } = await import(
  `data:text/javascript;base64,${Buffer.from(`${source}\nexport { fetchExtraResource, completeExternalResources, readResponseLimited };`).toString("base64")}`);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("cross-origin IPv4-mapped IPv6 cannot reach a real loopback server", async () => {
  let hits = 0;
  await withServer((_req, res) => { hits++; res.end("SYNTHETIC_SENTINEL"); }, async (port) => {
    for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:7f00:1]"]) {
      await assert.rejects(fetchExtraResource(`http://${host}:${port}/`, "https://public.example"), /blocked/);
    }
  });
  assert.equal(hits, 0);
});

test("1300 same-origin resources cause no more than 1200 real HTTP requests", async () => {
  let hits = 0;
  await withServer((_req, res) => { hits++; res.setHeader("content-type", "image/png"); res.end("fixture"); }, async (port) => {
    const url = `http://127.0.0.1:${port}/page`;
    const mhtml = htmlToMhtml(Array.from({ length: 1300 }, (_, i) => `<img src="/${i}.png">`).join(""), url);
    const result = await completeExternalResources(mhtml, materializeMhtml(mhtml), url);
    assert.equal(hits, 1200);
    assert.equal(result.resources.length, 1200);
    assert.equal(result.materialized.externalReferences.length, 100);
    assert.ok(result.failures.length > 0);
  });
});

test("failed downloads count toward the request limit too", async () => {
  let hits = 0;
  await withServer((_req, res) => { hits++; res.writeHead(404); res.end(); }, async (port) => {
    const url = `http://127.0.0.1:${port}/page`;
    const mhtml = htmlToMhtml(Array.from({ length: 1300 }, (_, i) => `<img src="/${i}.png">`).join(""), url);
    const result = await completeExternalResources(mhtml, materializeMhtml(mhtml), url);
    assert.equal(hits, 1200);
    assert.equal(result.resources.length, 0);
  });
});

test("streamed bytes consume a shared budget, including failed responses", async () => {
  const budget = { remaining: 10 };
  const first = await readResponseLimited(new Response("123456"), 20, budget);
  assert.equal(first.length, 6);
  await assert.rejects(readResponseLimited(new Response("12345"), 20, budget), /budget exhausted/);
  assert.equal(budget.remaining, 0);
  await assert.rejects(readResponseLimited(new Response("x"), 20, budget), /budget exhausted/);
  const oversized = { remaining: 10 };
  await assert.rejects(readResponseLimited(new Response("123456"), 5, oversized), /byte limit/);
  assert.equal(oversized.remaining, 4);
});

test("redirect from the requested host to a different private host never connects", async () => {
  let secretHits = 0;
  await withServer((req, res) => {
    if (req.url === "/secret") { secretHits += 1; res.end("secret"); return; }
    res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/secret` });
    res.end();
  }, async (port) => {
    await assert.rejects(fetchExtraResource(`http://127.0.0.1:${port}/start`, `http://127.0.0.1:${port}/page`), /blocked/);
  });
  assert.equal(secretHits, 0);
});

test("duplicate redirect targets preserve all request aliases", async () => {
  await withServer((req, res) => {
    if (req.url !== "/shared.png") { res.writeHead(302, { location: "/shared.png" }); res.end(); }
    else { res.setHeader("content-type", "image/png"); res.end("fixture"); }
  }, async (port) => {
    const url = `http://127.0.0.1:${port}/page`;
    const mhtml = htmlToMhtml('<img src="/a.png"><img src="/b.png">', url);
    const result = await completeExternalResources(mhtml, materializeMhtml(mhtml), url);
    assert.equal(result.materialized.assets.length, 1);
    assert.deepEqual(result.materialized.externalReferences, []);
    assert.equal((result.materialized.html.match(/src="\.\/assets\/001-shared.png"/g) || []).length, 2);
  });
});
