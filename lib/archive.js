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
  if (/^cid:/i.test(location)) return `cid:${location.slice(4).replace(/[<>]/g, "")}`;
  try {
    const url = base ? new URL(location, base) : new URL(location);
    url.hash = "";
    return url.href;
  } catch {
    return location;
  }
}

export function parseMhtml(source) {
  const raw = String(source || "");
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) throw new Error("invalid MHTML: top-level headers are missing");
  const headerBreak = /\r?\n\r?\n/.exec(raw.slice(headerEnd));
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
      part.text = part.bytes.toString("utf8");
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
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizeRef(ref, base) {
  let value = decodeHtml(ref).trim().replace(/^['"]+|['"]+$/g, "");
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return "";
  if (value.startsWith("//")) value = `https:${value}`;
  return normalizeLocation(value, base);
}

function localTarget(ref, base, map, prefix) {
  const key = normalizeRef(ref, base);
  if (!key) return ref;
  const found = map.get(key);
  if (found) return `${prefix}${found}`;
  return key;
}

function quoteAttr(value, quote) {
  let result = String(value).replace(/&/g, "&amp;");
  if (quote === "\"") result = result.replace(/\"/g, "&quot;");
  else result = result.replace(/'/g, "&#39;");
  return result;
}

function rewriteSrcset(value, base, map, prefix) {
  return String(value).split(",").map((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed) return trimmed;
    const match = /^(\S+)(\s+.*)?$/.exec(trimmed);
    if (!match) return trimmed;
    return `${localTarget(match[1], base, map, prefix)}${match[2] || ""}`;
  }).join(", ");
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

export function rewriteHtml(html, base, map, options = {}) {
  const prefix = options.prefix ?? "./assets/";
  let output = String(html || "").replace(/<base\b[^>]*>/gi, "");
  if (options.staticSnapshot !== false) {
    output = output.replace(/<meta\b[^>]*http-equiv\s*=\s*(['"]?)refresh\1[^>]*>/gi, "");
    output = output.replace(/<(?:video|audio)\b[^>]*>/gi, (tag) => tag.replace(/\s(src|poster)\s*=\s*(["'])(.*?)\2/gi, (attribute, _name, _quote, value) => normalizeRef(value, base) === normalizeLocation(base) ? "" : attribute));
  }
  output = output.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_all, attrs, css) =>
    `<style${attrs}>${rewriteCss(css, base, map, prefix)}</style>`);
  output = output.replace(/\b(src|href|poster|data-src|data-original|xlink:href|srcset)\s*=\s*(["'])([\s\S]*?)\2/gi, (_all, name, quote, value) => {
    const attr = String(name).toLowerCase();
    const rewritten = attr === "srcset"
      ? rewriteSrcset(value, base, map, prefix)
      : localTarget(value, base, map, prefix);
    return `${name}=${quote}${quoteAttr(rewritten, quote)}${quote}`;
  });
  output = output.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_all, quote, style) =>
    `style=${quote}${quoteAttr(rewriteCss(style, base, map, prefix), quote)}${quote}`);
  if (options.unfold === true) output = injectUnfoldStyle(output);
  return output;
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
      text: contentType.startsWith("text/") || /(?:javascript|json|xml|svg)/i.test(contentType) ? bytes.toString("utf8") : null,
    };
    const name = fileNameFor(part, ++index);
    map.set(requestedKey, name);
    map.set(key, name);
    records.push({ part, name, key: requestedKey });
  }

  const assets = records.map(({ part, name, key }) => {
    let bytes = part.bytes;
    if (part.contentType === "text/css") {
      bytes = Buffer.from(rewriteCss(part.text ?? bytes.toString("utf8"), part.location || parsed.snapshotLocation, map, ""), "utf8");
    } else if (part.contentType === "text/html") {
      bytes = Buffer.from(rewriteHtml(part.text ?? bytes.toString("utf8"), part.location || parsed.snapshotLocation, map, { prefix: "", staticSnapshot: true }), "utf8");
    }
    return { name, bytes, mime: part.contentType, url: part.location || key };
  });

  const html = rewriteHtml(parsed.main.text ?? parsed.main.bytes.toString("utf8"), parsed.main.location || parsed.snapshotLocation, map, { prefix: "./assets/", staticSnapshot: true });
  const externalReferences = new Set();
  const resourcePattern = /\s(?:src|poster|data-src|data-original)\s*=\s*["'](https?:\/\/[^\s"']+)/gi;
  for (const match of html.matchAll(resourcePattern)) externalReferences.add(match[1]);
  const srcsetPattern = /\ssrcset\s*=\s*["']([^"']+)/gi;
  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(",")) {
      const url = /^\s*(https?:\/\/[^\s]+)/i.exec(candidate);
      if (url) externalReferences.add(url[1]);
    }
  }
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^\s"']+)/gi)) externalReferences.add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']([^"']+)/i.exec(tag)?.[1]?.toLowerCase() || "";
    if (!/(?:stylesheet|icon|preload)/.test(rel)) continue;
    const href = /\bhref\s*=\s*["'](https?:\/\/[^\s"']+)/i.exec(tag);
    if (href) externalReferences.add(href[1]);
  }
  for (const asset of assets) {
    if (asset.mime === "text/css") {
      const css = asset.bytes.toString("utf8");
      for (const match of css.matchAll(/url\(["']?(https?:\/\/[^\s"')]+)/gi)) externalReferences.add(match[1]);
      for (const match of css.matchAll(/@import\s+["'](https?:\/\/[^\s"']+)/gi)) externalReferences.add(match[1]);
    }
  }

  return {
    html,
    assets,
    sourceUrl: parsed.snapshotLocation,
    partCount: parsed.parts.length,
    resourceCount: assets.length,
    externalReferences: [...externalReferences].filter((reference) => normalizeLocation(reference, parsed.snapshotLocation) !== normalizeLocation(parsed.snapshotLocation)).slice(0, 200),
    sourceHtmlBytes: parsed.main.bytes.length,
  };
}

function replaceAssetReferences(source, assetName, contentId) {
  let output = String(source || "");
  output = output.replaceAll(`./assets/${assetName}`, `cid:${contentId}`);
  output = output.replaceAll(`./${assetName}`, `cid:${contentId}`);
  output = output.replaceAll(`\"${assetName}\"`, `\"cid:${contentId}\"`);
  output = output.replaceAll(`'${assetName}'`, `'cid:${contentId}'`);
  return output;
}

function wrapBase64(bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  return base64.match(/.{1,76}/g)?.join("\r\n") || "";
}

export function buildMhtml(materialized, sourceUrl) {
  const boundary = `----Huoqu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const ids = new Map(materialized.assets.map((asset, index) => [asset.name, `huoqu-${index + 1}`]));
  let html = String(materialized.html || "");
  for (const asset of materialized.assets) html = replaceAssetReferences(html, asset.name, ids.get(asset.name));

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
      let css = bytes.toString("utf8");
      for (const dependency of materialized.assets) css = replaceAssetReferences(css, dependency.name, ids.get(dependency.name));
      bytes = Buffer.from(css, "utf8");
    }
    parts.push(
      `--${boundary}`,
      `Content-Type: ${asset.mime || "application/octet-stream"}`,
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
