## E4.9i-P2-6-R1｜数据可信度语义与目标编辑安全修正

**基准：** `main@7d7a04accd6f9a64f475c575405fe6db0c4484ca`（PR #22 合并提交）
**本轮起点：** `6ea2eeae62e86947d30cd146744cd4e83bdaf2bc`（P2-6 已审查 HEAD）
**验收报告：** `docs/ui-redesign/phase5/P2-6-R1-acceptance.md`
**指标与日志：** `docs/ui-redesign/phase5/P2-6-assets/r1-browser-metrics.json`、`r1-test-log.txt`
**浏览器脚本：** `docs/ui-redesign/phase5/scripts/qa_p2_6_r1.py`

本节是 P2-6 PR 的 R1 增补，接在上面的 P2-6 描述之后。

### F01（最高优先级）目标优先级的隐式写入

`GoalCard.save()` 原先无条件发送 `priority: draft.priority`，而
`server/routes/learner.ts:184-187` 按**字段是否出现**（`!== undefined`）打归属戳。
于是「只改标题」也会把 `priority` 标记为人工维护，并可能覆盖编辑期间服务端收到的新值。

修复：

- 新增纯函数 `goalPatchFromDraft(goal, draft, priorityTouched)`：每个字段只在真的变化时发送；
  `priority` 只在用户**动过控件**且值为 `[0,1]` 内有限数时发送；结果为空则**不发请求**。
- `GoalCard` 新增 `priorityTouched`；打开/取消/重开编辑器都清零；保存失败保留草稿与标记。
- 异常值（如 3）让手柄停在 100，点击该端点不触发 `change`，用户无法显式选择 100%。
  因此非正常值额外渲染一个显式按钮「将优先级设为 100%」（负值为 0%），
  放在 `<label>` 之外（嵌在 label 内的按钮会同时激活被标注的滑块）。

服务端规则**零改动**：`server/routes/learner.ts` 相对本轮起点无 diff，本轮在 `apps/learning-agent/src/` 下只动测试。

### F02 课程视图的证据口径说明

`ProvenanceRegionNotes` 从与阅读态相同的 i18n key 渲染两段说明，**每个知识区域一次**：
`CourseLearnerPanel` 在筛选行之前，`CourseOverviewPanel` 在列表之前。320px 与暗色下实测可读
（暗色对比度 4.52:1）。

### F03「来源不明」语义

按 `memory/learner/types.ts:117-118` 的真实定义（legacy 值因来源未知被原样保留）替换文案：

- zh：「此记录包含来源无法确认的历史信息，不能据此判断证据质量或知识判断的准确性。」
- en：*This record contains historical information whose provenance cannot be confirmed. This flag does not establish evidence quality or the accuracy of the knowledge assessment.*

不声称执行过追溯，不声称所有关联证据不可靠，不推断准确性。

### F04 证据标识数组边界

`describeEvidenceCount()`：合法字符串数组原样计数（不去重）；非数组、含非字符串元素、
含空串/空白串 → 不可用（**绝不显示 0**）。非字符串元素的依据是写入路径（`uniqueStrings()` trim 并丢弃空值）；
空白串不同——tool schema 无 `minLength` 且 `updateProfile()` 不规范化 `evidence_ids`，
所以它**可以**被存下；判为不可用的依据是服务端自己的计数（`daily-plan.ts:133`、
`recommendations.ts:97`）本来就跳过空白 id。
**不过滤、不去重、不修改原数组。**

### 改动文件

| 文件 | 内容 |
| --- | --- |
| `web/src/react/profile/knowledge-provenance.ts` | `goalPatchFromDraft`；`describeEvidenceCount` 拒绝坏元素 |
| `web/src/react/LearnerProfilePanel.tsx` | `priorityTouched`、`startEditing`/`cancelEditing`、端点按钮 |
| `web/src/react/profile/KnowledgeProvenance.tsx` | 新增 `ProvenanceRegionNotes` |
| `web/src/react/courses/CourseLearnerPanel.tsx` | 区域说明一次 |
| `web/src/react/courses/CourseOverviewPanel.tsx` | 区域说明一次 |
| `web/src/react/shell/shell.css` | `.mla-provenance__region-notes` |
| `web/src/i18n/locales/{zh-CN,en}.json` | 新 `unknownHint` 文案；`priorityUseEndpoint` |
| `src/server/routes/learner.goal-priority.test.ts` | **新增**，7 项真实 handler 归属测试 |
| 5 个既有测试文件 | 43 项新增/强化断言 |

### 测试

| 验证 | 结果 |
| --- | --- |
| `tsc --noEmit`（web） | exit 0 |
| 定向回归 | 59 文件 / 933 通过 |
| `npm run build` | 通过（41.31s） |
| 全量测试 | 2601 用例：2597 通过 / 1 失败 / 3 跳过 |

新增 **44** 项（P2-6 基准 2554 → 2601，含合并进来的 1 项）。唯一失败仍是 P2-5 起已记录的
`server.e48-workbench.test.ts` 历史基准失败，本轮未触碰任何 server 生产代码。

与浏览器验收并行时，`learning/*` 与真实端口测试会成批失败（单独重跑全通过）；
最终数字取不并行的干净运行——与 P2-5-R1 记录的原因相同。

### 浏览器验收

R01–R08 覆盖 F01–F04，另复跑 P2-6 的 B01–B10（其中 **B03、B09 的期望按任务书改正**：
B03 断言新文案且旧词不得出现；B09 断言 `priority` 键不存在、存储值不变）。
19 个场景 `pageErrors` 全部为空，无横向溢出。

R01–R05 的归属戳由 mock 复刻服务端规则，证明的是**请求体**；真实路由的打戳行为由
`learner.goal-priority.test.ts` 单独证明。两者不混为一谈。

### 原始 P2-6 证据未被覆盖

`qa_p2_6.py`、`p26-browser-metrics.json`、`p26-test-log.txt`、`p26-*.png` 全部未改动；
R1 输出写入 `P2-6-assets/r1/` 与独立命名的 JSON/日志。
（任务书交付物写作 `scripts/qa_p2_6.py`，因不能覆盖原始证据，本轮新增 `qa_p2_6_r1.py`，
它 `import qa_p2_6` 复用同一套 fixture。）

### 与远程分支的关系

开工时远程分支为 `6ea2eea`。验证完成后发现远程已被另一个环境推进到 `826915c`（19 个提交，
同一 R1 任务，自述「未运行 / NOT VERIFIED」，其证据文件是 `"executed": false` 的占位）。
本轮提交 rebase 到其上，冲突逐项取已验证实现；对方新增的 `server.smoke.test.ts`
真实 HTTP 用例保留并已单独实跑通过（该文件被 `vitest.config.ts` 排除，不在全量统计内）。
详见验收报告 §9.4。

### 明确未做

- 未改知识状态引擎、证据生成/回放、记忆、掌握度/置信度/稳定性、正式复习资格。
- 未改服务端 API 规则、数据库、六类筛选规则、`KnowledgeDraftGuard`、P2-5 响应式机制。
- 未新增可信度评分；未重构其他学习目标字段的编辑架构。
- 未开启自动合并。
