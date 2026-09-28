import test from "node:test";
import assert from "node:assert/strict";
import { blockedPageMessage, normalizeCaptureOptions, unexpectedOutputEntries } from "../lib/parse.js";

test("normalizeCaptureOptions accepts an absolute HTTP URL and output folder", () => {
  const result = normalizeCaptureOptions({ url: "https://www.gree.cn/", output_dir: "/Users/ning/Downloads/测试", width: 1440, height: 1000 });
  assert.equal(result.url, "https://www.gree.cn/");
  assert.equal(result.outputDir, "/Users/ning/Downloads/测试");
  assert.equal(result.width, 1440);
  assert.equal(result.height, 1000);
});

test("normalizeCaptureOptions rejects non-HTTP and credentialed URLs", () => {
  assert.throws(() => normalizeCaptureOptions({ url: "file:///etc/passwd" }), /http and https/);
  assert.throws(() => normalizeCaptureOptions({ url: "https://user:secret@example.test/" }), /must not contain credentials/);
});

test("blockedPageMessage identifies a firewall interstitial instead of site content", () => {
  assert.match(blockedPageMessage({ title: "可疑请求拦截通知", textSample: "抱歉，您的访问疑似攻击请求，已被系统自动拦截" }), /拦截页/);
  assert.equal(blockedPageMessage({ title: "昊华搪瓷官方网站", textSample: "金刚甲搪瓷水箱" }), "");
});

test("unexpectedOutputEntries ignores Finder metadata and a previous capture", () => {
  assert.deepEqual(unexpectedOutputEntries([".DS_Store", "index.html", "assets", ".huoqu-staging-1"]), []);
  assert.deepEqual(unexpectedOutputEntries([".DS_Store", "notes.txt"]), ["notes.txt"]);
});

test("normalizeCaptureOptions validates viewport and output path", () => {
  assert.throws(() => normalizeCaptureOptions({ url: "https://example.test", width: 120 }), /width must be an integer/);
  assert.throws(() => normalizeCaptureOptions({ url: "https://example.test", output_dir: "relative/path" }), /absolute path/);
  assert.throws(() => normalizeCaptureOptions({ url: "https://example.test", output_dir: "/" }), /dedicated project folder/);
});
