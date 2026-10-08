import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { htmlToMhtml, materializeMhtml } from "../lib/archive.js";

// Expose the actual private implementation only in this test's module loader.
const captureUrl = new URL("../lib/capture.js", import.meta.url).href;
const source = await readFile(new URL(captureUrl), "utf8");
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== captureUrl) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `${source}\nexport { assertAllowedResource, completeExternalResources };` };
  },
});
const { assertAllowedResource, completeExternalResources } = await import(captureUrl);
hook.deregister();

function imageArchive(count, sourceUrl = "https://example.test/") {
  const html = `<html><body>${Array.from({ length: count }, (_, index) => `<img src="${sourceUrl}${index}.png">`).join("")}</body></html>`;
  const mhtml = htmlToMhtml(html, sourceUrl);
  return { mhtml, initial: materializeMhtml(mhtml), sourceUrl };
}

test("cross-origin IPv4-mapped IPv6 private resources are rejected", async () => {
  for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:192.168.0.1", "::ffff:a9fe:a9fe"]) {
    await assert.rejects(assertAllowedResource(new URL(`http://[${address}]/image.png`), "https://example.test"), /private\/local/);
  }
  await assertAllowedResource(new URL("https://[::ffff:8.8.8.8]/image.png"), "https://example.test");
});

test("private resources on the explicitly selected source origin remain allowed", async () => {
  for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "localhost"]) {
    const url = new URL(`http://${host}/image.png`);
    await assertAllowedResource(url, url.origin);
  }
});

test("resource completion stops fetching after 120 resources", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("fixture", { headers: { "content-type": "image/png" } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(130);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 120);
    assert.equal(result.resources.length, 120);
    assert.equal(result.materialized.externalReferences.length, 10);
    assert.ok(result.failures.length);
  } finally { globalThis.fetch = originalFetch; }
});

test("resource completion stops fetching at the 100 MiB byte budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(20 * 1024 * 1024);
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(12);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 5);
    assert.equal(result.totalBytes, 100 * 1024 * 1024);
    assert.equal(result.resources.length, 5);
    assert.equal(result.materialized.externalReferences.length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("bytes read before a stream failure still consume the total budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(20 * 1024 * 1024);
  globalThis.fetch = async () => {
    calls += 1;
    if (calls !== 1) return new Response(bytes, { headers: { "content-type": "image/png" } });
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sent) controller.error(new Error("injected stream failure"));
        else { sent = true; controller.enqueue(bytes); }
      },
    });
    return new Response(body, { headers: { "content-type": "image/png" } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(12);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 5);
    assert.equal(result.totalBytes, 80 * 1024 * 1024);
    assert.equal(result.resources.length, 4);
    assert.ok(result.failures.some((failure) => failure.error.includes("injected stream failure")));
    assert.ok(result.failures.some((failure) => failure.error.includes("byte total limit")));
  } finally { globalThis.fetch = originalFetch; }
});

test("failed resource requests still consume the 120 request budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response("missing", { status: 404 }); };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(130);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 120);
    assert.equal(result.resources.length, 0);
    assert.ok(result.failures.some((failure) => failure.error.includes("request limit")));
  } finally { globalThis.fetch = originalFetch; }
});

test("the final response is cancelled when it exceeds the remaining byte budget", async () => {
  let calls = 0;
  let cancelled = false;
  const originalFetch = globalThis.fetch;
  const full = new Uint8Array(20 * 1024 * 1024);
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 5) return new Response(full, { headers: { "content-type": "image/png" } });
    if (calls === 5) return new Response(new Uint8Array(19 * 1024 * 1024), { headers: { "content-type": "image/png" } });
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(512 * 1024)); },
      cancel() { cancelled = true; },
    });
    return new Response(body, { headers: { "content-type": "image/png" } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(12);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 6);
    assert.equal(cancelled, true);
    assert.equal(result.totalBytes, 99 * 1024 * 1024);
    assert.equal(result.resources.length, 5);
    assert.ok(result.failures.some((failure) => failure.error.includes("1048576 byte limit")));
  } finally { globalThis.fetch = originalFetch; }
});

test("source 404 references are removed instead of left as offline failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(1);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(result.materialized.externalReferences.length, 0);
    assert.equal(result.materialized.html.includes("https://example.test/0.png"), false);
    assert.ok(result.failures.some((failure) => failure.error === "HTTP 404"));
    assert.equal(result.failures.some((failure) => failure.error.includes("remain unresolved")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("an in-document video between 20 MiB and 64 MiB is downloaded", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(30 * 1024 * 1024);
  globalThis.fetch = async () => new Response(bytes, {
    headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
  });
  try {
    const html = "<html><body><video src=\"https://example.test/promo.mp4\"></video></body></html>";
    const mhtml = htmlToMhtml(html, "https://example.test/");
    const result = await completeExternalResources(mhtml, materializeMhtml(mhtml), "https://example.test/");
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].bytes.length, bytes.length);
    assert.equal(result.materialized.externalReferences.includes("https://example.test/promo.mp4"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("cancelled completion rejects before initiating any resource request", async () => {
  const controller = new AbortController();
  controller.abort();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("cancelled work must not fetch");
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(1);
    await assert.rejects(completeExternalResources(mhtml, initial, sourceUrl, controller.signal), /cancelled/);
  } finally { globalThis.fetch = originalFetch; }
});
