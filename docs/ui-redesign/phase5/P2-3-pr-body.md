## E4.9i-P2-3｜学习概览结论与薄弱知识区块

**基准：** `main@a0e063f7f8569551612f675e107e0795b5acc69f`（开工时已核对，未变化）
**验收报告：** `docs/ui-redesign/phase5/P2-3-acceptance.md`
**截图与指标：** `docs/ui-redesign/phase5/P2-3-assets/`

### 目标

进入「我的学习档案 → 全部课程」后，用户能直接看出：记录了多少知识点、哪些需要关注、哪些稳定、是否存在待复习状态或未解决误区，以及档案为这些知识点记录了哪些下一步动作。**所有结论都来自已有字段，不调用 AI 重新分析。**

### 改动

| 文件 | 内容 |
| --- | --- |
| `react/profile/profile-overview.ts` | 纯计算 `deriveProfileOverview()`：四项原有统计与新结论共用同一结果 |
| `react/profile/ProfileConclusion.tsx` | 两层结论（事实 + 下一步关注）与固定口径说明 |
| `react/profile/WeakKnowledgeSection.tsx` | 需要关注的知识点：名称 / 领域 / 正式徽章 / 已记录的下一步动作 |
| `react/LearnerProfilePanel.tsx` | 概览接入结论，新增弱项卡（知识状态之后、学习目标之前），刷新中/失败时暂停结论 |
| `i18n/locales/{zh-CN,en}.json` | 新增 `profile.conclusion.*`、`profile.weak.*` |
| 4 个测试文件 | 新增 53 项用例，另含既有套件回归 |

冻结模块（`KnowledgeList` / `KnowledgeRow` / `KnowledgeDraftGuard` / `CourseLearnerPanel` / `PracticePage` / 后端）**0 行改动**。

### 规则边界

- 状态只取 `state_label`，经 `normalizeKnowledgeStateLabel()` / `isWeakKnowledgeState()`；不据 `mastery` / `confidence` / `stability` 新建阈值。
- `review_due` 是**分类计数**，不称「正式到期」；到期判定仍由服务端今日学习结果决定。
- 误区**知识点数**与误区**记录数**分开统计，不相加。
- 弱项卡按服务端顺序，默认展示 3 条并注明剩余数量；不按 mastery 重排、不用 `diagnosis` 顶替下一步动作、不新增定向练习或复习入口。
- 结论不得出现「已掌握全部」「正确率达到」「必须今天复习」等无数据支撑的说法（测试显式断言禁止列表）。

### 加载与错误

`load()` 失败时保留旧 `profile`。因此结论分四态：`loading` / `refreshing` / `failed` / `ready`，只有 `ready` 才生成结论；刷新中与失败时提示暂停原因，错误卡注明「数据可能已过期」，知识列表保持挂载以保护未保存草稿，并复用现有「刷新」重试。

### 测试

- 定向：11 个文件 / **143 项全部通过**（新增 53 项）。
- `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json`：通过。
- `npm --workspace my-learning-agent-web run build`、`npm run build`：通过。
- 全量 `npx vitest run`：**2352 通过 / 1 失败 / 3 跳过**。
  - 唯一失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`，为既有失败；`git diff origin/main -- apps/learning-agent/src` 为 0 行。
  - 基线 2298 通过 / 1 失败 / 3 跳过 → 本轮 +54 通过，失败与跳过数不变。

### 浏览器验收

Playwright + Chromium 驱动真实 React 页面，`page.route` 注入受控 fixture（不读写真实档案、无需后端）。16 个场景覆盖 1440×900 / 1024×768 / 768×1024 / 390×844 / 320×640、空态、无弱项、仅证据不足、首次失败、刷新失败、刷新中、长名称、深色、英文与指定课程视图。全部场景无 JS 错误、无页面横向溢出、新增区块无内容溢出。

### 已知问题（不在本阶段范围）

- 320px 下既有「学习目标」卡片与「知识状态」行的固定列挤压仍在（P2-2 已记录，本阶段未修复；新增区块不受影响）。
- 按知识点定向练习交接尚未实现（任务书 5.5 边界）。

### 验收门槛

- [x] 基于指定 `main` 提交开发
- [x] 结论完全由现有字段生成，四项统计口径不变
- [x] 复用 `isWeakKnowledgeState()`，未把 mastery 当正确率
- [x] 未把 `review_due` 当作正式到期，未混淆误区两种计数
- [x] 未伪造下一步建议，未新增复习调度/定向出题
- [x] 摘要编辑与知识编辑保护无退化，课程范围隔离通过
- [x] 新增测试、TS、Web 构建、完整构建全部通过
- [x] 浏览器验收、截图与指标完整
- [x] 验收报告已生成

## E4.9i-P2-3-R1 修正（审查反馈）

审查基准 `016133b`，在**同一分支、同一 PR** 内修复，未新建 PR。

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| F01 | 未解决误区记录只在 `weakCount > 0` 分支渲染，且 `totalConcepts === 0` 提前 return 会跳过 | 提示提为独立变量，`openMisconceptions > 0` 即渲染；与 misconception 状态计数仍分开 |
| F02 | 直接读 `next_actions.length` / `[0]`，缺失/`null`/非数组会在 render 抛错 | `firstRecordedAction(value: unknown)`：只读、取第一条非空白、不排序不改数组、不生成建议 |
| F03 | 机器名称 `concept_45125622e640` / `concept 45125622e640` 原样展示 | 复用 `trustedConceptLabel()`，与练习页同一规则 |

- 新增 25 项回归（R01–R21 + 顺序/不可变/中英文）；其中 12 项在改前代码上失败，确认覆盖缺陷。
- 定向 115/115；全量 **2377 通过 / 1 失败 / 3 跳过**（仍仅 `server.e48-workbench.test.ts` 历史失败）。
- TypeScript、Web 构建、完整构建通过。
- 浏览器：脚本保留原 16 个 P2-3 场景，新增 10 个 R1 场景写入 `r1-browser-metrics.json`；P2-3 原始截图未覆盖。
- 验收报告新增第 13–21 章（`P2-3-acceptance.md`）。

**R1 结论：`P2-3-R1 PASS_WITH_KNOWN_BASELINE_FAILURE`。**

**本 PR 待审查，不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
