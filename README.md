# huoqu

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

在 DeepSeek Harness 里采集网页的当前渲染结果，保存为可离线打开的**静态副本**。

当前插件版本 **0.2.2**。普通 `purpose=capture` 默认通过 [Chrome 插件](https://github.com/yueyexiayu/dsh-chrome) 复用当前正式 Chrome 的登录状态，并创建本任务独占的后台 capture target，不另开调试端口、不接管用户已有标签。**兼容性变化：默认身份为 `current`；扩展缺失或不可用时明确失败，不再悄悄变成匿名访问。**无头依赖固定为本插件安装的 `playwright-core@1.58.2` 对应专用 Chromium headless shell（revision `1208`，真实版本 `145.0.7632.6`），不扫描其他项目、不选择缓存最高 revision、不跨架构借用。缺失或验证失败明确报错，绝不回退 Google Chrome.app/Chromium.app。配套 Chrome 插件需提供 `openCaptureSession`。采集使用独立所有权，完成、取消后释放，不接管对话正在操作的标签。

### 用途、身份与隔离

- `purpose`: `capture`（默认）、`automation`、`web-regression`。自动化与 Web 回归默认 `anonymous` + owned true headless，绝不借用用户 Chrome。
- `backend`: `auto`（默认）、`current-chrome`、`headless`。auto 依用途/身份选择，不根据任意异常猜测后端。
- `browser_identity`: 普通 capture 默认 `current`；自动化/Web 回归默认 `anonymous`。显式 `prefer-current` 表示允许匿名结果，仅真正 `CHROME_EXTENSION_UNAVAILABLE` 或可选 Chrome 模块不存在时降级，并报告具体原因。协议、旧扩展、权限、能力、实际浏览器版本/身份失败不降级。
- `headless + current`、`current-chrome + anonymous`、自动化 + current 明确拒绝，不静默改模式或身份。
- `width/height` 仍作用于本任务新建 capture target 的 CDP viewport，不移动或缩放用户原生窗口；Chrome 原真实 UA 保留。离线 HTML/MHTML 的禁 JS、缓存/service worker 和断网状态仅在自有固定 shell 中启用，不污染借用 target。匿名 source 可在本批次自有 shell 内验收，不跨任务继承状态。
- scope 来自 Host 真实 loaded Session 和 task/job batch，operation cwd 显式传入；请求 wire 不能伪造 scope/cwd/ownership。Node 直接调用 `capturePage(input, signal, access, {cwd, scope:{sessionId,taskId}})` 也必须显式提供运行归属。
- 结果及报告分别记录 source 与 verifier 的 scope、purpose、backend（extension 或 CDP WebSocket）、mode、ownership、请求/实际身份、实际 engine version 和降级原因。Source width/height 以实际 viewport 回执为准。MHTML/素材不复制登录凭据，额外匿名资源 fetch 无法获取的私有素材按失败报告。

```json
{"url":"https://example.com/","purpose":"web-regression","browser_identity":"anonymous","backend":"headless","output_dir":"/tmp/new-capture"}
```

### 固定无头依赖

在本插件目录执行：

```sh
/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts
# 安装到本插件 playwright-core 包内（不修改其他项目浏览器缓存）
PLAYWRIGHT_BROWSERS_PATH=0 /usr/local/bin/node node_modules/playwright-core/cli.js install chromium-headless-shell
# 启动 Host/测试时也必须提供同一个安装语义
PLAYWRIGHT_BROWSERS_PATH=0 HUOQU_BROWSER_TESTS=1 /usr/local/bin/node --test test/*.test.mjs
```

也可执行 `npm run install:headless`，使用 Playwright 默认缓存。`PLAYWRIGHT_BROWSERS_PATH` 未设置或为空字符串时使用 `~/Library/Caches/ms-playwright`；为 `0` 时使用本插件 `node_modules/playwright-core/.local-browsers`；绝对值使用指定缓存，相对值按**执行 cwd**解析，不按源码目录或其他项目解析。PATH=0、empty/unset 和环境变量取值优先级遵循固定 Playwright 包；同名变量优先，其次 `npm_config_playwright_browsers_path`，再其次 `npm_package_config_playwright_browsers_path`（空字符串也占优先级）。相对路径则按插件明确的 execution cwd 契约，**刻意忽略 `INIT_CWD`**，不声称与 npm 启动时 Playwright 的全部路径语义完全相同。所有模式只寻找固定的 `chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell`。

`HUOQU_CHROME_PATH` 未设置时采用上述固定路径；显式为空、空白、失效或不兼容时失败，不再 fallback。有效 override 可指向另一处完整的相同固定安装（相对路径按执行 cwd）；仅重命名可执行文件、GUI `.app`、GUI symlink、其他版本均拒绝。解析验证 package/发布 browsers manifest、完成 marker、没有活动安装锁、原生 Mach-O arm64、全部17个安装文件 SHA-256 和实际 `--version`，不以文件名或 X_OK 冒充身份；每次批次解析检查，不在每个 CDP 操作重复 hash。

兼容性变化：目前只有 macOS arm64 有固定校验 manifest，实际验收系统为 macOS 27.0.1；x64/Rosetta、Linux、Windows 明确 `unsupported/unverified`，不再沿用 GUI 自动发现。最低 Darwin major 门禁为22，低于该版本拒绝；其他 macOS 版本未做真实运行验收，不宣称已验收。

版本来源为官方 npm `playwright-core@1.58.2` 的 `browsers.json`；npm 包由 `package-lock.json` 的 registry URL/SHA-512 integrity 固定。`lib/headless-browser.lock.json` 的资源 SHA-256 是本地对官方 CLI 下载字节计算并实际运行核验的**测量值**，不是上游签名；下载源为 `https://cdn.playwright.dev/builds/cft/145.0.7632.6/mac-arm64/chrome-headless-shell-mac-arm64.zip`。更新版本/增加平台必须同步固定 dependency/lock、官方 manifest 与完整安装测量值，在真实目标 OS/原生架构运行 DOM/截图/版本及无 GUI 验收后再开放；禁止根据缓存目录名自动扩兼容。

## 产物与限制

- 本地入口：`index.html`，资源目录：`assets/`
- 单文件副本：`index.mhtml`
- 截图与报告：`source.png`、`local.png`、`report.json`、`manifest.json`

本地 HTML 和 MHTML 移除脚本、事件处理器、嵌入页面和主动跳转，添加限制性的 CSP；离线验证禁用 JavaScript，隔离浏览器不启用跨本地文件读取特权。**不会复制原站 API、登录态、脚本或交互功能。**

采集滚动页面以加载懒加载内容，不自动点击通用按钮，也不调用原站轮播或 fullpage 翻页 API。尚未渲染、需要点击或接口请求才能出现的内容可能缺失。源站在线加载仍会运行源站自身的脚本。

普通外部 SVG 图标和渐变、滤镜等 paint 定义会内联以减少离线加载限制，覆盖属性、内联 CSS、页面样式及捕获的普通外部样式表。含主动内容、重复 ID 或样式表（`style`、`link`、XML stylesheet）的 SVG 不晋升到宿主 DOM，避免污染整页；保留原外部引用，不通过删除样式伪造完整还原。复杂或不支持的引用不强行改写；无法本地化或离线加载失败会进入报告并返回 `partial`。

输出目录必须为空，或能通过 `manifest.json`、`report.json` 及资源清单确认是既有 `huoqu` 副本。支持记录完整的旧版产物；无法确认归属时拒绝覆盖。不会仅凭 `index.html`、`assets/` 等文件名自动覆盖。替换失败时恢复旧内容；恢复失败则保留备份并报告位置。

只有资源引用完整、离线 HTML/MHTML 预览成功、页面内容和图片检查通过，且浏览器清理成功，结果才标为 `completed`。已保存但检查未通过返回 `partial`，具体原因记录在 `report.json`。浏览器清理失败阻止新产物发布和旧副本替换；原错误与清理错误同时保留，进程退出超时则保留 profile 并报告路径。生成文件不等于验证通过。

## DSH 权限与后台任务

插件通过现有 `sandboxPolicy` 和 `fs` 服务检查所有输出事务及浏览器临时目录的写入、替换、回滚和清理；服务缺失或策略未知时拒绝运行，不自行提升权限。不需要修改 DSH 官方源码。

- 工具调用使用当前会话的文件策略及工作区。
- 侧栏采集会带上当前对话的 `sessionId`，并使用该会话已经生效的文件策略，不另造 `danger-full-access`，也不接受请求里的权限提升字段。未关联会话、或会话未加载时拒绝采集，不会悄悄退回 Host 默认策略。
- 所有 HTTP 操作都必须传入有效 `sessionId`：GET 列表/状态使用查询参数；POST 采集、取消、打开及选择文件夹使用 JSON 字段。缺失、空白或畸形 ID 返回 400；不存在或仅在历史中、尚未加载的会话返回 403；服务不可用返回 503。不会主动加载历史会话，也不接受 agentless 工具调用或默认工作区回落。
- `read-only` 拒绝采集；`workspace-write` 仅允许规范化后的工作区、`/tmp` 和平台临时目录；`danger-full-access` 不限制写入位置。
- 默认输出在 `~/Downloads/huoqu/`。`workspace-write` 下该位置会被拒绝，应改到工作区或临时目录；当前会话为 `danger-full-access` 时可以写入。

任务绑定创建时的 loaded Session 对象，列表、状态、取消及本地打开均只认同一归属；另一会话请求返回 404，不泄露 URL、路径和结果。卸载后重新加载同 ID 的会话也不继承旧对象的任务。排队执行及每次文件写入/回滚/清理前重新确认 live 身份并解析最新策略；收紧策略或卸载会话后，无法获准的清理不会绕过策略，错误会报告残留临时目录/浏览器 profile 的位置。只读模式仍允许查看、打开自己的既有结果及请求停止；停止浏览器和退出清理不使用原始授权缓存。侧栏切换会话会清空旧结果并丢弃迟到响应，缺少会话时禁用采集和目录选择。

侧栏任务串行运行，最多保留 4 个运行或排队任务；排队开始 240 秒后请求停止，并等待清理退出，不强制将仍在清理的任务标为已结束。支持取消、列表恢复和组件重新挂载后继续查询。终态任务最多保留 1 小时、最多 40 条；Host 重启不会持久恢复旧任务。取消或超时先显示正在停止，待清理退出后才进入终态并释放运行位置。插件卸载会请求停止并等待任务及工具调用清理。

macOS 打开本地文件会等待 `open` 的退出状态；失败会显示错误，不再将进程启动视为打开成功。

## 安装

复制到 `$DSH_HOME/plugins/huoqu`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: huoqu
      name: ../../plugins/huoqu/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开并建立新会话，侧栏会出现「网页获取」。Host 修改和新工具 schema 需要重启/新会话才能加载；仅保存源码并不会更新正在运行的 Host。以当前会话的侧栏 GET `version: "0.2.2"`、新工具 purpose/backend/browser_identity schema 及 capture 结果 `pluginVersion: "0.2.2"` 核对实际加载版本，不能以源码单测代替已部署验收。

## 0.1.1 修复

保留重定向资源的原始地址映射；补齐 CSS `image-set()`、独立 SVG 及 SVG 属性的资源发现和离线改写。额外下载最多尝试 1200 个资源，读取字节共享 1000 MiB 预算，失败响应也占用预算，耗尽后停止新请求。普通资源单个不超过 200 MiB；页面里的视频和音频单个不超过 640 MiB，仍受总预算限制。最终 MHTML 不超过 1000 MiB。源站返回 404 或 410 的引用会从静态副本里去掉，不再因此把整次采集判失败。修复 IPv4 映射 IPv6 的私网识别，以及普通正文包含 “Just a moment” 时被误判为验证页的问题。静态化、权限、任务生命周期及清理修复见上述说明。

补修覆盖外部 SVG paint 的依赖、ID 冲突与样式隔离；侧栏任务列表乱序、文件夹选择及打开操作的迟到响应不覆盖新任务状态。移除来源、MHTML 和离线预览的绝对 1000 字符下限，有意义的短页面不再被误拒绝或误报 `partial`；仍验证原始 HTML 非空、MHTML MIME 结构及大小上限，保留正文不足、验证/拒绝页与丢图检查。正式 Chrome 扩展及快照失败时的 DOM 回退保留真实 `DOCTYPE`，包括分块读取，避免丢失文档模式造成布局偏移；不会给原本没有 `DOCTYPE` 的页面强加声明。

## 开发与验证

当前 Host/桥接测试依赖同级 `chrome/` 中的配套插件。这是开发测试依赖；运行时无配套插件，仅显式 anonymous/prefer-current 场景允许使用固定隔离 shell，默认 current 场景拒绝改变身份。共享验证逻辑来自 `vendor/browser-execution/` 中同一官方 source-provenance artifact，完整五包闭包为相对 file 依赖，锁定于 npm lock；插件只保留 tiny wrapper + 静态 pin JSON，不复制通用 resolver 或从绝对源码 checkout 运行。更新共享产物必须重建真实依赖 lock，并核对三个消费者 artifact SHA 一致。当前实际安装为 private off-cycle `0.2.1-alpha.2.browser-policy.1`，tarball SHA-256 `efae81d6fab57b12aa5c3a4663f42e379344b5a0a9b61b302a8ee55b3ae80b14`，官方源码 provenance SHA-256 `60bf07c6a6f8d5385aee45cb541128127e4645a3061532a93e6f1c47f88cc369`；不是官方 full release，也未修改已安装 ASAR。metadata 的 `policyPackage` 读取标准 package export 中真实 installed version/localArtifactVersion/sourceSha256，不能以 filename 或缓存常量自证。

```bash
for file in lib/*.js; do /usr/local/bin/node --check "$file" || exit; done
/usr/local/bin/node --test test/*.test.mjs
# 可选：全部回归，包含真实隔离 Chrome 安全与 SVG 像素测试，不访问用户正式 Chrome
HUOQU_BROWSER_TESTS=1 /usr/local/bin/node --test test/*.test.mjs
# 可选：对只读官方包运行真实 SessionStore / sandboxPolicy / FS 契约测试
DSH_OFFICIAL_ROOT=/path/to/official/dsh HUOQU_BROWSER_TESTS=1 /usr/local/bin/node --test test/*.test.mjs
```

会话回归覆盖所有 HTTP 操作缺失/空白/畸形 ID 拒绝、历史/未加载对象拒绝、跨会话列表/状态/取消/打开隔离、排队后卸载与收紧策略、取消时的清理权限、切换会话的迟到响应。可选官方集成直接使用 Cordis Context、SessionStore、SessionProjectionRegistry、SandboxPolicyService 与 LocalFileSystem：官方 `SessionStore.get(id)` 只返回 live 对象，`prepare()` 的 detached 会话不可执行，`resolve({ session })` 从投影事件读取实时 mode 和 session 工作区；本插件不调用默认 `resolve({})`，也不制造会话对象。

常规测试覆盖权限、任务取消/卸载/恢复、过期取消响应不覆盖新任务选择、参数规范化、资源限制、IPv6 私有地址、别名重定向、静态化、输出事务、Chrome 启动失败及清理失败；新增完整采集路径的短正文、小 MHTML、畸形/空归档拒绝，以及短路径/分块读取的 HTML5、传统和缺省 DOCTYPE。真实浏览器回归使用无害合成页面，检查自动业务按钮未触发、正常 MHTML 与快照失败的 HTML 回退均不执行本地文件读取脚本；嵌套 data 样式表在线生效、离线被 CSP 阻止且如实返回 `partial`。真实 SVG 和短页面分别覆盖正常快照与 DOM 回退：安全页面 `completed`、源站/HTML/MHTML 截图字节相同，带样式 SVG 仍为 `partial` 且不污染宿主；短页面同时验证标准模式和无 DOCTYPE 的 quirks 模式。
