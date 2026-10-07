window.__ModuleLoader__.load({
  id: "huoqu",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var inject = ["slots", "sidebarRightTabs"];
    var TAB_ID = "huoqu";
    var API_PATH = "/api/huoqu";
    var STYLE_ID = "huoqu-style";

    var cssText = [
      ".huoqu-root{display:flex;flex-direction:column;gap:14px;height:100%;min-height:0;overflow:auto;padding:18px 16px 24px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202124);font:13px/1.55 system-ui,sans-serif}",
      ".huoqu-title{font-size:17px;font-weight:650;letter-spacing:.01em}",
      ".huoqu-desc{margin-top:-8px;color:var(--dsw-alias-label-secondary,#777);font-size:12px}",
      ".huoqu-form{display:flex;flex-direction:column;gap:12px}",
      ".huoqu-field{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#666);font-size:12px}",
      ".huoqu-input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3,#d9d9d9);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#202124);font:13px/1.4 system-ui,sans-serif;padding:9px 10px;outline:none}",
      ".huoqu-input:focus{border-color:#4778e8;box-shadow:0 0 0 2px rgba(71,120,232,.12)}",
      ".huoqu-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".huoqu-button{border:1px solid var(--dsw-alias-border-l3,#d9d9d9);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8f8f8);color:var(--dsw-alias-label-primary,#202124);font:600 13px/1.4 system-ui,sans-serif;padding:9px 12px;cursor:pointer}",
      ".huoqu-button:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,#eee)}",
      ".huoqu-button-primary{background:#245fd3;color:#fff;border-color:#245fd3}",
      ".huoqu-button-primary:hover:not(:disabled){background:#174db8}",
      ".huoqu-button:disabled{opacity:.5;cursor:default}",
      ".huoqu-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".huoqu-folder-row{display:flex;align-items:flex-end;gap:8px}.huoqu-folder-row .huoqu-field{flex:1;min-width:0}.huoqu-folder-row .huoqu-button{flex:none;white-space:nowrap}",
      ".huoqu-notice{border-radius:8px;padding:10px 11px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-secondary,#555);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".huoqu-error{background:rgba(201,42,42,.08);color:var(--dsw-alias-danger-fg,#b42318)}",
      ".huoqu-result{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l3,#e3e3e3);border-radius:10px;padding:12px}",
      ".huoqu-path{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#666)}",
      ".huoqu-meta{display:grid;grid-template-columns:1fr 1fr;gap:6px;color:var(--dsw-alias-label-secondary,#666);font-size:11px}",
      ".huoqu-small{color:var(--dsw-alias-label-tertiary,#888);font-size:11px}",
    ].join(" ");

    function ensureStyle() {
      var existing = document.getElementById(STYLE_ID);
      if (existing) { existing.textContent = cssText; return; }
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function Glyph(props) {
      var size = props && props.size != null ? props.size : 24;
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
      },
        React.createElement("path", { d: "M4 5h16v14H4z" }),
        React.createElement("path", { d: "M4 9h16M8 5v4m8-4v4M8 13h3m2 0h3m-8 3h3" }),
      );
    }

    function Title() { return React.createElement("span", null, "网页获取"); }

    async function jsonRequest(url, options) {
      var response = await fetch(url, options);
      var raw = await response.text();
      var data;
      try {
        data = JSON.parse(raw);
      } catch {
        var preview = String(raw || "").replace(/<[^>]*>/g, " ")
          .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
          .replace(/([?&](?:token|access_token|auth|signature)=)[^&\s"']+/gi, "$1[redacted]")
          .replace(/\s+/g, " ").trim().slice(0, 120);
        throw new Error("接口返回非 JSON（HTTP " + response.status + "，" + (response.headers.get("content-type") || "无 Content-Type") + ")" + (preview ? "：" + preview : ""));
      }
      if (!response.ok || !data.ok) throw new Error(data.error || ("HTTP " + response.status));
      return data;
    }

    function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    function CapturePane() {
      var urlState = React.useState("");
      var url = urlState[0]; var setUrl = urlState[1];
      var outputState = React.useState("");
      var outputDir = outputState[0]; var setOutputDir = outputState[1];
      var busyState = React.useState(false);
      var busy = busyState[0]; var setBusy = busyState[1];
      var noticeState = React.useState("");
      var notice = noticeState[0]; var setNotice = noticeState[1];
      var errorState = React.useState("");
      var error = errorState[0]; var setError = errorState[1];
      var jobState = React.useState("");
      var jobId = jobState[0]; var setJobId = jobState[1];
      var resultState = React.useState(null);
      var result = resultState[0]; var setResult = resultState[1];
      var jobsState = React.useState([]);
      var jobs = jobsState[0]; var setJobs = jobsState[1];
      var statusState = React.useState("");
      var jobStatus = statusState[0]; var setJobStatus = statusState[1];
      var alive = React.useRef(true);
      var tracking = React.useRef(0);
      function active(status) { return status === "queued" || status === "running" || status === "cancelling"; }
      React.useEffect(function () {
        alive.current = true;
        refreshJobs(true);
        return function () { alive.current = false; tracking.current += 1; };
      }, []);

      async function refreshJobs(restore) {
        var revision = tracking.current;
        try {
          var data = await jsonRequest(API_PATH, { method: "GET", cache: "no-store" });
          if (!alive.current) return;
          setJobs(data.jobs);
          if (restore && revision === tracking.current && data.jobs.length) {
            var previous = data.jobs.find(function (item) { return active(item.status); }) || data.jobs[0];
            setUrl(previous.url); setOutputDir(previous.outputDir);
            trackJob(previous.jobId);
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err));
        }
      }

      async function trackJob(id) {
        var revision = ++tracking.current;
        setJobId(id); setResult(null); setError(""); setBusy(true);
        try {
          while (alive.current && revision === tracking.current) {
            var state = await jsonRequest(API_PATH + "?jobId=" + encodeURIComponent(id), { method: "GET", cache: "no-store" });
            if (!alive.current || revision !== tracking.current) return;
            setJobStatus(state.status);
            if (state.status === "completed" || state.status === "partial") {
              if (!state.result) throw new Error("采集结果缺失");
              setResult(state.result);
              setNotice(state.result.ok ? "静态网页副本已生成并通过离线检查。" : "页面文件已保存，但离线检查未完全通过；请查看报告和警告。");
              return;
            }
            if (!active(state.status)) {
              setNotice("");
              throw new Error(state.error || (state.status === "cancelled" ? "采集已取消" : "采集失败：" + state.status));
            }
            setNotice("任务状态：" + state.status + "。关闭面板不会取消，重新打开可恢复；可点击取消停止任务。");
            await pause(1200);
          }
        } catch (err) {
          if (alive.current && revision === tracking.current) setError(err && err.message ? err.message : String(err));
        } finally {
          if (alive.current && revision === tracking.current) { setBusy(false); refreshJobs(false); }
        }
      }

      async function cancelJob() {
        var revision = tracking.current;
        var id = jobId;
        try {
          await jsonRequest(API_PATH, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "cancel", jobId: id }) });
          if (alive.current && revision === tracking.current) { trackJob(id); refreshJobs(false); }
        } catch (err) { if (alive.current && revision === tracking.current) setError(err && err.message ? err.message : String(err)); }
      }

      async function submit(event) {
        event.preventDefault();
        var revision = ++tracking.current;
        setError(""); setResult(null); setJobId(""); setJobStatus("");
        var normalized = String(url || "").trim();
        try {
          var parsed = new URL(normalized);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("请提供 http 或 https 网页地址");
          setBusy(true); setNotice("正在连接 Chrome；优先使用已连接的 DSH 扩展…");
          var started = await jsonRequest(API_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "capture", url: normalized, output_dir: outputDir.trim(), wait_seconds: 2,
            }),
          });
          if (!alive.current || revision !== tracking.current) return;
          setJobStatus(started.status);
          refreshJobs(false);
          await trackJob(started.jobId);
        } catch (err) {
          if (alive.current && revision === tracking.current) { setError(err && err.message ? err.message : String(err)); setNotice(""); }
        } finally {
          if (alive.current && revision === tracking.current) setBusy(false);
        }
      }

      async function chooseFolder() {
        if (busy) return;
        setError(""); setNotice("正在打开本地文件夹选择器…"); setBusy(true);
        try {
          var selection = await jsonRequest(API_PATH, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "choose-folder" }),
          });
          if (!selection.cancelled && selection.outputDir) {
            setOutputDir(selection.outputDir);
            setNotice("已选择输出目录。同一目录可以再次采集，会替换上一次的网页副本；里面如果有其他文件则不会覆盖。");
          } else {
            setNotice("");
          }
        } catch (err) {
          setError(err && err.message ? err.message : String(err)); setNotice("");
        } finally {
          setBusy(false);
        }
      }

      async function openTarget(target) {
        try {
          await jsonRequest(API_PATH, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "open", jobId: jobId, target: target }),
          });
        } catch (err) { setError(err && err.message ? err.message : String(err)); }
      }

      function field(label, value, onChange, placeholder, type) {
        return React.createElement("label", { className: "huoqu-field" }, label,
          React.createElement("input", {
            className: "huoqu-input", type: type || "text", value: value,
            placeholder: placeholder || "", onChange: function (event) { onChange(event.target.value); },
          }),
        );
      }

      var resultView = result ? React.createElement("div", { className: "huoqu-result" },
        React.createElement("strong", null, result.title || "页面副本"),
        React.createElement("div", { className: "huoqu-meta" },
          React.createElement("span", null, "本地资源：" + result.assetCount),
          React.createElement("span", null, "MHTML：" + Math.round(result.mhtmlBytes / 1024) + " KB"),
          React.createElement("span", null, "外部资源引用：" + result.externalResourceReferences),
          React.createElement("span", null, "离线资源失败：" + result.offlineNetworkFailures),
        ),
        React.createElement("div", { className: "huoqu-path" }, result.indexHtml),
        React.createElement("div", { className: "huoqu-actions" },
          React.createElement("button", { className: "huoqu-button", type: "button", onClick: function () { openTarget("index"); } }, "打开本地页面"),
          React.createElement("button", { className: "huoqu-button", type: "button", onClick: function () { openTarget("directory"); } }, "打开输出目录"),
          result.localScreenshot ? React.createElement("button", { className: "huoqu-button", type: "button", onClick: function () { openTarget("local"); } }, "查看本地截图") : null,
        ),
        Array.isArray(result.warnings) && result.warnings.length ? React.createElement("div", { className: "huoqu-notice" }, result.warnings.join("\n")) : null,
      ) : null;

      return React.createElement("div", { className: "huoqu-root" },
        React.createElement("div", { className: "huoqu-title" }, "网页获取"),
        React.createElement("div", { className: "huoqu-desc" }, "优先用当前 Chrome 的 DSH 扩展在后台标签采集整页。扩展未连接时才使用无头 Chrome。"),
        React.createElement("form", { className: "huoqu-form", onSubmit: submit },
          field("网页 URL", url, setUrl, "https://example.com/", "url"),
          React.createElement("div", { className: "huoqu-folder-row" },
            field("输出目录（留空自动保存）", outputDir, setOutputDir, "~/Downloads/huoqu/<域名>-<时间>"),
            React.createElement("button", { className: "huoqu-button", type: "button", onClick: chooseFolder, disabled: busy }, "选择文件夹"),
          ),
          React.createElement("button", { className: "huoqu-button huoqu-button-primary", type: "submit", disabled: busy || !url.trim() }, busy ? "正在获取…" : "获取并生成本地页面"),
        ),
        React.createElement("div", { className: "huoqu-actions" },
          jobId && active(jobStatus) ? React.createElement("button", { className: "huoqu-button", type: "button", onClick: cancelJob, disabled: jobStatus === "cancelling" }, jobStatus === "cancelling" ? "正在清理…" : "取消采集") : null,
          React.createElement("button", { className: "huoqu-button", type: "button", onClick: function () { refreshJobs(false); } }, "刷新任务列表"),
        ),
        jobs.length ? React.createElement("div", { className: "huoqu-result" },
          React.createElement("strong", null, "最近任务（最多40个，最长1小时；Host重启后不保留）"),
          jobs.map(function (item) {
            return React.createElement("button", { key: item.jobId, className: "huoqu-button huoqu-path", type: "button", onClick: function () { setUrl(item.url); setOutputDir(item.outputDir); trackJob(item.jobId); } }, item.status + " · " + item.url);
          }),
        ) : null,
        notice ? React.createElement("div", { className: "huoqu-notice" }, notice) : null,
        error ? React.createElement("div", { className: "huoqu-notice huoqu-error" }, error) : null,
        resultView,
        React.createElement("div", { className: "huoqu-small" }, "说明：生成静态渲染副本，移除脚本、事件处理器和嵌入页面；不复制登录态、源站 API 或交互组件。含排队4分钟后请求停止并等待清理，同时最多4个任务。"),
      );
    }

    function apply(ctx) {
      ensureStyle();
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_ID,
          priority: "extension",
          title: function () { return "网页获取"; },
          guide: [{
            id: "open",
            order: 35,
            title: function () { return "网页获取"; },
            description: function () { return "采集网页并生成本地离线副本"; },
            icon: Glyph,
          }],
        });
      }, "huoqu.type");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, CapturePane);
        });
      }, "huoqu.body");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, Title);
        });
      }, "huoqu.title");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
