import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { capturePage } from "./capture.js";
import { normalizeCaptureOptions } from "./parse.js";
import { createCaptureAccess } from "./permissions.js";

// Chrome is optional. Only a genuinely absent owner module permits headless use;
// syntax errors and failures from the capture itself must remain visible.
async function withCaptureOwner(exec, capture) {
  const ownerUrl = new URL("../../chrome/lib/owner.js", import.meta.url);
  let owner;
  try { owner = await import(ownerUrl.href); }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== ownerUrl.href) throw error;
    return capture();
  }
  return owner.withOwner(exec, capture);
}

export const name = "huoqu";
export const inject = ["tools", "connection", "fs", "sandboxPolicy"];

export const API_PATH = "/api/huoqu";
const JOB_TTL_MS = 60 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 240_000;
const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

// Per-plugin lifetime: no orphaned module-global jobs after unload/reload.
export function createJobManager(run, { timeoutMs = CAPTURE_TIMEOUT_MS, maxPending = 4 } = {}) {
  const jobs = new Map();
  let running = null;
  let disposed = false;
  function prune() {
    const finished = [...jobs.values()].filter((job) => !ACTIVE_STATUSES.has(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of finished) {
      if (job.updatedAt < Date.now() - JOB_TTL_MS || jobs.size > 40) jobs.delete(job.id);
    }
  }
  function summary(job) {
    return { jobId: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
      url: job.options.url, outputDir: job.options.outputDir, result: job.result, error: job.error };
  }
  function abort(job, status, message) {
    if (!ACTIVE_STATUSES.has(job.status) || job.controller.signal.aborted) return;
    job.stopStatus = status;
    job.error = message;
    job.controller.abort(new Error(message));
    job.updatedAt = Date.now();
    if (job.status === "queued") {
      job.status = status;
      clearTimeout(job.timer);
      job.resolve();
    } else job.status = "cancelling"; // Cleanup still owns its slot and Chrome group.
  }
  function pump() {
    if (disposed || running) return;
    const job = [...jobs.values()].find((item) => item.status === "queued");
    if (!job) return;
    running = job;
    job.status = "running";
    job.updatedAt = Date.now();
    Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return run(job.options, job.controller.signal, job.id);
    }).then((result) => {
      job.controller.signal.throwIfAborted();
      job.result = result;
      job.status = result.status === "partial" ? "partial" : "completed";
    }).catch((error) => {
      job.status = job.stopStatus || "failed";
      job.error = errorMessage(error);
    }).finally(() => {
      clearTimeout(job.timer);
      job.updatedAt = Date.now();
      running = null;
      job.resolve();
      prune();
      pump();
    });
  }
  return {
    get(id) { prune(); return jobs.get(id); },
    list() { prune(); return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary); },
    summary,
    start(options) {
      if (disposed) throw Object.assign(new Error("huoqu plugin is stopping"), { status: 503 });
      prune();
      if ([...jobs.values()].filter((job) => ACTIVE_STATUSES.has(job.status)).length >= maxPending) {
        throw Object.assign(new Error(`采集任务已达上限（最多${maxPending}个运行或排队任务），请等待或取消已有任务`), { status: 429 });
      }
      const job = { id: randomUUID(), status: "queued", createdAt: Date.now(), updatedAt: Date.now(),
        options, result: null, error: "", controller: new AbortController() };
      job.promise = new Promise((resolve) => { job.resolve = resolve; });
      // The budget starts at enqueue, not after acquiring the Chrome queue.
      job.timer = setTimeout(() => abort(job, "timed_out", "采集超过总时限，已请求停止并清理浏览器资源"), timeoutMs);
      job.timer.unref?.();
      jobs.set(job.id, job);
      pump();
      return job;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (job) abort(job, "cancelled", "采集已取消");
      return job;
    },
    async dispose() {
      disposed = true;
      for (const job of jobs.values()) abort(job, "cancelled", "插件已卸载，采集已取消");
      await Promise.all([...jobs.values()].map((job) => job.promise));
    },
  };
}

function openNative(targetPath) {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("打开本地预览目前仅支持 macOS；请直接打开返回的本地文件路径"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("open", [targetPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `open exited with ${signal || code}`));
    });
  });
}

function chooseNativeFolder() {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("原生文件夹选择器目前仅支持 macOS；也可手动填写绝对路径"));
  }
  return new Promise((resolve, reject) => {
    const script = 'POSIX path of (choose folder with prompt "选择一个空文件夹作为网页副本输出目录")';
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        if (/user canceled|\(-128\)/i.test(stderr)) {
          resolve({ cancelled: true, path: "" });
        } else {
          reject(new Error(stderr.trim() || `folder picker exited with code ${code}`));
        }
        return;
      }
      const selected = output.trim();
      if (!selected) {
        reject(new Error("文件夹选择器没有返回路径"));
        return;
      }
      resolve({ cancelled: false, path: path.resolve(selected) });
    });
  });
}

async function handleRequest(request, jobs, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const id = String(url.searchParams.get("jobId") || "");
    if (!id) return jsonResponse(200, { ok: true, jobs: jobs.list() });
    const job = jobs.get(id);
    if (!job) return jsonResponse(404, { ok: false, error: "capture job not found or expired" });
    return jsonResponse(200, { ok: true, ...jobs.summary(job) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "request body must be valid JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(400, { ok: false, error: "request body must be an object" });
  if ("sandbox_permissions" in body || "justification" in body) return jsonResponse(400, { ok: false, error: "capture API does not accept permission overrides" });
  const action = String(body.action || "capture");
  if (action === "cancel") {
    const job = jobs.cancel(String(body.jobId || ""));
    if (!job) return jsonResponse(404, { ok: false, error: "capture job not found or expired" });
    return jsonResponse(200, { ok: true, ...jobs.summary(job) });
  }
  if (action === "choose-folder") {
    try {
      const selection = await chooseNativeFolder();
      return jsonResponse(200, { ok: true, cancelled: selection.cancelled, outputDir: selection.path });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: errorMessage(error) });
    }
  }
  if (action === "open") {
    const job = jobs.get(String(body.jobId || ""));
    if (!job || !["completed", "partial"].includes(job.status) || !job.result) {
      return jsonResponse(404, { ok: false, error: "finished capture job not found" });
    }
    const target = String(body.target || "index");
    const paths = {
      index: job.result.indexHtml,
      archive: job.result.archiveMhtml,
      source: job.result.sourceScreenshot,
      local: job.result.localScreenshot,
      directory: job.result.outputDir,
    };
    const targetPath = paths[target];
    if (!targetPath) return jsonResponse(400, { ok: false, error: "unknown preview target" });
    if ((target === "local" && !job.result.localScreenshot) || (target === "archive" && !job.result.archiveMhtml)) {
      return jsonResponse(404, { ok: false, error: "requested output file is not available" });
    }
    try {
      await openNative(targetPath);
      return jsonResponse(200, { ok: true, path: targetPath });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: errorMessage(error) });
    }
  }
  if (action !== "capture") return jsonResponse(400, { ok: false, error: "unknown action" });

  try {
    const options = normalizeCaptureOptions(body);
    // UI requests obey the deployment policy, not an invented privileged session.
    const access = await createCaptureAccess(ctx);
    await access.assertWrite(options.outputDir);
    const job = jobs.start(options);
    return jsonResponse(202, { ok: true, jobId: job.id, status: job.status, outputDir: options.outputDir });
  } catch (error) {
    return jsonResponse(error.status || (error.code === "FS_SANDBOX_DENIED" ? 403 : 400), { ok: false, error: errorMessage(error) });
  }
}

function resultText(value) {
  const lines = [
    value.ok ? "网页本地副本已生成并通过离线检查" : (value.indexHtml ? "网页已保存，但离线检查未完全通过" : "网页获取失败"),
    `来源：${value.url || ""}`,
    `标题：${value.title || ""}`,
    `输出目录：${value.outputDir || ""}`,
    `入口：${value.indexHtml || ""}`,
    `完整归档：${value.archiveMhtml || ""}`,
    `本地资源：${Number(value.assetCount) || 0} 个，${Number(value.assetBytes) || 0} 字节（额外下载 ${Number(value.additionalResourcesDownloaded) || 0} 个）`,
    `MHTML：${Number(value.mhtmlBytes) || 0} 字节`,
    `视口：${value.sourceViewport?.width || "?"} × ${value.sourceViewport?.height || "?"}`,
    `本地预览：${value.localScreenshot || "未生成"}`,
    `未本地化的资源引用：${Number(value.externalResourceReferences) || 0}`,
    `资源获取失败：${Number(value.resourceFetchFailures) || 0}`,
    `来源网络失败：${Number(value.networkFailures) || 0}；离线验证资源失败：${Number(value.offlineNetworkFailures) || 0}`,
  ];
  for (const warning of Array.isArray(value.warnings) ? value.warnings : []) lines.push(`提示：${warning}`);
  lines.push("说明：这是整页静态渲染副本，移除脚本、事件处理器和嵌入页面，不按窗口高度裁切；不会复制源站 API、登录态或交互组件。详情见输出目录内 report.json 和 README.md。");
  return lines.join("\n");
}

function captureTool(ctx, lifetime, pending) {
  return {
    name: "huoqu",
    description: "Open the given HTTP(S) URL in the user's current Chrome through the DSH Chrome extension when connected, otherwise in isolated headless Chrome. Scroll the full page, then save a static rendered HTML/assets copy with scripts, event handlers and embedded pages removed, a self-contained MHTML variant, and screenshots. Use the supplied output_dir when provided; it must be an absolute folder (~/ is accepted). Only an empty directory or a verified previous huoqu copy may be used; unrelated files are refused. Returns exact local paths and reports unresolved assets, firewall interstitials, or offline-check failures. This captures the rendered page, not server-side APIs or every interaction state.",
    timeoutMs: 240_000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "HTTP or HTTPS page URL to capture." },
        output_dir: { type: "string", description: "Optional absolute output folder. Replaces a previous huoqu copy; refuses unrelated files. Defaults to ~/Downloads/huoqu/<host>-<timestamp>." },
        width: { type: "integer", description: "Layout width in CSS pixels, 360-3840; default 1440. Does not crop the page." },
        height: { type: "integer", description: "Initial layout window height, 320-2160; default 1000. Screenshots and HTML still cover the full document." },
        wait_seconds: { type: "integer", description: "Extra wait after lazy scrolling and network quiet, 0-20; default 2." },
      },
      required: ["url"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          status: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
          outputDir: { type: "string" },
          indexHtml: { type: "string" },
          archiveMhtml: { type: "string" },
          sourceScreenshot: { type: "string" },
          localScreenshot: { type: "string" },
          archivePreview: { type: "string" },
          assetCount: { type: "integer" },
          assetBytes: { type: "integer" },
          additionalResourcesDownloaded: { type: "integer" },
          resourceFetchFailures: { type: "integer" },
          offlineNetworkFailures: { type: "integer" },
          mhtmlBytes: { type: "integer" },
          sourceViewport: { type: "object" },
          sourcePage: { type: "object" },
          localPage: { type: "object" },
          externalResourceReferences: { type: "integer" },
          networkFailures: { type: "integer" },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "status", "url", "title", "outputDir", "indexHtml", "archiveMhtml", "assetCount", "assetBytes", "additionalResourcesDownloaded", "resourceFetchFailures", "offlineNetworkFailures", "mhtmlBytes", "warnings"],
      },
      render(_args, value) {
        return [{ type: "text", text: resultText(value || {}) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(new Error("采集超过总时限")), CAPTURE_TIMEOUT_MS);
      timeout.unref?.();
      const signal = AbortSignal.any([lifetime.signal, timer.signal, ...(exec?.signal ? [exec.signal] : [])]);
      try {
        signal.throwIfAborted();
        const access = await createCaptureAccess(ctx, exec);
        signal.throwIfAborted();
        const running = withCaptureOwner(exec, () => capturePage(args || {}, signal, access));
        pending.add(running);
        try { return await running; }
        finally { pending.delete(running); }
      } finally { clearTimeout(timeout); }
    },
  };
}

export function apply(ctx) {
  const lifetime = new AbortController();
  const pending = new Set();
  const jobs = createJobManager(async (options, signal, id) => {
    const access = await createCaptureAccess(ctx);
    return withCaptureOwner({ agent: { session: { id: `huoqu-job:${id}` } } }, () => capturePage(options, signal, access));
  });
  ctx.effect(() => () => {
    lifetime.abort(new Error("huoqu plugin disposed"));
    return Promise.allSettled([jobs.dispose(), ...pending]);
  });
  ctx.tools.register(captureTool(ctx, lifetime, pending));
  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: (request) => handleRequest(request, jobs, ctx),
  });
}
