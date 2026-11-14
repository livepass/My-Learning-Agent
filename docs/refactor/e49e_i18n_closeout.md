# E4.9e — 中英文国际化遗漏修复与专项验收

- 修复前：`7e95fb7`
- 修复后：`4a7d534`
- 范围：界面文案、规则生成的说明、状态与错误提示；未改 AI 生成内容、后端提示词、数据格式与业务规则

## 1. 遗漏清单与修复对应表

### 1.1 规则生成的说明（服务端产出中文，前端直接显示）

| 位置 | 字段 | 修复前表现 | 修复方式 |
| --- | --- | --- | --- |
| 今日学习 · 课程任务 | `DailyTaskItem.reason` | 英文界面显示中文任务说明 | 按 `reason_code`（`over_budget` / `in_progress` / `next_task`）在前端生成，新增 `today.task.reason.*` |
| 今日学习 · 到期复习项 | `DailyReviewItem.reason` | 同上 | 固定 `review_due`，用 `today.review.reason.review_due` |
| 今日学习 · 课程说明 | `CourseDailyPlan.notes` | 英文界面显示中文说明 | 由 `status` / `other_active_plans` / `plan.title` 重建：`today.plan.{notes,noActivePlan,progressVsMastery,otherActivePlans,allCompleted,noteSeparator}` |
| 今日学习 · 下一步建议 | `LearningRecommendation.reason` | 英文界面显示中文推荐理由 | 按 `reason_code` 生成五种文案；`exposure_only` 单独成句；复习日期插值；未知规则回退原文 |
| 练习页 · 学习建议 | 同上 | 同上 | 复用同一 `recommendationReasonText` |

服务端的 `reason` / `notes` 字段**保留不动**（旧客户端兼容），前端不再把它们当作主显示文本。

### 1.2 错误提示

| 位置 | 修复前 | 修复方式 |
| --- | --- | --- |
| `courses-store.messageOf()` | 固定中文；优先返回服务端 `message` | 改为 `feedbackFor()` + `errorRef()`：已知错误码映射 `course.error.*`（21 个），未知按 404/409/503 归类，其余用 `course.error.generic`；原始 `message` 只作诊断 |
| 读取错误（10 个字段） | 存中文句子 | 存 `CourseErrorRef { messageKey, messageParams, message, code }` |
| 写入反馈 `CourseFeedback` | 存中文句子 | 增加 `messageKey` / `messageParams` / `code` / `revision`；冲突保留版本号并新增带 `{{revision}}` 插值的键 |
| 渲染层 | 直接打印 `message` | 新增 `useCourseErrorText()` / `useCourseFeedbackText()`，按当前语言解析，语言切换后已显示的错误随之更新 |

业务语义（400/404/409/503 的分类与重读行为）未变；测试断言从「包含旧中文」改为断言 `messageKey` / `messageParams`，行为覆盖不变。

### 1.3 边界确认（未修改）

| 内容 | 处理 |
| --- | --- |
| 课程名、计划名、阶段/任务名 | 保持原文（实机验证：英文界面显示「英语四级」「学习计划」「任务一」） |
| 用户作答、历史聊天、AI 题目与评分反馈 | 未触碰 |
| ID、枚举值、证据记录 | 未触碰 |
| 服务端 `message` / `reason` / `notes` | 字段与内容保留，仅不再作为主显示文本 |
| 模型提示词与 AI 回答语言 | 未改（界面语言 ≠ AI 回答语言） |

## 2. 新增翻译键

31 个（中英各一份，键总数 1331 → 1363 / 1333 → 1365）：

- `course.error.*` 15 个：`notFound`、`conflict`、`conflictReread`、`conflictWithRevision`、`unavailable`、`generic`、`archived`、`paused`、`completed`、`courseRequired`、`stateInvalid`、`dataCorrupt`、`readOnly`、`locked`、`sessionBusy`
- `today.plan.*` 6 个：`notes`、`noActivePlan`、`progressVsMastery`、`otherActivePlans`、`allCompleted`、`noteSeparator`
- `today.task.reason.*` 3 个：`over_budget`、`in_progress`、`next_task`
- `today.review.reason.review_due` 1 个
- `today.recommendation.reason.*` 7 个：`active_misconception`、`review_due`、`review_dueOverdue`、`fragile_evidence`、`learning_exposureOnly`、`learning_needs_diagnosis`、`stable_transfer`

## 3. 测试

```
npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json     PASS
npx vitest run apps/learning-agent/web/src/react \
  apps/learning-agent/web/src/i18n apps/learning-agent/web/src/stores
  → 45 files / 510 tests PASS
npm run build                                                 PASS
```

新增定向测试 14 项：

- `daily-plan-copy.test.tsx`（8 项）：三种任务理由中英含义一致、英文无中文、计划数量插值、计划标题保持原文、无计划/全完成说明、五种推荐理由双语、`exposure_only` 分支、复习日期插值与缺失、语言切换即时更新。
- `course-error-text.test.tsx`（6 项）：已知错误码双语、冲突版本号插值、有键时不显示原始服务端句子、无键时才回退原文、null 错误渲染空、反馈冲突双语。

`locales.test.ts` 8 项继续通过（含「英文资源不得含中文」与「字面量键必须存在」两项检查，本轮新增键全部覆盖）。

## 4. 真实浏览器验收

独立数据目录 + 当前构建（3110 端口），真实浏览器，非 mock：

| 检查 | 结果 |
| --- | --- |
| 今日学习（英文） | PASS — 任务说明、课程说明、推荐文案均为英文；服务端中文 `reason` / `notes` 未出现在页面上 |
| 今日学习（中文） | PASS — 文案恢复中文，无裸键 |
| 设置页语言切换 | PASS — 通过真实下拉框选择「中文」，标题与导航**即时**切换，无需刷新（`localStorage` 同步为 `zh-CN`） |
| 练习与反馈（英文） | PASS — 无中文残留、无裸键 |
| 我的学习档案（英文） | PASS — 无中文残留 |
| 课程详情（英文） | PASS — 仅剩用户内容（课程名/计划名/阶段名/任务名）为中文，符合边界 |
| 异常状态（404，英文） | PASS — 显示 "This course or plan no longer exists; it may have been deleted." |
| 异常状态（404，中文） | PASS — 显示「该课程或计划不存在，可能已被删除。」 |

截图：`docs/ui/e49e-today-en-1440x1000.jpg`、`docs/ui/e49e-today-zh-1440x1000.jpg`。

**测试未使用真实模型**：fixture provider 指向不可达地址，本轮所有验收均为界面层与错误路径，未触发模型调用。

## 5. 未解决问题

1. **服务端中文文案仍存在**：`daily-plan.ts` 的 `reason` / `notes`、`recommendations.ts` 的 `reason`、以及各 `failure(...)` 的中文 `message` 都还在。前端已不再把它们作为主显示文本，但**其他客户端**（未来的移动端、脚本）仍会读到中文。若要彻底统一，需要在后端按语言返回或只返回结构化字段——超出本轮「不修改后端 API」的约束，标记 **NOT_VERIFIED**。
2. **部分错误仍可能显示原始文本**：当后端返回一个前端未登记的 `code` 且没有可用的 HTTP 状态分类时，界面回退到服务端原文（可能是中文）。当前已覆盖 21 个课程/学习错误码与 404/409/503 三类状态，其余路径未逐一枚举。
3. **`ArchiveSettings` 的反馈**仍用 `coursesStore.feedback?.message` 作为兜底文本（`archive.errors.restoreCourseRetry` 已在前面兜底），未逐条接入 `useCourseFeedbackText`。
4. **后端其他中文**（校验错误、评分提示词等）不面向终端用户，未处理。
5. 未跑全量历史测试与后端验收；未做移动端逐页截图。

## 6. 结论

| 验收条件 | 结论 |
| --- | --- |
| 已确认的系统固定文案与规则说明支持中英文切换 | **PASS** |
| English 界面不再出现未登记的中文系统文案（已覆盖的有效业务状态） | **PASS**（服务端 `reason`/`notes` 已被前端本地化取代） |
| 切换语言后无需刷新即可正确显示已有系统文案 | **PASS**（设置页真实下拉框验证） |
| 用户及 AI 原始学习内容保持不变 | **PASS** |
| TypeScript、构建与相关定向测试通过 | **PASS** |
| 核心学习闭环没有回归 | **PASS**（510 项测试含练习提交/评分/证据、课程归档、会话路径） |

**E4.9e 最终结论：PASS**，附第 5 节两条 **NOT_VERIFIED** 项（服务端中文文案的跨客户端统一、未登记错误码的兜底语言）。
