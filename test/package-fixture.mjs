import { readFile } from 'node:fs/promises';

// Expectations come from package/lock artifacts, not the output constants under
// test. Keep plugin, browser-policy package and browser engine versions distinct.
// The browser-policy package is inlined under lib/browser-policy/, so its
// provenance lives in that directory's manifest.json instead of node_modules.
export const pluginPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const browserPolicyManifest = JSON.parse(await readFile(new URL('../lib/browser-policy/manifest.json', import.meta.url), 'utf8'));
export const browserPolicyPackage = {
  name: browserPolicyManifest.name,
  version: browserPolicyManifest.version,
  dshLocalArtifactVersion: browserPolicyManifest.dshLocalArtifactVersion,
  dshSourceArtifact: browserPolicyManifest.dshSourceArtifact,
};
export const headlessBrowserLock = JSON.parse(await readFile(new URL('../lib/headless-browser.lock.json', import.meta.url), 'utf8'));
