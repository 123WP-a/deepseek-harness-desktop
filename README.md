# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/main/LICENSE) 许可）的 Windows 桌面封装：双击即可启动，自动拉起内置的 `dsh web` 服务器并在 Electron 窗口中打开 Web GUI。

> ⚠️ **非官方项目**：这是个人维护的桌面封装，与 DeepSeek 官方无关。DeepSeek 及 DeepSeek Harness 商标归其各自所有者所有。

## 特性

- **点击即启动**：应用自行启动 `dsh web` 服务器，无需手动起服务、无需浏览器标签页。
- **无"拒绝连接"**：窗口只在服务器就绪（打印就绪行 **且** 返回 HTTP 200）后才打开；启动失败会弹错误对话框显示日志，而不是白屏。
- **端口零冲突**：服务器以 `--port 0` 启动，由操作系统分配空闲端口。
- **干净退出**：关闭窗口即终止服务器进程树；单实例锁防止重复启动。
- **用户数据**：会话、设置、凭据存储在标准 `$DSH_HOME`（默认 `~/.dsh`），与 CLI/Web 版一致。

## 目录结构

```
desktop/
  main.js                    Electron 主进程（应用外壳）
  package.json               外壳清单
  scripts/
    prepare-runtime.js       准备服务器运行时闭包
    make-icon.js             从官方 favicon.svg 生成应用图标（需 sharp）
    build.js                 组装可分发的应用目录
  assets/deepseek.ico        应用图标（来自官方 favicon.svg）
  runtime/                   [生成] dsh 服务器运行时闭包
  dist/DeepSeek Harness/     [生成] 应用目录
```

## 构建步骤（Windows）

前置要求：[Node.js](https://nodejs.org/) ≥ 22.19（或 ≥ 24）。

```sh
cd desktop
npm install                     # 安装 Electron（postinstall 会下载二进制）
node scripts/prepare-runtime.js # 准备服务器运行时闭包
node scripts/build.js           # 组装 dist/DeepSeek Harness/
```

完成后双击 `dist/DeepSeek Harness/DeepSeek Harness.exe` 即可启动。

构建单文件便携版（可选）：

```sh
npx electron-builder --win portable --config electron-builder.config.cjs \
  --prepackaged "dist/DeepSeek Harness"
# → dist/installer/DeepSeek-Harness-<version>-portable.exe
```

> 网络受限时：Electron 二进制下载可用
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_CUSTOM_DIR={{ version }}`、
> `electron_config_cache=<可写目录>` 加速；electron-builder 辅助二进制用
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 工作原理

`main.js` 是核心（约 260 行，无第三方运行时依赖）：

1. 用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）以 `--port 0` 拉起服务器；
2. 解析 stdout 就绪行 `dsh web: http://127.0.0.1:<port>`，再轮询该 URL 直到 HTTP 200；
3. 然后才创建 `BrowserWindow` 加载该 URL；
4. 服务器异常退出时显示错误对话框（可重试），关闭窗口时终止服务器进程树。

## 许可

- 本项目代码：MIT（见 [LICENSE](./LICENSE)）。
- 基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），运行时随 Electron 分发。
- 图标来自官方仓库的 `apps/web/public/favicon.svg`（黑色鲸鱼 logo），仅作标识用途。

## 已知限制

- 仅支持 Windows（目标平台 win32-x64）；macOS/Linux 需调整 `main.js` 的进程树终止逻辑。
- 桌面版与浏览器版 `dsh web` 使用同一 `$DSH_HOME`；两者同时运行可能产生会话写入竞争，建议只开其一。
