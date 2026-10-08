import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMhtml, htmlToMhtml, materializeMhtml, omitMissingReferences, parseMhtml } from "./archive.js";
import { blockedPageMessage, captureOutputEntries, isHttpUrl, normalizeCaptureOptions, offlinePreviewIssues, unexpectedOutputEntries } from "./parse.js";

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_MHTML_BYTES = 100 * 1024 * 1024;
const MAX_EXTRA_RESOURCE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRA_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRA_RESOURCE_COUNT = 120;
const OUTPUT_LOCKS = new Set();

// A capture-local policy wrapper: every output mutation is checked immediately
// before touching disk, including both rename endpoints and recovery cleanup.
function guardedOutputFs(access) {
  const guarded = (operation, paths) => async (...args) => {
    await access?.assertWrite(...paths(args));
    return operation(...args);
  };
  return {
    mkdir: guarded(mkdir, ([target]) => [target]),
    mkdtemp: guarded(mkdtemp, ([prefix]) => [prefix]),
    writeFile: guarded(writeFile, ([target]) => [target]),
    rename: guarded(rename, ([from, to]) => [from, to]),
    rm: guarded(rm, ([target]) => [target]),
  };
}

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
  // WHATWG URL canonicalizes dotted IPv4-mapped literals to hexadecimal IPv6.
  if (net.isIP(value) === 6) {
    value = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      value = [high >> 8, high & 255, low >> 8, low & 255].join(".");
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

async function readResponseLimited(response, maxBytes, budget) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      const budgetExceeded = budget && chunk.length > budget.remaining;
      // Failed/oversized downloads also consume the shared budget. Never keep
      // fetching after an oversized chunk exhausts it (up to five are in flight).
      if (budget) budget.remaining = Math.max(0, budget.remaining - chunk.length);
      if (total > maxBytes || budgetExceeded) {
        await reader.cancel().catch(() => {});
        throw new Error(total > maxBytes ? `resource exceeds ${maxBytes} byte limit` : "extra resource download byte budget exhausted");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function resourceByteLimit(mime, url) {
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  const pathName = String(url || "").toLowerCase().split("?")[0].split("#")[0];
  if (type.startsWith("video/") || type.startsWith("audio/") || /\.(?:mp4|webm|m4v|mov|mp3|ogg|wav|m4a)$/.test(pathName)) {
    return MAX_MEDIA_RESOURCE_BYTES;
  }
  return MAX_EXTRA_RESOURCE_BYTES;
}

async function savedLocalFile(url) {
  if (!String(url || "").startsWith("file:")) return false;
  try {
    const info = await lstat(fileURLToPath(String(url).split("#")[0]));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function withoutSavedFileRejections(failures) {
  const blocking = [];
  let ignored = 0;
  for (const failure of failures) {
    if (await savedLocalFile(failure.url)) ignored += 1;
    else blocking.push(failure);
  }
  return { blocking, ignored };
}

async function fetchExtraResource(rawUrl, sourceOrigin, signal, budget) {
  const original = new URL(rawUrl);
  if (original.protocol !== "http:" && original.protocol !== "https:") throw new Error("unsupported resource protocol");
  let current = original;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    checkAbort(signal);
    if (budget && budget.remaining <= 0) throw new Error("extra resource download byte budget exhausted");
    if (!["http:", "https:"].includes(current.protocol)) throw new Error("unsupported resource redirect protocol");
    if (current.username || current.password) throw new Error("resource URL must not contain credentials");
    await assertAllowedResource(current, sourceOrigin);
    const timeout = AbortSignal.timeout(resourceByteLimit("", current.href) > MAX_EXTRA_RESOURCE_BYTES ? 60_000 : 15_000);
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
    const declaredLimit = resourceByteLimit(response.headers.get("content-type"), current.href);
    const limit = Math.min(declaredLimit, budget?.remaining ?? declaredLimit);
    if (length > limit) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`resource exceeds ${limit} byte limit`);
    }
    const bytes = await readResponseLimited(response, limit, budget);
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
  const budget = { remaining: MAX_EXTRA_TOTAL_BYTES };
  let totalBytes = 0;
  let requestCount = 0;

  for (let round = 0; round < 4 && attempted.size < MAX_EXTRA_RESOURCE_COUNT && budget.remaining > 0; round += 1) {
    const pending = [];
    for (const reference of materialized.externalReferences) {
      if (attempted.size >= MAX_EXTRA_RESOURCE_COUNT) break;
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
      const remainingBytes = budget.remaining;
      const remainingCount = MAX_EXTRA_RESOURCE_COUNT - requestCount;
      if (remainingBytes <= 0 || remainingCount <= 0) break;
      // Shrink concurrency near the shared budget limit; every chunk, including
      // failed/oversized reads, is charged by readResponseLimited.
      const batchSize = Math.min(5, remainingCount, Math.max(1, Math.floor(remainingBytes / MAX_EXTRA_RESOURCE_BYTES)));
      const batch = pending.slice(offset, offset + batchSize);
      offset += batch.length;
      requestCount += batch.length;
      const results = await Promise.all(batch.map(async (url) => {
        try { return { url, value: await fetchExtraResource(url, new URL(sourceUrl).origin, signal, budget) }; }
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
  const missing = failures.filter((failure) => /^HTTP (?:404|410)$/.test(failure.error)).map((failure) => failure.url);
  if (missing.length) materialized = omitMissingReferences(materialized, missing);
  if (materialized.externalReferences.length) {
    if (requestCount >= MAX_EXTRA_RESOURCE_COUNT) {
      failures.push({ url: "", error: `extra resources reached ${MAX_EXTRA_RESOURCE_COUNT} request limit` });
    }
    if (budget.remaining <= 0) {
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

async function openChrome({ signal, access }) {
  const { mkdtemp } = guardedOutputFs(access);
  if (typeof WebSocket !== "function") throw new Error("当前 DSH Host Node 不支持 WebSocket，无法连接本地 Chrome DevTools");
  const binary = await chromePath();
  const profile = await mkdtemp(path.join(os.tmpdir(), "dsh-huoqu-chrome-"));
  let child;
  let startupError;
  try {
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
      "--lang=zh-CN",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ];
    if (process.platform === "linux") args.push("--disable-dev-shm-usage");
    child = spawn(binary, args, { stdio: "ignore", detached: process.platform !== "win32" });
    // Attach synchronously: failed spawn emits error on a later tick without a PID.
    // Keep the listener through shutdown so a late process error cannot crash Host.
    child.on("error", (error) => { startupError ??= error; });
    let endpoint;
    for (let i = 0; i < 100; i += 1) {
      checkAbort(signal);
      if (startupError) throw startupError;
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error(`Chrome exited before starting DevTools (code ${child.exitCode}, signal ${child.signalCode})`);
      }
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
    if (startupError) throw startupError;
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
    return { mode: "headless", cdp, child, profile, userAgent, access, close: async () => {} };
  } catch (error) {
    try { await stopChrome({ child, cdp: null, profile, access }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message}; Chrome 启动清理失败：${cleanupError.message}`, { cause: error });
    }
    throw error;
  }
}

async function openBrowser(signal, access) {
  try {
    const mod = await import("../../chrome/lib/browser.js");
    if (typeof mod.openCaptureSession !== "function") throw new Error("Chrome 插件没有提供正式浏览器采集入口");
    return await mod.openCaptureSession(signal);
  } catch (error) {
    checkAbort(signal);
    const headless = await openChrome({ signal, access });
    headless.fallbackReason = error instanceof Error ? error.message : String(error);
    return headless;
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function stopChrome(chrome = {}) {
  const { rm } = guardedOutputFs(chrome.access);
  if (chrome.mode === "extension") {
    await chrome.close?.();
    return;
  }
  const { child, cdp, profile } = chrome;
  const failures = [];
  try { await cdp?.close(); } catch (error) { failures.push(error); }
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
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
      } catch {
        try { child.kill("SIGKILL"); } catch { /* checked below */ }
      }
      await waitForExit(child, 2_000);
    }
  }
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    failures.push(new Error(`Chrome 进程退出超时（PID ${child.pid || "unknown"}）；保留 profile：${profile || "unknown"}`));
  } else if (profile) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); }
    catch (error) { failures.push(new Error(`Chrome profile 清理失败，保留于 ${profile}：${error.message}`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join("; "), { cause: failures[0] });
}

async function evaluate(cdp, sessionId, expression, { signal, timeoutMs = 30_000 } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
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

async function readDocumentHtml(cdp, sessionId, signal) {
  // outerHTML excludes the declaration; preserve the source's document mode,
  // including legacy declarations and pages intentionally lacking a DOCTYPE.
  const serialized = "((document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML)";
  const length = Number(await evaluate(cdp, sessionId, `${serialized}.length`, { signal, timeoutMs: 15_000 })) || 0;
  if (length <= 350_000) {
    return String(await evaluate(cdp, sessionId, serialized, { signal, timeoutMs: 20_000 }) || "");
  }
  const chunks = [];
  const size = 180_000;
  for (let offset = 0; offset < length; offset += size) {
    checkAbort(signal);
    const part = await evaluate(cdp, sessionId, `${serialized}.slice(${offset}, ${offset + size})`, { signal, timeoutMs: 15_000 });
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

async function paintOffscreen(cdp, sessionId, signal) {
  // Full-page capture misses layers that were never composited. Scroll the
  // saved page once so images and transformed cards paint before the screenshot.
  let metrics;
  try {
    metrics = await evaluate(cdp, sessionId, `(() => {
      for (const image of document.images || []) image.loading = "eager";
      const scrollRoot = document.scrollingElement || document.documentElement;
      return {
        maxHeight: Math.min(Math.max(scrollRoot?.scrollHeight || 0, document.body?.scrollHeight || 0), 16000),
        step: Math.max(400, Math.floor((innerHeight || 800) * 0.85)),
      };
    })()`, { signal, timeoutMs: 10_000 });
  } catch {
    return;
  }
  if (!metrics || typeof metrics.maxHeight !== "number" || typeof metrics.step !== "number") return;
  let visited = 0;
  for (let y = 0; y < metrics.maxHeight && visited < 24; y += metrics.step, visited += 1) {
    checkAbort(signal);
    await evaluate(cdp, sessionId, `window.scrollTo(0, ${Math.floor(y)})`, { signal, timeoutMs: 10_000 }).catch(() => {});
    await delay(60, signal);
  }
  await evaluate(cdp, sessionId, "window.scrollTo(0, 0)", { signal, timeoutMs: 10_000 }).catch(() => {});
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

export async function createOutputStage(outputDir, access) {
  const { mkdir, mkdtemp } = guardedOutputFs(access);
  await mkdir(outputDir, { recursive: true });
  const info = await lstat(outputDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("output_dir must be a real directory, not a symlink or file");
  const existing = await readdir(outputDir);
  await assertCaptureOwnership(outputDir, existing);
  return mkdtemp(path.join(outputDir, `.huoqu-staging-${process.pid}-`));
}

async function writeMhtmlBundle(stageDir, mhtml, materialized, metadata, access) {
  const { mkdir, writeFile } = guardedOutputFs(access);
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
    "`index.html` 保存当前访问状态的静态 DOM 与本地化资源；脚本、事件处理器和嵌入活动内容已移除，不保留原站交互。站内导航链接仍指向原站。",
    "`index.mhtml` 将静态 HTML 与本地资源封装为单文件归档，可在 Chrome 中离线打开；不复制登录态、API 或服务端功能。",
    "捕获的是当前 URL 滚动加载后的整页，不按窗口高度裁切。由脚本切换、尚未进入文档流或被站点策略拦截的内容可能缺失。检查 `report.json`。",
    "",
  ].join("\n");
  await writeFile(path.join(stageDir, "README.md"), readme, "utf8");
}

export async function finalizeStage(stageDir, outputDir, access) {
  const { mkdir, rename, rm } = guardedOutputFs(access);
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

export async function capturePage(input, signal, access) {
  const options = normalizeCaptureOptions(input);
  checkAbort(signal);
  await access?.assertWrite(options.outputDir);
  const { writeFile, rm } = guardedOutputFs(access);
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
  let chromeCleanupAttempted = false;
  const releaseChrome = async () => {
    const failures = [];
    const unsubscribe = stopNetworkEvents;
    stopNetworkEvents = null;
    try { unsubscribe?.(); } catch (error) { failures.push(error); }
    if (chrome && !chromeCleanupAttempted) {
      chromeCleanupAttempted = true;
      // The extension does not implement Target.closeTarget; its close() owns
      // the capture tab group and queue, and must finish successfully instead.
      if (targetId) {
        try { await chrome.cdp.send("Target.closeTarget", { targetId }, undefined, { timeoutMs: 3_000 }); }
        catch { /* stopChrome closes the group or terminates the process */ }
      }
      try { await stopChrome(chrome); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `Chrome 采集会话清理失败：${failures.map((error) => error.message).join("; ")}`, { cause: failures[0] });
  };

  try {
    checkAbort(signal);
    stageDir = await createOutputStage(options.outputDir, access);
    chrome = await openBrowser(signal, access);
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
    await waitForNetworkQuiet(cdp, sessionId, networkState, signal);
    const sourcePage = await pageSummary(cdp, sessionId, signal);
    const blocked = blockedPageMessage(sourcePage);
    if (blocked) {
      const hint = chrome.mode === "extension"
        ? blocked
        : `${blocked}。当前走的是无头 Chrome；请打开已安装 DSH 扩展的正式 Chrome 后重试。`;
      throw new Error(hint);
    }
    if (sourcePage.document.textLength < 20) {
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
    if (!capturedMhtml) {
      const html = await readDocumentHtml(cdp, sessionId, signal);
      capturedMhtml = htmlToMhtml(html, sourcePage.url || options.url);
    }
    const capturedMhtmlBytes = Buffer.byteLength(capturedMhtml, "utf8");
    if (!capturedMhtml) throw new Error("Chrome 未生成有效的页面归档");
    if (capturedMhtmlBytes > MAX_MHTML_BYTES) throw new Error(`MHTML 归档超过 ${MAX_MHTML_BYTES / 1024 / 1024} MB 上限，未写入输出目录`);
    // Validate the original HTML before materialization injects charset/CSP metadata.
    if (!parseMhtml(capturedMhtml).main.text?.trim()) {
      throw new Error("MHTML 解析没有提取到有效页面 HTML，拒绝报告成功");
    }
    const initialMaterialization = materializeMhtml(capturedMhtml);
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
    if (!mhtml) throw new Error("组装后的离线 MHTML 归档为空");
    if (mhtmlBytes > MAX_MHTML_BYTES) throw new Error(`MHTML 归档超过 ${MAX_MHTML_BYTES / 1024 / 1024} MB 上限，未写入输出目录`);
    await writeMhtmlBundle(stageDir, mhtml, materialized, metadata, access);

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
    // Never execute captured page code with a local-file origin, including MHTML.
    // Fail closed before either navigation if Chrome cannot disable scripts.
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId, { signal });
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
      await paintOffscreen(cdp, sessionId, signal);
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
    const localSplit = await withoutSavedFileRejections(localNetworkFailures);
    localNetworkFailures = localSplit.blocking;
    if (localNetworkFailures.length) localIssues.push(`index.html 离线预览有 ${localNetworkFailures.length} 项资源加载失败；详见 report.json`);
    if (localSplit.ignored) warnings.push("Chrome 离线模拟拒绝了已保存在本地的文件，直接打开副本不受影响");

    const archiveFailureStart = networkState.failures.length;
    try {
      if (!networkOffline) throw new Error("未能启用断网模式，不能验收离线 MHTML");
      await navigate(cdp, sessionId, fileUrl(path.join(stageDir, "index.mhtml")), signal, 30_000);
      await delay(500, signal);
      await paintOffscreen(cdp, sessionId, signal);
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
    const archiveSplit = await withoutSavedFileRejections(archiveNetworkFailures);
    archiveNetworkFailures = archiveSplit.blocking;
    if (archiveNetworkFailures.length) archiveIssues.push(`index.mhtml 离线预览有 ${archiveNetworkFailures.length} 项资源加载失败；详见 report.json`);
    if (archiveSplit.ignored) warnings.push("Chrome 离线模拟拒绝了已保存在本地的归档资源，直接打开副本不受影响");
    warnings.push(...localIssues, ...archiveIssues);
    const validationPassed = offlineComplete && networkOffline && Boolean(localPage && archivePage)
      && localScreenshotSaved && archiveScreenshotSaved && !localIssues.length && !archiveIssues.length;
    checkAbort(signal);
    // Cleanup is part of capture success, before publishing any success report
    // or replacing a previous archive. A failure here leaves it untouched.
    await releaseChrome();
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
      scroll: scrollResult,
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
        "index.html 和 index.mhtml 是静态 DOM、CSS 与本地化素材快照；脚本和活动嵌入已移除，离线校验禁用 JavaScript，不保留原站交互。",
        "采集仅滚动加载，不点击按钮或调用站点翻页 API；未加载的轮播、隐藏组件和其他交互状态可能缺失。",
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

    checkAbort(signal);
    await finalizeStage(stageDir, options.outputDir, access);
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
    const failures = [error];
    try { await releaseChrome(); } catch (cleanupError) { failures.push(cleanupError); }
    if (!finalized && stageDir) {
      try { await rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (cleanupError) { failures.push(new Error(`临时输出清理失败，保留于 ${stageDir}：${cleanupError.message}`, { cause: cleanupError })); }
    }
    if (failures.length > 1) throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "), { cause: error });
    throw error;
  } finally {
    // Never allow an error from browser or filesystem cleanup to retain a lock.
    OUTPUT_LOCKS.delete(options.outputDir);
  }
}
