import { spawn } from "node:child_process";
import { once } from "node:events";
import { lookup } from "node:dns/promises";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildMhtml, htmlToMhtml, materializeMhtml } from "./archive.js";
import { blockedPageMessage, captureOutputEntries, isHttpUrl, normalizeCaptureOptions, offlinePreviewIssues, unexpectedOutputEntries } from "./parse.js";

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_MHTML_BYTES = 100 * 1024 * 1024;
const MAX_EXTRA_RESOURCE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRA_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRA_RESOURCE_COUNT = 120;
const OUTPUT_LOCKS = new Set();

function checkAbort(signal) {
  if (signal?.aborted) throw new Error("capture cancelled");
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("capture cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("capture cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isPrivateAddress(address) {
  let value = String(address || "").toLowerCase().split("%")[0];
  if (net.isIP(value) === 6) {
    value = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(value);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      value = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (version === 6) {
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:");
  }
  return true;
}

async function assertAllowedResource(url, sourceOrigin) {
  if (url.origin === sourceOrigin) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal") {
    throw new Error("blocked a private/local resource host");
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("blocked a private/local resource address");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("blocked a hostname resolving to a private/local address");
  }
}

async function readResponseLimited(response, maxBytes, onRead) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      onRead?.(chunk.length);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`resource exceeds ${maxBytes} byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchExtraResource(rawUrl, sourceOrigin, signal, maxBytes = MAX_EXTRA_RESOURCE_BYTES, onRead) {
  const original = new URL(rawUrl);
  if (original.protocol !== "http:" && original.protocol !== "https:") throw new Error("unsupported resource protocol");
  let current = original;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    checkAbort(signal);
    await assertAllowedResource(current, sourceOrigin);
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(current.href, {
      redirect: "manual",
      signal: requestSignal,
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,font/*,text/css,*/*;q=0.8" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`HTTP ${response.status} redirect has no Location`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`resource exceeds ${maxBytes} byte limit`);
    }
    const bytes = await readResponseLimited(response, maxBytes, onRead);
    if (!bytes.length) throw new Error("resource response was empty");
    const mime = String(response.headers.get("content-type") || "application/octet-stream").trim();
    return { url: original.href, finalUrl: current.href, mime, bytes };
  }
  throw new Error("resource exceeded redirect limit");
}

async function completeExternalResources(mhtml, initial, sourceUrl, signal) {
  let materialized = initial;
  const resources = [];
  const failures = [];
  const attempted = new Set();
  let totalBytes = 0;
  let downloadedBytes = 0;
  let requestCount = 0;

  for (let round = 0; round < 4 && requestCount < MAX_EXTRA_RESOURCE_COUNT && downloadedBytes < MAX_EXTRA_TOTAL_BYTES; round += 1) {
    const pending = [];
    for (const reference of materialized.externalReferences) {
      let key;
      try {
        const parsed = new URL(reference);
        parsed.hash = "";
        key = parsed.href;
        if (key === sourceUrl) continue;
      } catch {
        continue;
      }
      if (attempted.has(key)) continue;
      attempted.add(key);
      pending.push(reference);
    }
    if (!pending.length) break;

    let addedThisRound = 0;
    for (let offset = 0; offset < pending.length;) {
      checkAbort(signal);
      const remainingBytes = MAX_EXTRA_TOTAL_BYTES - downloadedBytes;
      const remainingCount = MAX_EXTRA_RESOURCE_COUNT - requestCount;
      if (remainingBytes <= 0 || remainingCount <= 0) break;
      // Reserve a bounded share for each concurrent response, including failed reads.
      const batchSize = Math.min(5, remainingCount, Math.max(1, Math.floor(remainingBytes / MAX_EXTRA_RESOURCE_BYTES)));
      const batch = pending.slice(offset, offset + batchSize);
      const maxBytes = Math.min(MAX_EXTRA_RESOURCE_BYTES, Math.floor(remainingBytes / batch.length));
      offset += batch.length;
      requestCount += batch.length;
      const results = await Promise.all(batch.map(async (url) => {
        try {
          return { url, value: await fetchExtraResource(url, new URL(sourceUrl).origin, signal, maxBytes, (bytes) => { downloadedBytes += bytes; }) };
        }
        catch (error) {
          checkAbort(signal);
          return { url, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      for (const result of results) {
        if (!result.value) {
          failures.push({ url: result.url, error: result.error || "fetch failed" });
          continue;
        }
        resources.push(result.value);
        totalBytes += result.value.bytes.length;
        addedThisRound += 1;
      }
    }
    if (!addedThisRound) break;
    materialized = materializeMhtml(mhtml, resources);
  }
  if (materialized.externalReferences.length) {
    if (requestCount >= MAX_EXTRA_RESOURCE_COUNT) {
      failures.push({ url: "", error: `extra resources reached ${MAX_EXTRA_RESOURCE_COUNT} request limit` });
    }
    if (downloadedBytes >= MAX_EXTRA_TOTAL_BYTES) {
      failures.push({ url: "", error: `extra resources reached ${MAX_EXTRA_TOTAL_BYTES} byte total limit` });
    }
    failures.push({
      url: "",
      error: `${materialized.externalReferences.length} external resource references remain unresolved`,
    });
  }
  return { materialized, resources, failures, totalBytes };
}

async function chromePath() {
  const candidates = [
    process.env.HUOQU_CHROME_PATH,
    process.platform === "darwin" ? CHROME_MAC : "",
    process.platform === "win32" ? path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known Chrome location.
    }
  }
  throw new Error("找不到本机 Google Chrome/Chromium；可设置 HUOQU_CHROME_PATH 指定浏览器可执行文件");
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

class ChromeDevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "Chrome DevTools command failed"));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed"));
      this.pending.clear();
    });
    socket.addEventListener("error", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools WebSocket error"));
      this.pending.clear();
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForEvent(method, { timeoutMs = 30_000, signal, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.listeners.delete(listener);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(new Error("capture cancelled"));
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        finish(null, message.params || {});
      };
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
      this.listeners.add(listener);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  send(method, params = {}, sessionId, { signal, timeoutMs = 30_000 } = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome DevTools connection is closed"));
    if (signal?.aborted) return Promise.reject(new Error("capture cancelled"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
      const onAbort = () => finish(new Error("capture cancelled"));
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      this.pending.set(id, {
        resolve: (value) => finish(null, value),
        reject: (error) => finish(error),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        finish(error);
      }
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

async function openChrome({ signal }) {
  if (typeof WebSocket !== "function") throw new Error("当前 DSH Host Node 不支持 WebSocket，无法连接本地 Chrome DevTools");
  const binary = await chromePath();
  const profile = await mkdtemp(path.join(os.tmpdir(), "dsh-huoqu-chrome-"));
  const port = await reservePort();
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-gpu",
    "--hide-scrollbars",
    "--disable-blink-features=AutomationControlled",
    "--allow-file-access-from-files",
    "--lang=zh-CN",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
  if (process.platform === "linux") args.push("--disable-dev-shm-usage");
  const child = spawn(binary, args, { stdio: "ignore", detached: process.platform !== "win32" });
  let endpoint;
  try {
    for (let i = 0; i < 100; i += 1) {
      checkAbort(signal);
      if (child.exitCode != null) throw new Error(`Chrome exited before starting DevTools (code ${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) });
        if (response.ok) {
          endpoint = await response.json();
          break;
        }
      } catch {
        // Chrome may need a few seconds to initialize its isolated profile.
      }
      await delay(200, signal);
    }
    if (!endpoint?.webSocketDebuggerUrl) throw new Error("等待本地 Chrome DevTools 超时");
    const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接本地 Chrome DevTools 超时")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("连接本地 Chrome DevTools 失败")); }, { once: true });
    });
    const cdp = new ChromeDevTools(socket);
    const reported = String(endpoint["User-Agent"] || "").replace("HeadlessChrome", "Chrome");
    const userAgent = reported && !/Headless/i.test(reported)
      ? reported
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    return { mode: "headless", cdp, child, profile, userAgent, close: async () => {} };
  } catch (error) {
    await stopChrome({ child, cdp: null, profile });
    throw error;
  }
}

async function openBrowser(signal) {
  try {
    const mod = await import("../../chrome/lib/browser.js");
    if (typeof mod.openCaptureSession !== "function") throw new Error("Chrome 插件没有提供正式浏览器采集入口");
    return await mod.openCaptureSession(signal);
  } catch (error) {
    checkAbort(signal);
    const headless = await openChrome({ signal });
    headless.fallbackReason = error instanceof Error ? error.message : String(error);
    return headless;
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await Promise.race([
    once(child, "exit").catch(() => {}),
    delay(timeoutMs).catch(() => {}),
  ]);
}

async function stopChrome(chrome = {}) {
  if (chrome.mode === "extension") {
    await chrome.close?.();
    return;
  }
  const { child, cdp, profile } = chrome;
  try { cdp?.close(); } catch { /* ignore */ }
  if (child && child.exitCode == null && child.signalCode == null) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    await waitForExit(child, 3_000);
    if (child.exitCode == null && child.signalCode == null) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
      await waitForExit(child, 2_000);
    }
  }
  if (profile) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

async function evaluate(cdp, sessionId, expression, { signal, timeoutMs = 30_000 } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId, { signal, timeoutMs });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "page evaluation failed");
  }
  return result.result?.value;
}

async function pageSummary(cdp, sessionId, signal) {
  const value = await evaluate(cdp, sessionId, `(() => ({
    url: location.href,
    title: document.title || "",
    textSample: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500),
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    document: {
      width: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
      height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
      htmlBytes: document.documentElement?.outerHTML?.length || 0,
      textLength: document.body?.innerText?.length || 0,
    },
    images: Array.from(document.images || []).map((image) => ({
      src: image.currentSrc || image.src || "",
      loaded: Boolean(image.complete && image.naturalWidth > 0),
      width: image.naturalWidth || 0,
      height: image.naturalHeight || 0,
    })),
    stylesheets: Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).map((link) => link.href),
    scripts: Array.from(document.scripts || []).length,
  }))()` , { signal });
  if (!value || typeof value !== "object") throw new Error("Chrome 未返回页面状态");
  return value;
}

async function keepPageActive(cdp, sessionId, signal) {
  await cdp.send("Page.setWebLifecycleState", { state: "active" }, sessionId, { signal, timeoutMs: 5_000 }).catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, { signal, timeoutMs: 5_000 }).catch(() => {});
}

async function settlePage(cdp, sessionId, signal, waitSeconds) {
  const metrics = await evaluate(cdp, sessionId, `(() => {
    const scrollRoot = document.scrollingElement || document.documentElement;
    return {
      maxHeight: Math.min(Math.max(scrollRoot?.scrollHeight || 0, document.body?.scrollHeight || 0), 30000),
      step: Math.max(300, Math.floor((innerHeight || 800) * 0.8)),
    };
  })()`, { signal, timeoutMs: 15_000 });
  let visited = 0;
  for (let y = 0; y < metrics.maxHeight && visited < 40; y += metrics.step, visited += 1) {
    checkAbort(signal);
    await evaluate(cdp, sessionId, `window.scrollTo(0, ${Math.floor(y)})`, { signal, timeoutMs: 10_000 });
    await delay(120, signal);
  }
  await evaluate(cdp, sessionId, "window.scrollTo(0, 0)", { signal, timeoutMs: 10_000 });
  await delay(Math.max(0, waitSeconds) * 1000, signal);
  const rendered = await waitForRenderedContent(cdp, sessionId, signal);
  return { scrollHeight: rendered.scrollHeight || metrics.maxHeight, scrollSteps: visited, rendered };
}

async function waitForRenderedContent(cdp, sessionId, signal) {
  let last = "";
  let stable = 0;
  let scrollHeight = 0;
  for (let round = 0; round < 10; round += 1) {
    checkAbort(signal);
    const sample = await evaluate(cdp, sessionId, `(() => {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
      return (document.body?.innerText || "").length + ":" + (document.documentElement.scrollHeight || 0);
    })()`, { signal, timeoutMs: 10_000 });
    scrollHeight = Number(String(sample).split(":")[1]) || scrollHeight;
    if (sample === last) stable += 1;
    else stable = 0;
    last = String(sample);
    if (stable >= 2) break;
    await delay(500, signal);
  }
  await evaluate(cdp, sessionId, "window.scrollTo(0, 0)", { signal, timeoutMs: 10_000 }).catch(() => {});
  return { scrollHeight, stable };
}

async function expandCarousels(cdp, sessionId, signal) {
  let added = 0;
  for (let step = 0; step < 8; step += 1) {
    checkAbort(signal);
    const clicked = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector(".photo_next, .banner_next, .arrow_next, .jz_next, [class*='btn_next'], [class*='arrow_right'], [class*='next_btn']");
      if (!button) return false;
      button.click();
      return true;
    })()`, { signal, timeoutMs: 10_000 });
    if (!clicked) break;
    await delay(250, signal);
    added += Number(await evaluate(cdp, sessionId, `(() => {
      let count = 0;
      document.querySelectorAll(".photo_display_list, .banner_pic_group").forEach((list) => {
        const active = list.querySelector(".activedPic, .banner_item_actived");
        const id = active?.getAttribute("data-id") || active?.querySelector("[style*='background']")?.style.backgroundImage || "";
        if (!active || !id || list.querySelector("[data-huoqu-slide='" + CSS.escape(id) + "']")) return;
        const copy = active.cloneNode(true);
        copy.setAttribute("data-huoqu-slide", id);
        copy.style.display = "block";
        copy.style.position = "relative";
        list.appendChild(copy);
        count += 1;
      });
      return count;
    })()`, { signal, timeoutMs: 10_000 }) || 0);
  }
  return { added };
}

async function revealHiddenSections(cdp, sessionId, signal) {
  const info = await evaluate(cdp, sessionId, `(() => ({
    sliders: document.querySelectorAll(".swiper-container, .swiper").length,
    hasFullpage: Boolean(window.fullpage_api && typeof window.fullpage_api.moveSectionDown === "function"),
  }))()`, { signal, timeoutMs: 15_000 });
  let advanced = 0;
  const sliders = Math.min(Number(info?.sliders) || 0, 8);
  for (let slider = 0; slider < sliders; slider += 1) {
    const total = Number(await evaluate(cdp, sessionId, `(() => {
      const el = document.querySelectorAll(".swiper-container, .swiper")[${slider}];
      return Math.min(el?.swiper?.slides?.length || 0, 8);
    })()`, { signal, timeoutMs: 10_000 })) || 0;
    for (let index = 0; index < total; index += 1) {
      checkAbort(signal);
      await evaluate(cdp, sessionId, `(() => {
        const el = document.querySelectorAll(".swiper-container, .swiper")[${slider}];
        try { el?.swiper?.slideTo?.(${index}, 0); } catch { /* ignore a slider that rejects this index */ }
      })()`, { signal, timeoutMs: 10_000 });
      advanced += 1;
      await delay(40, signal);
    }
  }
  if (info?.hasFullpage) {
    for (let index = 0; index < 8; index += 1) {
      checkAbort(signal);
      const moved = await evaluate(cdp, sessionId, `(() => {
        try { window.fullpage_api.moveSectionDown(); return true; } catch { return false; }
      })()`, { signal, timeoutMs: 10_000 });
      if (!moved) break;
      advanced += 1;
      await delay(80, signal);
    }
  }
  return { sliders, advanced };
}

async function readDocumentHtml(cdp, sessionId, signal) {
  const length = Number(await evaluate(cdp, sessionId, "document.documentElement.outerHTML.length", { signal, timeoutMs: 15_000 })) || 0;
  if (length <= 350_000) {
    return String(await evaluate(cdp, sessionId, "document.documentElement.outerHTML", { signal, timeoutMs: 20_000 }) || "");
  }
  const chunks = [];
  const size = 180_000;
  for (let offset = 0; offset < length; offset += size) {
    checkAbort(signal);
    const part = await evaluate(cdp, sessionId, `document.documentElement.outerHTML.slice(${offset}, ${offset + size})`, { signal, timeoutMs: 15_000 });
    chunks.push(String(part || ""));
  }
  return chunks.join("");
}

function pageBox(page, fallback = { width: 1440, height: 1000 }) {
  const width = Math.max(1, Math.min(Math.ceil(page?.document?.width || page?.viewport?.width || fallback.width), 3840));
  const rawHeight = Math.max(1, Math.ceil(page?.document?.height || page?.viewport?.height || fallback.height));
  const height = Math.min(rawHeight, 16000);
  return { width, height, truncated: rawHeight > height };
}

async function screenshot(cdp, sessionId, signal, box) {
  const clip = {
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
    scale: 1,
  };
  let result;
  try {
    result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip,
    }, sessionId, { signal, timeoutMs: 60_000 });
  } catch {
    checkAbort(signal);
    result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }, sessionId, { signal, timeoutMs: 30_000 });
  }
  const bytes = Buffer.from(String(result.data || ""), "base64");
  if (!bytes.length) throw new Error("Chrome returned an empty screenshot");
  return bytes;
}

async function navigate(cdp, sessionId, url, signal, timeoutMs = 60_000) {
  const waiting = new AbortController();
  const loaded = cdp.waitForEvent("Page.loadEventFired", {
    timeoutMs, signal: signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal, sessionId,
  });
  loaded.catch(() => {}); // Navigation may reject before its load-event promise is awaited.
  try {
    const result = await cdp.send("Page.navigate", { url }, sessionId, { signal, timeoutMs });
    if (result.errorText) throw new Error(`页面导航失败：${result.errorText}`);
    await loaded;
  } finally {
    waiting.abort();
  }
}

async function assertCaptureOwnership(outputDir, existing) {
  const unexpected = unexpectedOutputEntries(existing);
  if (unexpected.length) throw new Error(`输出目录里有其他文件，已拒绝覆盖：${outputDir}（${unexpected.join(", ")}）`);
  const entries = captureOutputEntries(existing);
  if (!entries.length) return entries;
  for (const name of entries) {
    const info = await lstat(path.join(outputDir, name));
    if (info.isSymbolicLink() || (name === "assets" ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`输出文件归属检查失败，拒绝覆盖：${name}`);
    }
  }
  try {
    for (const name of ["manifest.json", "report.json"]) {
      if ((await lstat(path.join(outputDir, name))).size > 1024 * 1024) throw new Error("metadata too large");
    }
    const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
    const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
    if (!isHttpUrl(manifest.sourceUrl) || manifest.sourceUrl !== report.source?.url
      || !Array.isArray(manifest.resources) || !report.capturedAt
      || report.localCopy?.htmlPath !== "index.html" || report.archive?.path !== "index.mhtml"
      || !["passed", "partial"].includes(report.offlineValidation?.result)
      || !entries.includes("index.html") || !entries.includes("index.mhtml")
      || (manifest.producer != null && (manifest.producer !== "huoqu" || manifest.formatVersion !== 1))) {
      throw new Error("metadata does not describe a huoqu capture");
    }
    const ownedAssets = new Set();
    for (const resource of manifest.resources) {
      if (typeof resource.path !== "string" || !/^assets\/[^/\\]+$/.test(resource.path)
        || resource.path.endsWith("/.") || resource.path.endsWith("/..")) throw new Error("invalid resource ownership path");
      ownedAssets.add(resource.path.slice("assets/".length));
    }
    if (entries.includes("assets")) {
      for (const name of await readdir(path.join(outputDir, "assets"))) {
        const info = await lstat(path.join(outputDir, "assets", name));
        if (!info.isFile() || info.isSymbolicLink() || !ownedAssets.has(name)) {
          throw new Error(`assets/${name} is not an owned regular resource file`);
        }
      }
    }
  } catch (error) {
    throw new Error(`输出目录无法确认归属 huoqu，已拒绝覆盖：${outputDir}（${error.message}）`);
  }
  return entries;
}

export async function createOutputStage(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const info = await lstat(outputDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("output_dir must be a real directory, not a symlink or file");
  const existing = await readdir(outputDir);
  await assertCaptureOwnership(outputDir, existing);
  return mkdtemp(path.join(outputDir, `.huoqu-staging-${process.pid}-`));
}

async function writeMhtmlBundle(stageDir, mhtml, materialized, metadata) {
  const assetsDir = path.join(stageDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(stageDir, "index.mhtml"), mhtml, "utf8");
  await writeFile(path.join(stageDir, "index.html"), materialized.html, "utf8");
  for (const asset of materialized.assets) {
    await writeFile(path.join(assetsDir, asset.name), asset.bytes);
  }

  const readme = [
    `# ${metadata.title || "网页离线副本"}`,
    "",
    `- 来源：${metadata.url}`,
    `- 页面范围：整页（布局宽度 ${metadata.width}，文档高度 ${metadata.pageHeight || metadata.height}）`,
    "- 本地入口：`index.html`（后渲染 HTML + 本地化资源）",
    "- 单文件离线副本：`index.mhtml`（MHTML，包含静态 HTML 与资源）",
    "- 离线验证：以 `report.json` 中的结果为准",
    "- 截图：`source.png`（来源页）、`local.png`（离线 HTML）、`archive-preview.png`（MHTML 归档预览，如支持）",
    "- 资源目录：`assets/`",
    "",
    "## 说明",
    "`index.html` 保存当前访问状态的 DOM 与本地化资源，并保留原页面脚本以支持可离线运行的组件；原站 API、登录状态和服务端交互不会被复制。站内导航链接仍指向原站。",
    "`index.mhtml` 将 HTML、脚本与本地资源封装为单文件归档，可在 Chrome 中离线打开；脚本依赖远端服务的功能仍无法离线运行。",
    "捕获的是当前 URL 滚动加载后的整页，不按窗口高度裁切。由脚本切换、尚未进入文档流或被站点策略拦截的内容可能缺失。检查 `report.json`。",
    "",
  ].join("\n");
  await writeFile(path.join(stageDir, "README.md"), readme, "utf8");
}

export async function finalizeStage(stageDir, outputDir) {
  const stageName = path.basename(stageDir);
  const existing = (await readdir(outputDir)).filter((name) => name !== stageName);
  const replaceable = await assertCaptureOwnership(outputDir, existing);
  const trash = path.join(outputDir, `.huoqu-replaced-${process.pid}-${Date.now()}`);
  const moved = [];
  const promoted = [];
  try {
    if (replaceable.length) await mkdir(trash);
    for (const name of replaceable) {
      await rename(path.join(outputDir, name), path.join(trash, name));
      moved.push(name);
    }
    for (const name of await readdir(stageDir)) {
      await rename(path.join(stageDir, name), path.join(outputDir, name));
      promoted.push(name);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const name of promoted.reverse()) {
      try { await rm(path.join(outputDir, name), { recursive: true, force: true }); }
      catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    }
    for (const name of moved.reverse()) {
      try { await rename(path.join(trash, name), path.join(outputDir, name)); }
      catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    }
    if (recoveryErrors.length) {
      throw new Error(`${error.message}；回滚失败，旧文件保留于 ${trash}：${recoveryErrors.join("；")}`, { cause: error });
    }
    if (replaceable.length) await rm(trash, { recursive: true, force: true });
    throw error;
  }
  // All new files are installed. Cleanup failures must never restore a partially deleted backup.
  await rm(stageDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  if (replaceable.length) await rm(trash, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

async function waitForNetworkQuiet(cdp, sessionId, networkState, signal) {
  const started = Date.now();
  const maxWaitMs = 10_000;
  while (Date.now() - started < maxWaitMs) {
    checkAbort(signal);
    if (networkState.pending.size === 0 && Date.now() - networkState.lastActivity >= 1_200) break;
    await delay(200, signal);
  }
  if (networkState.pending.size > 0) {
    networkState.warnings.push(`${networkState.pending.size} 个请求在等待窗口结束时仍未完成`);
  }
  return cdp;
}

export async function capturePage(input, signal) {
  const options = normalizeCaptureOptions(input);
  if (OUTPUT_LOCKS.has(options.outputDir)) throw new Error(`another capture is already writing to ${options.outputDir}`);
  OUTPUT_LOCKS.add(options.outputDir);
  let chrome;
  let stageDir;
  let finalized = false;
  let targetId = "";
  let sessionId = "";
  const warnings = [];
  const networkState = { pending: new Set(), requestUrls: new Map(), lastActivity: Date.now(), failures: [], warnings };
  let stopNetworkEvents = null;

  try {
    checkAbort(signal);
    stageDir = await createOutputStage(options.outputDir);
    chrome = await openBrowser(signal);
    const { cdp } = chrome;

    const target = await cdp.send("Target.createTarget", { url: "about:blank" }, undefined, { signal });
    targetId = target.targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, { signal });
    sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId, { signal });
    await cdp.send("Runtime.enable", {}, sessionId, { signal });
    await cdp.send("Network.enable", { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 20_000_000 }, sessionId, { signal });
    if (chrome.userAgent) {
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: chrome.userAgent,
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
        platform: "MacIntel",
      }, sessionId, { signal });
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId, { signal });
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId, { signal }).catch(() => {});
    await keepPageActive(cdp, sessionId, signal);

    stopNetworkEvents = cdp.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === "Network.requestWillBeSent") {
        const requestId = event.params?.requestId;
        if (requestId) {
          networkState.pending.add(requestId);
          networkState.requestUrls.set(requestId, String(event.params?.request?.url || ""));
        }
        networkState.lastActivity = Date.now();
      } else if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") {
        const requestId = event.params?.requestId;
        networkState.pending.delete(requestId);
        networkState.lastActivity = Date.now();
        if (event.method === "Network.loadingFailed") {
          networkState.failures.push({
            url: networkState.requestUrls.get(requestId) || "",
            error: event.params?.errorText || "request failed",
            blockedReason: event.params?.blockedReason || "",
          });
        }
        networkState.requestUrls.delete(requestId);
      }
    });

    const sourceWaiting = new AbortController();
    const pageLoaded = cdp.waitForEvent("Page.loadEventFired", {
      timeoutMs: 60_000, signal: signal ? AbortSignal.any([signal, sourceWaiting.signal]) : sourceWaiting.signal, sessionId,
    });
    pageLoaded.catch(() => {});
    try {
      const navigation = await cdp.send("Page.navigate", { url: options.url }, sessionId, { signal, timeoutMs: 60_000 });
      if (navigation.errorText) throw new Error(`页面导航失败：${navigation.errorText}`);
      try {
        await pageLoaded;
      } catch (error) {
        checkAbort(signal);
        warnings.push(`等待 load 事件超时：${error.message}`);
      }
    } finally {
      sourceWaiting.abort();
    }
    await waitForNetworkQuiet(cdp, sessionId, networkState, signal);
    await keepPageActive(cdp, sessionId, signal);
    const scrollResult = await settlePage(cdp, sessionId, signal, options.waitSeconds);
    const revealed = await revealHiddenSections(cdp, sessionId, signal);
    const carousels = await expandCarousels(cdp, sessionId, signal);
    await waitForNetworkQuiet(cdp, sessionId, networkState, signal);
    const unfolded = { skipped: true };
    const sourcePage = await pageSummary(cdp, sessionId, signal);
    const blocked = blockedPageMessage(sourcePage);
    if (blocked) {
      const hint = chrome.mode === "extension"
        ? blocked
        : `${blocked}。当前走的是无头 Chrome；请打开已安装 DSH 扩展的正式 Chrome 后重试。`;
      throw new Error(hint);
    }
    if (sourcePage.document.htmlBytes < 1000 || sourcePage.document.textLength < 20) {
      throw new Error(`目标页面未加载出可用内容（HTML ${sourcePage.document.htmlBytes} 字符，文本 ${sourcePage.document.textLength} 字符）`);
    }
    if (sourcePage.url && new URL(sourcePage.url).protocol !== "http:" && new URL(sourcePage.url).protocol !== "https:") {
      throw new Error(`导航最终落在非网页地址：${sourcePage.url}`);
    }

    const sourceBox = pageBox(sourcePage, options);
    if (sourceBox.truncated) warnings.push("页面高于 16000px，截图只保存了前 16000px；HTML 副本仍包含完整文档");
    if (chrome.fallbackReason) warnings.push(`正式 Chrome 扩展不可用，已改用无头 Chrome：${chrome.fallbackReason}`);
    let sourceShot;
    try {
      sourceShot = await screenshot(cdp, sessionId, signal, sourceBox);
    } catch (error) {
      checkAbort(signal);
      warnings.push(`整页截图未通过扩展通道（${error.message}），已改存当前窗口截图`);
      sourceShot = await screenshot(cdp, sessionId, signal, { width: options.width, height: options.height, truncated: false });
    }
    await writeFile(path.join(stageDir, "source.png"), sourceShot);
    let capturedMhtml = "";
    if (chrome.mode !== "extension") {
      try {
        const archive = await cdp.send("Page.captureSnapshot", { format: "mhtml" }, sessionId, { signal, timeoutMs: 120_000 });
        capturedMhtml = String(archive.data || "");
      } catch (error) {
        checkAbort(signal);
        warnings.push(`浏览器单文件快照失败（${error.message}），已改用页面 HTML 继续本地化资源`);
      }
    }
    if (capturedMhtml.length < 1000) {
      const html = await readDocumentHtml(cdp, sessionId, signal);
      capturedMhtml = htmlToMhtml(html, sourcePage.url || options.url);
    }
    const capturedMhtmlBytes = Buffer.byteLength(capturedMhtml, "utf8");
    if (!capturedMhtml || capturedMhtmlBytes < 1000) throw new Error("Chrome 未生成有效的页面归档");
    if (capturedMhtmlBytes > MAX_MHTML_BYTES) throw new Error(`MHTML 归档超过 ${MAX_MHTML_BYTES / 1024 / 1024} MB 上限，未写入输出目录`);
    const initialMaterialization = materializeMhtml(capturedMhtml);
    if (initialMaterialization.html.length < 1000) {
      throw new Error("MHTML 解析没有提取到有效页面 HTML，拒绝报告成功");
    }
    const completedAssets = await completeExternalResources(capturedMhtml, initialMaterialization, sourcePage.url || options.url, signal);
    const materialized = completedAssets.materialized;
    if (completedAssets.failures.length) {
      warnings.push(`${completedAssets.failures.length} 项 CSS/素材引用未能下载或仍未本地化；详见 report.json`);
    }
    if (materialized.externalReferences.length) {
      warnings.push(`仍有 ${materialized.externalReferences.length} 个资源引用指向远端，离线副本不完整`);
    }
    const offlineComplete = materialized.externalReferences.length === 0;

    const title = String(sourcePage.title || "网页离线副本").trim();
    const metadata = {
      url: sourcePage.url || options.url,
      title,
      width: sourcePage.document?.width || options.width,
      height: sourcePage.document?.height || options.height,
      pageHeight: sourcePage.document?.height || options.height,
    };
    const mhtml = buildMhtml(materialized, metadata.url);
    const mhtmlBytes = Buffer.byteLength(mhtml, "utf8");
    if (!mhtml || mhtmlBytes < 1000) throw new Error("组装后的离线 MHTML 归档为空");
    if (mhtmlBytes > MAX_MHTML_BYTES) throw new Error(`MHTML 归档超过 ${MAX_MHTML_BYTES / 1024 / 1024} MB 上限，未写入输出目录`);
    await writeMhtmlBundle(stageDir, mhtml, materialized, metadata);

    let localPage = null;
    let archivePage = null;
    let localNetworkFailures = [];
    let archiveNetworkFailures = [];
    const localIssues = [];
    const archiveIssues = [];
    let localScreenshotSaved = false;
    let archiveScreenshotSaved = false;
    let networkOffline = false;
    const localFailureStart = networkState.failures.length;
    try {
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId, { signal });
      await cdp.send("Network.setBypassServiceWorker", { bypass: true }, sessionId, { signal });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
        connectionType: "none",
      }, sessionId, { signal });
      networkOffline = true;
      await navigate(cdp, sessionId, fileUrl(path.join(stageDir, "index.html")), signal, 30_000);
      await delay(700, signal);
      await waitForNetworkQuiet(cdp, sessionId, networkState, signal);
      localPage = await pageSummary(cdp, sessionId, signal);
      localIssues.push(...offlinePreviewIssues(localPage, "index.html"));
      if (networkState.pending.size) localIssues.push(`index.html 有 ${networkState.pending.size} 个资源请求尚未完成`);
      const localShot = await screenshot(cdp, sessionId, signal, pageBox(localPage, options));
      await writeFile(path.join(stageDir, "local.png"), localShot);
      localScreenshotSaved = true;
    } catch (error) {
      checkAbort(signal);
      localIssues.push(`本地 index.html 自动预览失败：${error.message}`);
    }
    localNetworkFailures = networkState.failures.slice(localFailureStart);
    if (localNetworkFailures.length) localIssues.push(`index.html 离线预览有 ${localNetworkFailures.length} 项资源加载失败；详见 report.json`);

    const archiveFailureStart = networkState.failures.length;
    try {
      if (!networkOffline) throw new Error("未能启用断网模式，不能验收离线 MHTML");
      await navigate(cdp, sessionId, fileUrl(path.join(stageDir, "index.mhtml")), signal, 30_000);
      await delay(500, signal);
      await waitForNetworkQuiet(cdp, sessionId, networkState, signal);
      archivePage = await pageSummary(cdp, sessionId, signal);
      archiveIssues.push(...offlinePreviewIssues(archivePage, "index.mhtml"));
      if (networkState.pending.size) archiveIssues.push(`index.mhtml 有 ${networkState.pending.size} 个资源请求尚未完成`);
      const archiveShot = await screenshot(cdp, sessionId, signal, pageBox(archivePage, options));
      await writeFile(path.join(stageDir, "archive-preview.png"), archiveShot);
      archiveScreenshotSaved = true;
    } catch (error) {
      checkAbort(signal);
      archiveIssues.push(`MHTML 本地预览未通过：${error.message}`);
    }
    archiveNetworkFailures = networkState.failures.slice(archiveFailureStart);
    if (archiveNetworkFailures.length) archiveIssues.push(`index.mhtml 离线预览有 ${archiveNetworkFailures.length} 项资源加载失败；详见 report.json`);
    warnings.push(...localIssues, ...archiveIssues);
    const validationPassed = offlineComplete && networkOffline && Boolean(localPage && archivePage)
      && localScreenshotSaved && archiveScreenshotSaved && !localIssues.length && !archiveIssues.length;
    checkAbort(signal);

    const report = {
      status: validationPassed ? "completed" : "partial",
      source: metadata,
      capturedAt: new Date().toISOString(),
      browser: {
        engine: chrome.mode === "extension" ? "Google Chrome via DSH extension" : "Google Chrome headless",
        viewport: sourcePage.viewport,
      },
      sourcePage: {
        finalUrl: sourcePage.url,
        title,
        document: sourcePage.document,
        imageCount: sourcePage.images.length,
        loadedImageCount: sourcePage.images.filter((image) => image.loaded).length,
        stylesheetCount: sourcePage.stylesheets.length,
        scriptCountAtCapture: sourcePage.scripts,
      },
      scroll: { ...scrollResult, revealed, carousels, unfolded },
      archive: {
        path: "index.mhtml",
        bytes: mhtmlBytes,
        mimeParts: materialized.assets.length + 1,
        sourceBrowserSnapshotBytes: capturedMhtmlBytes,
      },
      assetCompletion: {
        additionalResourcesDownloaded: completedAssets.resources.length,
        additionalResourceBytes: completedAssets.totalBytes,
        externalResourceReferences: materialized.externalReferences,
        fetchFailures: completedAssets.failures,
      },
      localCopy: {
        htmlPath: "index.html",
        htmlBytes: Buffer.byteLength(materialized.html, "utf8"),
        assetCount: materialized.resourceCount,
        assetBytes: materialized.assets.reduce((sum, asset) => sum + asset.bytes.length, 0),
        preview: localPage ? {
          title: localPage.title,
          url: localPage.url,
          document: localPage.document,
          imageCount: localPage.images.length,
          loadedImageCount: localPage.images.filter((image) => image.loaded).length,
        } : null,
      },
      offlineValidation: {
        networkEmulation: networkOffline ? "offline" : "failed",
        networkFailures: localNetworkFailures.slice(0, 100),
        archiveNetworkFailures: archiveNetworkFailures.slice(0, 100),
        htmlIssues: localIssues,
        archiveIssues,
        result: validationPassed ? "passed" : "partial",
      },
      archivePreview: archivePage ? {
        title: archivePage.title,
        url: archivePage.url,
        document: archivePage.document,
      } : null,
      screenshots: {
        source: "source.png",
        local: localScreenshotSaved ? "local.png" : null,
        archive: archiveScreenshotSaved ? "archive-preview.png" : null,
      },
      networkFailures: networkState.failures.filter((failure) => !localNetworkFailures.includes(failure) && !archiveNetworkFailures.includes(failure)).slice(0, 100),
      warnings,
      limitations: [
        "这是指定 URL 滚动加载后的整页快照，不按窗口高度裁切；不会复制服务端、API 数据、登录态或所有交互状态。",
        "index.html 和 index.mhtml 保留 DOM、原页面脚本、CSS 与本次本地化素材；依赖远端 API 或服务的脚本功能无法离线运行。",
        "超过限制、无法访问或被站点策略拦截的内容不会自动补齐；若离线检查未通过，状态标为 partial。",
      ],
    };
    await writeFile(path.join(stageDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(stageDir, "manifest.json"), `${JSON.stringify({
      producer: "huoqu",
      formatVersion: 1,
      sourceUrl: metadata.url,
      title,
      viewport: { width: options.width, height: options.height },
      resources: materialized.assets.map((asset) => ({ path: `assets/${asset.name}`, mime: asset.mime, bytes: asset.bytes.length, source: asset.url })),
      externalResourceReferences: materialized.externalReferences,
    }, null, 2)}\n`, "utf8");

    stopNetworkEvents?.();
    stopNetworkEvents = null;
    checkAbort(signal);
    await finalizeStage(stageDir, options.outputDir);
    finalized = true;

    return {
      ok: validationPassed,
      status: validationPassed ? "completed" : "partial",
      url: metadata.url,
      title,
      outputDir: options.outputDir,
      indexHtml: path.join(options.outputDir, "index.html"),
      archiveMhtml: path.join(options.outputDir, "index.mhtml"),
      sourceScreenshot: path.join(options.outputDir, "source.png"),
      localScreenshot: localScreenshotSaved ? path.join(options.outputDir, "local.png") : "",
      archivePreview: archiveScreenshotSaved ? path.join(options.outputDir, "archive-preview.png") : "",
      assetCount: materialized.resourceCount,
      assetBytes: materialized.assets.reduce((sum, asset) => sum + asset.bytes.length, 0),
      additionalResourcesDownloaded: completedAssets.resources.length,
      mhtmlBytes,
      sourceViewport: sourcePage.viewport,
      sourcePage: sourcePage.document,
      localPage: localPage?.document || {},
      externalResourceReferences: materialized.externalReferences.length,
      resourceFetchFailures: completedAssets.failures.length,
      networkFailures: networkState.failures.length - localNetworkFailures.length - archiveNetworkFailures.length,
      offlineNetworkFailures: localNetworkFailures.length + archiveNetworkFailures.length,
      warnings,
    };
  } catch (error) {
    if (!finalized && stageDir) await rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    throw error;
  } finally {
    stopNetworkEvents?.();
    if (chrome) {
      const { cdp } = chrome;
      if (targetId) await cdp.send("Target.closeTarget", { targetId }, undefined, { timeoutMs: 3_000 }).catch(() => {});
      await stopChrome(chrome).catch((error) => {
        const warning = `Chrome 采集会话清理失败：${error.message}`;
        warnings.push(warning);
        console.error(`[huoqu] ${warning}`);
      });
    }
    OUTPUT_LOCKS.delete(options.outputDir);
  }
}
