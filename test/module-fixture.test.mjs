import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutizeRelativeImports } from './module-fixture.mjs';

for (const quote of ["'", '"']) {
  test(`data URL fixture resolves ${quote === "'" ? 'single' : 'double'}-quoted relative imports and re-exports`, async () => {
    const moduleUrl = new URL('../lib/capture.js', import.meta.url);
    const source = `import { normalizeCaptureOptions } from ${quote}./parse.js${quote};
      export { isHttpUrl } from ${quote}../lib/parse.js${quote};
      import assert from 'node:assert/strict';
      export const options = normalizeCaptureOptions({url: 'https://example.test/'});
      assert.equal(typeof options, 'object');`;
    const resolved = absolutizeRelativeImports(source, moduleUrl);
    assert.ok(resolved.includes(`from ${quote}${new URL('../lib/parse.js', import.meta.url).href}${quote}`));
    assert.ok(resolved.includes("from 'node:assert/strict'"));
    const fixture = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
    assert.equal(fixture.options.url, 'https://example.test/');
    assert.equal(fixture.isHttpUrl('https://example.test/'), true);
    assert.equal(fixture.isHttpUrl('file:///tmp/fixture'), false);
  });
}
