# 变更历史

倒序排列。版本号唯一来源是 `package.json`；日期取提交 author date。
2026-11-28 之前的条目由 git 历史倒推整理：只有标题、无正文可判语义的已标注「据提交标题」；`v0.2.7`、`v0.2.10`、`v0.2.12` 没有 git tag，按版本递增提交归因。`0.2.0` 从未存在。

## 0.2.13 · 2026-11-28 · 补齐工程文档，修正官方会话契约夹具

- 新增 [docs/API.md](docs/API.md)：工具 `huoqu` 参数与返回、侧栏 `/api/huoqu` 五个 action、状态码、`sessionId`/排队/保留规则、`report.json` 与 `manifest.json` 字段、权限与不变量。
- 新增本文件与 [AGENTS.md](AGENTS.md)：把加载、重启、版本一致性与必跑验证写成可执行约定。
- 新增 [docs/ACCEPTANCE-0.2.13.md](docs/ACCEPTANCE-0.2.13.md)：记录本次实测通过数、环境与未验证边界。
- 修 `test/official-session.test.mjs`：官方 `0.2.3-alpha.2` 起 `enter()` 不再隐含 `session/created`，追加事件前必须先 `announce()`。夹具补 `ctx.sessions.announce?.(session)`（旧版无此方法时自动跳过），官方契约用例由 1 fail 恢复为 225/225 通过。
- `.gitignore` 增加 `.jilv/`（工程体检过程产物）。
- 产品代码未改动；本版不改变任何采集行为。

## 0.2.12 · 2026-11-19 · 内联已下线的 browser-policy，移除 vendored 依赖（无 tag）

- `0889200` 修复凭据外泄：`summary()` 的 `retryUrl` 不再回传原始 URL，改由 `action: retry` 让 Host 重放保存的 options；`redactSensitiveUrl` 覆盖 fragment 里的 `#access_token` / `#id_token` 且幂等；屏外 HTML 中的绝对 URL 一并脱敏；新增 `test/url-redaction.test.mjs`。
- `998c582` 内联 `browser-policy`：新增 `lib/browser-policy/{execution.js,headless-engine.js,manifest.json}`，删除 `vendor/browser-execution/` 下 5 个 tarball 与 `provenance.json`，`dependencies` 只剩 `playwright-core`；版本递增 0.2.11 → 0.2.12。
- `53721fc` `.gitignore` 忽略 `.jilv/`（工程体检过程产物）。

## 0.2.11 · 2026-11-10 · 内置 BrowserHost 支持私网采集（tag v0.2.11）

- `b935e44` 内置 BrowserHost 的私网采集贯通（据提交标题：`Enable private capture in embedded BrowserHost`）；改 `lib/capture.js`、`lib/client.js`、`lib/index.js`、`test/capture.test.mjs` 与双语 README；打 annotated tag。

## 0.2.10 · 2026-11-10 · 采集安全与恢复加固（无 tag）

- `7706942` 新增 `lib/url-safety.js`，收敛 `lib/permissions.js`；重写 `lib/capture.js`（366 行改动）；新增 `.github/workflows/test.yml` 与 `.npmrc`；15 个测试文件同步（据提交标题：`Harden capture security and recovery`）。

## 0.2.9 · 2026-11-07 · 默认后端改为 DSH 内置浏览器（tag v0.2.9）

- `027b681` 未指定后端时默认用内置浏览器，当前 Chrome 需显式 `backend=current-chrome`；Desktop BrowserHost 不再是必需 inject，缺失时插件仍能加载并给出明确错误。

## 0.2.8 · 2026-11-04 · 插件界面样式打磨（tag v0.2.8）

- `d52d3a9` 侧栏与表单样式调整（据提交标题：`Polish plugin interface styling`）；版本递增并同步 README 与 `test/host.test.mjs`。

## 0.2.7 · 2026-11-04 · 澄清内置浏览器身份的适用范围（无 tag）

- `e4ed566` 文档与文案明确内置浏览器身份的边界（据提交标题：`Clarify embedded browser identity scope`）；版本递增 0.2.6 → 0.2.7。

## 0.2.6 · 2026-11-03 · 以内置浏览器身份采集页面（tag v0.2.6）

- `269591d` 采集改用 DSH 内置浏览器身份（据提交标题）；`lib/capture.js` +95、`lib/client.js` +17，补 `capture` / `parse` 回归。

## 0.2.5 · 2026-11-03 · 本地化插件列表信息（tag v0.2.5）

- `d255114` `locale/en.json`、`locale/zh.json` 的插件说明文案本地化（据提交标题）。

## 0.2.4 · 2026-10-31 · 设置本地化插件显示名（tag v0.2.4）

- `c265627` 两个 locale 各新增一行显示名（据提交标题：`set localized plugin display name`）。

## 0.2.3 · 2026-10-29 · 绑定侧栏会话，扩展采集支持 MHTML 快照（tag v0.2.3）

- `8ae587e` 官方右侧栏不再压平 `sessionId` 时改从 `useTabInfo` 读取 `tab.sessionId`；缺扩展时不再暗示静默 headless；扩展采集先试 `Page.captureSnapshot`，失败回落实时 HTML 并给警告；`dsh-browser-use` 对齐 `0.2.1-alpha.4.browser-policy.1`。
- `0b86400` 2026-10-26 中文优先的双语 README 与原创配图。

## 0.2.2 · 2026-10-15 · 修复采集夹具并同步版本（tag v0.2.2）

- `334f2c8` 导入夹具支持静态相对 import/re-export 的单双引号与 `./`、`../`；版本断言改由测试独立读取插件包、policy 包与 headless lock；`HUOQU_VERSION` 从包元数据派生；默认套件 51 项失败清零（记录见 [docs/regression-verification-0.2.2.md](docs/regression-verification-0.2.2.md)：`197/197 pass`、`198/198 pass`）。

## 0.2.1 · 2026-10-15 · 采集策略与资源处理集中修复（无 tag）

- `3fe0d67` 侧栏任务改用会话的文件策略，不再误按部署的 `workspace-write` 拒绝 `~/Downloads`。
- `98408e2`、`4d005eb` 资源上限放宽：页内视频 64MB、丢弃 404/410 引用；图像/媒体/总量/数量/MHTML 上限整体 ×10。
- `449e87f`、`ed41283` 阻止私网重定向、固定资源 DNS、样式表失败降级为部分成功、输出锁规范化（据提交标题）。
- `69e455a`、`52f6649` 紧凑页面采集与 DOM fallback 文档模式；外部 SVG 绘制隔离与侧栏异步竞态修复（据提交标题）。
- `8e594ce` 强制已加载会话所有权、采集策略动态化（据提交标题）。
- `f996f5e` macOS 采集改用专用 headless shell（据提交标题）。
- `c0a8c06` 版本递增 0.1.1 → 0.2.1，补记已有的 current/anonymous 执行、固定 headless 产物与进程所有权生命周期。
- 另有唯一合并提交 `f4c1bb4`（`3e81b17` + `51ba2b0`），无独立内容。

## 0.1.1 · 2026-10-07 · 采集安全、权限与任务生命周期修复（无 tag）

- `3e81b17` 采集安全、sandbox 权限与 job 生命周期修复（据提交标题），改 `lib/permissions.js` 与 18 个测试文件；版本递增 0.1.0 → 0.1.1。
- `e21d99d` 离线采集资源、校验与替换恢复修复（据提交标题）。
- `51ba2b0` 离线资源重写与采集预算（据提交标题）。
- `f6fc0c1` 保留原始脚本以便本地页面重放组件（据提交标题）。
- `127ea3e` 等待延迟加载内容、保留轮播帧（据提交标题）。
- `476609c` 文档注明依赖 dsh-chrome 扩展（据提交标题）。

## 0.1.0 · 2026-09-28 · 首个提交（无 tag）

- `77864e1` `Add huoqu webpage capture plugin.`：建立 `lib/`、`test/`、README 与 `package.json` 基础结构。
