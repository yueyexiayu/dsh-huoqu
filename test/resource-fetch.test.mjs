import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { htmlToMhtml, materializeMhtml } from "../lib/archive.js";

// Expose the actual private implementation only in this test's module loader.
const captureUrl = new URL("../lib/capture.js", import.meta.url).href;
const source = await readFile(new URL(captureUrl), "utf8");
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== captureUrl) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `${source}
export { assertAllowedResource, assertNavigationAllowed, privateRemoteAddressError, pinnedResourceRequest, fetchExtraResource, completeExternalResources, resolveHostname };
export function useResolver(fn) { resolveHostname = fn; }
export function usePinnedResourceRequest(fn) { pinnedResourceRequest = fn; }
`,
    };
  },
});
const {
  assertAllowedResource,
  assertNavigationAllowed,
  privateRemoteAddressError,
  pinnedResourceRequest,
  fetchExtraResource,
  completeExternalResources,
  resolveHostname,
  useResolver,
  usePinnedResourceRequest,
} = await import(captureUrl);
hook.deregister();
const originalResolveHostname = resolveHostname;
const originalPinnedResourceRequest = pinnedResourceRequest;

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

test("private resources on the explicitly selected request host remain allowed", async () => {
  for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "localhost"]) {
    const url = new URL(`http://${host}/image.png`);
    await assertAllowedResource(url, url.origin);
    await assertAllowedResource(url, `http://${host}/page`);
  }
  await assert.rejects(assertAllowedResource(new URL("http://127.0.0.1/image.png"), "https://example.test/"), /private\/local/);
  await assert.rejects(assertAllowedResource(new URL("http://localhost/image.png"), "http://127.0.0.1/page"), /private\/local/);
  await assert.rejects(assertAllowedResource(new URL("http://metadata./latest"), "https://example.test/"), /private\/local/);
  await assert.rejects(assertAllowedResource(new URL("http://printer.local/icon.png"), "https://example.test/"), /private\/local/);
  await assert.rejects(assertAllowedResource(new URL("http://db.internal/icon.png"), "https://example.test/"), /private\/local/);
});

test("resource completion stops fetching after 1200 resources", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("fixture", { headers: { "content-type": "image/png" } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(1300);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 1200);
    assert.equal(result.resources.length, 1200);
    assert.equal(result.materialized.externalReferences.length, 100);
    assert.ok(result.failures.length);
  } finally { globalThis.fetch = originalFetch; }
});

test("resource completion stops fetching at the 1000 MiB byte budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(200 * 1024 * 1024);
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
  };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(12);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 5);
    assert.equal(result.totalBytes, 1000 * 1024 * 1024);
    assert.equal(result.resources.length, 5);
    assert.equal(result.materialized.externalReferences.length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("bytes read before a stream failure still consume the total budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(200 * 1024 * 1024);
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
    assert.equal(result.totalBytes, 800 * 1024 * 1024);
    assert.equal(result.resources.length, 4);
    assert.ok(result.failures.some((failure) => failure.error.includes("injected stream failure")));
    assert.ok(result.failures.some((failure) => failure.error.includes("byte total limit")));
  } finally { globalThis.fetch = originalFetch; }
});

test("failed resource requests still consume the 1200 request budget", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response("missing", { status: 404 }); };
  try {
    const { mhtml, initial, sourceUrl } = imageArchive(1300);
    const result = await completeExternalResources(mhtml, initial, sourceUrl);
    assert.equal(calls, 1200);
    assert.equal(result.resources.length, 0);
    assert.ok(result.failures.some((failure) => failure.error.includes("request limit")));
  } finally { globalThis.fetch = originalFetch; }
});

test("the final response is cancelled when it exceeds the remaining byte budget", async () => {
  let calls = 0;
  let cancelled = false;
  const originalFetch = globalThis.fetch;
  const full = new Uint8Array(200 * 1024 * 1024);
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 5) return new Response(full, { headers: { "content-type": "image/png" } });
    if (calls === 5) return new Response(new Uint8Array(190 * 1024 * 1024), { headers: { "content-type": "image/png" } });
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
    assert.equal(result.totalBytes, 990 * 1024 * 1024);
    assert.equal(result.resources.length, 5);
    assert.ok(result.failures.some((failure) => failure.error.includes("10485760 byte limit")));
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

test("an in-document video between 200 MiB and 640 MiB is downloaded", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(201 * 1024 * 1024);
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

test("navigation allows the same explicit private host and rejects a different private host", async () => {
  await assertNavigationAllowed("http://127.0.0.1/page", "http://127.0.0.1/other");
  await assertNavigationAllowed("http://localhost./page", "http://localhost/other");
  await assertNavigationAllowed("https://example.test./page", "https://example.test/other");
  for (const target of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://172.16.5.5/",
    "http://192.168.1.9/",
    "http://localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://metadata/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    await assert.rejects(assertNavigationAllowed("https://example.test/", target), /private\/local/);
  }
  await assert.rejects(assertNavigationAllowed("http://127.0.0.1/", "http://localhost/"), /private\/local/);
  await assert.rejects(assertNavigationAllowed("https://example.test/", "file:///etc/passwd"), /非网页地址/);
});

test("a public name that resolves to a private address is rejected before navigation", async () => {
  useResolver(async () => [{ address: "10.0.0.8", family: 4 }]);
  try {
    await assert.rejects(assertNavigationAllowed("https://rebind.example/", "https://rebind.example/"), /private\/local/);
    await assert.rejects(assertNavigationAllowed("https://example.test/", "https://rebind.example/moved"), /private\/local/);
  } finally {
    useResolver(originalResolveHostname);
  }
});

test("explicit private hosts skip the public-name resolution check", async () => {
  useResolver(async () => { throw new Error("must not resolve an explicit private host"); });
  try {
    await assertNavigationAllowed("http://127.0.0.1/", "http://127.0.0.1/x");
    await assertNavigationAllowed("http://localhost/", "http://localhost/x");
    await assertNavigationAllowed("http://printer.local/", "http://printer.local/x");
  } finally {
    useResolver(originalResolveHostname);
  }
});

test("private remote addresses abort only when the request host differs", () => {
  assert.equal(privateRemoteAddressError("", "http://cdn.example/", "https://example.test/"), null);
  assert.equal(privateRemoteAddressError(undefined, "http://10.0.0.1/", "https://example.test/"), null);
  assert.equal(privateRemoteAddressError("8.8.8.8", "http://cdn.example/", "https://example.test/"), null);
  assert.equal(privateRemoteAddressError("127.0.0.1", "http://127.0.0.1/x", "http://127.0.0.1/page"), null);
  assert.equal(privateRemoteAddressError("127.0.0.1", "file:///tmp/index.html", "https://example.test/"), null);
  assert.match(privateRemoteAddressError("169.254.169.254", "http://169.254.169.254/latest", "https://example.test/").message, /private\/local/);
  assert.match(privateRemoteAddressError("::1", "http://[::1]/", "https://example.test/").message, /private\/local/);
  assert.match(privateRemoteAddressError("::ffff:127.0.0.1", "http://127.0.0.1/", "https://example.test/").message, /private\/local/);
  assert.match(privateRemoteAddressError("10.0.0.1", "", "https://example.test/").message, /private\/local/);
});

test("cross-host fetch pins each redirect hop and does not fetch by hostname", async () => {
  const calls = [];
  useResolver(async (hostname) => {
    if (hostname === "cdn.example") return [{ address: "8.8.8.8", family: 4 }];
    if (hostname === "img.example") return [{ address: "1.1.1.1", family: 4 }];
    throw new Error(`unexpected lookup ${hostname}`);
  });
  usePinnedResourceRequest(async (url, options) => {
    calls.push({ host: url.hostname, address: options.address, family: options.family });
    if (url.hostname === "cdn.example") {
      return new Response(null, { status: 302, headers: { location: "https://img.example/a.png" } });
    }
    return new Response("fixture", { headers: { "content-type": "image/png" } });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("cross-host request must not fetch by hostname");
  try {
    const result = await fetchExtraResource("https://cdn.example/app.png", "https://example.test/page");
    assert.deepEqual(calls, [
      { host: "cdn.example", address: "8.8.8.8", family: 4 },
      { host: "img.example", address: "1.1.1.1", family: 4 },
    ]);
    assert.equal(result.bytes.toString(), "fixture");
  } finally {
    globalThis.fetch = originalFetch;
    useResolver(originalResolveHostname);
    usePinnedResourceRequest(originalPinnedResourceRequest);
  }
});

test("a public resource redirect to a private host is rejected before connect", async () => {
  useResolver(async () => [{ address: "8.8.8.8", family: 4 }]);
  usePinnedResourceRequest(async (url) => {
    if (url.hostname !== "cdn.example") assert.fail(`must not connect to ${url.hostname}`);
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  });
  try {
    await assert.rejects(fetchExtraResource("https://cdn.example/app.png", "https://example.test/"), /private\/local/);
  } finally {
    useResolver(originalResolveHostname);
    usePinnedResourceRequest(originalPinnedResourceRequest);
  }
});

test("pinned resource request connects to the resolved address and keeps the original host", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.headers.host);
    res.setHeader("content-type", "image/png");
    res.end("pinned");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const response = await pinnedResourceRequest(new URL(`http://pinned.example:${port}/asset.png`), {
      address: "127.0.0.1",
      family: 4,
      headers: { accept: "image/*" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
    assert.equal(hits[0], `pinned.example:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
