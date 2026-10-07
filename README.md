# huoqu

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

在 DeepSeek Harness 里采集网页的当前渲染结果，保存为可离线打开的**静态副本**。

连接 [Chrome 插件](https://github.com/yueyexiayu/dsh-chrome) 的扩展时，复用当前正式 Chrome 的后台标签和登录状态，不另开调试端口。未安装插件或扩展未连接时，退回隔离的无头 Chrome；部分站点会拦截无头浏览器。配套 Chrome 插件需提供 `openCaptureSession`。采集使用独立所有权，完成、取消后释放，不接管对话正在操作的标签。

## 产物与限制

- 本地入口：`index.html`，资源目录：`assets/`
- 单文件副本：`index.mhtml`
- 截图与报告：`source.png`、`local.png`、`report.json`、`manifest.json`

本地 HTML 和 MHTML 移除脚本、事件处理器、嵌入页面和主动跳转，添加限制性的 CSP；离线验证禁用 JavaScript，隔离浏览器不启用跨本地文件读取特权。**不会复制原站 API、登录态、脚本或交互功能。**

采集滚动页面以加载懒加载内容，不自动点击通用按钮，也不调用原站轮播或 fullpage 翻页 API。尚未渲染、需要点击或接口请求才能出现的内容可能缺失。源站在线加载仍会运行源站自身的脚本。

普通外部 SVG 图标会内联以减少离线加载限制；含主动内容或复杂递归引用的 SVG 不强行改写。无法本地化或加载失败的资源会进入报告，不会静默视为通过。

输出目录必须为空，或能通过 `manifest.json`、`report.json` 及资源清单确认是既有 `huoqu` 副本。支持记录完整的旧版产物；无法确认归属时拒绝覆盖。不会仅凭 `index.html`、`assets/` 等文件名自动覆盖。替换失败时恢复旧内容；恢复失败则保留备份并报告位置。

只有资源引用完整、离线 HTML/MHTML 预览成功、页面内容和图片检查通过，且浏览器清理成功，结果才标为 `completed`。已保存但检查未通过返回 `partial`，具体原因记录在 `report.json`。浏览器清理失败阻止新产物发布和旧副本替换；原错误与清理错误同时保留，进程退出超时则保留 profile 并报告路径。生成文件不等于验证通过。

## DSH 权限与后台任务

插件通过现有 `sandboxPolicy` 和 `fs` 服务检查所有输出事务及浏览器临时目录的写入、替换、回滚和清理；服务缺失或策略未知时拒绝运行，不自行提升权限。不需要修改 DSH 官方源码。

- 工具调用使用当前会话的文件策略及工作区。
- 侧栏 HTTP 任务不绑定对话会话，使用 DSH **部署默认策略及工作区**，不是当前对话的会话覆盖策略。
- `read-only` 拒绝采集；`workspace-write` 仅允许规范化后的工作区、`/tmp` 和平台临时目录；`danger-full-access` 不限制写入位置。
- 默认输出在 `~/Downloads/huoqu/`。受限工作区下应显式选择工作区或临时区内的输出目录，否则拒绝写入。

侧栏任务串行运行，最多保留 4 个运行或排队任务；排队开始 240 秒后请求停止，并等待清理退出，不强制将仍在清理的任务标为已结束。支持取消、列表恢复和组件重新挂载后继续查询。终态任务最多保留 1 小时、最多 40 条；Host 重启不会持久恢复旧任务。取消或超时先显示正在停止，待清理退出后才进入终态并释放运行位置。插件卸载会请求停止并等待任务及工具调用清理。

macOS 打开本地文件会等待 `open` 的退出状态；失败会显示错误，不再将进程启动视为打开成功。

## 安装

复制到 `$DSH_HOME/plugins/huoqu`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: huoqu
      name: ../../plugins/huoqu/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开，侧栏会出现「网页获取」。Host 修改需要重启才能加载；仅保存源码并不会更新正在运行的 Host。

## 开发与验证

```bash
for file in lib/*.js; do /usr/local/bin/node --check "$file" || exit; done
/usr/local/bin/node --test test/*.test.mjs
# 可选：真实隔离 Chrome 安全回归，不访问用户正式 Chrome
HUOQU_BROWSER_TESTS=1 /usr/local/bin/node --test test/browser-security.test.mjs
```

常规测试覆盖权限、任务取消/卸载/恢复、过期取消响应不覆盖新任务选择、参数规范化、资源限制、IPv6 私有地址、别名重定向、静态化、输出事务、Chrome 启动失败及清理失败。真实浏览器回归使用无害合成页面，检查自动业务按钮未触发、正常 MHTML 与快照失败的 HTML 回退均不执行本地文件读取脚本；嵌套 data 样式表在线生效、离线被 CSP 阻止且如实返回 `partial`，安全页面仍返回 `completed`。
