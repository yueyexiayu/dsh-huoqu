# API 契约 · huoqu

本文件是 huoqu 的**对外契约**：工具入参、侧栏 HTTP 接口、产物字段、错误码与不变量。
契约的事实来源是源码（每节末尾给出 `file:line`）；实现改动必须同步改这里，见 [AGENTS.md](../AGENTS.md)。

适用版本：0.2.12 起的 `lib/`。工具返回与侧栏 `GET version` 里的版本号来自 `package.json`（`HUOQU_VERSION`），不是本文件。

## 1. 两个入口

| 入口 | 谁调用 | 说明 |
| --- | --- | --- |
| 工具 `huoqu` | DSH Host 的 agent 工具调用 | 一次调用采集一个页面，同步返回结果；不允许并发 |
| HTTP `/api/huoqu` | 侧栏界面（`lib/client.js`） | GET 查询任务、POST 发起/取消/重试/选目录/打开产物；异步任务模型 |

两个入口共用同一套参数归一化、权限校验与采集实现，差异只在「同步返回结果」还是「返回 jobId 后查询」。

## 2. 工具 `huoqu`

`name: "huoqu"`，`timeoutMs: 240_000`，`isConcurrencySafe: () => false`（同一 Host 内串行）。

### 2.1 参数

| 字段 | 类型 | 必填 | 默认 | 取值 |
| --- | --- | --- | --- | --- |
| `url` | string | 是 | — | `http:` / `https:`，必须有 hostname，不得含 user/password |
| `output_dir` | string | 否 | 见 2.2 | 绝对路径或 `~/` 开头 |
| `width` | integer | 否 | `1440` | 360–3840 |
| `height` | integer | 否 | `1000` | 320–2160 |
| `wait_seconds` | integer | 否 | `2` | 0–20 |
| `purpose` | string | 否 | `capture` | `capture` / `automation` / `web-regression` |
| `backend` | string | 否 | `auto` | `auto` / `current-chrome` / `headless` / `dsh-embedded` |
| `browser_identity` | string | 否 | 由 `backend` 推导 | `current` / `anonymous` / `prefer-current` / `dsh-embedded` |
| `allow_private` | boolean | 否 | `false` | `true` 才允许 loopback / 私网 / 链路本地 / `.local` |

`additionalProperties: false`；`required: ["url"]`。

### 2.2 默认输出目录

`danger-full-access` → `~/Downloads/huoqu/<hostSlug>-<时间戳>`；`workspace-write` → `<workspaceRoot>/huoqu/<hostSlug>-<时间戳>`。
`read-only` 会话在 `assertWrite` 处被拒绝（见第 5 节）。

### 2.3 拒绝规则（原文）

- `capture ${field} belongs to its Host execution owner, not request input`——请求体里出现 `scope` / `execution` / `cwd` / `ownership` / `operationCwd` / `mode` 一律拒绝。
- `unsupported capture purpose` / `unsupported capture backend` / `unsupported browser identity`
- `dsh-embedded backend requires dsh-embedded identity; no identity fallback`
- `automatic capture and web-regression require anonymous owned headless, not current-chrome`
- `headless requires anonymous identity; it cannot preserve current Chrome login state`
- `current-chrome cannot guarantee anonymous identity; choose headless`
- `url is required` / `url must be a valid http or https URL` / `only http and https URLs can be captured` / `url must have a hostname and must not contain credentials`
- `width must be an integer from 360 to 3840`（`height` 320–2160、`wait_seconds` 0–20 同模板）
- `allow_private must be a boolean`
- `output_dir must be an absolute path (or start with ~/)` / `output_dir contains an invalid character` / `output_dir must be a dedicated project folder, not a system or DSH root`

不合法组合一律**抛错**，不静默换身份或换后端。

### 2.4 返回

`required`：`ok`、`status`、`url`、`title`、`outputDir`、`indexHtml`、`archiveMhtml`、`assetCount`、`assetBytes`、`additionalResourcesDownloaded`、`resourceFetchFailures`、`offlineNetworkFailures`、`mhtmlBytes`、`warnings`。

| 字段 | 说明 |
| --- | --- |
| `ok` | 等于离线校验是否通过；`partial` 时为 `false`，但文件已落盘 |
| `status` | 只有 `completed` / `partial` 两个成功态 |
| `pluginVersion` | 实际加载的插件版本（可选字段，但正常运行时存在） |
| `sourceScreenshot` / `localScreenshot` / `archivePreview` | 产物路径（可选） |
| `browserExecution` / `verificationBrowserExecution` | 采集与核验两个浏览器引擎的实际记录（可选） |
| `warnings` | 字符串数组，降级、丢资源、未覆盖项都写这里 |

失败不返回对象：抛异常。HTTP 侧对应 `status: failed` / `cancelled` / `timed_out`，`result: null`，`error` 带原因。

## 3. HTTP `/api/huoqu`

`path: "/api/huoqu"`，`methods: ["GET", "POST"]`，`requestBody: "buffered"`。

### 3.1 GET

| 请求 | 响应 |
| --- | --- |
| `GET /api/huoqu?sessionId=<id>` | `200 { ok: true, version, jobs: summary[] }` |
| `GET /api/huoqu?sessionId=<id>&jobId=<id>` | `200 { ok: true, ...summary }`；不存在或过期 → `404 { ok: false, error: "capture job not found or expired" }` |

`summary` 字段：`jobId`、`status`、`createdAt`、`updatedAt`、`url`（脱敏）、`urlRedacted`、`outputDir`、`retryUrl`、`backend`、`browserIdentity`、`allowPrivate`、`result`、`error`。

### 3.2 POST

请求体必须是 JSON 对象；`action` 缺省为 `capture`。含 `sandbox_permissions` 或 `justification` 直接 400（`capture API does not accept permission overrides`）。

| `action` | 必填字段 | 成功响应 |
| --- | --- | --- |
| `capture` | `sessionId`、`url`；可选 `output_dir`、`wait_seconds`、`backend`、`allow_private`、`browser_identity` | `202 { ok: true, jobId, status, outputDir }` |
| `cancel` | `sessionId`、`jobId` | `200 { ok: true, ...summary }` |
| `retry` | `sessionId`、`jobId` | `202 { ok: true, jobId, status, outputDir }` |
| `choose-folder` | `sessionId` | `200 { ok: true, cancelled, outputDir }` |
| `open` | `sessionId`、`jobId`、`target`（`index` / `archive` / `source` / `local` / `directory`，默认 `index`） | `200 { ok: true, path }` |

`open` 只对 `completed` / `partial` 且有 `result` 的任务生效；`local` 无截图、`archive` 无 MHTML 时 `404 requested output file is not available`。

### 3.3 状态码

| 码 | 触发条件 |
| --- | --- |
| 200 | 查询、`cancel`、`choose-folder`、`open` 成功 |
| 202 | `capture` / `retry` 已入队 |
| 400 | JSON 非法或非对象；权限覆盖字段；`sessionId` 非当前会话 id；参数归一化失败；`unknown action`；`unknown preview target` |
| 403 | 会话不存在或未加载（`当前会话不存在或未加载，已拒绝操作，不会回落到 Host 默认策略`）；无绝对工作区；`FS_SANDBOX_DENIED`（read-only 或越出可写根） |
| 404 | 任务不存在/已过期（`capture job not found or expired`）；`finished capture job not found`；产物不可用 |
| 429 | `采集任务已达上限（最多4个运行或排队任务），请等待或取消已有任务` |
| 500 | `chooseNativeFolder` / `openNative` 失败 |
| 503 | 读不到当前会话（`huoqu 无法读取当前会话，已拒绝操作`）；插件正在停止（`huoqu plugin is stopping`） |

### 3.4 `sessionId`、排队与保留

- `sessionId` 必须等于**当前已加载**会话 id：非字符串 / 空白 / 首尾空格 / 超 200 字符 / 含控制字符 → 400；`ctx.sessions.get` 不可用 → 503；查不到、id 不一致或会话无绝对 cwd → 403。**任何情况都不回落到 Host 默认策略或默认工作区。**
- 同时最多 4 个「运行或排队」任务，超出 429；任务**串行**执行，`cancelling` 仍占槽。
- 单任务总时限 240 秒，**从入队开始计**；超时置 `timed_out`，正在运行的任务转 `cancelling` 并等待清理退出。
- 终态保留：`JOB_TTL_MS = 60 * 60 * 1000`，且任务数超过 40 时淘汰；Host 重启不恢复任务。

## 4. 产物契约

| 文件 | 内容 |
| --- | --- |
| `index.html` / `assets/` | 本地入口与本地化资源 |
| `index.mhtml` | 单文件快照（上限 512 MiB） |
| `source.png` / `local.png` | 源站与本地预览截图（各上限 128 MiB） |
| `report.json` | 本次运行的可核验记录 |
| `manifest.json` | 产物归属清单，也是「能否覆盖此目录」的唯一凭据 |

`manifest.json`：`producer: "huoqu"`、`formatVersion: 1`、`sourceUrl`、`title`、`networkPolicy`、`viewport{width,height}`、`resources[{path,mime,bytes,source}]`、`externalResourceReferences`。

`report.json` 顶层：`status`、`source`、`capturedAt`、`pluginVersion`、`browser`（`requestedBackend`、`viewport`、`requestedIdentity`、`actualIdentity`、`engine`、`policyPackage`、`downgradeReason`）、`networkPolicy.allowPrivate`、`verificationBrowser`、`sourcePage`、`scroll`、`archive`、`assetCompletion`、`localCopy`、`offlineValidation`（`networkEmulation`、`networkFailures`、`archiveNetworkFailures`、`ignoredSaveFailures`、`htmlIssues`、`archiveIssues`、`result`）、`archivePreview`、`screenshots`、`networkFailures`、`warnings`、`limitations`。

`offlineValidation.result` 只有 `passed` / `partial`；源码里没有名为 `verification` 或 `issues` 的顶层字段。

## 5. 权限、输出目录与不变量

1. **身份不降级**：Chrome 扩展不可用时只有 `browser_identity: "prefer-current"` 允许降级到匿名 headless，并把原因写进 `warnings` / `report.browser.downgradeReason`；其余组合抛错。Desktop BrowserHost 不可用时明确失败（`DSH 内置浏览器采集服务不可用；不会切换浏览器或身份`）。
2. **网络策略统一**：`allow_private=false` 时 loopback、10/8、172.16/12、192.168/16、169.254/16、`::1`、`fc00::/7`、`fe80::/10`、`.local`、`.internal` 与云 metadata 一律阻断（`blocked a private/local navigation host`、`blocked a hostname resolving to a private/local address`）；三类后端共用同一策略。
3. **写入按真实会话策略**：每次写入前重新解析 `sandboxPolicy`；read-only 抛 `huoqu writes capture files and browser temporary data`；`workspace-write` 只能写 `workspaceRoot`、`/tmp`、`os.tmpdir()`，写 `~/Downloads` 需要 `danger-full-access`。
4. **目录不覆盖他人内容**：`output_dir` 必须是真实目录（`output_dir must be a real directory, not a symlink or file`）；已有内容必须由 `manifest.json` / `report.json` 证明是 huoqu 产物，否则 `输出目录无法确认归属 huoqu，已拒绝覆盖`；同一目录同时只允许一个采集写入（`another capture is already writing to ...`），写入走 staging + 事务替换。
5. **结果口径**：只有资源完整、离线 HTML/MHTML 预览与内容/图片检查通过、浏览器清理成功才是 `completed`；否则 `partial`；清理失败阻止发布与替换并报告残留。

## 6. 预算

额外资源请求数 ≤ 1200，额外资源读取总计 ≤ 1000 MiB（失败响应计入），单个普通资源 ≤ 200 MiB、音视频 ≤ 640 MiB，MHTML ≤ 512 MiB，截图 ≤ 128 MiB。404/410 的引用可移除而不判整次失败。

## 7. 未验证

- Host 侧框架对非 GET/POST 的响应（405 之类）由 `ctx.connection` 决定，本仓库只声明 `methods`，未读框架实现。
- `report.json` 的字段清单来自写入代码与测试断言，未与「真实产品运行」的完整样本逐字段对照；字段以源码为准。

## 8. 证据

| 结论 | 位置 |
| --- | --- |
| 端点常量与上限 | `lib/index.js:38`（`export const API_PATH = "/api/huoqu";`）、`lib/index.js:39`、`lib/index.js:41` |
| 工具 schema 与超时 | `lib/index.js:324`–`lib/index.js:380` |
| 参数归一化与拒绝原文 | `lib/parse.js:32`–`lib/parse.js:96` |
| 会话校验与状态码 | `lib/permissions.js:15`、`:18`、`:22`、`:25`、`:63`、`:83` |
| HTTP 路由与错误映射 | `lib/index.js:206`–`lib/index.js:294`、`lib/index.js:419`–`lib/index.js:421` |
| 排队、上限、保留 | `lib/index.js:66`、`:93`、`:127`、`:128`、`:134` |
| 产物字段 | `lib/capture.js:1704`–`lib/capture.js:1788` |
