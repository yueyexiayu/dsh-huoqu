import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Only browser and OS-launch side effects are replaced; actual Host, parser,
// owner and access-policy adapter are exercised.
const captureUrl = new URL("../lib/capture.js", import.meta.url).href;
const ownerUrl = new URL("../../chrome/lib/owner.js", import.meta.url).href;
const parseUrl = new URL("../lib/parse.js", import.meta.url).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === "node:child_process") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from 'node:events';
        export function spawn() {
          const child = new EventEmitter(); child.stderr = new EventEmitter();
          child.stderr.setEncoding = () => {};
          setImmediate(() => { child.emit('spawn'); child.stderr.emit('data', 'fixture open failed'); child.emit('close', 1); });
          return child;
        }`,
    };
    if (url !== captureUrl) return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: `import { currentOwner } from ${JSON.stringify(ownerUrl)};
        import { normalizeCaptureOptions } from ${JSON.stringify(parseUrl)};
        export async function capturePage(input, signal, access) {
          const options = normalizeCaptureOptions(input);
          await access.assertWrite(options.outputDir);
          signal.throwIfAborted();
          if (input.url.endsWith('/failed')) throw new Error('capture fixture failed');
          if (input.url.endsWith('/hold')) await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
          });
          return {ok: !input.url.endsWith('/partial'), status: input.url.endsWith('/partial') ? 'partial' : 'completed', title: currentOwner(), waitSeconds: options.waitSeconds, indexHtml: '/tmp/huoqu/index.html', warnings: []};
        }`,
    };
  },
});
const { apply } = await import("../lib/index.js");
hook.deregister();
let tool, route, dispose;
let mode = "danger-full-access";
const policyRequests = [];
const sessions = new Map();
const sessionModes = new Map();
const fsTargets = [];
apply({
  tools: { register(value) { tool = value; } },
  connection: { fetch: { register(value) { route = value; } } },
  effect(fn) { dispose = fn(); },
  fs: {
    async resolve(value) { fsTargets.push(value); return { path: value }; },
    processPath(target) { return target.path; },
    async contains(root, target) { return target.path === root.path || target.path.startsWith(root.path + "/"); },
  },
  sandboxPolicy: { resolve(request) {
    policyRequests.push(request);
    return { mode: request.session ? (sessionModes.get(request.session.id) || mode) : mode, workspaceRoot: "/tmp" };
  } },
  sessions: { get(id) { return sessions.get(id); } },
});
const post = (body, signal) => route.fetch(new Request("http://dsh.local/api/huoqu", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
}));
const state = async (id) => (await route.fetch(new Request(`http://dsh.local/api/huoqu?jobId=${id}`))).json();
async function settled(id) {
  for (let i = 0; i < 100; i++) {
    const value = await state(id);
    if (!["queued", "running", "cancelling"].includes(value.status)) return value;
    await new Promise(setImmediate);
  }
  assert.fail("fixture did not finish");
}
const start = async (suffix, extra = {}) => {
  const response = await post({ url: `https://example.test/${suffix}`, output_dir: "/tmp/huoqu-fixture", ...extra });
  assert.equal(response.status, 202);
  return response.json();
};

test("Host tool preserves ownership and resolves the calling session policy", async () => {
  const result = await tool.execute({ url: "https://example.test/good", output_dir: "/tmp/fixture" }, { agent: { session: { id: "session-fixture" } } });
  assert.equal(result.title, "session-fixture");
  assert.deepEqual(policyRequests.at(-1), { session: { id: "session-fixture" } });
  assert.ok(fsTargets.includes("/tmp/fixture"));
});

test("capture jobs have distinct owners, preserve wait_seconds and partial validation", async () => {
  const first = await start("partial", { wait_seconds: 17 });
  const second = await start("good");
  const partial = await settled(first.jobId);
  const good = await settled(second.jobId);
  assert.equal(partial.status, "partial");
  assert.equal(partial.result.ok, false);
  assert.equal(partial.result.status, "partial");
  assert.equal(partial.result.waitSeconds, 17);
  assert.equal(partial.result.title, `huoqu-job:${first.jobId}`);
  assert.equal(good.result.title, `huoqu-job:${second.jobId}`);
  assert.notEqual(partial.result.title, good.result.title);
  assert.deepEqual(policyRequests.at(-1), {});
  const failed = await settled((await start("failed")).jobId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, null);
  assert.equal(failed.error, "capture fixture failed");
});

test("HTTP rejects read-only policy and permission overrides before starting", async () => {
  mode = "read-only";
  try {
    const denied = await post({ url: "https://example.test/good" });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /file access denied/);
    const override = await post({ url: "https://example.test/good", sandbox_permissions: "danger-full-access" });
    assert.equal(override.status, 400);
  } finally { mode = "danger-full-access"; }
});

test("sidebar capture uses the loaded conversation policy instead of deployment workspace-write", async () => {
  const full = { id: "conversation-full" };
  const limited = { id: "conversation-limited" };
  sessions.set(full.id, full);
  sessions.set(limited.id, limited);
  sessionModes.set(full.id, "danger-full-access");
  sessionModes.set(limited.id, "workspace-write");
  const previous = mode;
  mode = "workspace-write";
  try {
    const missing = await post({ url: "https://example.test/good", output_dir: "/Users/ning/Downloads", sessionId: "missing" });
    assert.equal(missing.status, 403);
    assert.match((await missing.json()).error, /不会回落到/);
    const malformed = await post({ url: "https://example.test/good", sessionId: 12 });
    assert.equal(malformed.status, 400);

    const denied = await post({ url: "https://example.test/good", output_dir: "/Users/ning/Downloads", sessionId: limited.id });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /cannot modify "\/Users\/ning\/Downloads"/);

    const before = policyRequests.length;
    const started = await post({ url: "https://example.test/good", output_dir: "/Users/ning/Downloads", sessionId: full.id });
    assert.equal(started.status, 202);
    const job = await started.json();
    const done = await settled(job.jobId);
    assert.equal(done.status, "completed");
    assert.equal(done.result.title, `huoqu-job:${job.jobId}`);
    const seen = policyRequests.slice(before);
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((request) => request.session === full));
  } finally {
    mode = previous;
    sessions.clear();
    sessionModes.clear();
  }
});

test("native open allows completed and partial results, and reports nonzero exit", { skip: process.platform !== "darwin" }, async () => {
  for (const outcome of ["good", "partial"]) {
    const job = await start(outcome);
    await settled(job.jobId);
    const response = await post({ action: "open", jobId: job.jobId, target: "index" });
    assert.equal(response.status, 500, "open should reach the OS launcher, not reject the partial result as missing");
    assert.match((await response.json()).error, /fixture open failed/);
  }
});

test("HTTP jobs survive request disconnect, can be listed/recovered and explicitly cancelled", async () => {
  const request = new AbortController();
  const response = await post({ url: "https://example.test/hold", output_dir: "/tmp/fixture" }, request.signal);
  const job = await response.json();
  await new Promise(setImmediate);
  request.abort();
  assert.equal((await state(job.jobId)).status, "running");
  const listing = await (await route.fetch(new Request("http://dsh.local/api/huoqu"))).json();
  assert.ok(listing.jobs.some((entry) => entry.jobId === job.jobId && entry.status === "running"));
  const cancelled = await post({ action: "cancel", jobId: job.jobId });
  assert.equal(cancelled.status, 200);
  assert.equal((await settled(job.jobId)).status, "cancelled");
  assert.equal((await post({ action: "cancel", jobId: "missing" })).status, 404);
});

test("missing optional Chrome owner allows startup/capture, other owner errors stay visible", async () => {
  let failure = Object.assign(new Error("optional owner missing"), { code: "ERR_MODULE_NOT_FOUND", url: ownerUrl });
  const missing = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === ownerUrl) throw failure;
      return nextResolve(specifier, context);
    },
  });
  try {
    // A fresh Host entry must not statically import Chrome at startup.
    const standalone = await import("../lib/index.js?owner-unavailable");
    assert.equal(standalone.name, "huoqu");
    const result = await tool.execute({ url: "https://example.test/good", output_dir: "/tmp/fixture" }, {});
    assert.equal(result.ok, true);
    failure = new SyntaxError("owner fixture syntax failure");
    await assert.rejects(tool.execute({ url: "https://example.test/good" }, {}), /owner fixture syntax failure/);
    failure = Object.assign(new Error("transitive dependency missing"), { code: "ERR_MODULE_NOT_FOUND", url: "file:///missing-dependency.js" });
    await assert.rejects(tool.execute({ url: "https://example.test/good" }, {}), /transitive dependency missing/);
  } finally { missing.deregister(); }
});

test("plugin disposal aborts captures and refuses new work", async () => {
  const job = await start("hold");
  const toolStopped = assert.rejects(tool.execute({ url: "https://example.test/hold", output_dir: "/tmp/fixture" }, {}), /disposed/);
  await new Promise(setImmediate);
  await dispose();
  await toolStopped;
  assert.equal((await state(job.jobId)).status, "cancelled");
  assert.equal((await post({ url: "https://example.test/good" })).status, 503);
  await assert.rejects(tool.execute({ url: "https://example.test/good" }, {}), /disposed/);
});
