# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：设置 coding persona，插入 Web 宿主行（webserver、API 网关、workspace、投影缓存、存储）、浏览器插件名录与始终挂载的客户端插件重载链（[`dsh-client-hmr`](../../client/hmr/README.md)，在重建 watcher 改写客户端 bundle 之前保持空闲），并挂载本包的 `web-runtime` 粘合插件（配置为 `{printUrl, surfaceContext, trustedHosts}`）。该插件通过 `@deepseek-ai/dsh-web-frontend` 的 exports 解析已构建的前端 dist，只采样一次依赖 bind 的 LAN 信任信息并将其作为 `webRuntime` 提供给浏览器信任栅栏和客户端名录，挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退席位所有者，在 `surfaceContext` 为 true 时注册 Harness 源码与 Web 表层提示词段落，以及 bash 可见的 `DSH_WEB_URL` 运行时变量，并在 `printUrl` 为 true 时等自身的 Loader 配置树结算后再打印 `dsh web:` URL 行，避免兄弟行失败时公告一个已失效的应用。本组合包还持有应用命令行：普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)），解析 `--host`、`--port`、可重复的 `--trusted-host` 以及应用自己的 `--help`，再提供 `webStartup`。它会在发布该服务前拒绝 `--host 0.0.0.0`，因为 CLI 目前有意不支持绑定所有网络接口。由 flag 配置的行会注入该服务，并在惰性配置中直接读取它，因此参数解析完成前不会有任何东西绑定端口，`dsh --profile web --help` 也不会启动服务器。[`dsh-headless`](../headless/README.md) 是同一 base 之上的同级表层，不挂载本组合包。

`desktop-events` 插件（[`src/desktop-events.ts`](src/desktop-events.ts)）监听实时会话事件流，把每条 `approval/asked` 转发到桌面壳的 stdout 事件协议（`dsh desktop-event:` 行 → OS 通知）；它不触碰决策链。`security-scan` 工具（[`src/security-scan.ts`](src/security-scan.ts)，核心逻辑在 [`src/security-scan-core.ts`](src/security-scan-core.ts)）注册 `plugin_security_scan`：对解包后的插件目录做安装前静态检查——可执行文件、混淆密度、读凭证+外联组合、随包 `.env`/密钥字面量——高危结论会镜像到同一通道。`tasks-active` 插件（[`src/tasks-active.ts`](src/tasks-active.ts)）观察作业注册表，把「存在运行/停止中的后台作业」镜像为 `tasks` desktop-event，桌面壳据此开启关闭确认守卫。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。
- **桌面通知依赖桌面壳**：`desktop-events` 与 `security-scan` 的高危结论始终打印事件行，但只有桌面壳会将其渲染为 OS 通知；纯浏览器会话只能在服务器日志中看到这些行。
- **安全扫描 v1 仅支持本地目录**：npm/git 拉取与注册表依赖审计尚未实现；报告只列出依赖名，不做审计。
- **工具调用审计仅记名称且不轮转**：`tool-audit` 把工具名/状态/时序行追加到 `$DSH_HOME/audit/tool-calls.jsonl`（绝不记录参数或结果内容）；该文件只增不减。
- **退出守卫的任务检测仅覆盖作业**：`tasks-active` 监视后台作业；goal 没有可用的服务端在线信号，暂不计入守卫 v1。
