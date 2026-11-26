## E4.9i-P2-6｜学习档案来源与证据可信度展示

**基准：** `main@7d7a04accd6f9a64f475c575405fe6db0c4484ca`（PR #22 合并提交）
**验收报告：** `docs/ui-redesign/phase5/P2-6-acceptance.md`
**截图与指标：** `docs/ui-redesign/phase5/P2-6-assets/`
**浏览器脚本：** `docs/ui-redesign/phase5/scripts/qa_p2_6.py`

### 目标

在「全部课程」与「指定课程」两个学习档案视图里，如实展示每条知识记录的**来源**与**证据标识数量**，
让读者能区分「系统推导 / 人工维护 / 历史记录 / 来源未标明」，并明确说明数量不等于独立练习次数。
同时修正目标优先级的异常值展示：越界值显示原始值，而不是 300% 或静默钳位。

### 展示规则（不改变任何判定）

| 展示项 | 唯一来源 | 缺失/异常时 |
| --- | --- | --- |
| 记录来源 | `origin` | 「来源未标明」，**永不**落回「系统推导」 |
| 来源不明 | `provenance_unknown` | 仅字面 `true` 才显示；缺失/false ≠ 已核实 |
| 证据数量 | `evidence_ids.length` | 「证据标识数量不可用」，**绝不**显示 0 |
| 目标优先级 | `priority` | 越界显示原始值；NaN/缺失显示「优先级不可用」 |

- `origin` 与 `provenance_unknown` **独立**展示，可同时出现；矛盾组合按原样显示，不做「纠正」。
- 证据数量**不去重**：旧版镜像与源事件各计一次，并在说明中写清。
- 不提供复合可信度评分，不显示置信度百分比，不做证据质量分级。

### 服务端 owns `origin`（已核实源码）

`memory/learner/profile-updater.ts`：显式写入落 `origin: "manual"`（L114），
新建状态同样（L159）；`evidence_ids` 为空时置 `provenance_unknown: true`。
前端**没有**任何写 `origin` 的代码，保存请求体仅 `diagnosis` / `mastery` / `next_actions`
（浏览器 B06 实测断言）。

### 改动

| 文件 | 内容 |
| --- | --- |
| `react/profile/knowledge-provenance.ts` | **新增**。纯函数：来源映射、证据计数、优先级格式化（含 `goalPriorityLine`） |
| `react/profile/KnowledgeProvenance.tsx` | **新增**。共享展示组件，两个视图同一套语义 |
| `react/profile/KnowledgeReadView.tsx` | 阅读态插入来源与证据块（含两段说明） |
| `react/courses/CourseLearnerPanel.tsx` | 替换原证据文本，读取课程自己的字段 |
| `react/courses/CourseOverviewPanel.tsx` | 同一 `evidence_ids`，改用共享措辞（T04 影响面） |
| `react/LearnerProfilePanel.tsx` | 优先级改用 `goalPriorityLine`；滑块经 `priorityForSlider`；异常提示 |
| `react/shell/shell.css` | 新增 `.mla-provenance*`；删除无引用的 `__evidence` 规则 |
| `i18n/locales/{zh-CN,en}.json` | 新增来源/证据/优先级文案；英文补 `evidenceCount_one` |

### 关键设计

- **一个组件、一处语义**：两个课程视图共用 `KnowledgeProvenance`，避免各自解释来源。
- **课程视图不借全局数据**：B10 用故意冲突的固定数据验证——全局「人工维护 / 9 个」，
  课程「系统推导 / 1 个」，页面显示后者。
- **异常优先级只保护显示**：滑块手柄停最近端点，`draft.priority` 不变；
  只改标题保存写回原值 3（B09 实测），用户真正拖动才覆盖。
- **真实边界测量**：沿用 P2-5-R1 思路，逐祖先检查裁剪、检查文字溢出与页面横向溢出，
  不用 `width > 0`。

### 过程中修复的两个真实缺陷（截图暴露，jsdom 无法发现）

1. 证据行显示「证据标识 证据标识 3 个」——标签与完整短语重复，已删标签。
2. 优先级显示「优先级 优先级异常 · 原始值 3」——已改 `goalPriorityLine()`，仅百分比加前缀。

两处均补了会失败的回归测试，并用变异测试验证断言有效（6 个变异全部被捕获）。

### 测试

| 验证 | 结果 |
| --- | --- |
| `tsc --noEmit`（web） | 0 错误 |
| 定向回归（profile + courses + i18n） | 24 文件 / 354 通过 |
| `npm --workspace my-learning-agent-web run build` | ✓ 1m 24s |
| `npm run build` | ✓ 1m 27s |
| 全量测试（default reporter） | 2554 用例：**2550 通过 / 1 失败 / 3 跳过** |

新增 **68** 项用例。与 P2-5-R1 基准（2486 / 2482 / 1 / 3）相比，通过数 +68，失败与跳过数不变。

唯一失败为已记录的历史基准失败，与本任务无关：

```text
FAIL apps/learning-agent/src/server.e48-workbench.test.ts
  > E4.8a — course status gates chat writes
  > allows an in_progress course to continue chatting
  AssertionError: expected 2 to be 1   (server.e48-workbench.test.ts:253)
```

单独重跑：1 失败 / 8 通过，同一用例。未删除、未跳过、未放宽。

### 浏览器验收 B01–B10

1440 / 390 / 320 三种宽度，light + dark，zh-CN + en，全部零 `pageerror`、零页面横向溢出。
暗色下来源块对比度实测 **6.59:1**（WCAG AA 要求 4.5）。

### 明确未做

- 未改知识状态引擎、证据生成/回放、记忆、掌握度/置信度/稳定性计算。
- 未改六种筛选规则、概览统计、正式复习资格、服务端 API、数据库、草稿保护规则。
- 未改 P2-5 响应式机制；P2-5 / P2-5-R1 资产未被覆盖。
- 未新增证据明细 API，未对 `legacy_` 做去重。
- 未新增服务端优先级校验或数据迁移。
- 无 P2-7 / P2-8 内容。
- 未开启自动合并。
