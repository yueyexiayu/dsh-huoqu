import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSensitiveUrl } from "../lib/url-safety.js";

test("query credentials are redacted", () => {
  assert.equal(
    redactSensitiveUrl("https://example.test/p?token=abc&view=1"),
    "https://example.test/p?token=REDACTED&view=1",
  );
  assert.equal(
    redactSensitiveUrl("https://example.test/p?X-Amz-Signature=sig&X-Amz-Credential=c"),
    "https://example.test/p?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED",
  );
});

test("fragment credentials are redacted, not just the query", () => {
  assert.equal(
    redactSensitiveUrl("https://example.test/cb#access_token=SECRET123&state=ok"),
    "https://example.test/cb#access_token=REDACTED&state=ok",
  );
  assert.equal(
    redactSensitiveUrl("https://example.test/cb#id_token=abc"),
    "https://example.test/cb#id_token=REDACTED",
  );
});

test("a harmless fragment is preserved byte for byte", () => {
  const url = "https://example.test/docs#section-2";
  assert.equal(redactSensitiveUrl(url), url);
  assert.equal(redactSensitiveUrl(""), "");
});

test("re-running the redaction does not change an already redacted URL", () => {
  const once = redactSensitiveUrl("https://example.test/cb#access_token=SECRET&state=ok");
  assert.equal(redactSensitiveUrl(once), once);
});
