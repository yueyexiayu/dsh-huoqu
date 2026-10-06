import path from "node:path";

function parseHeaders(block) {
  const unfolded = String(block || "").replace(/\r?\n[\t ]+/g, " ");
  const headers = Object.create(null);
  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

function decodeQuotedPrintable(source) {
  const text = String(source || "").replace(/=\r?\n/g, "");
  const chunks = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      chunks.push(Buffer.from([Number.parseInt(text.slice(i + 1, i + 3), 16)]));
      i += 3;
      continue;
    }
    const point = text.codePointAt(i);
    const char = String.fromCodePoint(point);
    chunks.push(Buffer.from(char, "utf8"));
    i += char.length;
  }
  return Buffer.concat(chunks);
}

function decodeBody(body, encoding) {
  const normalized = String(encoding || "").trim().toLowerCase();
  if (normalized === "base64") return Buffer.from(String(body || "").replace(/\s+/g, ""), "base64");
  if (normalized === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(String(body || ""), "utf8");
}

function normalizeLocation(value, base) {
  const location = String(value || "").trim();
  if (!location) return "";
  if (/^cid:/i.test(location)) return `cid:${location.slice(4).replace(/[<>]/g, "").split("#")[0]}`;
  try {
    const url = base ? new URL(location, base) : new URL(location);
    url.hash = "";
    return url.href;
  } catch {
    return location;
  }
}

function decodeText(bytes, contentType) {
  const charset = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType || "");
  return new TextDecoder(charset?.[1] || charset?.[2] || charset?.[3] || "utf-8").decode(bytes);
}

export function parseMhtml(source) {
  const raw = String(source || "");
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) throw new Error("invalid MHTML: top-level headers are missing");
  const topHeaders = parseHeaders(raw.slice(0, headerEnd));
  const contentType = topHeaders["content-type"] || "";
  const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundaryMatch) throw new Error("invalid MHTML: multipart boundary is missing");
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const snapshotLocation = topHeaders["snapshot-content-location"] || "";
  const marker = `--${boundary}`;
  const sections = raw.split(marker).slice(1);
  const parts = [];

  for (let section of sections) {
    if (section.startsWith("--")) break;
    section = section.replace(/^\r?\n/, "");
    const match = /\r?\n\r?\n/.exec(section);
    if (!match) continue;
    const splitAt = match.index;
    const headers = parseHeaders(section.slice(0, splitAt));
    let body = section.slice(splitAt + match[0].length);
    body = body.replace(/\r?\n$/, "");
    const bytes = decodeBody(body, headers["content-transfer-encoding"]);
    const rawId = headers["content-id"] || "";
    parts.push({
      headers,
      contentType: (headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase(),
      location: headers["content-location"] || "",
      id: rawId.replace(/[<>]/g, "").trim(),
      bytes,
      text: null,
    });
  }

  if (!parts.length) throw new Error("invalid MHTML: no MIME parts were found");
  let main = parts.find((part) => part.contentType === "text/html" && normalizeLocation(part.location) === normalizeLocation(snapshotLocation));
  if (!main) main = parts.find((part) => part.contentType === "text/html");
  if (!main) throw new Error("invalid MHTML: the HTML page part was not found");
  for (const part of parts) {
    if (part.contentType.startsWith("text/") || /(?:javascript|json|xml|svg)/i.test(part.contentType)) {
      part.text = decodeText(part.bytes, part.headers["content-type"]);
    }
  }
  return { headers: topHeaders, snapshotLocation, parts, main };
}

const MIME_EXTENSIONS = new Map([
  ["text/css", ".css"],
  ["text/html", ".html"],
  ["text/javascript", ".js"],
  ["application/javascript", ".js"],
  ["application/x-javascript", ".js"],
  ["application/json", ".json"],
  ["application/xml", ".xml"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/x-icon", ".ico"],
  ["font/woff2", ".woff2"],
  ["font/woff", ".woff"],
  ["application/font-woff", ".woff"],
  ["application/vnd.ms-fontobject", ".eot"],
  ["font/ttf", ".ttf"],
  ["font/otf", ".otf"],
  ["video/mp4", ".mp4"],
  ["audio/mpeg", ".mp3"],
]);

function fileNameFor(part, index) {
  let urlName = "";
  try {
    urlName = path.posix.basename(new URL(part.location).pathname);
  } catch {
    urlName = "";
  }
  let ext = path.posix.extname(urlName).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = MIME_EXTENSIONS.get(part.contentType) || ".bin";
  let stem = urlName ? path.posix.basename(urlName, path.posix.extname(urlName)) : part.contentType.split("/").pop();
  stem = decodeURIComponentSafe(stem).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "resource";
  return `${String(index).padStart(3, "0")}-${stem}${ext}`;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return String(value); }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (all, code) => {
      const point = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
    })
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizeRef(ref, base) {
  let value = decodeHtml(ref).trim().replace(/^['"]+|['"]+$/g, "");
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return "";
  return normalizeLocation(value, base);
}

function localTarget(ref, base, map, prefix) {
  const key = normalizeRef(ref, base);
  if (!key) return ref;
  const found = map.get(key);
  const value = decodeHtml(ref).trim().replace(/^['"]+|['"]+$/g, "");
  const hashAt = value.indexOf("#");
  const fragment = hashAt >= 0 ? value.slice(hashAt) : "";
  if (found) return `${prefix}${found}${fragment}`;
  return `${key}${fragment}`;
}

function quoteAttr(value, quote) {
  let result = String(value).replace(/&/g, "&amp;");
  if (quote === "\"") result = result.replace(/\"/g, "&quot;");
  else result = result.replace(/'/g, "&#39;");
  return result;
}

function srcsetCandidates(value) {
  const source = String(value);
  const candidates = [];
  let at = 0;
  while (at < source.length) {
    while (/[\s,]/.test(source[at] || "") && at < source.length) at += 1;
    const start = at;
    while (at < source.length && !/\s/.test(source[at])) at += 1;
    let url = source.slice(start, at);
    if (!url) break;
    if (url.endsWith(",")) {
      candidates.push({ url: url.replace(/,+$/, ""), descriptor: "" });
      continue;
    }
    const descriptorStart = at;
    let depth = 0;
    while (at < source.length) {
      if (source[at] === "(") depth += 1;
      if (source[at] === ")") depth = Math.max(0, depth - 1);
      if (source[at] === "," && depth === 0) break;
      at += 1;
    }
    candidates.push({ url, descriptor: source.slice(descriptorStart, at).trim() });
    if (source[at] === ",") at += 1;
  }
  return candidates;
}

function rewriteSrcset(value, base, map, prefix) {
  return srcsetCandidates(value).map(({ url, descriptor }) =>
    `${localTarget(url, base, map, prefix)}${descriptor ? ` ${descriptor}` : ""}`).join(", ");
}

export function rewriteCss(css, base, map, prefix = "./assets/") {
  let output = String(css || "");
  output = output.replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (_all, quote, quoted, bare) => {
    const original = String(quoted ?? bare ?? "").trim();
    const rewritten = localTarget(original, base, map, prefix);
    return `url("${String(rewritten).replace(/"/g, "\\\"")}")`;
  });
  output = output.replace(/(@import\s+)(['"])(.*?)\2/gi, (_all, start, quote, ref) => {
    const rewritten = localTarget(ref, base, map, prefix);
    return `${start}${quote}${String(rewritten).replaceAll(quote, `\\${quote}`)}${quote}`;
  });
  return output;
}

export const UNFOLD_STYLE = [
  "html, body { height: auto !important; min-height: 100% !important; overflow: visible !important; }",
  ".opacity-0, .cssLazyFont, .photo_desc, .module_text_content, .s_footer, .jz_web_footer { opacity: 1 !important; visibility: visible !important; }",
  ".photo_display_list > li, .banner_pic_group > .banner_pic_item_wrap { display: block !important; position: relative !important; }",
  ".swiper-container-vertical, .swiper-vertical, .fp-enabled, #fullpage, .fullpage-wrapper { height: auto !important; max-height: none !important; overflow: visible !important; }",
  ".swiper-container-vertical > .swiper-wrapper, .swiper-vertical > .swiper-wrapper { display: flex !important; flex-direction: column !important; width: 100% !important; height: auto !important; transform: none !important; transition: none !important; }",
  ".swiper-container-vertical > .swiper-wrapper > .swiper-slide, .swiper-vertical > .swiper-wrapper > .swiper-slide, .fp-section, .fullpage-wrapper > .section { position: relative !important; flex: 0 0 auto !important; width: 100% !important; height: 100vh !important; min-height: 100vh !important; overflow: hidden !important; transform: none !important; }",
  ".swiper-container-vertical > .swiper-wrapper > .swiper-slide-duplicate, .swiper-vertical > .swiper-wrapper > .swiper-slide-duplicate { display: none !important; }",
  ".swiper-container-vertical > .swiper-wrapper > .swiper-slide.ind-footer, .swiper-container-vertical > .swiper-wrapper > .swiper-slide:has(.ind-footer) { height: auto !important; min-height: 0 !important; overflow: visible !important; }",
].join(" ");

export function htmlToMhtml(html, sourceUrl) {
  const boundary = `----HuoquHtml-${Date.now().toString(36)}`;
  const body = Buffer.from(String(html || ""), "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
  return [
    "From: <Saved by huoqu>",
    `Snapshot-Content-Location: ${sourceUrl}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=\"utf-8\"",
    "Content-Transfer-Encoding: base64",
    `Content-Location: ${sourceUrl}`,
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export function injectUnfoldStyle(html) {
  const source = String(html || "");
  if (source.includes("huoqu-unfold")) return source;
  const tag = `<style id="huoqu-unfold">${UNFOLD_STYLE}</style>`;
  if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, `${tag}</head>`);
  return `${tag}${source}`;
}

function transformAttributes(tag, transform) {
  return tag.replace(/(\s)([^\s/>=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (all, space, name, double, single, bare) => {
    const value = double ?? single ?? bare ?? "";
    const next = transform(name.toLowerCase(), decodeHtml(value));
    if (next === undefined) return all;
    const quote = single !== undefined ? "'" : '"';
    return `${space}${name}=${quote}${quoteAttr(next, quote)}${quote}`;
  });
}

function attributesOf(tag) {
  const attributes = new Map();
  transformAttributes(tag, (name, value) => {
    if (!attributes.has(name)) attributes.set(name, value);
  });
  return attributes;
}

// Treat raw script/style bodies and comments separately from element attributes.
function transformHtml(html, transformTag, transformStyle = (css) => css) {
  return String(html || "").replace(/<!--[\s\S]*?-->|<(script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1\s*>|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (token, rawTag, body) => {
    if (token.startsWith("<!--")) return token;
    if (rawTag) {
      const opening = /^<(?:[^"'<>]|"[^"]*"|'[^']*')*>/.exec(token)[0];
      const closing = token.slice(opening.length + body.length);
      return `${transformTag(opening)}${rawTag.toLowerCase() === "style" ? transformStyle(body) : body}${closing}`;
    }
    return transformTag(token);
  });
}

function documentBase(html, fallback) {
  let first;
  transformHtml(html, (tag) => {
    if (first === undefined && /^<base\b/i.test(tag)) first = attributesOf(tag).get("href");
    return tag;
  });
  if (first === undefined) return fallback;
  try { return new URL(first, fallback).href; } catch { return fallback; }
}

function utf8Html(html) {
  const result = transformHtml(html, (tag) => /^<meta\b/i.test(tag) ? transformAttributes(tag, (name, value) => {
    if (name === "charset") return "utf-8";
    if (name === "content" && /charset\s*=/i.test(value)) return value.replace(/charset\s*=\s*[^;\s]+/i, "charset=utf-8");
  }) : tag);
  const meta = '<meta charset="utf-8">';
  if (/<head\b/i.test(result)) return result.replace(/<head\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i, (tag) => `${tag}${meta}`);
  if (/<html\b/i.test(result)) return result.replace(/<html\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i, (tag) => `${tag}<head>${meta}</head>`);
  if (/^\s*<!doctype\b/i.test(result)) return result.replace(/^(\s*<!doctype[^>]*>)/i, `$1${meta}`);
  return `${meta}${result}`;
}

export function rewriteHtml(html, base, map, options = {}) {
  const prefix = options.prefix ?? "./assets/";
  const resolvedBase = documentBase(html, base);
  let output = transformHtml(html, (tag) => {
    if (/^<base\b/i.test(tag)) return "";
    const attrs = attributesOf(tag);
    if (options.staticSnapshot !== false && /^<meta\b/i.test(tag) && attrs.get("http-equiv")?.toLowerCase() === "refresh") return "";
    if (options.staticSnapshot !== false && /^<(?:video|audio)\b/i.test(tag)) {
      tag = tag.replace(/\s(?:src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (attribute, double, single, bare) =>
        normalizeRef(double ?? single ?? bare, resolvedBase) === normalizeLocation(base) ? "" : attribute);
    }
    return transformAttributes(tag, (name, value) => {
      if (name === "srcset") return rewriteSrcset(value, resolvedBase, map, prefix);
      if (name === "style") return rewriteCss(value, resolvedBase, map, prefix);
      if (/^(?:src|href|poster|data-src|data-original|xlink:href)$/.test(name) || (name === "data" && /^<object\b/i.test(tag))) return localTarget(value, resolvedBase, map, prefix);
    });
  }, (css) => rewriteCss(css, resolvedBase, map, prefix));
  if (options.unfold === true) output = injectUnfoldStyle(output);
  return output;
}

function collectCssReferences(css, references) {
  const add = (value) => { if (/^https?:\/\//i.test(value)) references.add(value); };
  for (const match of String(css).matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) add((match[1] ?? match[2] ?? match[3]).trim());
  for (const match of String(css).matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) add(match[1] ?? match[2]);
}

function collectHtmlReferences(html, references) {
  const add = (value) => { if (/^https?:\/\//i.test(value || "")) references.add(value); };
  transformHtml(html, (tag) => {
    const attrs = attributesOf(tag);
    for (const name of ["src", "poster", "data-src", "data-original"]) add(attrs.get(name));
    for (const { url } of srcsetCandidates(attrs.get("srcset") || "")) add(url);
    if (/^<link\b/i.test(tag) && /(?:^|\s)(?:stylesheet|icon|preload|modulepreload)(?:\s|$)/i.test(attrs.get("rel") || "")) add(attrs.get("href"));
    if (/^<(?:use|image|feimage)\b/i.test(tag)) { add(attrs.get("href")); add(attrs.get("xlink:href")); }
    if (/^<object\b/i.test(tag)) add(attrs.get("data"));
    if (attrs.has("style")) collectCssReferences(attrs.get("style"), references);
    return tag;
  }, (css) => { collectCssReferences(css, references); return css; });
}

function inlineSvgReferences(html, records, map, prefix, fallbackBase) {
  const occupied = new Set();
  transformHtml(html, (tag) => { const id = attributesOf(tag).get("id"); if (id) occupied.add(id); return tag; });
  const svgRecords = new Map(records.filter(({ part }) => part.contentType === "image/svg+xml").map((record) => [`${prefix}${record.name}`, record]));
  const embedded = new Map();
  let serial = 0;
  function prepare(record) {
    if (embedded.has(record.name)) return embedded.get(record.name);
    const source = record.part.text ?? record.part.bytes.toString("utf8");
    const svg = /<svg\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*<\/svg\s*>/i.exec(source)?.[0];
    // Renaming IDs cannot preserve script-driven SVG behavior reliably.
    if (!svg || /<script\b/i.test(svg)) return null;
    const originalIds = new Set();
    transformHtml(svg, (tag) => { const id = attributesOf(tag).get("id"); if (id) originalIds.add(id); return tag; });
    let namespace;
    do { namespace = `huoqu-svg-${++serial}-`; } while ([...occupied].some((id) => id.startsWith(namespace)));
    const ids = new Map([...originalIds].map((id, index) => [id, `${namespace}${index + 1}`]));
    const rootAttrs = attributesOf(/^<svg\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(svg)[0]);
    const rootId = ids.get(rootAttrs.get("id")) || `${namespace}root`;
    for (const id of [...ids.values(), rootId]) occupied.add(id);
    const fragment = (value) => {
      const self = `${prefix}${record.name}#`;
      const ref = value.startsWith(self) ? `#${value.slice(self.length)}` : value;
      return ref.startsWith("#") && ids.has(decodeURIComponentSafe(ref.slice(1))) ? `#${ids.get(decodeURIComponentSafe(ref.slice(1)))}` : value;
    };
    const urls = (value) => value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (all, double, single, bare) => {
      const ref = String(double ?? single ?? bare).trim();
      const next = fragment(ref);
      return next === ref ? all : `url(${next})`;
    });
    const css = (value) => urls(value).replace(/([^{}]+)\{/g, (_all, selectors) => `${selectors.replace(/#([a-zA-Z_][\w-]*)/g, (all, id) => ids.has(id) ? `#${ids.get(id)}` : all)}{`);
    let content = rewriteHtml(svg, record.part.location || fallbackBase, map, { prefix, staticSnapshot: true });
    content = transformHtml(content, (tag) => transformAttributes(tag, (name, value) => {
      if (name === "id") return ids.get(value) || value;
      if (name === "href" || name === "xlink:href") return fragment(value);
      if (name === "aria-labelledby" || name === "aria-describedby") return value.split(/\s+/).map((id) => ids.get(id) || id).join(" ");
      return urls(value);
    }), css);
    if (!rootAttrs.has("id")) content = content.replace(/^<svg\b/i, `<svg id="${rootId}"`);
    const result = { content, ids, rootId };
    embedded.set(record.name, result);
    return result;
  }
  let output = transformHtml(html, (tag) => {
    if (!/^<(?:use|feimage)\b/i.test(tag)) return tag;
    return transformAttributes(tag, (name, value) => {
      if (name !== "href" && name !== "xlink:href") return;
      const at = value.indexOf("#");
      const record = svgRecords.get(at >= 0 ? value.slice(0, at) : value);
      if (!record) return;
      const embeddedSvg = prepare(record);
      if (!embeddedSvg) return;
      const target = at >= 0 ? embeddedSvg.ids.get(decodeURIComponentSafe(value.slice(at + 1))) : embeddedSvg.rootId;
      return target ? `#${target}` : undefined;
    });
  });
  if (!embedded.size) return output;
  const definitions = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="0" height="0" style="position:absolute;overflow:hidden"><defs>${[...embedded.values()].map(({ content }) => content).join("")}</defs></svg>`;
  let inserted = false;
  output = transformHtml(output, (tag) => {
    if (!inserted && /^<\/body\s*>/i.test(tag)) { inserted = true; return `${definitions}${tag}`; }
    return tag;
  });
  return inserted ? output : `${output}${definitions}`;
}

export function materializeMhtml(source, additionalResources = []) {
  const parsed = parseMhtml(source);
  const resourceParts = parsed.parts.filter((part) => part !== parsed.main && (part.location || part.id));
  const map = new Map();
  const records = [];
  let index = 0;

  for (const part of resourceParts) {
    const key = part.location ? normalizeLocation(part.location, parsed.snapshotLocation) : `cid:${part.id}`;
    if (!key || map.has(key)) continue;
    const name = fileNameFor(part, ++index);
    map.set(key, name);
    if (part.id) map.set(`cid:${part.id}`, name);
    records.push({ part, name, key });
  }
  for (const extra of additionalResources) {
    const requestedKey = normalizeLocation(extra.url, parsed.snapshotLocation);
    const contentLocation = String(extra.finalUrl || extra.url || "");
    const key = normalizeLocation(contentLocation, parsed.snapshotLocation) || requestedKey;
    if (!requestedKey || !key || map.has(requestedKey) || map.has(key)) continue;
    const contentType = String(extra.mime || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const bytes = Buffer.from(extra.bytes || []);
    const part = {
      location: contentLocation,
      id: "",
      contentType,
      bytes,
      text: contentType.startsWith("text/") || /(?:javascript|json|xml|svg)/i.test(contentType) ? decodeText(bytes, extra.mime) : null,
    };
    const name = fileNameFor(part, ++index);
    map.set(requestedKey, name);
    map.set(key, name);
    records.push({ part, name, key: requestedKey });
  }

  const assets = records.map(({ part, name, key }) => {
    let bytes = part.bytes;
    if (part.contentType === "text/css") {
      bytes = Buffer.from(rewriteCss(part.text ?? bytes.toString("utf8"), part.location || parsed.snapshotLocation, map, "").replace(/^\s*@charset\s+["'][^"']*["'];/i, '@charset "UTF-8";'), "utf8");
    } else if (part.contentType === "text/html") {
      const rewritten = rewriteHtml(part.text ?? bytes.toString("utf8"), part.location || parsed.snapshotLocation, map, { prefix: "", staticSnapshot: true });
      bytes = Buffer.from(utf8Html(inlineSvgReferences(rewritten, records, map, "", parsed.snapshotLocation)), "utf8");
    }
    return { name, bytes, mime: part.contentType, url: part.location || key };
  });

  const rewrittenHtml = rewriteHtml(parsed.main.text ?? parsed.main.bytes.toString("utf8"), parsed.main.location || parsed.snapshotLocation, map, { prefix: "./assets/", staticSnapshot: true });
  const html = utf8Html(inlineSvgReferences(rewrittenHtml, records, map, "./assets/", parsed.snapshotLocation));
  const externalReferences = new Set();
  collectHtmlReferences(html, externalReferences);
  for (const asset of assets) {
    if (asset.mime === "text/css") collectCssReferences(asset.bytes.toString("utf8"), externalReferences);
    if (asset.mime === "text/html") collectHtmlReferences(asset.bytes.toString("utf8"), externalReferences);
  }

  return {
    html,
    assets,
    sourceUrl: parsed.snapshotLocation,
    partCount: parsed.parts.length,
    resourceCount: assets.length,
    externalReferences: [...externalReferences].slice(0, 200),
    sourceHtmlBytes: parsed.main.bytes.length,
  };
}

function wrapBase64(bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  return base64.match(/.{1,76}/g)?.join("\r\n") || "";
}

export function buildMhtml(materialized, sourceUrl) {
  const boundary = `----Huoqu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const ids = new Map(materialized.assets.map((asset, index) => [asset.name, `huoqu-${index + 1}`]));
  const bundleBase = "https://huoqu.invalid/";
  const map = new Map();
  for (const [name, id] of ids) {
    for (const relative of [name, `assets/${name}`]) map.set(new URL(relative, bundleBase).href, `cid:${id}`);
  }
  const html = rewriteHtml(materialized.html, bundleBase, map, { prefix: "", staticSnapshot: false });

  const parts = [
    `From: <Saved by huoqu>`,
    `Snapshot-Content-Location: ${sourceUrl}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type=\"text/html\"; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=\"utf-8\"",
    "Content-Transfer-Encoding: base64",
    `Content-Location: ${sourceUrl}`,
    "",
    wrapBase64(Buffer.from(html, "utf8")),
  ];

  for (const asset of materialized.assets) {
    const contentId = ids.get(asset.name);
    let bytes = Buffer.from(asset.bytes);
    if (asset.mime === "text/css") {
      bytes = Buffer.from(rewriteCss(bytes.toString("utf8"), bundleBase, map, ""), "utf8");
    } else if (asset.mime === "text/html") {
      bytes = Buffer.from(rewriteHtml(bytes.toString("utf8"), bundleBase, map, { prefix: "", staticSnapshot: false }), "utf8");
    }
    parts.push(
      `--${boundary}`,
      `Content-Type: ${asset.mime || "application/octet-stream"}${/^(?:text\/html|text\/css)$/.test(asset.mime) ? '; charset="utf-8"' : ""}`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${contentId}>`,
      `Content-Location: ${asset.url || `https://huoqu.invalid/${asset.name}`}`,
      "",
      wrapBase64(bytes),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}
