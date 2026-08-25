# DeepSeek Harness 桌面端路线图 — 缺口总结与任务

> 范围：`desktop/` Electron 壳与必要的服务端接缝。页面内功能一律归 web-ui 插件，本文只记录壳与内核必须补的部分。
> 判别标准：**窗口一关就失效**或**需要操作系统/进程层能力**的功能不可能由 web-ui 插件承载——落在壳（`desktop/main.js`）或内核（server 能力接缝）上；其余全部插件化。

## 1. 现状基线（已具备，勿重复建设）

- **壳**：readiness 门控（stdout 行解析 + HTTP 轮询）、`--port 0` 免端口冲突、单实例锁、附加已运行服务器（`DSH_WEB_URL`/3080）、主题跟随（`appearance.js` 监听 settings）、runtime 自更新（npm dist-tag 暂存后原子激活）、`DSH_DESKTOP_SMOKE=1` 无头冒烟通道。
- **生态**：market / plugin-manager / community-plugins / skin-center / doctor / chat-recovery / task-board / git-graph / ssh / pet 等 web-ui 插件已覆盖页面内功能；dsh-super-injector 提供注入/热重载/卸载即净引擎。
- **桥面现状**：`preload.js` 仅暴露 `window.desktopWindow` 的 5 个函数（minimize / toggleMaximize / close / isMaximized / onMaximizedChange），专为注入标题栏服务——这是页面可触达的全部桌面能力。

## 2. 缺口清单

### A. Electron 壳（main.js / preload.js）

| 编号 | 缺口 | 现状证据 | 优先级 | 规模 |
|---|---|---|---|---|
| S1 | 外链拦截 | main.js 无 `setWindowOpenHandler`；外链会导航走主窗或在应用内弹第二个渲染器 | P0 | S |
| S2 | 安全模式启动 | 服务崩溃对话框仅 Relaunch/Quit；坏第三方插件会导致启动无限失败循环 | P0 | S–M |
| S3 | 托盘常驻 + 关窗行为选项 | 关窗即 `killServerTree()`，daemon-loop 插件与后台 job 全部终止 | P1 | M |
| S4 | 系统通知 | 未使用 `Notification`；审批请求卡住时用户无感知 | P1 | M |
| S5 | 退出保护 | 有活跃 agent loop/goal 时关窗无警告 | P1 | S–M |
| S6 | 全局快捷键 | 无 `globalShortcut`（呼出主窗/快速提问） | P2 | S |
| S7 | 多窗口 | second-instance 只聚焦旧窗，无法每会话一窗 | P2 | M |
| S8 | 长任务防睡眠 | 无 `powerSaveBlocker`，挂机跑长任务会被系统睡眠打断 | P2 | S |
| S9 | 任务栏进度/闪烁 | 未用 `setProgressBar` / `flashFrame` | P2 | S |
| S10 | 开机自启 | 无 | P3 | S |
| S11 | 壳自更新 + 渠道设置化 | 只有 runtime 更新，Electron 壳无升级路径；渠道靠环境变量 | P3 | M |

### B. server 内核接缝（cordis 能力，非 client UI）

| 编号 | 缺口 | 说明 | 优先级 |
|---|---|---|---|
| K1 | notification 能力 seam | Service Definition 在内核 + provider 注册制：桌面壳实现一个 provider，纯 web 场景降级页内 toast；插件一行调用即可发通知 | P1 |
| K2 | 审批/提问事件旁路 | approval 与 ask_user_question 的状态变化广播为可订阅事件，供通知链路消费 | P1 |
| K3 | 插件生命周期/审计事件 | installed/enabled/disabled/crashed 变成事件 + 工具调用审计日志；展示归 web-ui 插件，产生数据的能力必须在 host | P2 |

### C. 关键架构决策：通知链路

daemon-loop 插件活在 server 进程，弹 OS 通知的是壳进程；窗口关闭后渲染进程死亡，preload 桥断。三个方案：

1. **stdout 结构化行协议（选定）**：server 打印 `dsh desktop-event: {json}` 行，main.js 解析——复用 readiness 行（`dsh web: http://...`）的同构模式，不依赖任何渲染进程存活。
2. main.js 轮询 server HTTP 端点：引入拉取语义与额外状态管理。
3. 隐藏后台渲染窗保活桥：内存与复杂度最高，不采用。

### D. 明确不进壳/内核（留给 web-ui 插件）

首启向导、市场聚合页、权限披露/审计的展示界面、设置表单、皮肤、一切业务面板。壳只提供接缝，不在 main.js 里长业务功能。

## 3. 任务分解

### M0 卫生与安全（先行，均为小改动）

- **T-S1 外链拦截**
  - 落点：`desktop/main.js` `openWindow()`。
  - 做法：`webContents.setWindowOpenHandler` → http(s) 用 `shell.openExternal` 打开并 deny 其余；可选加固：主窗 `did-navigate` 到非本机 URL 时回退原 URL。
  - 验收：聊天内点击 https 链接在默认浏览器打开，主窗 URL 不变。
  - 规模：S（约 15 行）。
- **T-S2 安全模式启动**
  - 落点：`showServerError` / `onServerDied` 对话框 + `spawnServer()` env。
  - 做法：对话框增加「禁用第三方插件启动」按钮；写标记文件 `%APPDATA%/DeepSeek Harness/safe-mode`；`spawnServer` 读到标记时按 cordis loader/include 既有的 disabled 语义禁用第三方插件；进入安全模式后 UI 顶部提示条询问下次是否恢复正常。
  - 验收：人为注入必崩插件 → 启动失败对话框出现 → 点安全模式 → UI 正常且三方插件未加载；清除标记后恢复正常。
  - 机制（已核验）：profile 启动器家族支持 `--patch <path>` overlay（app-boot/src/index.ts:291），补丁格式即 id-targeted disable 数组。安全模式 = 壳生成临时补丁文件禁用第三方 entry，spawn 时附加 `--patch`，无需改内核；第三方判定用 plugin-inventory 清单（entryId/enabled/fiberPhase 含 failed）。
- **T-S5 退出保护（简化版）**
  - 做法：窗口 close 事件时向 server 查询活跃 goal/jobs；有则弹确认对话框。
  - 验收：运行中任务时关窗出现确认框；空闲关窗直接退出。

### M1 托盘与通知（决定 daemon-loop 生态成立与否）

- **T-K1 notification 能力 seam（内核先行）**
  - 落点：新包（Service Definition + consumer API），provider 注册制；stdout provider 由桌面场景装配。
  - 验收：definition 合同单测；无 provider 时降级为日志输出。
- **T-S3+S4 托盘常驻 + 系统通知（壳）**
  - 落点：`desktop/main.js`（Tray / Notification）、settings 新字段 `desktop.closeBehavior: quit | tray`（复用 appearance.js 的 settings 监听模式做实时生效）。
  - 通知来源：stdout 行协议 `dsh desktop-event: {"type":"notify"|"approval", ...}`。
  - 托盘菜单：显示主窗 / 退出；角标数字 = 活跃任务数（由 K2/K3 事件驱动）。
  - 验收：关窗选「最小化到托盘」→ daemon-loop 任务继续跑且完成时收到 OS 通知；托盘退出真正结束进程树。
- **T-K2 审批旁路**
  - approval / ask_user_question 状态变化接入 K1（type=approval）；点击通知聚焦主窗并定位对应会话。
  - 检测修正：approval 能力已有完整事件模型——waterfall `approval/request` 加会话审计事件 `approval/asked`/`decided`/`policy`（user-approval/src/index.ts:22-72）。K2 缩窄为 server 侧挂监听并打印 stdout 行，无需新增事件模型，规模降为 S。

### M2 普通用户闭环（多数为 web-ui 插件形态，可与 M1 并行）

- **T-W1 首启向导 → 裁撤**：开发者阶段无必要（官方 ui-settings-models 已含 key 录入与校验）；设计存档 desktop/W1-onboarding-DESIGN.md，面向非开发者用户时再启。
- **T-W2 插件一键装卸产品化（范围修订）**：装卸 UI 与通道已由创意工坊/插件管理器覆盖，不重做；剩余为安装前安全闸——C 最小版已交付（web-app bundle security-scan），注入器前置钩子（A 形态）待做。
- **T-W3 审计展示插件**：消费 K3 事件的列表/筛选视图。

### M3 桌面增值

T-S6 全局快捷键 → T-S7 多窗口 → T-S8 powerSaveBlocker（goal/job 活跃期间阻止睡眠）→ T-S9 任务栏进度 → T-S10 开机自启 → T-S11 electron-updater 壳自更新 + 设置页渠道切换（stable/next）。

## 4. 风险登记

- **R1 第三方插件同进程运行**：崩溃面 = 整个 server。短期靠 S2 兜底 + 注入器 skip-bad-client 自愈；长期评估 worker 隔离或加载超时自动禁用。
- **R2 runtime 更新走 npm dist-tag 且无签名校验**：供应链依赖 registry + npm 包文 integrity；本轮已补「暂存指纹 + 激活前校验」（update-integrity，防止暂存—激活窗口的损坏/篡改）；全量签名签注留待 S11。
- **R3 通知链路方案风险**：隐藏渲染窗方案会增加内存与复杂度——已决策用 stdout 行协议规避。

## 5. 依赖与执行顺序

```
M0（S1/S2/S5，独立可立即做）
   └→ K1（内核 seam）──→ S3+S4（托盘+通知，依赖行协议）──→ K2（审批旁路）
M2（W1/W2/W3，web-ui 插件形态，与 M1 并行，不依赖壳改动）
M3（增值项，最后）
```

工作量粗估：M0 约 1–2 天；M1 约 3–5 天（含内核新包）；M2 视 W2 复杂度另估；M3 各 S 级半天内。

## 6. 全面检测结论（2026-08 代码级核验）

对上文每条主张做了四波 grep/read 核验，证据均为当前工作区源码：

| 主张 | 结论 | 证据 |
|---|---|---|
| S1 外链无拦截 | 确认缺失 | desktop/ 内 setWindowOpenHandler、openExternal、will-navigate 零匹配 |
| S2 无安全模式 | 缺失，机制实测定案 | DSH_* env 开关全表无禁用插件项；实测确认 web 子命令拒绝父级 --patch（unknown option），定案为 profile patch 备份+追加禁用行+恢复 |
| S3/S4/S6-S10 壳层 API 全缺 | 确认缺失 | Tray、globalShortcut、powerSaveBlocker、setProgressBar、flashFrame、setLoginItemSettings 在 desktop/ 零匹配；关窗即 killServerTree 见 main.js:442-446 |
| S5 活跃任务可查 | 可行证实 | jobs-local 为内存 registry，提供快照与变更监听（jobs/jobs-local/src/index.ts）；ui-jobs/ui-goal 面板证明 RPC 面存在，渲染进程查询后经 preload 桥询问壳即可，无需新端点 |
| S11 壳无自更新 | 确认 | update.js 头注释明示仅更新 @deepseek-ai/dsh runtime 到暂存目录；package.json 无 electron-updater |
| K1 内核无通知能力 | 确认缺失 | packages/ 全表命中均为 ACP JSON-RPC notification、credentials 内部 notifyUpdated、client-modules rebuildListeners，无面向用户的通知 seam |
| K2 审批需新增事件模型 | 修正缩窄 | approval 已有 waterfall approval/request 加审计事件 asked/decided/policy（user-approval/src/index.ts:22-72）；K2 只剩消费侧接线，规模降为 S |
| K3 插件生命周期数据缺 | 部分修正 | host/plugin-inventory 已有只读清单（entryId/moduleName/enabled/fiberPhase 含 failed），注释确认 Cordis plugin/status 事件维护真相；缺的只是变更推送通道与按插件工具调用审计 |
| stdout 行协议可行 | 证实可行 | web-app/src/index.ts:168 打印 dsh web: <url> 行，main.js 已解析同款行；desktop-event 行照搬该模式 |
| closeBehavior 复用 settings 监听 | 可行 | appearance.js 目录 watch + basename 过滤 + 2s 轮询兜底读取 settings.yaml 的 ui-theme.preference；写入端走注册 namespace 的设置页即可 |
| preload 桥仅窗口控制 | 确认 | preload.js:7-25 仅 5 个函数 |

实现约束提醒（packages/AGENTS.md）：内核新包（K1）需要 ./invariant 注册、REAL 组合测试（boot 经 Loader 的 cordis.yml）、README Model Experience 格式与 Known Limitations 节、函数插件无默认导出——K1 工作量估算已含这些门槛。

待确认小点：settings provider 对未注册顶层键的容忍度未逐行核验（types.ts 仅读得事件面）；桌面壳可如 appearance.js 只读不写，closeBehavior 写入端走注册 namespace 即不受影响，风险低。

## 7. 插件冲突面分析（对已装插件实测）

对 ~/.dsh/profiles/web/node_modules 下已装社区插件与注入器本体做了 grep/read 实测：

| 冲突面 | 实测结果 | 设计对策 |
|---|---|---|
| S1 外链拦截 vs window.open | better-sidebar 与 market 直接开外链 URL（改走系统浏览器属体验升级）；dsh-ssh 与 better-sidebar 的 client-terminal 内嵌 xterm OSC 链接走「空白窗口 + 清 opener + location.href 跳外链」（各 1 处） | 拦截策略三分：本源弹窗放行并在子窗挂 will-navigate 守卫；空白窗口先放行，子窗导航到非本源 http(s) 时转 shell.openExternal 并销毁子窗；其余协议拒绝。主窗加 will-navigate 兜底。不能一刀切 deny |
| K1 通知 vs 插件自发通知 | 已装插件零使用 DOM Notification / requestPermission（grep 命中均为 rxjs 内部类） | 无现存冲突；在插件开发者约定中声明唯一通道为 K1 seam，防未来重复通知 |
| S2 安全模式 vs 注入器自愈 | 注入器含周期循环（ctx.setInterval 两处）、scheduleHeal（watchdog-timeout / reboot-failed 触发）、healProfileLinks、restore/purge 逻辑 | 安全模式禁用全部第三方 entry（含注入器本体）时其自愈停摆，无拉锯；安全模式与注入器同写 profile cordis.patch.yml，靠「备份+窗口打开后恢复」保证原子性；枚举采用 allowlist（已定） |
| S3 托盘退出 vs desktop-launcher | 该插件已提供悬浮电源按钮（优雅退出 host）与桌面快捷方式创建 | 托盘退出复用同一优雅退出语义而非 taskkill 硬杀；功能重叠无害，后续协调 |
| stdout 行协议 vs 壳现状缺陷 | main.js 对子进程 stdout 无界累积（只增不减），长时运行内存增长——这是既有潜在 bug | 引入 desktop-event 协议前必须改为按行消费 + 有限环形缓冲；协议用严格前缀 + JSON 解析校验，插件日志噪音无法误触 |
| S7 多窗口 vs client 单例假设 | 服务端多客户端已被 remote-web-ui 场景证明可行；client 运行时的单例假设未验证 | 不阻塞 M0/M1；S7 实现期先验证 client-runtime/HMR 的多实例行为 |

结论：无不可解冲突。一个必修前置（stdout 缓冲治理）、一处策略细化（S1 三分拦截）、一个实现期决策点（S2 第三方枚举）。

## 8. 执行清单（整合版 v1 · 决策已定，开工待命）

综合 §2 缺口、§6 检测修正、§7 冲突实测后的最终执行序列：

### M0 卫生与安全（P0 · 约 1.5–2 天）

- [x] **T0 stdout 缓冲治理**：main.js 子进程输出改按行消费 + 有限缓冲（既有缺陷修复，S4 前置，约 0.5 天）
- [x] **T-S1 外链拦截**：三分策略（本源弹窗放行+子窗导航守卫 / 空白窗放行+外域转 openExternal / 其余拒绝）+ 主窗 will-navigate 兜底（约 0.5 天）
- [x] **T-S2 安全模式**（最终机制：profile cordis.patch.yml 备份+追加 allowlist 禁用行+窗口打开后恢复——实测发现 web 子命令拒绝 --patch，定案为此方案）：崩溃对话框加「禁用第三方插件启动」→ 生成临时 --patch 补丁 → UI 提示条询问恢复（约 0.5–1 天；含决策点 D1）
- [x] **T-S5 退出保护**（闭环完成）：壳 close 守卫 + preload API + 内核 `tasks-active` 观察器（jobs 运行/停止中 → `tasks` desktop-event → 壳置守卫）；goal 触达留作将来（无在线服务端信号）；桌面套件含守卫断言全绿

### M1 托盘与通知（P1 · 约 3–5 天）

- [ ] **T-K1 notification seam**：推迟——packages/AGENTS「Require a current owner and need」：当前仅一个消费者（桌面壳），完整 Service Definition 属过早建设；待第二个消费者出现时再抽为能力面
- [x] **T-S3+S4 托盘常驻 + 系统通知 + closeBehavior 设置**：壳侧完成——desktop-event 行协议 + OS 通知 + 托盘菜单 + closeBehavior(默认 quit)；K1/K2 内核与接线仍未做
- [x] **T-K2 审批旁路**：web-app bundle `desktop-events` 插件——session/event 流监听 approval/asked → `dsh desktop-event:` 行（tsc + 冒烟通过；点击聚焦留待 shell 通知点击处理）

### M2 普通用户闭环（web-ui 插件形态 · 可与 M1 并行）

- [x] **T-W1 裁撤**（开发者阶段不必要；官方模型设置已含 key 录入+校验；设计存档 W1-onboarding-DESIGN.md）
- [x] **T-W2-C 安装前安全扫描（最小版已交付）**：web-app bundle `security-scan` 工具（plugin_security_scan）——本地目录静态四查（可执行二进制/混淆密度/读密+外联/.env 与密钥字面量），高危判定经 desktop-event 通道镜像为 OS 通知；npm/git 拉取与注册表依赖审计列入 Known Limitations；注入器前置钩子（A 形态，覆盖全部安装通道）留作强化
- [ ] **T-W3 审计展示**（K3-lite 已交付，见上）——：消费 K3 数据的插件审计视图

### M3 桌面增值（P2/P3 · 逐项独立）

- [x] T-S6 全局快捷键（Ctrl/Cmd+Shift+H 呼出主窗）→ [ ] T-S7 多窗口（先验证 client 单例假设）→ [x] T-S8 防睡眠（task 活跃期间 powerSaveBlocker）→ [x] T-S9 任务栏进度（task 活跃时 indeterminate）→ [x] T-S10 开机自启（desktop.autostart）→ [x] T-S11 部分（自动更新真实接线：settings 驱动渠道/registry + 暂存指纹 + OS 通知；electron-updater 与激活目标策略待定案）

### 横切约定

- K1 是唯一通知通道，写入插件开发者约定，防止自发 DOM Notification 造成重复弹窗
- 托盘/退出类壳能力只提供语义接口，具体呈现留给插件

### 决策点（2026-08 已拍板）

- **D1 已定**：S2 第三方枚举采用「官方 bundle 补丁求 allowlist」——读官方双 bundle 补丁收集 entry id 白名单，其余全禁
- **D2 已定**：closeBehavior 默认 quit（保持现状），托盘常驻为显式开启项
- **D3 留待 T-S11**：runtime 更新渠道默认 tag 实现时再定
- **开工状态**：M0 已执行——T0/T-S1/T-S2/T-S5(机制) 完成并提交（9577e42/9aa7063）；M1 及以后未启动
## 9. UI 风格约束（贴合官方）

适用于桌面壳与未来新增的一切 UI（M1 托盘/通知/设置项、M2 面板）。官方风格的具体落地物（已核验）：

**token 体系**：语义 token 用 `--dsw-alias-*`（随 ui-theme 亮/暗/系统自动切换），静态品牌物用 `--dsw-static-*`/`--dsw-font-*`；由 packages/client/ui-theme 的 token 字典定义（bg 表面层、label 三级、border、state 状态色、interactive hover、scrollbar、button、markdown-code-block 等 20+ 组）。

**规范**：

1. 颜色/表面/文字/状态一律引用 `--dsw-alias-*`，禁止硬编码色值；引用必须带回退（参考 main.js 标题栏 `var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #111))`），在 token 未注入时兜底。
2. 窗口原生外观跟随 `ui-theme.preference`（appearance.js 已实现）；托盘/通知同样跟随 nativeTheme。
3. 壳内嵌页面 UI（标题栏、提示条、设置项）走官方插槽（settings.section / settings.plugins.tab / sidebar.footer.action / shell.overlay 等）并用官方表单原语渲染，不引入独立设计体系。
4. 品牌物用官方 deepseek.ico，应用名固定 DeepSeek Harness，通知文案与官方用语一致、简洁。
5. 系统托盘/通知属 OS 级，风格要求 = 官方图标 + 官方名称 + 主题跟随，不做自定义皮肤。
6. 社区皮肤类插件（skin-center 等）属用户自选，不纳入官方贴合判定。
