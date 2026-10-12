import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCaptureAccess, captureSession } from "../lib/permissions.js";

// Optional installed-official contract integration: never modifies the source,
// starts a Host, reads persistence/credentials or uses real user sessions.
const root = process.env.DSH_OFFICIAL_ROOT;
test("official live SessionStore, projection policy and local FS honor dynamic session boundaries", { skip: !root }, async () => {
  const load = (name) => import(pathToFileURL(path.join(root, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { SandboxPolicyService, setSandboxMode }, { LocalFileSystem }] = await Promise.all([
    load("cordis"), load("dsh-session"), load("dsh-session-projection"), load("dsh-sandbox-policy"), load("dsh-fs-local"),
  ]);
  const ctx = new Context();
  const fibers = [ctx.plugin(SessionStore), ctx.plugin(SessionProjectionRegistry), ctx.plugin(LocalFileSystem, { cwd: "/tmp" }),
    ctx.plugin(SandboxPolicyService, { mode: "danger-full-access", workspaceRoot: "/tmp" })];
  await Promise.all(fibers.map((fiber) => fiber.await()));
  let detach;
  try {
    const session = ctx.sessions.prepare("huoqu-official-fixture", { meta: { cwd: "/tmp" } });
    assert.equal(ctx.sessions.get(session.id), undefined, "prepared/detached replay is not loaded");
    assert.throws(() => captureSession(ctx, session.id), (error) => error.status === 403);
    detach = ctx.sessions.enter(session);
    assert.equal(captureSession(ctx, session.id), session);
    setSandboxMode(session, "workspace-write");
    const access = await createCaptureAccess(ctx, { agent: { session } });
    await access.assertWrite("/tmp/huoqu-official-fixture");
    await assert.rejects(access.assertWrite("/Users/huoqu-outside-fixture"), { code: "FS_SANDBOX_DENIED" });
    setSandboxMode(session, "read-only");
    await assert.rejects(access.assertWrite("/tmp/huoqu-official-fixture"), { code: "FS_SANDBOX_DENIED" });
    setSandboxMode(session, "danger-full-access");
    await access.assertWrite("/Users/huoqu-outside-fixture");
    detach(); detach = null;
    await assert.rejects(access.assertWrite("/tmp/huoqu-official-fixture"), (error) => error.status === 403);
    const replacement = ctx.sessions.prepare(session.id, { meta: { cwd: "/tmp" } });
    detach = ctx.sessions.enter(replacement);
    await assert.rejects(createCaptureAccess(ctx, { agent: { session } }), (error) => error.status === 403);
  } finally {
    detach?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});
