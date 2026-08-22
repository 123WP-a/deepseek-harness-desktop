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
- **dsh 自动更新**：窗口打开 30 秒后起、每 6 小时检查 npm dist-tag（默认 `next`，可配置），发现新版本时后台 `npm install -g` 升级并询问重启；每 60 秒监视本机版本，终端手动升级也能感知。
- **不弹浏览器**：拉起服务时探测 `--no-open` 支持（新版 dsh 默认把 URL 交给系统浏览器），避免桌面窗口与浏览器标签页同时弹出。
- **用户数据**：会话、设置、凭据存储在标准 `$DSH_HOME`（默认 `~/.dsh`），与 CLI/Web 版一致。

## 推荐搭配的 Web UI 插件

以下社区插件与桌面端搭配使用效果最佳（均为 bundle 标准装法，点击名称进入仓库）：

| 插件 | 用途 | 亮点 |
|---|---|---|
| [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) | 插件市场 | 在 Web GUI 设置页一键浏览 / 安装 / 更新全部 `dsh-plugin` 生态插件，无需命令行 |
| [dsh-usage-stats](https://github.com/wannanbigpig/dsh-usage-stats) | 用量与计费 | 侧栏常驻余额与今日消费、年度热图、24 小时柱状图、限额提醒；API Key 仅在服务端解析 |
| [dsh-mpkg-wallpaper](https://github.com/XHR666/dsh-mpkg-wallpaper) | 壁纸引擎背景 | Wallpaper Engine mpkg / 创意工坊壁纸作网页背景，多时段切换与整屏磨砂虚化，与半透明主题契合 |

> 提示：先装「插件市场」，其余插件即可直接在 Web GUI 里一键安装；也可参考各仓库 README 的 bundle 安装说明。

## 目录结构

```
desktop/
  main.js                    Electron 主进程（应用外壳）
  update.js                 （预留模块）运行时暂存更新器，未接线；当前自动更新逻辑内置于 main.js
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
   优先使用用户已安装的 dsh（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`），找不到再用内置 runtime；支持时附加 `--no-open`。
3. 解析 stdout 就绪行 `dsh web: http://127.0.0.1:<port>`，再轮询该 URL 直到 HTTP 200；
4. 然后创建无边框 `BrowserWindow`，注入 32px 官方风格标题栏（自绘最小化/最大化/关闭，经 `preload.js` IPC 控制窗口）；
5. 自动把页面右上角高度 ≤ 96px 的悬浮控件（`position: fixed/absolute`，跳过全屏层与标题栏自身）下移 32px，确保不被标题栏遮挡；
6. 服务器异常退出时显示错误对话框（可重试），关闭窗口时终止服务器进程树。
7. 窗口打开后在后台检查 `@deepseek-ai/dsh` 更新，安装完成后弹窗询问是否立即重启切换。

## 自动更新

窗口打开 30 秒后，桌面外壳会查询 npm registry 的 dist-tags 文档（`/-/package/@deepseek-ai%2Fdsh/dist-tags`），取 `DSH_DESKTOP_UPDATE_CHANNEL` 指定的 dist-tag（默认 `next`——rc 预发布走这个 tag；该 tag 不存在时回退 `latest`）。发现比当前运行版本更新时，直接用 `npm install -g @deepseek-ai/dsh@<版本>` 升级全局 dsh（与命令行共用同一份安装），完成后弹窗询问「立即重启 / 稍后」：立即重启经 `app.relaunch()` 换到新版本。

此外每 60 秒轮询本机 dsh 版本：即使你在终端手动 `npm install -g` 升级，桌面端也会感知并提示重启。

可用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_DESKTOP_NO_AUTO_UPDATE` | 未设置 | 设为 `1` 禁用自动更新 |
| `DSH_DESKTOP_UPDATE_CHANNEL` | `next` | 要跟踪的 npm dist-tag，如 `next` 或 `latest` |
| `DSH_DESKTOP_GLOBAL_ROOT` | 自动探测 | 覆盖全局 dsh 的查找根目录 |
| `DSH_DESKTOP_NATIVE_TITLEBAR` | 未设置 | 设为 `1` 回退原生标题栏 |
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | 覆盖服务复用探测地址 |

如果机器上没有 `npm`、网络不可用、或设置了 `DSH_DESKTOP_SMOKE=1`（冒烟测试），自动更新会跳过并记录日志，不影响当前 dsh 运行。

## 许可

- 本项目代码：MIT（见 [LICENSE](./LICENSE)）。
- 基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），运行时随 Electron 分发。
- 图标来自官方仓库的 `apps/web/public/favicon.svg`（黑色鲸鱼 logo），仅作标识用途。

## 已知限制

- 仅支持 Windows（目标平台 win32-x64）；macOS/Linux 需调整 `main.js` 的进程树终止逻辑。
- 桌面版与浏览器版 `dsh web` 使用同一 `$DSH_HOME`；两者同时运行可能产生会话写入竞争。桌面端已优先复用已运行的 3080 服务以降低冲突，但建议仍只开其一。
- 无边框标题栏默认开启；如遇异常可设环境变量 `DSH_DESKTOP_NATIVE_TITLEBAR=1` 回退原生标题栏。
