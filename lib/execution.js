import path from "node:path";
import pluginManifest from "../package.json" with { type: "json" };
import policyManifest from "./browser-policy/manifest.json" with { type: "json" };
import { parseBrowserExecutionRequest, resolveBrowserExecution, validateBrowserExecution } from "./browser-policy/execution.js";

// 浏览器策略代码已内联到 ./browser-policy/，不再依赖停发的 @deepseek-ai/dsh-browser-use。
// 溯源字段来自同目录 manifest.json，供 /api/huoqu 与测试断言使用。
export const BROWSER_POLICY_PACKAGE = Object.freeze({
  name: policyManifest.name,
  version: policyManifest.version,
  localArtifactVersion: policyManifest.dshLocalArtifactVersion,
  sourceSha256: policyManifest.dshSourceArtifact?.sourceSha256,
  vendored: true,
});

export { validateBrowserExecution };
export const HUOQU_VERSION = pluginManifest.version;

// Host supplies the live Session and a batch ID outside the tool's request wire.
export function captureExecution(options, operation, { identity, purpose = options.purpose } = {}) {
  if (!operation || !path.isAbsolute(operation.cwd || "")) throw new Error("capture requires an explicit operation cwd and execution scope from its owner");
  const current = (identity ?? options.browserIdentity) !== "anonymous";
  return resolveBrowserExecution(parseBrowserExecutionRequest({
    scope: operation.scope,
    purpose,
    mode: current ? "headed" : "headless",
    ownership: current ? "borrowed-connection" : "owned-process",
    capabilities: current ? ["dom", "screenshot", "authenticated-state"] : ["dom", "screenshot"],
  }));
}

export function validateCaptureAttachment(browser, execution) {
  const metadata = browser?.execution;
  if (!metadata || browser.mode !== "extension" || browser.backend !== "chrome-extension"
    || typeof browser.engine?.browserVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(browser.engine.browserVersion)
    || metadata.scope?.sessionId !== execution.scope.sessionId || metadata.scope?.taskId !== execution.scope.taskId
    || metadata.purpose !== execution.purpose || metadata.mode !== execution.mode || metadata.ownership !== execution.ownership) {
    throw Object.assign(new Error("Chrome capture adapter did not return matching execution scope and actual engine version; no anonymous fallback"), { code: "BROWSER_ENGINE_MISMATCH" });
  }
  validateBrowserExecution(execution, { kind: "attach", engine: browser.engine });
}

export function captureBrowserRecord(browser, requestedIdentity) {
  return {
    scope: browser.execution.scope,
    purpose: browser.execution.purpose,
    backend: browser.backend,
    mode: browser.mode === "embedded" ? "hidden-window" : browser.execution.mode,
    ownership: browser.mode === "embedded" ? "operation-owned-window" : browser.execution.ownership,
    requestedIdentity,
    actualIdentity: browser.mode === "embedded" ? "dsh-embedded" : browser.mode === "extension" ? "current" : "anonymous",
    engine: browser.engine,
    runtimeVersion: browser.runtimeVersion || null,
    policyPackage: BROWSER_POLICY_PACKAGE,
    downgradeReason: browser.fallbackReason || null,
  };
}
