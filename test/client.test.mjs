import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const clientPath = new URL("../lib/client.js", import.meta.url);

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
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
  }
});
