import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromePath } from '../lib/capture.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'huoqu-headless-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  async function executable(file) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'fixture, never launched'); await chmod(file, 0o755); return file; }
  const shell = (revision, arch = 'arm64') => executable(path.join(cache, `chromium_headless_shell-${revision}`, `chrome-headless-shell-mac-${arch}`, 'chrome-headless-shell'));
  return { home, cache, executable, shell };
}

test('macOS chooses the newest executable dedicated headless shell, not GUI Chrome', async t => {
  const f = await fixture(t); await f.shell(99); const latest = await f.shell(100, 'x64');
  await mkdir(path.join(f.cache, 'chromium_headless_shell-999'), { recursive: true });
  assert.equal(await chromePath({ env: {}, platform: 'darwin', home: f.home }), latest);
});

test('macOS missing shell fails rather than using the installed GUI browser', async t => {
  const f = await fixture(t);
  await assert.rejects(chromePath({ env: {}, platform: 'darwin', home: f.home }), /headless.shell|无头/i);
});

test('macOS rejects explicit GUI app executables and GUI symlinks', async t => {
  const f = await fixture(t);
  const gui = await f.executable(path.join(f.home, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
  const alias = path.join(f.home, 'chrome-headless-shell'); await symlink(gui, alias);
  for (const candidate of [gui, alias]) await assert.rejects(chromePath({ env: { HUOQU_CHROME_PATH: candidate }, platform: 'darwin', home: f.home }), /headless.shell|无头|GUI/i);
});

test('macOS accepts explicit shell and respects a custom Playwright cache', async t => {
  const f = await fixture(t); const shell = await f.shell(100);
  assert.equal(await chromePath({ env: { HUOQU_CHROME_PATH: shell }, platform: 'darwin', home: f.home }), shell);
  const custom = path.join(f.home, 'custom'); const customShell = await f.executable(path.join(custom, 'chromium_headless_shell-101/chrome-headless-shell-mac-arm64/chrome-headless-shell'));
  assert.equal(await chromePath({ env: { PLAYWRIGHT_BROWSERS_PATH: custom }, platform: 'darwin', home: f.home }), customShell);
});

test('macOS an invalid explicit override never falls back to a valid cache', async t => {
  const f = await fixture(t); await f.shell(100);
  await assert.rejects(chromePath({ env: { HUOQU_CHROME_PATH: path.join(f.home, 'missing/chrome-headless-shell') }, platform: 'darwin', home: f.home }), /HUOQU_CHROME_PATH|headless.shell|无头/i);
});
