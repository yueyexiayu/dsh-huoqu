# AGENTS.md · huoqu

本文件是**本仓库内部**的 AI 执行约定（命令、约束、禁忌）。全局约定在 `~/.dsh/AGENTS.md`，两者冲突时以本文件为准。
产品定位与边界见 [README](README.md#产物与边界)；对外契约见 [docs/API.md](docs/API.md)；变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 1. 这是什么

DSH 桌面插件（desktop profile bundle）：把网页的**当前渲染状态**保存成本地静态 HTML / MHTML 副本，并用自有隔离 shell 做离线核验。不是整站备份、不是交互回放、不迁移登录凭据。

## 2. 动手前必读

| 要改的东西 | 先看 |
| --- | --- |
| 采集、资源本地化、MHTML | `lib/capture.js`、`lib/archive.js`、[docs/API.md](docs/API.md) |
| 工具 schema、侧栏 HTTP、权限 | `lib/index.js`、`lib/client.js`、`lib/permissions.js` |
| 浏览器身份、执行策略、headless 固定 | `lib/execution.js`、`lib/browser-policy/`、`lib/headless-browser.lock.json` |
| 版本号相关 | `package.json`（唯一来源）、`lib/execution.js` 的 `HUOQU_VERSION` |

## 3. 必跑验证（改完立即跑，不许跳过）

```sh
cd "$DSH_HOME/plugins/huoqu"
for file in lib/*.js; do node --check "$file" || exit 1; done
node --test test/*.test.mjs
```

- 默认套件**不依赖**同级 Chrome 插件；2026-11-28 基线：225 tests / 215 pass / 0 fail / 10 skip / exit 0（skip 是需要真实浏览器的 opt-in 用例，不是通过）。
- opt-in 真实浏览器用例：`HUOQU_BROWSER_TESTS=1 node --test test/*.test.mjs`（使用固定隔离 shell，需要已 `npm run install:headless`）。
- 官方包契约用例：`DSH_OFFICIAL_ROOT` 指向只读官方 ASAR；查 SessionStore / sandboxPolicy / LocalFileSystem 真实契约。
- 夹具不得连接用户的正式 Chrome；模拟页面与源码测试**不能**替代部署验收。真实 Chrome 与 Desktop BrowserHost 必须分别做部署验收，并在验收记录里如实写「未验证」的部分。

## 4. 加载、重启与版本

- 作为 desktop profile bundle 加载：`$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 加 `link:$DSH_HOME/plugins/huoqu`，`dsh.profile.bundles` 加字符串 id `huoqu`。
- **禁止**再在 desktop `cordis.patch.yml` 里 `insert` 同一 id（两个实例）。仓库内 `cordis.patch.yml` 是本插件自己的 bundle 补丁，只管自己。
- Host / Client 改动必须 **⌘Q 完全退出 DSH 后重开并建新会话**，再核对侧栏 `GET version`、工具新 schema 与结果里的 `pluginVersion`。**不要自行重启 DSH 桌面端**——这件事交给用户人工做。
- 磁盘上的 `package.json` 版本 ≠ 已加载版本。不许用磁盘版本或刷新页面冒充加载成功。
- 版本号只改 `package.json` 一处，同步 `package-lock.json`、`README.md` 与 `README.en.md` 的版本声明；`HUOQU_VERSION` 从包元数据派生，不要手写第二份。测试会独立读取包、policy 包与 lock 三者校验一致性。

## 5. 安全与身份禁忌

- 不保存 Cookie / 登录态；MHTML 元数据、report、manifest 里的常见认证查询参数必须脱敏。页面正文自带的敏感数据按静态副本规则保存，**不要**额外抓取。
- 身份不可用时**明确失败**，不静默降级到匿名或另一身份；降级只能由 `browser_identity=prefer-current` 显式允许，且必须写进报告。
- 私网、loopback、链路本地、`.local` 默认阻止；只有 `allow_private: true` 才允许，三类后端共用同一策略。
- 输出目录：不是全新目录时必须由 `manifest.json` / `report.json` 证明归属；无法确认归属就拒绝覆盖，不要去猜「看起来像 huoqu 产物」。

## 6. 代码改动纪律

- 改动淘汰的旧实现、重复代码与死代码**同一提交内删除**，不注释保留、不留旧目录、不留「备用」分支；同步清理因此无用的 import、依赖、配置与测试。
- 删除前核对调用方（`lib/` 内部引用、`test/` 覆盖、README 与 docs 的声明）；历史实现靠 git 历史回查。
- 新增行为必须同时在 `test/` 有可复现断言，并在 [docs/API.md](docs/API.md) 或 [README](README.md) 更新契约；只改代码不改契约文档视为未完成。

## 7. 提交与发版

- 验证通过后默认 `git commit`；有 `origin` 时默认普通 `git push`（远端：`https://github.com/yueyexiayu/dsh-huoqu`）。
- 发版：`package.json` 递增版本 → 同步版本声明 → 跑第 3 节验证 → 更新 `CHANGELOG.md` 与 `docs/ACCEPTANCE-<version>.md` → commit & tag `v<version>` → push → GitHub Release。
- 递增版本前确认：本轮**实测**通过数写进验收记录，未验证的部分（另一平台、真实 Chrome、BrowserHost、重启持久化）逐条列出。

## 8. 工程体检（可选）

```sh
node ~/.dsh/skills/jilv/scripts/check.mjs scan . --out .jilv/scan.json
node ~/.dsh/skills/jilv/scripts/check.mjs verify . --scan .jilv/scan.json --judge .jilv/judge.json
```

`.jilv/` 是过程产物，已进 `.gitignore`；报告默认落到 `~/jilv-reports/`。
