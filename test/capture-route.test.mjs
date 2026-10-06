import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Replace only the browser side effect; exercise the actual Host entry and job API.
const captureUrl = new URL("../lib/capture.js", import.meta.url).href;
const ownerUrl = new URL("../../chrome/lib/owner.js", import.meta.url).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== captureUrl) return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: `import { currentOwner } from ${JSON.stringify(ownerUrl)};
        export async function capturePage(input) {
          if (input.url.endsWith('/failed')) throw new Error('capture fixture failed');
          return {ok: !input.url.endsWith('/partial'), status: input.url.endsWith('/partial') ? 'partial' : 'completed', title: currentOwner(), indexHtml: '/tmp/huoqu/index.html', warnings: []};
        }`,
    };
  },
});
const { apply } = await import("../lib/index.js");
hook.deregister();
let tool, route;
apply({ tools: { register(value) { tool = value; } }, connection: { fetch: { register(value) { route = value; } } } });

test("Host tool capture preserves its calling session ownership", async () => {
  const result = await tool.execute({ url: "https://example.test/good" }, { agent: { session: { id: "session-fixture" } } });
  assert.equal(result.title, "session-fixture");
});

test("capture jobs have distinct owners and retain partial validation results", async () => {
  const start = async (suffix) => {
    const response = await route.fetch(new Request("http://dsh.local/api/huoqu", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://example.test/${suffix}` }),
    }));
    assert.equal(response.status, 202);
    return response.json();
  };
  const first = await start("partial");
  const second = await start("good");
  const state = async (id) => (await route.fetch(new Request(`http://dsh.local/api/huoqu?jobId=${id}`))).json();
  const partial = await state(first.jobId);
  const good = await state(second.jobId);
  assert.equal(partial.status, "completed"); // Job finished; validation remains partial.
  assert.equal(partial.result.ok, false);
  assert.equal(partial.result.status, "partial");
  assert.equal(partial.result.title, `huoqu-job:${first.jobId}`);
  assert.equal(good.result.title, `huoqu-job:${second.jobId}`);
  assert.notEqual(partial.result.title, good.result.title);
  const failed = await state((await start("failed")).jobId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.ok, false);
  assert.equal(failed.result, null);
  assert.equal(failed.error, "capture fixture failed");
});
