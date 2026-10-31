import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { API_PATH, apply, inject, name } from "../lib/index.js";
import { BROWSER_POLICY_PACKAGE } from "../lib/execution.js";
import { pluginPackage, browserPolicyPackage } from "./package-fixture.mjs";

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
  assert.deepEqual(tool.parameters.properties.purpose.enum, ["capture", "automation", "web-regression"]);
  assert.deepEqual(tool.parameters.properties.backend.enum, ["auto", "current-chrome", "headless"]);
  assert.deepEqual(tool.parameters.properties.browser_identity.enum, ["current", "anonymous", "prefer-current"]);
  assert.equal(tool.output.schema.properties.browserExecution.type, "object");
  assert.equal(tool.output.schema.properties.verificationBrowserExecution.type, "object");
  const list = await route.fetch(new Request("http://dsh.local/api/huoqu?sessionId=fixture"));
  assert.equal((await list.json()).version, pluginPackage.version);
  assert.doesNotMatch(tool.description, /retaining scripts/);
  assert.match(rendered[0].text, /图片未加载/);
});

test("installed browser-policy package matches provenance metadata, not the tarball filename", async () => {
  const provenance = JSON.parse(await readFile(new URL("../vendor/browser-execution/provenance.json", import.meta.url), "utf8"));
  assert.equal(pluginPackage.version, "0.2.4");
  assert.equal(browserPolicyPackage.version, provenance.version);
  assert.equal(browserPolicyPackage.dshLocalArtifactVersion, provenance.version);
  assert.equal(browserPolicyPackage.dshSourceArtifact?.sourceSha256, provenance.sourceSha256);
  assert.equal(BROWSER_POLICY_PACKAGE.version, provenance.version);
  assert.equal(BROWSER_POLICY_PACKAGE.localArtifactVersion, provenance.version);
  assert.equal(BROWSER_POLICY_PACKAGE.sourceSha256, provenance.sourceSha256);
  assert.notEqual(provenance.version, "0.2.1-alpha.2.browser-policy.1");
});
