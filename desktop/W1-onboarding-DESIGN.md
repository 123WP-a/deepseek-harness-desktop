> 状态：**已裁撤/暂缓**——开发者阶段无必要；面向非开发者用户时可按本设计重启。

# W1 首启向导 — 实现设计（拍板后照此构建）

> 形态：新 client 插件 packages/client/ui-onboarding（包 @deepseek-ai/dsh-client-ui-onboarding)。
> 我能做：写全源码+spec+metadata+跑 tsc -b tsconfig.client.json 类型门禁；但 pnpm --filter ... bundle（tsdown→esbuild）只能你本机跑。

## 1. 定位
- 仅「未配置 API key」首次进入出现；不打扰老用户；UI 走官方 --dsw-alias-* token + 官方表单原语，文案中文。

## 2. 决策表
| 维度 | 选用 | 理由
|---|---|---|
| 触发 | 检测 credentials 无有效 key → 门户；有 key 则隐身 | 最小介入 |
| 步骤 | 语言→key→默认模型→主题 | 按依赖排序，文案即时镜像语言 |
| key 存放 | 经 credentials 能力写入（不落明文），仅发写入呼叫 | 安全 |
| 模型 | 读模型目录给出下拉，只读 | 不动模型解析 |
| 外观 | 写 ui-theme.preference | 与 appearance.js 联动 |
| 归宿 | 门户插 shell.overlay；完成后拆下回到常规会话 UI | 向导与会话解耦 |


## 2b. 复用官方面（不重造）
- 模型添加/选择：官方 ui-settings-models → 向导只承接「去模型页」入口
- 语言：官方 dsh-client-locale → 向导只提供首发语言入口
- 主题：官方 ui-theme + appearance.js → 只写 ui-theme.preference
- key：官方 credentials 能力承载写入；向导的唯一自研 UI 仅此处（「粘贴 key」控件）

## 2c. 复核官方后收紧
- 官方已有：语言(locale)、模型添加 ∧ API key 录入+校验(ui-settings-models: apiKeyFailure + settings.mutate + credentials/updated)、主题(ui-theme)、key 存取(credentials)
- 官方确实没有：首启触发器。
- 结论：W1 从「首启向导」降为「首启提示壳」——检 credentials 空 → 首屏/托盘一条提示 → 直达官方「设置→模型(填 key)+语言+主题」→ 暂态即逝。规模〈半天，甚至可不独立成包。
## 3. 文件清单
- package.json（dsh.client {platform:web}；peer/dev 镜像每依赖）
- tsconfig.json（extends tsconfig.base.client.json + references）
- tsdown.config.ts（clientBundle）
- src/index.ts（node 空半）+ src/invariant.ts（配偶，一件合法 no-op + 真理由）+ src/css-modules.d.ts
- src/client/：index.ts（slots.register + store 控制器）、步骤组件、locales（zh/en）
- tests/：vi store/分步 spec + @vitest-environment jsdom 渲染 spec
- README.md + README.zh.md（Model Experience + Known Limitations）
- 三个必挂注册面：tsconfig.client.json references / web-app cordis.patch.yml dsh.client row / web-app package.json 依赖

## 4. 数据流
boot → client 常驻但隐身：查 credentials 无 key → shell.overlay 渲染向导；分步写入 locale/key/model/theme → 完成拆 overlay → 常规 UI 登场；可「跳过」，随时自设置再唤起。

## 5. 边界/风险
- key 只发写入呼叫；健康校验 1-token；网络挂时离线只读导航
- 待真机点验的隐藏假设：credentials 无 key 精确应答；shell.overlay 首载时序

## 6. 你本机构建/验收
pnpm install --fetch-timeout 1200000；pnpm --filter @deepseek-ai/dsh-client-ui-onboarding bundle；vitest run packages/client/ui-onboarding/tests；tsc -b tsconfig.client.json；doc-sync / constraints / lint / hygiene；真机点一遍。

要我把这个包全文一次写出（我先跑 tsc -b tsconfig.client.json 打通），你只跑最后的 bundle+真机点验？
