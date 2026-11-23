## E4.9h-P2-3 — 评分反馈三层视觉优化

基准：`main` @ `8f361c5`（PR #9 合并后）。只调整评分反馈的展示结构与样式，不改任何学习业务规则。

### 做了什么

把 `PracticeFeedback` 拆成三层阅读结构：

1. **结果概览** — `评分反馈` + 结果徽章 + `得分 N / 100`（右对齐）。`result` → `success` / `warning` / `danger` / `neutral`；分数沿用 `practice.evaluate.score` 与 `Math.round(score * 100)`。
2. **评价维度** — 按服务端 `criteria` 顺序，逐条展示 `criterion_id`（等宽）、judgment 文案（已满足 / 部分满足 / 未满足 / 未判定）与 `explanation`；图标 + 文字双通道，分隔线列表，无嵌套卡片。
3. **AI 反馈** — `assessment.feedback` 原样渲染，`pre-wrap` 保留换行，不截断、不改写；`unknown_reason` 单独成块。

同时删除 `PracticeAnswerPanel` 中重复的结果徽章与 `resultLabel` Prop，页面同步清理该展示参数——同一次评分只显示一份结果标签。

### 业务冻结

- `shownAssessment` 的来源（持久化 attempt → 响应作用域回退）与题目/会话隔离规则**一字未改**。
- `PracticeProgress.tsx` 与 P2-2 三步进度**零改动**；提交、评分、记录证据仍是三个独立操作。
- `PracticeFeedback` 仍是纯展示组件：不读 Store、不调 API、不读 URL、不写状态。

### 边界行为

| 输入 | 行为 |
| --- | --- |
| `score: 0` | 显示 `得分 0 / 100` |
| `score: undefined` | 不渲染分数行，不填 0 |
| `result: unknown` | 显示「无法判定」+ 原因，无分数，不显示为答错 |
| `criteria: []` | 不渲染空列表 |
| `judgment: unknown` | 显示「未判定」，与「未满足」区分 |
| 超长反馈 / 超长 id | 全文保留，`overflow-wrap: anywhere` |

### 测试与验证

| 项 | 结果 |
| --- | --- |
| 定向（practice + 页面 + i18n + store） | 原 P2-3 记录 **217 / 217 通过**；R1 新增 1 项英文 neutral Badge 断言，尚未重跑 |
| `PracticeFeedback` | 20 项（T01–T15） |
| 页面新增 | 6 项（T16–T20 + unknown） |
| `tsc --noEmit` | 原 P2-3 验收记录为 0 错误；R1 尚未重跑 |
| `npm --workspace my-learning-agent-web run build` / `npm run build` | 通过 |
| 全量 `vitest run --maxWorkers=4` | 原 P2-3：194 文件 / **2172 通过** / 1 失败 / 3 跳过；R1 尚未重跑 |

唯一失败是基线既有 `server.e48-workbench.test.ts` 的 `providerCalls` 断言，与本轮前端改动无关。通过数相对 P2-2 基线 2153 增加 19，恰为新增用例数。

### 真实浏览器验收

5 视口（1440×900 / 1024×768 / 900×800 / 390×844 / 320×640）× 浅色深色 × 7 个基础反馈场景（correct / partial / incorrect 零分 / unknown / 长文本+长 id / 已评分未记录 / 证据已记录），另加英文 2 视口，共 74 条浏览器指标记录（另有 5 张滚动截图，PNG 实际 79 张）：

- 横向溢出 **0**、重复结果标签 **0**、控制台错误 **0**
- `.mla-practice-card` 数量恒为 1，反馈块内嵌套卡片 **0**
- 320px 概览自动换行，长 id 折行；2240 字符反馈完整保留

截图与指标：`docs/ui-redesign/phase4/P2-3-assets/`，报告：`docs/ui-redesign/phase4/P2-3-acceptance.md`。

### 已知限制

- `criteria: []` 无法由真实 C2 端点产生（服务端要求逐条判定），该分支由组件 T11 覆盖。
- `unknown` 时服务端仍下发逐条「未判定」维度，界面如实展示。
- 英文场景的 AI 正文为桩 provider 返回的中文，界面标签已翻译。

### 修改范围

`PracticeFeedback.tsx(.test.tsx)`、`PracticeAnswerPanel.tsx(.test.tsx)`、`PracticePage.tsx`（仅删冗余展示参数）、`PracticePage.test.tsx`、`shell.css`、中英文案、验收文档。未改 store、API、后端、进度组件、导航，未新增依赖。

### P2-3-R1 证据修正（待审查）

- 修正验收场景数量口径：7 基础场景 × 5 视口 × 2 主题 = 70，另 4 个英文指标，总计 74 条指标；外加 5 张滚动特写，PNG 共 79 张。
- 修正英文 unknown 文案：真实翻译为 `Unable to judge`，不是 `Can't be judged`。
- 原始 metrics 的两个英文 unknown 用例计数为 0，尽管 overviewText 记录正确文案且源码为 neutral 渲染基础 `.mla-badge`。不推断该计数的根因，不伪改原始指标。
- 新增英文 unknown 单结果徽章组件断言（尚未重跑）。
- **合并前待办**：执行该新增断言，在真实浏览器的 1440px 与 320px 英文 unknown 状态重新确认 neutral 徽章计数，必要时修复验收脚本并重采对应指标；更新验收报告的结论。

**请在以上 R1 复核通过后再合并。当前 PR 仅供审查，不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
