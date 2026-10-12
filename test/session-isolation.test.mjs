import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createCaptureAccess } from "../lib/permissions.js";

const hook = registerHooks({
  load(url, context, next) {
    if (url === new URL("../lib/capture.js", import.meta.url).href) return {
      format: "module", shortCircuit: true,
      source: `export async function capturePage(options, signal, access) {
        await access.assertWrite(options.outputDir);
        signal.throwIfAborted();
        if (options.url.endsWith('/hold')) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
        return {ok:true, status:'completed', indexHtml:'/tmp/out/index.html'};
      }`,
    };
    return next(url, context);
  },
});
const { apply } = await import("../lib/index.js");
hook.deregister();
function fixture() {
  const a = { id: "a", header: { cwd: "/tmp" } }, b = { id: "b", header: { cwd: "/tmp" } };
  const sessions = new Map([[a.id, a], [b.id, b]]), requests = [];
  let route, dispose, mode = "danger-full-access";
  const ctx = {
    sessions: { get: (id) => sessions.get(id) },
    fs: { resolve: async (value) => ({ path: value }), processPath: (target) => target.path, contains: () => true },
    sandboxPolicy: { resolve(request) { requests.push(request); return { mode, workspaceRoot: "/tmp", sessionId: request.session?.id }; } },
    tools: { register() {} }, connection: { fetch: { register(value) { route = value; } } }, effect(fn) { dispose = fn(); },
  };
  apply(ctx);
  const post = (body) => route.fetch(new Request("http://fixture/api/huoqu", { method: "POST", body: JSON.stringify(body) }));
  const get = (sessionId, jobId) => route.fetch(new Request(`http://fixture/api/huoqu?sessionId=${sessionId || ""}${jobId ? `&jobId=${jobId}` : ""}`));
  const start = async (sessionId, suffix = "good") => { const response = await post({ sessionId, url: `https://example.test/${suffix}`, output_dir: "/tmp/out" }); assert.equal(response.status, 202); return (await response.json()).jobId; };
  const done = async (id) => { for (let n = 0; n < 100; n++) { const state = await (await get("a", id)).json(); if (!["queued", "running", "cancelling"].includes(state.status)) return state; await new Promise(setImmediate); } assert.fail("did not settle"); };
  return { a, b, sessions, requests, ctx, post, get, start, done, dispose: () => dispose(), mode(value) { mode = value; } };
}

test("every HTTP operation requires a valid loaded session, without Host fallback", async () => {
  const f = fixture();
  try {
    assert.equal((await f.get("", "missing")).status, 400);
    for (const action of ["capture", "cancel", "open", "choose-folder"]) {
      for (const sessionId of [undefined, null, "", "  ", 12]) {
        assert.equal((await f.post({ action, sessionId, url: "https://example.test/", jobId: "missing" })).status, 400, `${action}/${sessionId}`);
      }
      assert.equal((await f.post({ action, sessionId: "historical-only", url: "https://example.test/", jobId: "missing" })).status, 403);
    }
    assert.equal(f.requests.length, 0);
  } finally { await f.dispose(); }
});

test("list/status/open/cancel do not expose or mutate another session's job", async () => {
  const f = fixture();
  try {
    const id = await f.start("a", "hold");
    await new Promise(setImmediate);
    assert.deepEqual((await (await f.get("b")).json()).jobs, []);
    assert.equal((await f.get("b", id)).status, 404);
    for (const action of ["open", "cancel"]) assert.equal((await f.post({ action, sessionId: "b", jobId: id, target: "index" })).status, 404);
    assert.equal((await (await f.get("a", id)).json()).status, "running");
    assert.equal((await f.post({ action: "cancel", sessionId: "a", jobId: id })).status, 200);
    assert.equal((await f.done(id)).status, "cancelled");
  } finally { await f.dispose(); }
});

test("queued capture refuses an unloaded owner before execution", async () => {
  const f = fixture();
  try {
    const holding = await f.start("a", "hold");
    const queued = await f.start("b");
    f.sessions.delete("b");
    await f.post({ action: "cancel", sessionId: "a", jobId: holding });
    await new Promise(setImmediate);
    f.sessions.set("b", f.b);
    const state = await (await f.get("b", queued)).json();
    assert.equal(state.status, "failed");
    assert.match(state.error, /未加载|not loaded/);
    assert.equal(state.result, null);
  } finally { await f.dispose(); }
});

test("queued capture rereads mode instead of retaining an enqueue grant", async () => {
  const f = fixture();
  try {
    const holding = await f.start("a", "hold");
    const queued = await f.start("a");
    f.mode("read-only");
    await f.post({ action: "cancel", sessionId: "a", jobId: holding });
    const state = await f.done(queued);
    assert.equal(state.status, "failed");
    assert.match(state.error, /read-only/);
  } finally { await f.dispose(); }
});

test("filesystem access never resolves agentless policy or uses detached session objects", async () => {
  const f = fixture();
  try {
    await assert.rejects(createCaptureAccess(f.ctx), /session/i);
    await assert.rejects(createCaptureAccess(f.ctx, { agent: { session: { ...f.a } } }), /未加载|not loaded/);
    assert.equal(f.requests.length, 0);
    const access = await createCaptureAccess(f.ctx, { agent: { session: f.a } });
    await access.assertWrite("/tmp/stage");
    f.sessions.delete("a");
    await assert.rejects(access.assertWrite("/tmp/stage"), /未加载|not loaded/);
    assert.equal(f.requests.length, 1);
  } finally { await f.dispose(); }
});

test("unknown, unattributed or invalid-root policies never fall back to a permissive default", async () => {
  const f = fixture();
  try {
    const access = await createCaptureAccess(f.ctx, { agent: { session: f.a } });
    for (const policy of [null, { mode: "unknown", workspaceRoot: "/tmp", sessionId: "a" },
      { mode: "danger-full-access", workspaceRoot: "/tmp" },
      { mode: "danger-full-access", workspaceRoot: "/tmp", sessionId: "b" },
      { mode: "danger-full-access", workspaceRoot: "relative", sessionId: "a" }]) {
      f.ctx.sandboxPolicy.resolve = () => policy;
      await assert.rejects(access.assertWrite("/tmp/stage"), { code: "FS_SANDBOX_DENIED" });
    }
    f.a.header.cwd = "relative";
    await assert.rejects(createCaptureAccess(f.ctx, { agent: { session: f.a } }), /默认工作区/);
  } finally { await f.dispose(); }
});

test("cleanup observes tightened policy even when capture has already been cancelled", async () => {
  const f = fixture();
  try {
    const access = await createCaptureAccess(f.ctx, { agent: { session: f.a }, signal: AbortSignal.abort() });
    await access.assertWrite("/tmp/stage");
    f.mode("read-only");
    await assert.rejects(access.assertWrite("/tmp/stage"), { code: "FS_SANDBOX_DENIED" });
    assert.ok(f.requests.every((request) => request.session === f.a));
  } finally { await f.dispose(); }
});
