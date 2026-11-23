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

5 视口 × 深浅主题 × 5 状态 + 英文，共 62 条指标、58 张截图：横向溢出 **0**、折叠区内错误 **0**。键盘 Enter/Space 切换折叠区且值保留、标签关联、焦点可见、320px 底栏不遮挡最后操作（按钮底边 = 导航顶边）。

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

- 证据：`docs/ui-redesign/phase4/P2-5-assets/`（3 份 metrics + 58 张截图 + 全量测试日志），报告：`P2-5-acceptance.md`。
- 桩 provider 提供固定评分，结论只关于界面与协议，**不代表真实模型质量**。
- 评分重试耗尽与证据记录失败未在浏览器注入，由组件测试覆盖（报告中已区分来源）。

### 结论

**PASS_WITH_KNOWN_BASELINE_FAILURE** —— 新增与相关业务验证全部通过，仍存在一项经独立复现、与本阶段无关的历史测试失败。

**不自动合并。** E4.9h 功能开发到此停止，等待最终审查。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
