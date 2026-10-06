# huoqu

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

在 DeepSeek Harness 里采集一个网页的渲染结果，保存为可离线打开的本地副本。

当前插件需要配合 [Chrome 插件项目](https://github.com/yueyexiayu/dsh-chrome) 的 Chrome 扩展。网页获取会复用这个扩展，在当前正式 Chrome 的后台标签里打开页面，不另开调试端口。扩展未连接时才会退回隔离的无头 Chrome，部分站点会把无头浏览器当成可疑请求拦截。

- 本地入口：`index.html`
- 单文件副本：`index.mhtml`
- 资源目录：`assets/`
- 截图和检查报告：`source.png`、`local.png`、`report.json`

本地副本会保留原站脚本和组件，尽量按采集时打开的样子复刻。依赖源站接口、登录态或采集时还没渲染出来的数据，仍然可能缺失。

输出目录必须为空，或能通过 `manifest.json`、`report.json` 及资源清单确认是既有 `huoqu` 副本。支持这些记录完整的旧版产物；无法确认归属的目录请保留，改用新的空目录。不会仅凭 `index.html`、`assets/` 等文件名自动覆盖。替换失败时恢复旧内容；恢复失败则保留备份并报告位置。

只有资源引用完整、离线 HTML 和 MHTML 预览成功、页面内容足够且图片加载通过，结果才会标为 `completed`。文件已保存但检查未通过时返回 `partial`，具体原因记录在 `report.json`；生成文件不等于离线验证通过。

Chrome 可能禁用 MHTML 内的脚本，交互组件请优先使用 `index.html`。普通外部 SVG 图标会内联到当前文档，避免离线跨文件限制；含脚本、目标缺失或复杂递归引用的 SVG 不强行改写，其加载失败会保留在检查报告中。

## 安装

复制到 `$DSH_HOME/plugins/huoqu`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: huoqu
      name: ../../plugins/huoqu/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。侧栏会出现「网页获取」。

使用前请先安装并连接 [dsh-chrome](https://github.com/yueyexiayu/dsh-chrome) 的 Chrome 扩展。这是配套要求，不是可选项。

Chrome 插件也需要更新到提供 `openCaptureSession` 的版本。采集使用独立的后台标签和所有权，完成或取消后释放，不切换对话正在操作的标签。

### 0.1.1 修复

保留重定向资源的原始地址映射；补齐 CSS `image-set()`、独立 SVG 及 SVG 属性的资源发现和离线改写。额外下载最多尝试 120 个资源，按读取字节限制 100 MiB 总预算，耗尽后停止新请求。修复 IPv4 映射 IPv6 的私网识别，以及普通正文包含 “Just a moment” 时被误判为验证页的问题。

## 开发

开发检出时，把 `dsh-chrome` 放在本项目同级的 `chrome/` 目录，供 Host 与采集测试使用。

```bash
for file in lib/*.js; do node --check "$file" || exit; done
node --test test/*.test.mjs
```
