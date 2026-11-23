## E4.9h-P2-5 — 最终集成验收与遗留证据闭环

基准：`main` @ `1c90d94`（PR #11 合并后）。**纯验收轮：未修改任何产品代码**，只新增验收证据与报告。

### 遗留问题闭环

**P2-4：「生成复习题」按钮状态矛盾**

原始指标记录 `reviewGenerationEnabled=false`，与「复习到期时按钮可用」矛盾。本轮在真实页面分三个采样点重测：

| 采样点 | 1440×900 | 320×640 |
| --- | --- | --- |
| 点击前（核查与会话读取已完成） | `disabled=false` | `disabled=false` |
| 点击后（请求进行中） | 复习准备页已卸载 | 复习准备页已卸载 |
| 结果之后 | 同上 | 同上 |

结论：只要等到核查与会话读取完成，按钮就可用；旧的 `false` 来自采样时机与页面卸载，**不是产品缺陷**，也没有放宽 `reviewCanGenerate`。另补测失败变体：生成失败后按钮恢复可用、错误可见。

**P2-3：英文 unknown 徽章计数**

旧指标记为 0。改为枚举反馈块内**全部** `.mla-badge`（不再只匹配 success/warning/danger）：

| 视口 | 徽章数 | 文本 | neutral | 分数 | 显示为 Incorrect |
| --- | ---: | --- | --- | --- | --- |
| 1440×900 | **1** | `Unable to judge` | 是 | 无 | 否 |
| 320×640 | **1** | 同左 | 是 | 无 | 否 |

结论：UI 正确，旧计数是**验收脚本选择器遗漏 neutral**；只修正测试口径，未改产品代码。

### 完整业务闭环（真实浏览器 + 真实 API）

- **普通练习 E01–E12**：不自动建记录 → 显式初始化 → 生成 → 同卡作答 → 提交持久化 → 评分前无分数 → 服务端结果 → 评分后仍「待记录」→ 独立记录 → `stage=completed` → 档案有证据 → 建议来自长期状态。
- **再练一道**：知识点预填、题型跨折叠保留、新题身份正确、`after_attempt_id` 绑定上一题、答案与评分不继承。
- **复习 R01–R10**：URL 身份、每次重查到期、`intent: "review"`、服务端 `review=true`、作答评分记录、证据归属正确、重新读取长期状态（以服务端计算为准）。
- **隔离 D**：会话切换 S01–S04、四阶段刷新恢复、评分失败与重试。
- **R1 三个遗留场景**：真实 503 核查失败、会话阻塞（原题与 pending attempt 未被覆盖）、无可信名称（人工确认控件存在、确认前禁用）。

### 响应式与可访问性

5 视口 × 深浅主题 × 5 状态 + 英文，共 62 条指标、58 张截图：横向溢出 **0**、折叠区内错误 **0**。键盘折叠交互、标签关联和焦点记录存在。**原指标 `lastActionClear=false`、`navTop=0`，320px 底栏是否遮挡尚待真实浏览器复核，不以页面 CSS 推断为通过。**

### 测试结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run PracticePage.test.tsx` | 89 / 89 |
| `npx vitest run pages/practice` | 186 / 186 |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 0 错误 |
| `npm --workspace my-learning-agent-web run build` / `npm run build` | 通过 |
| `npx vitest run --maxWorkers=4` | 194 文件 / **2193 通过** / **1 失败** / 3 跳过 |

唯一失败 `server.e48-workbench.test.ts` 的 `providerCalls` 断言（期望 1 实得 2），已在本分支（无任何代码改动）上独立复现，与 E4.9h 无关。**不称全量测试全绿。**

### 证据与限制

- 证据：`docs/ui-redesign/phase4/P2-5-assets/`（3 份 metrics + 58 张截图；58 个截图路径已补入 E 阶段指标）。报告：`P2-5-acceptance.md`。当前提交**没有** `full-test.log`，需要补充日志或可追溯 CI 链接。
- 桩 provider 提供固定评分，结论只关于界面与协议，**不代表真实模型质量**。
- 评分重试耗尽与证据记录失败未在浏览器注入，由组件测试覆盖（报告中已区分来源）。

### 结论

**核心业务验收有证据支持；最终 PASS_WITH_KNOWN_BASELINE_FAILURE 暂缓签收。** 原始测试记录仍有一项历史失败，且需复测移动端底栏、补齐可追溯测试日志。

### P2-5-R1 证据修正与合并门槛

- `metrics-phase-c.json` 实际为 E11 **16** 条、R02 **16** 条、R10 **18** 条证据，报告已从错误的 4→6 口径修正。
- `metrics-phase-e.json` 的 62 条记录中有 58 条对应已有 PNG，已逐一写入真实 `file` 路径；4 条纯 DOM/身份核查记录不对应独立截图，保留 `file=""`。
- `metrics-phase-b.json` 可支持按钮与英文 neutral 徽章的 DOM 验证，但本仓库未提交被旧报告引用的 B1/B2 专项截图，现已如实标明。
- 已有 `PracticePage.test.tsx` 中的 URL 伪装负向测试可支持代码级防伪造结论；本轮浏览器指标没有做伪造 URL 的负向测试，不再混淆证据等级。
- **合并门槛（未完成）**：真实浏览器 320px 导航遮挡复测（原 `lastActionClear=false`、`navTop=0`），提供截图与 DOM 矩形指标；补充全量测试日志或 CI 链接；再更新最终报告结论。
- 本轮只补证据关联和文档，不修改任何产品代码；**R1 未重新执行测试**。

**PR 保持 Draft，完成以上复核后再申请合并；不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
