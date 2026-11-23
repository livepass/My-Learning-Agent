## E4.9h-P2-4 — 复习准备布局与出题交互优化

基准：`main` @ `330777e`（PR #10 合并后）。只改布局、展示组件、局部 UI 状态与响应式样式，不改任何学习业务规则。

### 做了什么

**1. 复习准备页改单列**

去掉 `.mla-split` + 224px `.mla-rail`，改用 `.mla-practice` 的 860px 阅读列；两个说明区块合并为一个默认折叠的原生 `<details>`，移到表单下方。`.mla-split` / `.mla-rail` 的全局样式保留，其他页面不受影响。

折叠的只有解释性文案；知识点、到期状态、核查失败、会话选择、阻塞原因、生成按钮与禁用态、生成错误、「改为普通练习」全部保持可见。

**2. 出题表单折叠可选配置**

目标 / 题型 / 模型回退收进 `<details class="mla-generator-advanced">`。知识点输入、说明与校验提示、生成按钮、生成中状态、失败提示、取消操作始终可见。值仍在页面 state，折叠与展开不会重置，也不会绕过生成资格检查。

**3. 移动端**

窄屏给输入与下拉加 `scroll-margin-block`，避免聚焦后被底栏挡住；练习/复习页用 `.mla-main:has(.mla-practice)` 增加 safe-area 底部留白。新增样式全部限定在局部选择器，未改 `.mla-card` / `.mla-split` / `.mla-page-head`。

### 业务冻结

- 复习到期核查（每次进入重新读取 `getLearningRecommendations`）、复习身份（`question.review === true`）、会话资格、`reviewIntentRef` / `reviewTicketRef` / `reviewScopeProblem` 等异步隔离机制**一字未改**。
- 生成参数（`concept_id`、可信名称、`intent: "review"`、`after_attempt_id`、题型、`allow_model_fallback`）未改。
- `PracticeProgress.tsx`、`PracticeFeedback.tsx` 未触碰；C2/C3 三步仍独立。

### 测试与验证

| 项 | 结果 |
| --- | --- |
| 定向（practice + 页面 + i18n + store） | **238 / 238 通过** |
| 页面新增 | 11 项（T01–T10 + 退出复习） |
| 表单新增 | 9 项（T11–T18 + 键盘） |
| `tsc --noEmit` | 0 错误 |
| `npm --workspace my-learning-agent-web run build` / `npm run build` | 通过 |
| 全量 `vitest run --maxWorkers=4` | 194 文件 / **2193 通过** / 1 失败 / 3 跳过 |

唯一失败是基线既有 `server.e48-workbench.test.ts` 的 `providerCalls` 断言。通过数相对 P2-3 合并后基线 2173 增加 20，恰为新增用例数。

### 真实浏览器验收

5 视口（1440×900 / 1024×768 / 900×800 / 390×844 / 320×640）× 浅色深色 × 6 场景，另加英文与生成失败，共 **65 条指标、66 张截图**：

- 横向溢出 **0**、复习页侧栏 **0**、复习页多列 **0**、页面异常 **0**
- 键盘：Enter/Space 均可切换两个折叠区，折叠/展开后题型值仍为 `application`，复习到期时生成按钮可用
- 320px 复习准备页完整可操作，无横向滚动

唯一的 1 条 502 控制台错误来自 `generate-failed` 场景（桩 provider 主动失败），正是被验证的失败路径本身。

截图与指标：`docs/ui-redesign/phase4/P2-4-assets/`，报告：`docs/ui-redesign/phase4/P2-4-acceptance.md`。

### 已知限制

- jsdom 不隐藏 `<details>` 内容，组件测试在显式点击 summary 后断言折叠区字段；折叠行为由浏览器验收证明。
- 记录证据会重新投影 `review_due_at`，验收脚本在每个复习场景前重落一次到期日——这是产品正确行为。

**不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
