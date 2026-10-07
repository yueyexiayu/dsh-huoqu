import test from "node:test";
import assert from "node:assert/strict";
import { createJobManager } from "../lib/index.js";

const turn = () => new Promise(setImmediate);
const options = { url: "https://example.test/", outputDir: "/tmp/fixture" };

test("job queue caps running+queued, cancels queued work without starting it, and drains serially", async () => {
  const started = [];
  const releases = [];
  const manager = createJobManager(async (_, signal, id) => {
    started.push(id);
    await new Promise((resolve, reject) => {
      releases.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { ok: true };
  });
  try {
    const a = manager.start(options);
    const b = manager.start(options);
    const c = manager.start(options);
    const d = manager.start(options);
    assert.throws(() => manager.start(options), (error) => error.status === 429);
    await turn();
    assert.deepEqual(started, [a.id]);
    assert.equal(b.status, "queued");
    manager.cancel(b.id);
    await b.promise;
    assert.equal(b.status, "cancelled");
    releases.shift()();
    await a.promise;
    await turn();
    assert.deepEqual(started, [a.id, c.id]);
    releases.shift()();
    await c.promise;
    await turn();
    assert.deepEqual(started, [a.id, c.id, d.id]);
    releases.shift()();
    await d.promise;
    assert.equal(d.status, "completed");
  } finally { await manager.dispose(); }
});

test("partial capture is a distinct recoverable terminal result, never completed", async () => {
  const result = { ok: false, status: "partial", indexHtml: "/tmp/fixture/index.html", warnings: ["offline validation failed"] };
  const manager = createJobManager(async () => result);
  try {
    const job = manager.start(options);
    await job.promise;
    assert.equal(job.status, "partial");
    assert.equal(manager.list()[0].status, "partial");
    assert.equal(manager.get(job.id).result, result);
    manager.cancel(job.id);
    assert.equal(job.status, "partial");
  } finally { await manager.dispose(); }
});

test("timeout starts at enqueue and holds the running slot through cooperative cleanup", async () => {
  let finishCleanup;
  let calls = 0;
  const manager = createJobManager(async (_, signal) => {
    calls++;
    await new Promise((resolve) => signal.addEventListener("abort", () => {
      finishCleanup = resolve;
    }, { once: true }));
    return { ok: true }; // Delayed completion after cancellation must not report success.
  }, { timeoutMs: 15 });
  const holdEventLoop = setTimeout(() => {}, 1000);
  try {
    const a = manager.start(options);
    const b = manager.start(options);
    await b.promise;
    assert.equal(b.status, "timed_out");
    assert.equal(a.status, "cancelling");
    assert.equal(a.controller.signal.aborted, true);
    assert.equal(calls, 1);
    const c = manager.start(options);
    await turn();
    assert.equal(c.status, "queued");
    manager.cancel(c.id);
    finishCleanup();
    await a.promise;
    assert.equal(a.status, "timed_out");
    assert.equal(a.result, null);
  } finally {
    clearTimeout(holdEventLoop);
    if (finishCleanup) finishCleanup();
    await manager.dispose();
  }
});

test("dispose cancels running and queued jobs and waits for cleanup", async () => {
  let release;
  const manager = createJobManager(async (_, signal) => {
    await new Promise((resolve) => { release = resolve; });
    signal.throwIfAborted();
  });
  const a = manager.start(options);
  const b = manager.start(options);
  await turn();
  let finished = false;
  const disposed = manager.dispose().then(() => { finished = true; });
  await turn();
  assert.equal(a.status, "cancelling");
  assert.equal(b.status, "cancelled");
  assert.equal(finished, false);
  release();
  await disposed;
  assert.equal(a.status, "cancelled");
  assert.throws(() => manager.start(options), (error) => error.status === 503);
});
