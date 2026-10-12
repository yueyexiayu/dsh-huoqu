import os from "node:os";
import path from "node:path";

function denial(mode, detail) {
  const error = new Error(`[sandbox: file access denied under ${mode} mode] ${detail}`);
  error.code = "FS_SANDBOX_DENIED";
  return error;
}

// SessionStore.get is a live-only lookup. Never load history or manufacture a
// Session-shaped policy object; detached/replaced objects must not retain grants.
export function captureSession(ctx, sessionId, expected) {
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId !== sessionId.trim()
    || sessionId.length > 200 || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw Object.assign(new Error("sessionId must be the current conversation id"), { status: 400 });
  }
  if (typeof ctx.sessions?.get !== "function") {
    throw Object.assign(new Error("huoqu 无法读取当前会话，已拒绝操作"), { status: 503 });
  }
  const session = ctx.sessions.get(sessionId);
  if (!session || session.id !== sessionId || (expected && session !== expected)) {
    throw Object.assign(new Error("当前会话不存在或未加载，已拒绝操作，不会回落到 Host 默认策略"), { status: 403 });
  }
  if (!path.isAbsolute(session.header?.cwd || "")) {
    throw Object.assign(new Error("当前会话没有有效的绝对工作区，已拒绝操作，不会回落到 Host 默认工作区"), { status: 403 });
  }
  return session;
}

// Binary captures and directory transactions are outside ctx.fs.writeText's
// text-only API. Use its public native resolution/containment before EACH Node
// mutation, including rollback and cleanup (a trusted-code fence, not a kernel).
export async function createCaptureAccess(ctx, exec) {
  const session = exec?.agent?.session;
  captureSession(ctx, session?.id, session);
  const fs = ctx.fs;
  const policyService = ctx.sandboxPolicy;
  if (typeof policyService?.resolve !== "function"
    || typeof fs?.resolve !== "function" || typeof fs?.processPath !== "function"
    || typeof fs?.contains !== "function") {
    throw denial("unavailable", "huoqu requires the DSH filesystem and sandboxPolicy services");
  }
  return {
    async assertWrite(...paths) {
      // Recheck live identity and resolve anew at EVERY operation. An aborted
      // capture still checks cleanup without reusing its original policy grant.
      captureSession(ctx, session.id, session);
      const policy = await policyService.resolve({ session });
      if (!policy || !["read-only", "workspace-write", "danger-full-access"].includes(policy.mode)
        || policy.sessionId !== session.id || !path.isAbsolute(policy.workspaceRoot || "")) {
        throw denial("unavailable", "sandboxPolicy did not return a valid policy for the loaded session");
      }
      if (policy.mode === "read-only") throw denial(policy.mode, "huoqu writes capture files and browser temporary data");
      // Same roots as the installed official writableRoots(policy).
      const roots = policy.mode === "workspace-write"
        ? await Promise.all([...new Set([policy.workspaceRoot, "/tmp", os.tmpdir()])]
          .map((root) => fs.resolve(root, { cwd: policy.workspaceRoot }))) : [];
      for (const value of paths) {
        if (typeof value !== "string" || !path.isAbsolute(value)) {
          throw denial(policy.mode, "capture mutations require absolute native paths");
        }
        const target = await fs.resolve(value, { cwd: policy.workspaceRoot });
        const native = fs.processPath(target);
        if (typeof native !== "string" || !path.isAbsolute(native)) {
          throw denial("unavailable", "huoqu requires a local native filesystem backend");
        }
        if (policy.mode === "workspace-write") {
          let contained = false;
          for (const root of roots) {
            if (await fs.contains(root, target)) { contained = true; break; }
          }
          if (!contained) {
            throw denial(policy.mode, `cannot modify ${JSON.stringify(value)} outside writable roots；workspace-write 只能写工作区、/tmp 和系统临时目录。写入 ~/Downloads 需要当前会话的文件策略为 danger-full-access`);
          }
        }
      }
    },
  };
}
