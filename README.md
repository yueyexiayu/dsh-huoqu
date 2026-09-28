# huoqu

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

在 DeepSeek Harness 里采集一个网页的渲染结果，保存为可离线打开的本地副本。

当前插件需要配合 [Chrome 插件项目](https://github.com/yueyexiayu/dsh-chrome) 的 Chrome 扩展。网页获取会复用这个扩展，在当前正式 Chrome 的后台标签里打开页面，不另开调试端口。扩展未连接时才会退回隔离的无头 Chrome，部分站点会把无头浏览器当成可疑请求拦截。

- 本地入口：`index.html`
- 单文件副本：`index.mhtml`
- 资源目录：`assets/`
- 截图和检查报告：`source.png`、`local.png`、`report.json`

这是指定 URL 的静态页面快照，不复制源站 API、登录态或所有交互状态。纵向分屏会展开成可滚动的整页；某一屏内部的横向轮播仍只保留当时可见的卡片。

## 安装

复制到 `$DSH_HOME/plugins/huoqu`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: huoqu
      name: ../../plugins/huoqu/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。侧栏会出现「网页获取」。

使用前请先安装并连接 [dsh-chrome](https://github.com/yueyexiayu/dsh-chrome) 的 Chrome 扩展。这是配套要求，不是可选项。

## 开发

```bash
/usr/local/bin/node --check lib/index.js lib/capture.js lib/archive.js lib/parse.js lib/client.js
/usr/local/bin/node --test test/*.test.mjs
```
