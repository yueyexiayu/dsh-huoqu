import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { capturePage } from "./capture.js";
import { normalizeCaptureOptions } from "./parse.js";

export const name = "huoqu";
export const inject = ["tools", "connection"];

export const API_PATH = "/api/huoqu";
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

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

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.updatedAt < now - JOB_TTL_MS && job.status !== "running") jobs.delete(id);
  }
  if (jobs.size > 40) {
    const finished = [...jobs.entries()]
      .filter(([, job]) => job.status !== "running")
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (jobs.size > 40 && finished.length) jobs.delete(finished.shift()[0]);
  }
}

function startJob(options) {
  pruneJobs();
  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    options,
    result: null,
    error: "",
  };
  jobs.set(id, job);
  job.status = "running";
  job.updatedAt = Date.now();
  job.promise = capturePage(options).then((result) => {
    job.result = result;
    job.status = "completed";
    job.updatedAt = Date.now();
  }, (error) => {
    job.error = errorMessage(error);
    job.status = "failed";
    job.updatedAt = Date.now();
  });
  return job;
}

function openNative(targetPath) {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("打开本地预览目前仅支持 macOS；请直接打开返回的本地文件路径"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("open", [targetPath], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
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

async function handleRequest(request) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const id = String(url.searchParams.get("jobId") || "");
    const job = jobs.get(id);
    if (!job) return jsonResponse(404, { ok: false, error: "capture job not found or expired" });
    return jsonResponse(200, {
      ok: job.status !== "failed",
      jobId: id,
      status: job.status,
      url: job.options.url,
      outputDir: job.options.outputDir,
      result: job.result,
      error: job.error,
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "request body must be valid JSON" });
  }
  const action = String(body?.action || "capture");
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
    if (!job || job.status !== "completed" || !job.result) {
      return jsonResponse(404, { ok: false, error: "completed capture job not found" });
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
    const job = startJob(options);
    return jsonResponse(202, { ok: true, jobId: job.id, status: job.status, outputDir: options.outputDir });
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) });
  }
}

function resultText(value) {
  const lines = [
    value.ok ? "网页本地副本已生成并通过离线检查" : (value.indexHtml ? "网页已保存，但离线资源不完整" : "网页获取失败"),
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
    `来源网络失败：${Number(value.networkFailures) || 0}；离线验证网络失败：${Number(value.offlineNetworkFailures) || 0}`,
  ];
  for (const warning of Array.isArray(value.warnings) ? value.warnings : []) lines.push(`提示：${warning}`);
  lines.push("说明：这是整页静态快照，不按窗口高度裁切；不会复制源站 API、登录态或所有服务端交互。详情见输出目录内 report.json 和 README.md。");
  return lines.join("\n");
}

function captureTool() {
  return {
    name: "huoqu",
    description: "Open the given HTTP(S) URL in the user's current Chrome through the DSH Chrome extension when connected, otherwise in isolated headless Chrome. Scroll the full page, then save a static HTML/assets copy, a self-contained MHTML variant, and screenshots. Use the supplied output_dir when provided; it must be an absolute folder (~/ is accepted). A previous huoqu copy or Finder .DS_Store may be replaced; other existing files are refused. Returns exact local paths and reports unresolved assets, firewall interstitials, or offline-check failures. This captures the rendered page, not server-side APIs or every interaction state.",
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
      return capturePage(args || {}, exec?.signal);
    },
  };
}

export function apply(ctx) {
  ctx.tools.register(captureTool());
  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: handleRequest,
  });
}
