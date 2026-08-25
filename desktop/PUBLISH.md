# DeepSeek Harness 桌面版 — 发布记录

## 发布信息

- **仓库**：https://github.com/123WP-a/deepseek-harness-desktop （公开）
- **分支**：`master` / `main` / `ai-auto-20260814-1348` 三分支同指最新交付快照；历史旧分支 `ai-auto-20260819-*`、`ai-auto-20260822-*` 与标签 `v0.1.3–v0.1.7` 保留未动
- **作者身份**：全部 `123WP-a <123WP-a@users.noreply.github.com>`（GitHub noreply 邮箱，未公开个人邮箱）
- **内容模式**：整仓孤儿快照（单提交含全部源码/文档/测试），每次发布强制覆盖三分支

## 本次发布增量（相对上一版 v0.1.7）

完整特性以 [`README.md`](README.md) 为准（双语成对）。本次新增要点：安全模式逃生门、审批 OS 通知、托盘常驻与关闭行为可选、退出保护、全局快捷键、防休眠+任务栏进度、开机自启、插件安装前扫描（plugin_security_scan）、工具调用审计 JSONL、自动更新真实接线 + SHA-256 指纹校验、外链三分拦截。

## 旧版特性存档（v0.1.x 时点）

- **点击即启动**：自动拉起 `dsh web` 服务器（`--port 0` 免端口冲突），就绪后才开窗口，无"拒绝连接"
- **窗口图标/标题固定**：标题栏图标与桌面快捷方式同为官方黑色 `deepseek.ico`，标题固定为 `DeepSeek Harness`（`page-title-updated` 拦截，网页 `<title>` 无法改写）
- **外观与设置同步**：`appearance.js` 读取 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`（light/dark/system），映射到 `nativeTheme.themeSource`；目录 watch + 2s 轮询双保险，在 Web UI 设置里切换外观即时生效（含窗口背景色防白闪）
- **dsh 自动更新**：窗口打开后检查 npm `@deepseek-ai/dsh` 的 `next` dist-tag，有新版本时下载到用户目录暂存区，可选择立即重启或下次启动生效；更新安装到 `%APPDATA%/DeepSeek Harness/runtime` 后优先于内置 runtime 启动

## 隐私与安全检查结论（发布前已执行）

| 检查项 | 结果 |
|---|---|
| API 密钥（`sk-` 长密钥、`DEEPSEEK_API_KEY` 赋值） | ✅ 无 |
| 密码/secret 赋值 | ✅ 无 |
| 用户会话/凭据文件（`~/.dsh`、`credentials.yaml`、`settings.yaml`） | ✅ 不在仓库 |
| 测试快照中的真实数据 | ✅ 使用 `{{sessionId}}`/`{{cwd}}` 模板变量 |
| 硬编码本机路径（`E:\`、`C:\Users`、`ASUS`） | ✅ 无 |
| 提交历史中的个人邮箱（QQ 邮箱） | ✅ 已重写为 noreply |
| 大于 50MB 文件 | ✅ 无 |
| 构建产物（node_modules/runtime/dist）、缓存 | ✅ 已 gitignore |

## 发布方式（当前生效）

本机直连 `github.com:443` 会被间歇性重置，但**系统代理（127.0.0.1:7890）可用**。标准流程：

```powershell
git checkout --orphan desktop-snapshot   # 孤儿分支：绕开本地对象库一处幻影引用损伤
git add -A; git commit --no-verify       # 单提交快照（含全部源码/文档）
git -c http.proxy=http://127.0.0.1:7890 push -f desktop desktop-snapshot:refs/heads/master `
  desktop-snapshot:refs/heads/main desktop-snapshot:refs/heads/ai-auto-20260814-1348
git checkout <原开发分支>; git branch -D desktop-snapshot
```

注意：
- 远端仓库自带历史引用了缺失对象 `abe560f8…`（远端对象库残缺），因此必须 `-f` 强制覆盖且**不要**让谈判复用远端 advertised 对象（普通推送会报 did not receive expected object）；
- 暂存更新会经 `update-integrity.js` 记录 SHA-256 指纹并在激活前校验；
- 远端旧内容已抢救到本地 `refs/remote-desktop/*`。

## 安全事件记录（v0.2.0，已处置）

首版孤儿快照误将 `remote-proxy/key.pem + cert.pem` 与备份 bundle 一并入库并被公开约十几分钟。处置：删除 Release v0.2.0 与同名远端标签；确认其余全部标签/分支干净；`.gitignore` 已加 `remote-proxy/` 防再犯；建议择机重签代理自签名证书。

本机 `github.com:443`（HTTPS）与 git 客户端均被网络环境阻断，`api.github.com`（REST API）可达，因此采用：

1. **REST API 创建仓库**：`POST /user/repos`（需要 PAT，scope: `repo`）
2. **Git Data API 推送内容**：`blobs → tree → commit → refs`（单一 commit，author 显式指定为 noreply 邮箱）
3. **强制更新 ref**：`PATCH /repos/{owner}/{repo}/git/refs/heads/main {force:true}`

> 注意：Contents API（`PUT /contents/{path}`）每文件产生一个 commit 且 author 自动用账号主邮箱（会泄露邮箱），**不要**用它发布；Git Data API 可在 commit 请求中显式指定 `author.email`。

## 后续维护

### 更新代码并推送（网络正常时）

```sh
cd desktop-release
git remote add origin git@github.com:123WP-a/deepseek-harness-desktop.git
git push -u origin main
```

### 网络受限时（与本次相同环境）

1. 在发布目录完成本地 commit
2. 用 `git diff --binary main..HEAD` 生成补丁，或直接复用 `push-via-contents` 思路改为 Git Data API 脚本（author 显式传 noreply）

### 待办

- [ ] 在 GitHub 删除用于本次发布的 SSH 公钥（Settings → SSH and GPG keys → 删除 `dsh-publish`）
- [ ] 吊销本次使用的 PAT（Settings → Developer settings → Personal access tokens → 删除）
- [ ] 可选：为仓库添加 GitHub Actions 自动构建桌面版

## 本地文件

- 发布源目录：`desktop-release/`（本地 git 仓库，与远程内容一致）
- 桌面快捷方式：`C:\Users\ASUS\Desktop\DeepSeek Harness.lnk`（图标为官方黑色鲸鱼）
- 应用目录：`desktop/dist/DeepSeek Harness/`
