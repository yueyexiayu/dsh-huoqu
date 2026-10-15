import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { absolutizeRelativeImports } from './module-fixture.mjs';
import { normalizeCaptureOptions } from '../lib/parse.js';
import { captureExecution, validateCaptureAttachment, captureBrowserRecord } from '../lib/execution.js';

const operation = { cwd: '/tmp', scope: { sessionId: 'real-loaded-session', taskId: 'capture-batch' } };
const options = identity => normalizeCaptureOptions({ url: 'https://example.test/', output_dir: '/tmp/capture-unit', browser_identity: identity });
const engine = { kind: 'external-browser', resolver: 'chrome-extension-native-messaging', browserVersion: '145.0.7632.6', capabilities: ['dom', 'screenshot', 'extension', 'authenticated-state'] };

async function boundary(t, handler, importFailure, chromeModuleUrl = new URL('../../chrome/lib/browser.js', import.meta.url)) {
  const key = `huoqu_unit_${randomUUID()}`;
  const fixtureUrl = new URL(chromeModuleUrl);
  fixtureUrl.searchParams.set('fixture', key);
  const chromeUrl = fixtureUrl.href;
  const calls = { attachment: [], launch: [] };
  globalThis[key] = async (signal, request) => { calls.attachment.push(request); return handler(signal, request); };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Preserve this unique synthetic URL before Node realpaths a sibling
      // Chrome symlink; otherwise load() could miss and contact the real bridge.
      if (specifier === chromeUrl) return { url: chromeUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url !== chromeUrl) return nextLoad(url, context);
      if (importFailure) throw importFailure(chromeUrl);
      return { format: 'module', shortCircuit: true, source: `export const openCaptureSession=(signal,request)=>globalThis[${JSON.stringify(key)}](signal,request);` };
    },
  });
  t.after(() => { hook.deregister(); delete globalThis[key]; });
  const moduleUrl = new URL('../lib/capture.js', import.meta.url);
  let source = absolutizeRelativeImports(await readFile(moduleUrl, 'utf8'), moduleUrl);
  source = source.replace('new URL("../../chrome/lib/browser.js", import.meta.url)', `new URL(${JSON.stringify(chromeUrl)})`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport {openBrowser}; export function fixtureLaunch(fn) {openChrome=fn;}').toString('base64')}#${key}`);
  mod.fixtureLaunch(async request => { calls.launch.push(request); return { execution: request.execution, mode: 'headless', backend: 'cdp-websocket', engine: { ...engine, kind: 'chromium-headless-shell', capabilities: ['dom', 'screenshot'] } }; });
  return { mod, calls };
}
const failure = (code, message = code) => Object.assign(new Error(message), { code });

test('symlink Chrome fixture resolves to its synthetic loader without loading the canonical module', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'huoqu-execution-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonical = path.join(root, 'canonical-chrome');
  await mkdir(path.join(canonical, 'lib'), { recursive: true });
  // The canonical target is inert: a missed hook fails locally, never handshakes
  // with the real Chrome bridge or reads the user's browser state.
  await writeFile(path.join(canonical, 'lib', 'browser.js'), "export {}; throw new Error('CANONICAL_CHROME_MODULE_MUST_NOT_LOAD');\n");
  await symlink(canonical, path.join(root, 'chrome'), 'dir');
  const chromeUrl = pathToFileURL(path.join(root, 'chrome', 'lib', 'browser.js'));
  const expected = failure('SYNTHETIC_SYMLINK_ATTACHMENT');
  const { mod, calls } = await boundary(t, () => { throw expected; }, undefined, chromeUrl);
  await assert.rejects(mod.openBrowser(undefined, undefined, options('current'), operation), error => error === expected);
  assert.equal(calls.attachment.length, 1);
  assert.equal(calls.launch.length, 0);
});

test('scope and cwd must be supplied by the owner; identity selects truthful mode/ownership', () => {
  assert.throws(() => captureExecution(options('current')), /explicit operation cwd/);
  assert.throws(() => captureExecution(options('current'), { cwd: 'relative', scope: operation.scope }), /explicit operation cwd/);
  assert.throws(() => captureExecution(options('current'), { cwd: '/tmp' }), /scope/);
  const current = captureExecution(options('current'), operation);
  assert.equal(current.mode, 'headed'); assert.equal(current.ownership, 'borrowed-connection'); assert.deepEqual(current.scope, operation.scope);
  const anonymous = captureExecution(options('anonymous'), operation);
  assert.equal(anonymous.mode, 'headless'); assert.equal(anonymous.ownership, 'owned-process');
});

test('automatic anonymous work never imports or attaches current Chrome', async t => {
  const { mod, calls } = await boundary(t, () => { throw new Error('must not attach'); }, () => { throw new Error('must not import Chrome'); });
  const input = normalizeCaptureOptions({ url: 'https://example.test/', purpose: 'web-regression', output_dir: '/tmp/capture-unit' });
  const browser = await mod.openBrowser(undefined, undefined, input, operation);
  assert.equal(calls.attachment.length, 0); assert.equal(calls.launch.length, 1);
  assert.equal(browser.execution.purpose, 'web-regression'); assert.deepEqual(browser.execution.scope, operation.scope);
});

test('ordinary current capture preserves explicit extension failure instead of changing identity', async t => {
  const error = failure('CHROME_EXTENSION_UNAVAILABLE');
  const { mod, calls } = await boundary(t, () => { throw error; });
  await assert.rejects(mod.openBrowser(undefined, undefined, options('current'), operation), value => value === error);
  assert.equal(calls.launch.length, 0); assert.deepEqual(calls.attachment[0], { execution: captureExecution(options('current'), operation), operationCwd: '/tmp' });
});

test('prefer-current downgrades only stable genuine unavailability and reports scope/reason', async t => {
  const { mod, calls } = await boundary(t, () => { throw failure('CHROME_EXTENSION_UNAVAILABLE', 'no usable connection'); });
  const browser = await mod.openBrowser(undefined, undefined, options('prefer-current'), operation);
  const record = captureBrowserRecord(browser, 'prefer-current');
  assert.equal(calls.launch.length, 1); assert.equal(record.actualIdentity, 'anonymous'); assert.equal(record.mode, 'headless');
  assert.deepEqual(record.scope, operation.scope); assert.match(record.downgradeReason, /^CHROME_EXTENSION_UNAVAILABLE:/);
});

for (const code of ['CHROME_EXTENSION_BUSY', 'CHROME_BRIDGE_PROTOCOL_ERROR', 'CHROME_BRIDGE_CONNECTION_CLOSED', 'CHROME_EXTENSION_UPDATE_REQUIRED', 'CHROME_BROWSER_IDENTITY_UNAVAILABLE', 'EACCES', 'ECONNREFUSED', undefined]) {
  test(`prefer-current must not downgrade ${code || 'uncoded disconnect text'}`, async t => {
    const error = failure(code, 'extension unavailable disconnected: misleading text');
    const { mod, calls } = await boundary(t, () => { throw error; });
    await assert.rejects(mod.openBrowser(undefined, undefined, options('prefer-current'), operation), value => value === error);
    assert.equal(calls.launch.length, 0);
  });
}

test('only exact optional module absence, not nested dependency absence, can downgrade', async t => {
  const missing = await boundary(t, () => {}, url => Object.assign(failure('ERR_MODULE_NOT_FOUND'), { url }));
  assert.equal((await missing.mod.openBrowser(undefined, undefined, options('prefer-current'), operation)).mode, 'headless');
  const nestedError = Object.assign(failure('ERR_MODULE_NOT_FOUND'), { url: 'file:///missing-dependency.js' });
  const dependency = await boundary(t, () => {}, () => nestedError);
  await assert.rejects(dependency.mod.openBrowser(undefined, undefined, options('prefer-current'), operation), value => value === nestedError);
  assert.equal(dependency.calls.launch.length, 0);
});

test('returned actual metadata must agree with the requested scope and current identity', () => {
  const execution = captureExecution(options('current'), operation);
  const valid = { execution, engine, mode: 'extension', backend: 'chrome-extension' };
  assert.doesNotThrow(() => validateCaptureAttachment(valid, execution));
  for (const invalid of [
    { ...valid, execution: undefined },
    { ...valid, engine: { ...engine, browserVersion: '' } },
    { ...valid, engine: { ...engine, browserVersion: true } },
    { ...valid, mode: 'headless' },
    { ...valid, execution: { ...execution, scope: { ...execution.scope, taskId: 'other-batch' } } },
    { ...valid, execution: { ...execution, purpose: 'interactive' } },
  ]) assert.throws(() => validateCaptureAttachment(invalid, execution), { code: 'BROWSER_ENGINE_MISMATCH' });
});

test('attachment identity failure and failed cleanup both remain visible; never downgrade', async t => {
  const cleanupError = failure('FIXTURE_CLOSE_FAILED');
  const { mod, calls } = await boundary(t, () => ({ mode: 'extension', close: async () => { throw cleanupError; } }));
  await assert.rejects(mod.openBrowser(undefined, undefined, options('prefer-current'), operation), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].code, 'BROWSER_ENGINE_MISMATCH'); assert.equal(error.errors[1], cleanupError); return true;
  });
  assert.equal(calls.launch.length, 0);
});
