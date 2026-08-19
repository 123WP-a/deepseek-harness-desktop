# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/main/LICENSE) 许可）的 Windows 桌面封装：双击即可启动，自动拉起内置的 `dsh web` 服务器并在 Electron 窗口中打开 Web GUI。

> ⚠️ **非官方项目**：这是个人维护的桌面封装，与 DeepSeek 官方无关。DeepSeek 及 DeepSeek Harness 商标归其各自所有者所有。

## 特性

- **点击即启动**：应用自行启动 `dsh web` 服务器，无需手动起服务、无需浏览器标签页。
- **无"拒绝连接"**：窗口只在服务器就绪（打印就绪行 **且** 返回 HTTP 200）后才打开；启动失败会弹错误对话框显示日志，而不是白屏。
- **端口零冲突**：服务器以 `--port 0` 启动，由操作系统分配空闲端口。
- **干净退出**：关闭窗口即终止服务器进程树；单实例锁防止重复启动。
- **无边框一体化窗口**：隐藏原生标题栏，页面内自绘 32px 官方风格标题栏（最小化/最大化/关闭），不遮挡 dsh 或 web-ui 插件的任何右上角按钮。
- **服务复用**：如果 `http://127.0.0.1:3080` 已有 dsh web 在运行，直接复用打开窗口，不重复启动第二个服务（避免 task-board 锁冲突）。
- **版本跟随**：独立启动时优先使用用户已安装的 dsh（全局 npm），版本永远匹配；内置 runtime 仅作最后回退。
- **用户数据**：会话、设置、凭据存储在标准 `$DSH_HOME`（默认 `~/.dsh`），与 CLI/Web 版一致。

## 目录结构

```
desktop/
  main.js                    Electron 主进程（应用外壳）
  preload.js                 窗口控制 IPC 桥（contextBridge）
  appearance.js              明暗主题同步
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

`main.js` 是核心（无第三方运行时依赖）：

1. 优先探测 `http://127.0.0.1:3080`；已有 dsh web 在运行则直接打开窗口复用。
2. 否则用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）以 `--port 0` 拉起服务器；
   优先使用用户已安装的 dsh（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`），找不到再用内置 runtime。
3. 解析 stdout 就绪行 `dsh web: http://127.0.0.1:<port>`，再轮询该 URL 直到 HTTP 200；
4. 然后创建无边框 `BrowserWindow`，注入 32px 官方风格标题栏（自绘最小化/最大化/关闭，经 `preload.js` IPC 控制窗口）；
5. 自动把页面中 `position: fixed` 且位于右上角的 web-ui 插件按钮下移 32px，确保不被标题栏遮挡；
6. 服务器异常退出时显示错误对话框（可重试），关闭窗口时终止服务器进程树。

## 许可

- 本项目代码：MIT（见 [LICENSE](./LICENSE)）。
- 基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），运行时随 Electron 分发。
- 图标来自官方仓库的 `apps/web/public/favicon.svg`（黑色鲸鱼 logo），仅作标识用途。

## 已知限制

- 仅支持 Windows（目标平台 win32-x64）；macOS/Linux 需调整 `main.js` 的进程树终止逻辑。
- 桌面版与浏览器版 `dsh web` 使用同一 `$DSH_HOME`；两者同时运行可能产生会话写入竞争。桌面端已优先复用已运行的 3080 服务以降低冲突，但建议仍只开其一。
- 无边框标题栏默认开启；如遇异常可设环境变量 `DSH_DESKTOP_NATIVE_TITLEBAR=1` 回退原生标题栏。
