import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const clientPath = new URL("../lib/client.js", import.meta.url);

// A small deterministic hooks runner executes the shipped Client code, including
// mount effects, async requests and handlers. It is not a real browser acceptance test.
function mountClient(source, fetch) {
  let api, pane, cursor = 0, mounted = false;
  const hooks = [], effects = [], cleanup = [], timers = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], (value) => { hooks[index] = value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(fn) { cursor++; if (!mounted) effects.push(fn); },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) { api = definition.factory(() => React); } } },
    document: { getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} } },
    fetch, URL, setTimeout(fn) { timers.push(fn); },
  });
  api.apply({
    effect(fn) { return fn(); }, sidebarRightTabs: { register() {} },
    slots: { inject(_, fn) { return fn(); }, register(spec, component) { if (spec.name === "sidebar.right.pane.tab") pane = component; } },
  });
  return {
    render(props) {
      cursor = 0;
      const node = pane(props);
      if (!mounted) { mounted = true; for (const effect of effects) cleanup.push(effect()); }
      return node;
    },
    unmount() { for (const fn of cleanup) fn?.(); },
    async drain() { await new Promise(setImmediate); },
  };
}
function walk(node, predicate, found = []) {
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) walk(child, predicate, found);
  return found;
}
function text(node) { return typeof node === "string" ? node : (node?.children || []).map(text).join(" "); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function button(tree, label) {
  const found = walk(tree, (node) => node.type === "button" && text(node).includes(label))[0];
  assert.ok(found, `missing button: ${label}`);
  return found;
}
function response(value) { return new Response(JSON.stringify(value)); }
async function raceFixture() {
  const jobs = ["A", "B"].map((id) => ({ jobId: id, status: "completed", url: `https://example.test/${id}`, outputDir: `/tmp/${id}`,
    result: { ok: true, title: `Result ${id}`, indexHtml: `/tmp/${id}/index.html`, warnings: [] } }));
  const pending = { list: [], folder: null, open: null, runningB: false };
  const client = mountClient(await readFile(clientPath, "utf8"), async (url, options) => {
    const action = options.body ? JSON.parse(options.body).action : null;
    if (action === "choose-folder") return pending.folder.promise;
    if (action === "open") return pending.open.promise;
    const id = new URL(url, "http://fixture.local").searchParams.get("jobId");
    if (id) return response({ ok: true, ...jobs.find((job) => job.jobId === id), ...(id === "B" && pending.runningB ? { status: "running" } : {}) });
    return pending.list.length ? pending.list.shift().promise : response({ ok: true, jobs });
  });
  client.render(); await client.drain();
  return { client, pending, jobs };
}

test("older list success cannot replace a newer refresh", async () => {
  const { client, pending, jobs } = await raceFixture();
  const older = deferred(), newer = deferred(); pending.list.push(older, newer);
  button(client.render(), "刷新任务列表").props.onClick();
  button(client.render(), "刷新任务列表").props.onClick();
  newer.resolve(response({ ok: true, jobs: [jobs[1]] })); await client.drain();
  older.resolve(response({ ok: true, jobs: [jobs[0]] })); await client.drain();
  const history = walk(client.render(), (node) => node.type === "button" && String(node.props.className).includes("huoqu-path"));
  assert.deepEqual(history.map(text), ["completed · https://example.test/B"]);
  client.unmount();
});

test("old list failure cannot contaminate newly selected job", async () => {
  const { client, pending } = await raceFixture();
  const older = deferred(); pending.list.push(older);
  button(client.render(), "刷新任务列表").props.onClick();
  button(client.render(), "https://example.test/B").props.onClick(); await client.drain();
  older.reject(new Error("stale list failure")); await client.drain();
  assert.doesNotMatch(text(client.render()), /stale list failure/);
  assert.match(text(client.render()), /Result B/);
  client.unmount();
});

for (const outcome of ["resolve", "cancel", "reject"]) {
  test(`late folder ${outcome} cannot overwrite selected running job`, async () => {
    const { client, pending } = await raceFixture();
    pending.folder = deferred();
    const choosing = button(client.render(), "选择文件夹").props.onClick();
    pending.runningB = true;
    button(client.render(), "https://example.test/B").props.onClick(); await client.drain();
    if (outcome === "reject") pending.folder.reject(new Error("stale folder failure"));
    else pending.folder.resolve(response({ ok: true, cancelled: outcome === "cancel", outputDir: "/tmp/stale-folder" }));
    await choosing; await client.drain();
    const tree = client.render();
    assert.equal(walk(tree, (node) => node.type === "input")[1].props.value, "/tmp/B");
    assert.match(text(tree), /任务状态：running/);
    assert.doesNotMatch(text(tree), /stale folder failure|已选择输出目录/);
    assert.equal(button(tree, "选择文件夹").props.disabled, true);
    client.unmount();
  });
}

test("old open failure cannot contaminate newly selected job", async () => {
  const { client, pending } = await raceFixture();
  pending.open = deferred();
  button(client.render(), "打开本地页面").props.onClick();
  button(client.render(), "https://example.test/B").props.onClick(); await client.drain();
  pending.open.reject(new Error("stale open failure")); await client.drain();
  assert.doesNotMatch(text(client.render()), /stale open failure/);
  assert.match(text(client.render()), /Result B/);
  client.unmount();
});

for (const action of ["list", "folder", "open"]) {
  test(`current ${action} failure remains visible`, async () => {
    const { client, pending } = await raceFixture();
    const request = deferred();
    if (action === "list") pending.list.push(request);
    else pending[action] = request;
    button(client.render(), { list: "刷新任务列表", folder: "选择文件夹", open: "打开本地页面" }[action]).props.onClick();
    request.reject(new Error(`current ${action} failure`)); await client.drain();
    assert.match(text(client.render()), new RegExp(`current ${action} failure`));
    if (action === "folder") assert.equal(button(client.render(), "选择文件夹").props.disabled, false);
    client.unmount();
  });
}

test("folder completion after unmount cannot change component state", async () => {
  const { client, pending } = await raceFixture();
  pending.folder = deferred();
  const choosing = button(client.render(), "选择文件夹").props.onClick();
  const before = JSON.stringify(client.render());
  client.unmount();
  pending.folder.resolve(response({ ok: true, cancelled: false, outputDir: "/tmp/late-folder" }));
  await choosing; await client.drain();
  assert.equal(JSON.stringify(client.render()), before);
});

test("mount recovers an existing job, cancel is explicit, and remount restores partial results", async () => {
  const source = await readFile(clientPath, "utf8");
  const requests = [];
  const job = { jobId: "persisted-job", status: "running", url: "https://example.test/", outputDir: "/tmp/fixture" };
  const fetch = async (url, options) => {
    requests.push([url, options]);
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.action === "cancel") { assert.equal(body.jobId, job.jobId); job.status = "cancelled"; job.error = "采集已取消"; }
    const result = url.includes("?jobId=") || body ? { ok: true, ...job } : { ok: true, jobs: [{ ...job }] };
    return new Response(JSON.stringify(result));
  };
  const first = mountClient(source, fetch);
  first.render(); await first.drain();
  let tree = first.render();
  assert.match(text(tree), /running/);
  assert.match(text(tree), /静态渲染副本/);
  assert.doesNotMatch(text(tree), /保留原站脚本和组件/);
  const cancel = walk(tree, (node) => node.type === "button" && node.children.includes("取消采集"))[0];
  assert.ok(cancel);
  await cancel.props.onClick(); await first.drain();
  tree = first.render();
  assert.match(text(tree), /采集已取消/);
  assert.equal(requests.filter(([, options]) => options.body && JSON.parse(options.body).action === "cancel").length, 1);
  first.unmount();
  job.status = "partial";
  job.result = { ok: false, status: "partial", title: "Recovered capture", warnings: ["离线图片未加载"], indexHtml: "/tmp/fixture/index.html" };
  const second = mountClient(source, fetch);
  second.render(); await second.drain();
  tree = second.render();
  assert.match(text(tree), /Recovered capture/);
  assert.match(text(tree), /partial · https:\/\/example.test\//);
  assert.doesNotMatch(text(tree), /completed/);
  assert.match(text(tree), /离线检查未完全通过/);
  assert.doesNotMatch(text(tree), /已生成并通过离线检查/);
  assert.ok(walk(tree, (node) => node.type === "button" && node.children.includes("打开本地页面")).length);
  second.unmount();
});

for (const outcome of ["resolve", "reject"]) {
  test(`late cancel ${outcome} for A cannot overwrite newly selected B`, async () => {
    const source = await readFile(clientPath, "utf8");
    let resolveCancel, rejectCancel;
    const delayed = new Promise((resolve, reject) => { resolveCancel = resolve; rejectCancel = reject; });
    const jobs = [
      { jobId: "A", status: "running", url: "https://example.test/A", outputDir: "/tmp/A" },
      { jobId: "B", status: "partial", url: "https://example.test/B", outputDir: "/tmp/B", result: { ok: false, status: "partial", title: "Selected B result", indexHtml: "/tmp/B/index.html", warnings: [] } },
    ];
    const opened = [];
    const fetch = async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (body?.action === "cancel") { assert.equal(body.jobId, "A"); return delayed; }
      if (body?.action === "open") { opened.push(body.jobId); return new Response(JSON.stringify({ ok: true })); }
      const id = new URL(url, "http://fixture.local").searchParams.get("jobId");
      return new Response(JSON.stringify(id ? { ok: true, ...jobs.find((job) => job.jobId === id) } : { ok: true, jobs }));
    };
    const client = mountClient(source, fetch);
    try {
      client.render(); await client.drain();
      let tree = client.render();
      const cancel = walk(tree, (node) => node.type === "button" && node.children.includes("取消采集"))[0];
      assert.ok(cancel);
      const cancelling = cancel.props.onClick();
      const selectB = walk(tree, (node) => node.type === "button" && node.children.includes("partial · https://example.test/B"))[0];
      assert.ok(selectB);
      selectB.props.onClick(); await client.drain();
      assert.match(text(client.render()), /Selected B result/);
      if (outcome === "resolve") {
        jobs[0].status = "cancelled";
        resolveCancel(new Response(JSON.stringify({ ok: true, ...jobs[0] })));
      } else rejectCancel(new Error("stale A cancel failure"));
      await cancelling; await client.drain();
      tree = client.render();
      assert.match(text(tree), /Selected B result/);
      assert.doesNotMatch(text(tree), /stale A cancel failure/);
      const open = walk(tree, (node) => node.type === "button" && node.children.includes("打开本地页面"))[0];
      assert.ok(open);
      await open.props.onClick();
      assert.deepEqual(opened, ["B"]);
    } finally { client.unmount(); }
  });
}

test("sidebar folder button calls the native folder picker API action", async () => {
  const source = await readFile(clientPath, "utf8");
  let moduleApi;
  let pane;
  let requestUrl = "";
  let requestOptions;
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };

  function createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  }
  const React = {
    createElement,
    useState(initial) { return [initial, () => {}]; },
    useEffect() {},
    useRef(value) { return { current: value }; },
  };
  globalThis.document = {
    getElementById() { return null; },
    createElement() { return {}; },
    head: { appendChild() {} },
  };
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        moduleApi = definition.factory((id) => {
          assert.equal(id, "react");
          return React;
        });
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ ok: true, cancelled: false, outputDir: "/tmp/selected-folder" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  function findButtons(node, output = []) {
    if (!node || typeof node !== "object") return output;
    if (node.type === "button") output.push(node);
    for (const child of node.children || []) findButtons(child, output);
    return output;
  }

  try {
    Function(source)();
    moduleApi.apply({
      effect(fn) { return fn(); },
      sidebarRightTabs: { register() { return () => {}; } },
      slots: {
        inject(_name, register) { return register(); },
        register(spec, component) {
          if (spec.name === "sidebar.right.pane.tab" && spec.key === "huoqu") pane = component;
          return () => {};
        },
      },
    });
    assert.equal(typeof pane, "function");
    const button = findButtons(pane()).find((item) => item.children.includes("选择文件夹"));
    assert.ok(button, "folder picker button should render");
    await button.props.onClick();
    assert.equal(requestUrl, "/api/huoqu");
    assert.equal(JSON.parse(requestOptions.body).action, "choose-folder");
    assert.match(text(pane()), /未关联当前会话/);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
  }
});

test("sidebar capture sends the current conversation sessionId", async () => {
  const bodies = [];
  const client = mountClient(await readFile(clientPath, "utf8"), async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (body) bodies.push(body);
    if (body?.action === "capture") return response({ ok: true, jobId: "job-1", status: "queued", outputDir: "/tmp/out" });
    if (String(url).includes("jobId=")) {
      return response({ ok: true, jobId: "job-1", status: "completed", url: "https://example.test/page", outputDir: "/tmp/out",
        result: { ok: true, title: "done", indexHtml: "/tmp/out/index.html", warnings: [] } });
    }
    return response({ ok: true, jobs: [] });
  });
  try {
    client.render({ sessionId: "sess-1" });
    await client.drain();
    let tree = client.render({ sessionId: "sess-1" });
    assert.doesNotMatch(text(tree), /未关联当前会话/);
    const urlInput = walk(tree, (node) => node.type === "input" && node.props.type === "url")[0];
    assert.ok(urlInput, "url field missing");
    urlInput.props.onChange({ target: { value: "https://example.test/page" } });
    tree = client.render({ sessionId: "sess-1" });
    const form = walk(tree, (node) => node.type === "form")[0];
    assert.ok(form?.props.onSubmit, "capture form missing");
    await form.props.onSubmit({ preventDefault() {} });
    await client.drain();
    const capture = bodies.find((body) => body.action === "capture");
    assert.equal(capture?.sessionId, "sess-1");
  } finally { client.unmount(); }
});
