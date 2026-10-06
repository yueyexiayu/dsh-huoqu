import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Exercise the existing transaction directly without starting a browser.
import { capturePage, createOutputStage, finalizeStage } from "../lib/capture.js";

async function temporaryDirectory(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "huoqu-capture-test-"));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function previousCapture(dir) {
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "old.css"), "original asset");
  await fs.writeFile(path.join(dir, "index.html"), "original page");
  await fs.writeFile(path.join(dir, "index.mhtml"), "original archive");
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ sourceUrl: "https://example.test/", resources: [{ path: "assets/old.css" }] }));
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({
    source: { url: "https://example.test/" }, capturedAt: new Date().toISOString(),
    archive: { path: "index.mhtml" }, localCopy: { htmlPath: "index.html" }, offlineValidation: { result: "passed" },
  }));
}

test("capture rejects an ordinary website directory even when its filenames match", async () => {
  await temporaryDirectory(async (dir) => {
    await fs.mkdir(path.join(dir, "assets"));
    await fs.writeFile(path.join(dir, "index.html"), "user website");
    await assert.rejects(createOutputStage(dir), /归属|huoqu/);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "user website");
  });
});

test("failed promotion restores previous page and nonempty assets", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const stage = await createOutputStage(dir);
    await fs.mkdir(path.join(stage, "assets"));
    await fs.writeFile(path.join(stage, "assets", "new.css"), "replacement asset");
    await fs.writeFile(path.join(stage, "index.html"), "replacement page");
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (from === path.join(stage, "index.html")) throw new Error("injected promotion failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(finalizeStage(stage, dir), /injected promotion failure/); }
    finally { fs.rename = originalRename; syncBuiltinESMExports(); }
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "original page");
    assert.deepEqual(await fs.readdir(path.join(dir, "assets")), ["old.css"]);
    assert.equal(await fs.readFile(path.join(dir, "assets", "old.css"), "utf8"), "original asset");
  });
});

test("rollback failure retains old assets in the named recovery directory", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    const stage = await createOutputStage(dir);
    await fs.mkdir(path.join(stage, "assets"));
    await fs.writeFile(path.join(stage, "assets", "new.css"), "new");
    await fs.writeFile(path.join(stage, "index.html"), "new");
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (from === path.join(stage, "index.html")) throw new Error("injected promotion failure");
      if (from.includes(".huoqu-replaced-") && path.basename(from) === "assets") throw new Error("injected rollback failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(finalizeStage(stage, dir), /回滚失败，旧文件保留于/); }
    finally { fs.rename = originalRename; syncBuiltinESMExports(); }
    const backup = (await fs.readdir(dir)).find((name) => name.startsWith(".huoqu-replaced-"));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(dir, backup, "assets", "old.css"), "utf8"), "original asset");
  });
});

test("capture rejects symlinks and unlisted files inside previous assets", async () => {
  await temporaryDirectory(async (dir) => {
    await previousCapture(dir);
    await fs.symlink(path.join(dir, "index.html"), path.join(dir, "assets", "old.css.tmp"));
    await assert.rejects(createOutputStage(dir), /归属/);
    await fs.rm(path.join(dir, "assets", "old.css.tmp"));
    await fs.writeFile(path.join(dir, "assets", "notes.txt"), "unrelated user data");
    await assert.rejects(createOutputStage(dir), /归属/);
  });
});

test("capture allows empty directories and leaves Finder metadata unchanged", async () => {
  await temporaryDirectory(async (dir) => {
    await fs.writeFile(path.join(dir, ".DS_Store"), "Finder metadata");
    const stage = await createOutputStage(dir);
    await fs.writeFile(path.join(stage, "index.html"), "captured page");
    await finalizeStage(stage, dir);
    assert.equal(await fs.readFile(path.join(dir, ".DS_Store"), "utf8"), "Finder metadata");
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), "captured page");
  });
});

test("cancelled capture rejects without creating or modifying the requested output", async () => {
  await temporaryDirectory(async (dir) => {
    const output = path.join(dir, "not-created");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(capturePage({ url: "https://example.test/", output_dir: output }, controller.signal), /cancelled/);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});
