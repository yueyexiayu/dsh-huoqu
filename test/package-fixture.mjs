import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Expectations come from package/lock artifacts, not the output constants under
// test. Keep plugin, browser-policy package and browser engine versions distinct.
export const pluginPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const browserPolicyPackage = createRequire(import.meta.url)('@deepseek-ai/dsh-browser-use/package.json');
export const headlessBrowserLock = JSON.parse(await readFile(new URL('../lib/headless-browser.lock.json', import.meta.url), 'utf8'));
