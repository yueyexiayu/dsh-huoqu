import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, realpath, copyFile, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { chromePath as resolveBrowser } from '../lib/capture.js';

// Independent published version and measured official bytes, not resolver constants.
const digest = 'a46b3b1e63163fa2d2437fb6ae967cb5a73b50050bca32f1964e6129b6228244';
const override = 'HUOQU_CHROME_PATH';
async function fixture(t) {
  const source = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64');
  assert.equal(createHash('sha256').update(await readFile(path.join(source, 'chrome-headless-shell'))).digest('hex'), digest);
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pinned-headless-')));
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(home, { recursive: true, force: true }); });
  t.mock.method(os, 'homedir', () => home);
  let version = 'Google Chrome for Testing 145.0.7632.6';
  const versionCalls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    assert.deepEqual(args, ['--version']); assert.equal(options.killSignal, 'SIGKILL');
    versionCalls.push(file); return version;
  });
  syncBuiltinESMExports();
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  const playwrightPackageRoot = path.join(home, 'node_modules/playwright-core');
  await mkdir(playwrightPackageRoot, { recursive: true });
  await writeFile(path.join(playwrightPackageRoot, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.58.2' }));
  await writeFile(path.join(playwrightPackageRoot, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: '1208', browserVersion: '145.0.7632.6' }] }));
  async function shell(root = cache, revision = '1208', arch = 'arm64') {
    const dir = path.join(root, `chromium_headless_shell-${revision}`, `chrome-headless-shell-mac-${arch}`);
    await mkdir(dir, { recursive: true });
    for (const name of ['chrome-headless-shell', 'ABOUT', 'LICENSE.headless_shell', 'icudtl.dat', 'headless_lib_data.pak', 'headless_lib_strings.pak', 'headless_command_resources.pak', 'v8_context_snapshot.arm64.bin', 'libEGL.dylib', 'libGLESv2.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json', 'PrivacySandboxAttestationsPreloaded/manifest.json', 'PrivacySandboxAttestationsPreloaded/privacy-sandbox-attestations.dat', 'resources/accessibility/reading_mode_gdocs_helper/content.js', 'resources/accessibility/reading_mode_gdocs_helper/gdocs_script.js', 'resources/accessibility/reading_mode_gdocs_helper_manifest.json']) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      // CoW copies, never hard links: corruption tests cannot mutate the real installation.
      await copyFile(path.join(source, name), path.join(dir, name), constants.COPYFILE_FICLONE);
    }
    await writeFile(path.join(path.dirname(dir), 'INSTALLATION_COMPLETE'), '');
    return path.join(dir, 'chrome-headless-shell');
  }
  const options = { env: {}, cwd: home, playwrightPackageRoot };
  const resolve = extra => Promise.resolve().then(() => resolveBrowser({ ...options, ...extra }));
  return { home, cache, playwrightPackageRoot, shell, options, resolve, versionCalls, setVersion: value => { version = value; } };
}

test('selects pinned 1208 even when another project has newer 9999', async t => {
  const f = await fixture(t); const pinned = await f.shell(); await f.shell(f.cache, '9999');
  assert.equal(await f.resolve(), pinned); assert.deepEqual(f.versionCalls, [pinned]);
});
test('does not borrow another revision or architecture when pinned install is absent', async t => {
  const f = await fixture(t); await f.shell(f.cache, '9999'); await f.shell(f.cache, '1208', 'x64');
  await assert.rejects(f.resolve(), /1208|installation|headless/i); assert.equal(f.versionCalls.length, 0);
});
test('Playwright PATH=0 uses its package-local .local-browsers', async t => {
  const f = await fixture(t); const expected = await f.shell(path.join(f.playwrightPackageRoot, '.local-browsers'));
  assert.equal(await f.resolve({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }), expected);
});
test('absolute and relative caches resolve with execution cwd; empty means Playwright default', async t => {
  const f = await fixture(t); const defaultShell = await f.shell();
  assert.equal(await f.resolve({ env: { PLAYWRIGHT_BROWSERS_PATH: '' } }), defaultShell);
  const custom = await f.shell(path.join(f.home, 'execution/cache'));
  for (const value of [path.join(f.home, 'execution/cache'), 'cache']) assert.equal(await f.resolve({ cwd: path.join(f.home, 'execution'), env: { PLAYWRIGHT_BROWSERS_PATH: value } }), custom);
});
test('cache env precedence follows fixed package; INIT_CWD cannot replace execution cwd', async t => {
  const f = await fixture(t); const defaultShell = await f.shell(); const custom = await f.shell(path.join(f.home, 'execution/cache'));
  assert.equal(await f.resolve({ cwd: path.join(f.home, 'execution'), env: { PLAYWRIGHT_BROWSERS_PATH: 'cache', INIT_CWD: path.join(f.home, 'wrong') } }), custom);
  for (const env of [{ npm_config_playwright_browsers_path: path.join(f.home, 'execution/cache') }, { npm_package_config_playwright_browsers_path: path.join(f.home, 'execution/cache') }, { PLAYWRIGHT_BROWSERS_PATH: '', npm_config_playwright_browsers_path: path.join(f.home, 'missing') }]) assert.equal(await f.resolve({ env }), env.PLAYWRIGHT_BROWSERS_PATH === '' ? defaultShell : custom);
  assert.equal(await f.resolve({ env: { npm_config_playwright_browsers_path: '', npm_package_config_playwright_browsers_path: path.join(f.home, 'missing') } }), defaultShell);
});
test('unset, empty, valid and invalid explicit overrides are distinct; never fallback', async t => {
  const f = await fixture(t); const shell = await f.shell();
  assert.equal(await f.resolve(), shell); assert.equal(await f.resolve({ env: { [override]: shell } }), shell);
  for (const value of ['', ' ', path.join(f.home, 'missing')]) await assert.rejects(f.resolve({ env: { [override]: value } }), new RegExp(override));
});
test('rejects renamed executable, GUI path and GUI symlink before version execution', async t => {
  const f = await fixture(t); await f.shell();
  const gui = path.join(f.home, 'Chrome.app/Contents/MacOS/chrome-headless-shell'); await mkdir(path.dirname(gui), { recursive: true }); await writeFile(gui, 'fake'); await chmod(gui, 0o755);
  const alias = path.join(f.home, 'chrome-headless-shell'); await symlink(gui, alias);
  for (const file of [gui, alias]) await assert.rejects(f.resolve({ env: { [override]: file } }), /GUI|installation|layout/i);
  assert.equal(f.versionCalls.length, 0);
});
test('requires completion marker and essential resources', async t => {
  const f = await fixture(t); const shell = await f.shell();
  await rm(path.join(path.dirname(path.dirname(shell)), 'INSTALLATION_COMPLETE')); await assert.rejects(f.resolve(), /INSTALLATION_COMPLETE/);
  await f.shell(); await rm(path.join(path.dirname(shell), 'icudtl.dat')); await assert.rejects(f.resolve(), /icudtl.dat/);
});
test('checks real binary format, native architecture and content digest', async t => {
  const f = await fixture(t); const shell = await f.shell();
  const foreign = Buffer.alloc(32); foreign.writeUInt32LE(0xfeedfacf); foreign.writeUInt32LE(0x01000007, 4); foreign.writeUInt32LE(2, 12); await writeFile(shell, foreign);
  await assert.rejects(f.resolve(), /architecture/i);
  await writeFile(shell, '#!/bin/sh\necho Google Chrome for Testing 145.0.7632.6'); await assert.rejects(f.resolve(), /Mach-O|binary/i);
  await f.shell(); const handle = await open(shell, 'r+'); await handle.write(Buffer.from('forged!'), 0, 7, 64); await handle.close();
  await assert.rejects(f.resolve(), /SHA-256|digest/i); assert.equal(f.versionCalls.length, 0);
});
test('rejects active download lock, marker directories, corrupt resources and caller verification knobs', async t => {
  const f = await fixture(t); const shell = await f.shell();
  await mkdir(path.join(f.cache, '__dirlock')); await assert.rejects(f.resolve(), /download lock/); await rm(path.join(f.cache, '__dirlock'), { recursive: true });
  const marker = path.join(path.dirname(path.dirname(shell)), 'INSTALLATION_COMPLETE'); await rm(marker); await mkdir(marker); await assert.rejects(f.resolve(), /regular file/); await rm(marker, { recursive: true }); await f.shell();
  await writeFile(path.join(path.dirname(shell), 'icudtl.dat'), 'corrupt resource'); await assert.rejects(f.resolve(), /resource SHA-256/);
  for (const extra of [{ binaryDigest: () => digest }, { resourceDigest: () => digest }, { versionProbe: () => '145.0.7632.6' }, { platform: 'darwin' }]) await assert.rejects(f.resolve(extra), /Unsupported.*field/);
});
test('checks actual --version dependency response, not folder revision', async t => {
  const f = await fixture(t); await f.shell();
  for (const result of ['Google Chrome for Testing 146.0.1.0', '145.0.7632.6', '']) { f.setVersion(result); await assert.rejects(f.resolve(), /version/i); }
  assert.equal(f.versionCalls.length, 3);
});
test('rejects unsupported real system identity and inconsistent package manifest', async t => {
  const f = await fixture(t); await f.shell();
  for (const [key, value] of [['platform', 'linux'], ['arch', 'x64'], ['release', '21.0.0']]) {
    const original = os[key]; os[key] = () => value; syncBuiltinESMExports();
    try { await assert.rejects(f.resolve(), /supported|verified|system/i); } finally { os[key] = original; syncBuiltinESMExports(); }
  }
  await assert.rejects(f.resolve({ env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'mac15-arm64' } }), /override/i);
  await writeFile(path.join(f.playwrightPackageRoot, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }));
  await assert.rejects(f.resolve(), /1.58.2|package/i);
});
