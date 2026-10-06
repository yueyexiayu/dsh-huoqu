import test from "node:test";
import assert from "node:assert/strict";
import { API_PATH, apply, inject, name } from "../lib/index.js";

test("host entry registers huoqu tool and the declared route", async () => {
  let tool;
  let route;
  apply({
    tools: { register(value) { tool = value; } },
    connection: { fetch: { register(value) { route = value; } } },
  });
  assert.equal(name, "huoqu");
  assert.deepEqual(inject, ["tools", "connection"]);
  assert.equal(tool.name, "huoqu");
  assert.deepEqual(tool.parameters.required, ["url"]);
  assert.equal(tool.output.schema.properties.localPage.type, "object");
  assert.equal(route.path, API_PATH);
  assert.deepEqual(route.methods, ["GET", "POST"]);

  const missing = await route.fetch(new Request("http://dsh.local/api/huoqu?jobId=missing"));
  assert.equal(missing.status, 404);
  const invalid = await route.fetch(new Request("http://dsh.local/api/huoqu", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "capture", url: "file:///etc/passwd" }),
  }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /http and https/);

  const rendered = tool.output.render({}, { ok: false, status: "partial", indexHtml: "/tmp/huoqu/index.html", warnings: ["index.html 有图片未加载"] });
  assert.match(rendered[0].text, /网页已保存，但离线检查未完全通过/);
  assert.doesNotMatch(rendered[0].text, /副本已生成并通过离线检查/);
  assert.match(rendered[0].text, /保留原站脚本和组件/);
  assert.match(rendered[0].text, /图片未加载/);
});
