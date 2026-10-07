import os from "node:os";
import path from "node:path";

function denial(mode, detail) {
  const error = new Error(`[sandbox: file access denied under ${mode} mode] ${detail}`);
  error.code = "FS_SANDBOX_DENIED";
  return error;
}

// Binary captures and directory transactions are outside ctx.fs.writeText's text-only
// API. Resolve through the official backend and apply its public containment API
// before EACH Node filesystem mutation, including rollback and cleanup. This is
// the same trusted-code containment fence as dsh-fs-sandbox, not kernel isolation.
export async function createCaptureAccess(ctx, exec) {
  const fs = ctx.fs;
  const policyService = ctx.sandboxPolicy;
  if (typeof policyService?.resolve !== "function"
    || typeof fs?.resolve !== "function" || typeof fs?.processPath !== "function"
    || typeof fs?.contains !== "function") {
    throw denial("unavailable", "huoqu requires the DSH filesystem and sandboxPolicy services");
  }
  const request = exec?.agent?.session ? { session: exec.agent.session } : {};
  return {
    async assertWrite(...paths) {
      // Resolve anew so changing a session's mode during a job cannot leave a
      // cached grant active. Do not pass an aborted signal: cleanup still needs
      // permission checks, but must be able to remove its own temporary files.
      const policy = await policyService.resolve(request);
      if (!policy || !["read-only", "workspace-write", "danger-full-access"].includes(policy.mode)) {
        throw denial("unavailable", "sandboxPolicy returned an unknown file policy");
      }
      if (policy.mode === "read-only") throw denial(policy.mode, "huoqu writes capture files and browser temporary data");
      if (!path.isAbsolute(policy.workspaceRoot || "")) {
        throw denial("unavailable", "sandboxPolicy did not provide an absolute workspace root");
      }
      // Keep parity with the installed official writableRoots(policy): workspace,
      // host /tmp and os.tmpdir(). UI calls without a session use deployment policy;
      // they do NOT manufacture a danger-full-access policy or accept escalation.
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
          if (!contained) throw denial(policy.mode, `cannot modify ${JSON.stringify(value)} outside writable roots`);
        }
      }
    },
  };
}
