import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, access as fsAccess } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCaptureAccess as createAccess } from "../lib/permissions.js";
const fixtureSession = { id: "fixture", header: { cwd: os.tmpdir() } };
const createCaptureAccess = (ctx, exec = { agent: { session: fixtureSession } }) => createAccess(ctx, exec);
import { capturePage } from "../lib/capture.js";

// A local FS service test double implements only the official public interfaces;
// it supplies physical path identity rather than duplicating the policy fence.
async function resolveNative(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try { return path.join(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
function context(policy, requests = []) {
  return {
    sessions: { get(id) { return id === fixtureSession.id ? fixtureSession : undefined; } },
    sandboxPolicy: { resolve(request) { requests.push(request); return { ...(typeof policy === "function" ? policy(request) : policy), sessionId: request.session?.id }; } },
    fs: {
      async resolve(value) { return { displayPath: value, targetKey: await resolveNative(value) }; },
      processPath(target) { return target.targetKey; },
      contains(parent, child) {
        const relative = path.relative(parent.targetKey, child.targetKey);
        return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      },
    },
  };
}
const denied = { code: "FS_SANDBOX_DENIED" };

test("missing/unknown official policy fails closed rather than running without permission checks", async () => {
  await assert.rejects(createCaptureAccess({}), /无法读取当前会话/);
  const ctx = context({ mode: "unknown", workspaceRoot: os.tmpdir() });
  await assert.rejects((await createCaptureAccess(ctx)).assertWrite(path.join(os.tmpdir(), "capture")), denied);
});

test("read-only capture refuses before output creation or browser startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huoqu-permission-"));
  const outputDir = path.join(dir, "must-not-exist");
  try {
    const access = await createCaptureAccess(context({ mode: "read-only", workspaceRoot: dir }));
    await assert.rejects(capturePage({ url: "https://example.test/", output_dir: outputDir }, undefined, access), denied);
    await assert.rejects(fsAccess(outputDir), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workspace fence canonicalizes roots, checks both rename endpoints and blocks prefix siblings", async () => {
  const dir = await mkdtemp(path.join(os.homedir(), ".huoqu-permission-"));
  const workspace = path.join(dir, "work");
  const outside = path.join(dir, "work-other");
  try {
    await mkdir(workspace); await mkdir(outside);
    const access = await createCaptureAccess(context({ mode: "workspace-write", workspaceRoot: workspace }));
    await access.assertWrite(path.join(workspace, "stage"), path.join(workspace, "assets", "a.png"));
    await assert.rejects(access.assertWrite(path.join(workspace, "source"), path.join(outside, "destination")), denied);
    await symlink(outside, path.join(workspace, "escape"));
    await assert.rejects(access.assertWrite(path.join(workspace, "escape", "capture")), denied);
    await symlink(workspace, path.join(dir, "workspace-alias"));
    await access.assertWrite(path.join(dir, "workspace-alias", "capture"));
    const temp = path.join(os.tmpdir(), "huoqu-permitted-temp");
    await access.assertWrite(temp);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session policy is supplied and reread on every mutation, including cleanup", async () => {
  const requests = [];
  let mode = "danger-full-access";
  const session = fixtureSession;
  const access = await createCaptureAccess(context(() => ({ mode, workspaceRoot: os.tmpdir() }), requests), { agent: { session } });
  await access.assertWrite(path.join(os.homedir(), "Downloads", "huoqu", "fixture"));
  mode = "read-only";
  await assert.rejects(access.assertWrite(path.join(os.tmpdir(), "fixture-stage")), denied);
  assert.deepEqual(requests, [{ session }, { session }]);
});

test("agentless calls are rejected without resolving deployment policy", async () => {
  const requests = [];
  await assert.rejects(createAccess(context({ mode: "danger-full-access", workspaceRoot: os.tmpdir() }, requests)), /sessionId/);
  assert.deepEqual(requests, []);
});
