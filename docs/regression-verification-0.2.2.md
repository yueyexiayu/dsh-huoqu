# 0.2.2 回归修复与双路径真实验收

日期：2026-10-15，Asia/Tokyo。此记录区分既有基础、本次修复、真实采集与未验证边界。

## 修改与版本

- 入场工作区为 0.2.1，HEAD 包元数据仍为 0.1.1；执行策略、固定 headless、所有权生命周期及会话接线已存在但尚未提交。本次保留这些基础，不将其冒称本次新功能。
- [导入夹具](../test/module-fixture.mjs)统一支持静态相对 import/re-export 的合法单双引号与 `./`、`../`；[产品采集实现](../lib/capture.js#L3)的 `from './owned-process.js'` 不改。新增[单双引号真实导入回归](../test/module-fixture.test.mjs)。
- [版本断言来源](../test/package-fixture.mjs)独立读取插件包、已安装 policy 包和固定 headless lock，不混淆三者版本。[执行元数据](../lib/execution.js#L1-L9)直接从[插件包](../package.json)派生 HUOQU_VERSION；[lock](../package-lock.json)与[说明](../README.md)同步 0.2.2。
- 导入修复后暴露 11 项旧夹具问题：合成浏览器未登记 OWNED_CHROME。仅在[测试内存模块](../test/capture.test.mjs#L151-L187)登记 synthetic record，继续调用真实 stopChrome；新增伪造/复制 handle 拒绝回归。不削弱产品所有权、不跳过失败项、不改变身份/权限。默认套件未发现新的产品缺陷。

## 测试结果

用户给定原始结果为 **179 tests / 128 pass / 51 fail，exit 1**，不是全通过；[原日志](</tmp/dsh-nonchrome-audit-h3elw87t/huoqu.log>)仍存在。本轮默认集合现场重现及修复记录：

| 日志 | total | pass | fail | 原有 opt-in skip | exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| [before](</tmp/huoqu-test-fixtures-MkyToW/before.tap>) | 189 | 128 | 51 | 10 | 1 |
| [导入修复后](</tmp/huoqu-test-fixtures-MkyToW/after.tap>) | 196 | 175 | 11 | 10 | 1 |
| [owned 夹具修复后](</tmp/huoqu-test-fixtures-MkyToW/after-owned.tap>) | 197 | 187 | 0 | 10 | 0 |

增加的计数来自 resources 整文件导入错误解除后恢复的子测试及新增回归，不把 skip 计为通过。见[逐项说明](</tmp/huoqu-test-fixtures-MkyToW/summary.md>)。

最后实际运行全部 opt-in 浏览器与当前已安装官方包契约：

```sh
DSH_OFFICIAL_ROOT='/Applications/DeepSeek Harness 0.2.1-alpha.2.20261015.1.app/Contents/Resources/app.asar/dsh' \
HUOQU_BROWSER_TESTS=1 ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness 0.2.1-alpha.2.20261015.1.app/Contents/MacOS/DeepSeek Harness' \
--test --test-reporter=tap test/*.test.mjs
```

[工作区首轮完整日志](</tmp/huoqu-acceptance-0afb275b-XUv44z/full-browser-official.tap#L1193-L1199>)：**197/197 pass、0 fail、0 cancelled、0 skip，exit 0**。包含真实 headless 安全、短页面、SVG/DOM fallback，以及实际官方 SessionStore / projection / sandboxPolicy / LocalFileSystem 契约。全部 lib/*.js 语法、版本来源一致性及 git diff --check 亦通过。

提交前又导出精确暂存树并在项目自身目录离线 `npm ci --ignore-scripts --offline`，成功安装全部 6 个锁定依赖。用只读 symlink 提供当前同级 Chrome 项目（不复制/提交其源码）；[首次导出树运行](</tmp/huoqu-acceptance-0afb275b-XUv44z/staged-full-browser-official.tap>)为 **185 pass / 12 fail**：Node realpath 规范化绕过旧 load hook，使合成身份测试误触真实桥并被拒绝。不是产品身份降级，更不能隐藏这次失败。

[边界夹具](../test/execution.test.mjs#L17-L61)现在仅对本次唯一合成 URL 在 resolve 阶段精确短路，其他解析和错误注入不变。新增真实 temp symlink 回归的 canonical 目标只抛本地 sentinel，漏 hook 也绝不连接真实 Chrome。[修复前](</tmp/huoqu-symlink-fixture-hy4it1/before.tap>)安全复现失败；[普通 Node 修复后](</tmp/huoqu-symlink-fixture-hy4it1/after.tap>)与[当前 App Node 修复后](</tmp/huoqu-symlink-fixture-hy4it1/after-app-node.tap>)均 16/16、0 skip，exit 0。新增此项后全量计数从 197 增为 198。

**最终精确导出树**再次[离线安装成功](</tmp/huoqu-acceptance-0afb275b-XUv44z/final-staged-install.log>)，随后按同一官方 App/ASAR/真实 shell 命令[实际运行 198/198 pass，0 fail、0 cancelled、0 skip，exit 0](</tmp/huoqu-acceptance-0afb275b-XUv44z/final-staged-full-browser-official.tap#L1199-L1205>)。校验树为 `721ffcc842156c4a191309383a3024518bca5b76`，之后仅补充本验收文档；源码/测试与校验树一致。末次按本任务固定 revision 1208 检查无存活进程或 profile 残留。较早一项过宽的“所有 shell 都必须退出”检查因其他任务 revision 1243 shell 而失败，已改为只读核查[本任务所有权范围](</tmp/huoqu-acceptance-0afb275b-XUv44z/final-scoped-cleanup.json>)，没有触碰其他任务进程。

## 实际加载、一次失败与重启边界

- 当前 App 的 Node 模式能解析其只读 ASAR；普通 Node 直接读取该虚拟路径失败，不用普通 Node 的失败冒充官方契约成功。
- 首次从独立官方 App Node 进程连接原生桥，真实失败 `Chrome connection closed during handshake`，无产物或残留 profile。[acceptance.log](</tmp/huoqu-acceptance-0afb275b-XUv44z/acceptance.log>)和[初次汇总](</tmp/huoqu-acceptance-0afb275b-XUv44z/acceptance-summary.json>)保留失败，**不是最终成功汇总**。未放宽 peer/token/protocol/单控制器规则，未重复竞争此连接。
- 后续沿用原 Host 已连接扩展。经其已安装官方 HMR，在 runExclusive 内定向 invalidate 本插件 manifest / partialReload。重载前工具 pending captures=0，仅 include:huoqu 的 fiber 从 162 变为 447，注册及 VERSION=0.2.2，其他 entry generation 未变。见[运行代证据](</tmp/huoqu-acceptance-0afb275b-XUv44z/hmr-huoqu.log>)。
- 未修改官方源码、手工替换工具函数或改 profile。**没有完整退出 DSH 再打开**，不等同于 [dsh-plugin skill 第 5 条](</Users/ning/.dsh/skills/dsh-plugin/SKILL.md#L108-L109>)的重启步骤；加载结论来自新 fiber 和之后真实工具产物 pluginVersion，不来自磁盘声明/刷新。重启持久化未在本轮验收。

## 双路径真实工具采集

使用本任务独有 loopback 页面、CSS、SVG、全新输出目录和 HttpOnly 测试 cookie。cookie 仅证明受控状态保留/隔离，**不是实际账号登录验收**。

| 产物报告 | 实际 source | 实际浏览器 | 离线 verifier | 结果 |
| --- | --- | --- | --- | --- |
| [当前 Chrome](</tmp/huoqu-acceptance-0afb275b-XUv44z/current-host/report.json>) | current / chrome-extension / headed / borrowed-connection | Chrome 153.0.8010.37，扩展 0.2.4 | owned anonymous shell 145.0.7632.6 | completed / passed |
| [独立匿名](</tmp/huoqu-acceptance-0afb275b-XUv44z/anonymous-host/report.json>) | anonymous / cdp-websocket / headless / owned-process | shell 145.0.7632.6，Playwright 1.58.2 revision 1208 | 同批次自有 shell | completed / passed |

两次均通过真实 `huoqu` 工具、当前 loaded Session 的文件策略执行，pluginVersion 均 **0.2.2**；各自 source/verifier scope 一致，两次 taskId 不同，无 downgrade reason。当前身份副本包含 CURRENT_COOKIE_PRESENT，匿名包含 ANONYMOUS_NO_COOKIE。各有 2 项本地资源、1 张已加载图片，无远端资源引用、下载失败或离线 issues。

已实际检查两组 HTML、MHTML MIME/正文、manifest 资源字节数、报告，以及六张 960×720 PNG 的真实 magic/尺寸/SHA-256，不只核对路径。

## 停服后的独立离线复验

清除本任务 cookie（真实 fetch /state 返回 hasFixture=false）并停止服务器后，运行[独立复验脚本](</tmp/huoqu-acceptance-0afb275b-XUv44z/verify-offline.mjs>)：先断言源站不可连接，再由本插件 Playwright `chromium.launch({headless:true})` 启动，不传 channel 或 executablePath。复用一个自有 browser、隔离 context，offline=true、JavaScript=false、service worker blocked、cache disabled，重新打开四份 HTML/MHTML。

四份均通过标题/正文身份标记、图片、无脚本、零 HTTP 尝试/请求失败；新截图逐字节匹配保存的 local/archive-preview。**未宣称 current source 截图与离线 verifier 相同**：source 为 Chrome 153，verifier 为 shell 145，实际 hash 不同。匿名 source/local/archive 三者 hash 相同。

最终成功证据：[离线日志](</tmp/huoqu-acceptance-0afb275b-XUv44z/verify-offline.log>)及[完整文件哈希/身份/回放记录](</tmp/huoqu-acceptance-0afb275b-XUv44z/offline-independent.json>)。独立复核又重算两组共 18 份文件长度/哈希，与记录一致。

## 生命周期与无 GUI 证据

- [监测汇总](</tmp/huoqu-acceptance-0afb275b-XUv44z/gui-process-summary.json>)：07:14:41–07:22:24Z 共 672 个 AppKit/窗口/进程采样，未发现新增 regular GUI App 或 headless/Chromium 窗口。用户 Chrome 主 PID 始终 24855；末次仅剩原有 Chrome，无 shell 进程。用户在 DSH 和其他两个应用间切换，不能说“全程焦点不变”；未采样到 Chrome/headless 抢焦点。
- 自有 browser/context 均关闭，无新 dsh-huoqu-chrome profile 残留。[任务 owner 清理](</tmp/huoqu-acceptance-0afb275b-XUv44z/task-owner-cleanup.json>)确认 captureSessions、ownerCleanups、unconfirmedCreates 均为 0，无本任务 page/capture owner entries。
- [Host 总体状态](</tmp/huoqu-acceptance-0afb275b-XUv44z/chrome-cleanup.json>)仍有非本任务 page/诊断记录，本任务普通交互 owner 亦留 resourceActivity 诊断项；未关闭他人 page，未将所有 Host map 说成空。本任务服务器、monitor 均停止，未退出用户 Chrome。
- 故障、取消、回滚/清理失败的可见性由实跑全量回归覆盖，未额外声称做过真实 worker crash 注入。

## 三组契约的可证状态

1. Chrome 修复：已有[验收记录](../../chrome/docs/native-bridge-verification.md)，工作区 252/252 与实际暂存树 206/206 为不同范围；本轮再次真实握手确认 adapter 0.2.2 / extension 0.2.4 / Chrome 153.0.8010.37。hard worker crash、完整重启不在本轮通过范围。
2. huoqu：本记录的回归修复、197/197、双真实采集和独立离线复验完成。
3. 其他插件：可恢复旧非 Chrome 审计为 12 插件 1110 tests / 1057 pass / 52 fail / 1 skip；其中 huoqu 51 fail 本轮解除，[shengcheng 原 1 fail](</tmp/dsh-nonchrome-audit-h3elw87t/shengcheng.log#L2-L21>)因缺 DSH_OFFICIAL_ROOT，[shichang skip](</tmp/dsh-nonchrome-audit-h3elw87t/shichang.log#L151-L155>)不能抹去。另 7 插件官方 API 补测 83/83 通过，不等于重跑全部套件/运行态；如[huoqu 原官方补测](</tmp/dsh-official-plugin-audit-yuia75da/huoqu.log>)仅 1 项。未恢复“三份原始契约”的完整命名文本，故只汇总可证三组，不虚构第三份定义或全通过。

其他插件只核对现存测试/集成日志；**没有做真实登录、生图、在线额度、全部 UI 或全部功能验收**，不以隔离测试或受控 cookie 替代。

## Git 范围

入场 tracked diff 已保存，index 为空。用户看过依赖冲突后明确批准“允许纳入必要前置并提交”。先提交既有 0.2.1 浏览器执行基础，再提交本次 0.2.2 修复；仅本插件必要生产闭包、测试/文档，不含其他插件。前置提交保留已知旧夹具失败，由后一提交修复，不冒称前置测试全通过。
