// data: modules have no filesystem base; preserve both legal quote styles while
// resolving the real implementation's relative static imports/re-exports.
export function absolutizeRelativeImports(source, moduleUrl) {
  return source.replace(/\bfrom(\s*)(["'])(\.\.?\/[^"'\r\n]+)\2/g,
    (_match, spacing, quote, relative) => `from${spacing}${quote}${new URL(relative, moduleUrl).href}${quote}`);
}
