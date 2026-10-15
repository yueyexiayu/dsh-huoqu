import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolvePinnedHeadlessEngine } from '@deepseek-ai/dsh-browser-use/headless-engine';

const pin = JSON.parse(fs.readFileSync(new URL('./headless-browser.lock.json', import.meta.url), 'utf8'));
Object.freeze(pin.files);
export const HEADLESS_BROWSER_PIN = Object.freeze(pin);
const packageRoot = fileURLToPath(new URL('../node_modules/playwright-core/', import.meta.url));

// Plugin-owned inventory only; all discovery and verification lives in the shared core.
export function resolveHeadlessBrowser(options = {}) {
  return resolvePinnedHeadlessEngine({ playwrightPackageRoot: packageRoot, ...options, pin: HEADLESS_BROWSER_PIN, overrideName: 'HUOQU_CHROME_PATH' });
}
