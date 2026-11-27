# 验收记录 · huoqu 0.2.13

日期：2026-11-28。本记录只写本次**实测**结果；未跑的部分在第 5 节逐条列出，不并入通过。
本记录随 `v0.2.13` 一并提交；精确校验树用 `git rev-parse v0.2.13^{tree}` 取，不写死哈希以免记录自身改树。

## 1. 版本与改动范围

| 项目 | 值 |
| --- | --- |
| 插件版本 | `0.2.13`（`package.json` 唯一来源；`HUOQU_VERSION` 由此派生） |
| 依赖 | `playwright-core@1.58.2`（唯一运行时依赖） |
| 产品代码 | 未改动（`lib/` 与 0.2.12 相同） |
| 本次改动 | 新增 `docs/API.md`、`CHANGELOG.md`、`AGENTS.md`、本记录；双语 README 增加文档索引；`test/official-session.test.mjs` 适配官方 `announce()` 契约；`.gitignore` 忽略 `.jilv/`；版本递增 0.2.12 → 0.2.13 |

## 2. 环境

| 项目 | 实测值 |
| --- | --- |
| 机器 / 系统 | macOS 27.0.1（Darwin 27），arm64 |
| Node.js | v26.13.1（宿主要求 ≥ 22.17） |
| 浏览器引擎 | `chromium_headless_shell-1208`，Chromium `145.0.7632.6`，`playwright-core` 1.58.2 |
| 官方包（可选契约用例） | DSH `0.2.3-alpha.2`，只读 ASAR `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh` |

## 3. 实跑的三套验证

```sh
cd "$DSH_HOME/plugins/huoqu"
for file in lib/*.js; do node --check "$file" || exit 1; done   # 全部 lib/*.js 语法通过
node --test test/*.test.mjs                                      # 默认套件
HUOQU_BROWSER_TESTS=1 node --test test/*.test.mjs                # 加真实隔离 shell 用例
DSH_OFFICIAL_ROOT='<dsh asar>/dsh' ELECTRON_RUN_AS_NODE=1 HUOQU_BROWSER_TESTS=1 \
  '<DSH.app>/Contents/MacOS/DeepSeek Harness' --test --test-reporter=tap test/*.test.mjs
```

| 套件 | tests | pass | fail | skipped | exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 默认（无浏览器 opt-in） | 225 | 215 | 0 | 10 | 0 |
| 浏览器 opt-in（`HUOQU_BROWSER_TESTS=1`） | 225 | 224 | 0 | 1 | 0 |
| 官方包契约（官方 Node + ASAR + 浏览器 opt-in） | 225 | 225 | 0 | 0 | 0 |

被跳过的是 opt-in 用例，**不计入通过**：默认套件跳过的 10 项是 8 个 `isolated Chrome` 用例与 1 个官方 SessionStore 契约用例等；浏览器 opt-in 只剩官方 SessionStore 一项（缺少 `DSH_OFFICIAL_ROOT` 时不跑）；第三套补齐这一项。

## 4. 本次修掉的一个真实失败

对着已安装的官方 DSH `0.2.3-alpha.2` 首次运行契约用例时是 **224 pass / 1 fail / exit 1**：

```
not ok 156 - official live SessionStore, projection policy and local FS honor dynamic session boundaries
error: 'session "huoqu-official-fixture" cannot append before session/created completes'
```

原因是官方 `SessionStore` 从 `0.2.3-alpha.2` 起不再让 `enter()` 隐含 `session/created`：进入 store 的会话在 `announce()` 完成前一律拒绝追加事件（官方实现里 `publicationEntry` 显式抛错）。夹具直接 `setSandboxMode(...)` 追加事件，因此失败。
修法是夹具在 `enter()` 之后调用 `ctx.sessions.announce?.(session)`（旧版没有该方法时自动跳过）。修正后第三套 225/225、0 skip、exit 0。
**这不是产品降级**：`lib/` 只读会话，不创建、不追加。

## 5. 未验证（不算通过）

1. **当前 Chrome 身份的部署采集**：未运行。需要同级 [dsh-chrome](https://github.com/yueyexiayu/dsh-chrome) 插件与扩展；本记录不声称该路径已验收。
2. **Desktop BrowserHost 的内置身份采集**：未在真实宿主里跑工具调用；只由源码与单元/集成用例覆盖。
3. **侧栏界面加载验收**：本版未做 ⌘Q 重开后的侧栏核对。`0.2.13` 只改了文档、夹具与版本号，加载后侧栏 `GET version`、工具 schema 与结果 `pluginVersion` 应为 `0.2.13`——这条要由重启后的人工核对确认。
4. **重启持久化**：未验证 Host 重启后任务/产物的表现（设计上任务不跨重启保留）。
5. **其它平台**：Linux、Windows、非 arm64、其他 macOS 版本一律未验收；Darwin major < 22 直接拒绝。
6. **0.2.3–0.2.12 的验收**：这些版本没有验收记录；唯一既有记录是 [0.2.2 的回归核验](regression-verification-0.2.2.md)，其数字是当时的实测，不并入本记录。

## 6. 结论

在 macOS 27.0.1 / arm64 / Node v26.13.1 上，`0.2.13` 的三套验证全部 exit 0、零失败；产品行为与 0.2.12 相同。加载与两种真实身份的部署采集仍未验收，见第 5 节。
