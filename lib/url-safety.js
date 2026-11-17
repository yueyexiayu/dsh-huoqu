const SENSITIVE_QUERY_KEY = /^(?:access_?token|auth|authorization|api_?key|code|credential|id_?token|key|password|passwd|secret|sig|signature|token)$/i;
const AMZ_KEY = /^x-amz-(?:credential|signature|security-token)$/i;
/**
 * OAuth and SAML responses deliver credentials in the fragment rather than the
 * query, so a `#access_token=…` tail is the same leak as `?access_token=…`. The
 * fragment is now treated as a second parameter list before falling back to the
 * raw text for hashes that are not key/value pairs.
 */
const SENSITIVE_FRAGMENT_VALUE = /(?:^|[&;])([A-Za-z0-9_.~-]+)=([^&;]*)/g;

function redactFragment(fragment) {
  if (!fragment) return { value: fragment, changed: false };
  let changed = false;
  const value = fragment.replace(SENSITIVE_FRAGMENT_VALUE, (match, key, raw) => {
    if (!SENSITIVE_QUERY_KEY.test(key) && !AMZ_KEY.test(key)) return match;
    if (raw === "REDACTED") return match;
    changed = true;
    return `${key}=REDACTED`;
  });
  return { value, changed };
}

export function redactSensitiveUrl(value) {
  const source = String(value || "");
  if (!source) return "";
  try {
    const url = new URL(source);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key) || AMZ_KEY.test(key)) {
        url.searchParams.set(key, "REDACTED");
        changed = true;
      }
    }
    const fragment = redactFragment(url.hash.replace(/^#/u, ""));
    if (fragment.changed) {
      url.hash = `#${fragment.value}`;
      changed = true;
    }
    return changed ? url.href : source;
  } catch {
    return source;
  }
}
