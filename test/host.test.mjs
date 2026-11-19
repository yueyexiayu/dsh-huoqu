import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { API_PATH, apply, inject, name } from "../lib/index.js";
import { BROWSER_POLICY_PACKAGE } from "../lib/execution.js";
import { pluginPackage } from "./package-fixture.mjs";

test("host entry registers huoqu tool and the declared route", async () => {
  let tool;
  let route;
  const session = { id: "fixture", header: { cwd: "/tmp" } };
  apply({
    sessions: { get(id) { return id === session.id ? session : undefined; } },
    tools: { register(value) { tool = value; } },
    connection: { fetch: { register(value) { route = value; } } },
    effect(fn) { return fn(); },
    fs: { async resolve(value) { return { path: value }; }, processPath(target) { return target.path; }, async contains(root, target) { return target.path === root.path || target.path.startsWith(root.path + "/"); } },
    sandboxPolicy: { resolve() { return { mode: "danger-full-access", workspaceRoot: "/tmp" }; } },
  });
  assert.equal(name, "huoqu");
  assert.deepEqual(inject, ["tools", "connection", "fs", "sandboxPolicy", "sessions"]);
  assert.equal(tool.name, "huoqu");
  assert.deepEqual(tool.parameters.required, ["url"]);
  assert.equal(tool.output.schema.properties.localPage.type, "object");
  assert.equal(route.path, API_PATH);
  assert.deepEqual(route.methods, ["GET", "POST"]);

  const missing = await route.fetch(new Request("http://dsh.local/api/huoqu?jobId=missing&sessionId=fixture"));
  assert.equal(missing.status, 404);
  const invalid = await route.fetch(new Request("http://dsh.local/api/huoqu", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "capture", sessionId: "fixture", url: "file:///etc/passwd" }),
  }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /http and https/);

  const rendered = tool.output.render({}, { ok: false, status: "partial", indexHtml: "/tmp/huoqu/index.html", warnings: ["index.html 有图片未加载"] });
  assert.match(rendered[0].text, /网页已保存，但离线检查未完全通过/);
  assert.doesNotMatch(rendered[0].text, /副本已生成并通过离线检查/);
  assert.match(rendered[0].text, /静态渲染副本/);
  assert.doesNotMatch(rendered[0].text, /保留原站脚本和组件/);
  assert.match(tool.description, /static offline HTML\/MHTML/);
  assert.match(tool.description, /never silent anonymous fallback/);
  assert.match(tool.description, /Default capture uses the login data supplied by the DSH embedded browser/);
  assert.deepEqual(tool.parameters.properties.purpose.enum, ["capture", "automation", "web-regression"]);
  assert.deepEqual(tool.parameters.properties.backend.enum, ["auto", "current-chrome", "headless", "dsh-embedded"]);
  assert.deepEqual(tool.parameters.properties.browser_identity.enum, ["current", "anonymous", "prefer-current", "dsh-embedded"]);
  assert.equal(tool.parameters.properties.allow_private.type, "boolean");
  assert.equal(tool.output.schema.properties.browserExecution.type, "object");
  assert.equal(tool.output.schema.properties.verificationBrowserExecution.type, "object");
  const list = await route.fetch(new Request("http://dsh.local/api/huoqu?sessionId=fixture"));
  assert.equal((await list.json()).version, pluginPackage.version);
  assert.doesNotMatch(tool.description, /retaining scripts/);
  assert.match(rendered[0].text, /图片未加载/);
});

test("inlined browser-policy code matches its provenance manifest, not a vendored tarball", async () => {
  const manifest = JSON.parse(await readFile(new URL("../lib/browser-policy/manifest.json", import.meta.url), "utf8"));
  assert.equal(pluginPackage.version, "0.2.12");
  assert.equal(manifest.version, "0.2.1-alpha.4.browser-policy.1");
  assert.equal(manifest.dshLocalArtifactVersion, manifest.version);
  assert.equal(manifest.dshSourceArtifact?.sourceSha256, "1a0d4cb9021826ef0cbba2f63a0fd07d4f295fd01418f5e61754c9b897a362a8");
  assert.equal(BROWSER_POLICY_PACKAGE.name, manifest.name);
  assert.equal(BROWSER_POLICY_PACKAGE.version, manifest.version);
  assert.equal(BROWSER_POLICY_PACKAGE.localArtifactVersion, manifest.version);
  assert.equal(BROWSER_POLICY_PACKAGE.sourceSha256, manifest.dshSourceArtifact.sourceSha256);
  // 内联后不再有 node_modules 副本可解析，也不再有私有 tarball 目录。
  assert.equal(existsSync(new URL("../vendor/browser-execution", import.meta.url)), false);
  await assert.rejects(import("@deepseek-ai/dsh-browser-use/execution"));
});
