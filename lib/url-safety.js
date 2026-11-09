const SENSITIVE_QUERY_KEY = /^(?:access_?token|auth|authorization|api_?key|code|credential|id_?token|key|password|passwd|secret|sig|signature|token)$/i;

export function redactSensitiveUrl(value) {
  const source = String(value || "");
  if (!source) return "";
  try {
    const url = new URL(source);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key) || /^x-amz-(?:credential|signature|security-token)$/i.test(key)) {
        url.searchParams.set(key, "REDACTED");
        changed = true;
      }
    }
    return changed ? url.href : source;
  } catch {
    return source;
  }
}
