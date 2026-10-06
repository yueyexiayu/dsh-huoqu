import os from "node:os";
import path from "node:path";

function intInRange(value, fallback, min, max, label) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function hostSlug(hostname) {
  return String(hostname || "site")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function normalizeCaptureOptions(input = {}) {
  const rawUrl = String(input.url || "").trim();
  if (!rawUrl) throw new Error("url is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https URLs can be captured");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("url must have a hostname and must not contain credentials");
  }

  const width = intInRange(input.width ?? input.viewport_width, 1440, 360, 3840, "width");
  const height = intInRange(input.height ?? input.viewport_height, 1000, 320, 2160, "height");
  const waitSeconds = intInRange(input.wait_seconds, 2, 0, 20, "wait_seconds");

  let outputDir = String(input.output_dir || input.outputDir || "").trim();
  if (outputDir) {
    if (outputDir.includes("\0")) throw new Error("output_dir contains an invalid character");
    outputDir = expandHome(outputDir);
    if (!path.isAbsolute(outputDir)) throw new Error("output_dir must be an absolute path (or start with ~/)");
    outputDir = path.resolve(outputDir);
  } else {
    outputDir = path.join(os.homedir(), "Downloads", "huoqu", `${hostSlug(url.hostname)}-${timestamp()}`);
  }

  const root = path.parse(outputDir).root;
  const home = path.resolve(os.homedir());
  const dshHome = path.resolve(process.env.DSH_HOME || path.join(home, ".dsh"));
  if (outputDir === root || outputDir === home || outputDir === dshHome) {
    throw new Error("output_dir must be a dedicated project folder, not a system or DSH root");
  }

  return {
    url: url.href,
    outputDir,
    width,
    height,
    waitSeconds,
  };
}

const IGNORED_OUTPUT_NAMES = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"]);
const PREVIOUS_CAPTURE_NAMES = new Set([
  "index.html",
  "index.mhtml",
  "source.png",
  "local.png",
  "archive-preview.png",
  "report.json",
  "manifest.json",
  "README.md",
  "assets",
]);

export function unexpectedOutputEntries(names) {
  return names.filter((name) => {
    if (IGNORED_OUTPUT_NAMES.has(name)) return false;
    return !PREVIOUS_CAPTURE_NAMES.has(name);
  });
}

export function captureOutputEntries(names) {
  return names.filter((name) => PREVIOUS_CAPTURE_NAMES.has(name));
}

export function blockedPageMessage(page) {
  const title = String(page?.title || "").trim();
  const hay = `${page?.title || ""}\n${page?.textSample || ""}`;
  if (/可疑请求拦截|疑似攻击请求|已被系统自动拦截/.test(hay)) {
    return "站点防火墙把这次访问判定为可疑请求，返回的是拦截页，不是网站正文";
  }
  const challengeTitle = /^(?:Just a moment\s*[.!…]*|Attention Required\s*!?(?:\s*\|\s*Cloudflare)?)$/i.test(title);
  if (challengeTitle || /cf-browser-verification|请完成安全验证/i.test(hay)) {
    return "站点返回了人机验证页，不是网站正文";
  }
  if (/Access Denied|Request Rejected|403 Forbidden/i.test(hay) && Number(page?.document?.textLength || page?.textSample?.length || 0) < 500) {
    return "站点拒绝了这次访问，返回的不是网站正文";
  }
  return "";
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function offlinePreviewIssues(page, label) {
  if (!page) return [`${label} 没有返回页面状态`];
  const issues = [];
  if (Number(page.document?.htmlBytes || 0) < 1000 || Number(page.document?.textLength || 0) < 20) {
    issues.push(`${label} 预览内容不足（HTML ${page.document?.htmlBytes || 0} 字符，文本 ${page.document?.textLength || 0} 字符）`);
  }
  const blocked = blockedPageMessage(page);
  if (blocked) issues.push(`${label}：${blocked}`);
  const missing = (page.images || []).filter((image) => !image.loaded).length;
  if (missing) issues.push(`${label} 有 ${missing} 张图片未加载`);
  return issues;
}
