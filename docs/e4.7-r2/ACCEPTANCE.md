# E4.7-R2 验收报告

会话删除体验与课程学习记录可追溯性修复。改动已提交（见 `git log`），未推送。

---

## 一、修复前根因与复现

### 1. 最后一个会话无法删除

**根因**：PI SDK 没有「无会话」状态，运行时必须始终绑定一个会话文件。`deleteSessionFileInQueue` 在删除当前会话前要求 `selectReplacement()` 返回一个**已存在的**会话；`selectReplacementSession` 只接受 `messageCount > 0` 且未归档的会话。只有一个会话时必然返回 `null`，路由抛 `NoReplacementSessionError`，返回：

```
409 {"error":"no_replacement_session","requiresExplicitChoice":true}
```

前端只能提示「请先新建一个会话，或归档后再删除」——用户被迫创建一个无意义的会话才能删掉真正的最后一个。

**复现**（修复前）：
1. 清空数据目录，`POST /api/sessions` 创建一个会话；
2. `DELETE /api/sessions/<id>` → 409 `no_replacement_session`；
3. 无论确认多少次都无法删除。

### 2. 课程删除预览只有数量，无法定位

**根因**：`courseDeletionReport` / `planDeletionReport` 只统计 `started_tasks` 数量并生成一条 blocker 文案。对话框因此只能显示「该课程有 N 个任务已开始或完成」，用户不知道是哪些任务、属于哪个计划/阶段、有没有真实会话或 B2 证据。同时「任务状态 ≠ 学习证据」这条规则只写在注释里，没有体现在数据上。

**复现**（修复前）：建一门课 → 建计划 → 把一个任务标为 `in_progress` → 打开删除对话框，只能看到「1 个任务已开始或完成」，无法定位。

---

## 二、后端改动

| 文件 | 改动 |
| --- | --- |
| `src/agent/pi-runner.ts` | `SessionDeletionPlan.createReplacement`（可选）；`deleteSessionFileInQueue` 在无既有替代会话时**在同一 Agent 队列槽内**创建空白会话、校验运行时已绑定、再 unlink 原文件；失败时 `discardFailedBlankSession` + `restoreRuntimeBinding` 回滚。导出 `createNewSessionInQueueSlot`。`SessionDeletionOutcome.createdReplacement`。 |
| `src/agent/session-lifecycle.ts` | 新增 `ReplacementCreationError`。 |
| `src/server/routes/sessions.ts` | DELETE 读取可选 body `{ createReplacement: true }`；仅在显式确认时传入 `createReplacement`；返回 `replacedWith: "created"`；新会话按 `POST /api/sessions` 相同路径记录 web origin 并绑定临时工作区；创建失败 → `500 replacement_create_failed`（原会话保留，`retryable: true`）；409 文案改为「确认删除并新建空白对话后可以继续」。 |
| `src/courses/types.ts` | 新增 `TaskEvidenceState`、`CourseDeletionTaskDetail`；`CourseDeletionReport.started_task_details` / `mastery_state_count`；`PlanDeletionReport.started_task_details`。 |
| `src/courses/course-store.ts` | `startedTaskDetails()`：从同一 `state.json` 快照生成 task/plan/stage 标题、状态、完成/更新时间、绑定会话列表与初始证据状态；两个 report 构造器接入。 |
| `src/server/routes/courses.ts` | `annotateDeletionEvidence()` 用 B2 计数把 `session_bound` 升级为 `b2_evidence`；`courseMasteryStateCount()` 读取课程范围 L1；两个 delete-preview 路由返回明细。 |
| `src/learning/record-store.ts` | 新增 `countFormalEvidence()`；`recordHasFormalEvidence()` 改为复用它（同一判定，避免两套规则漂移）。 |
| `src/server.ts` | 注入 `learningEvidenceCounts`：缺失记录计 0，不可读记录不写入 map（预览显示「待核实」，不伪造成 0）。 |

### 新增 API 字段

**`DELETE /api/sessions/:id`**

| 字段 | 说明 |
| --- | --- |
| 请求 body `createReplacement?: boolean` | 用户明确确认「删除并新建空白对话」。缺省/false 时保持原 409 行为，服务端绝不静默创建。 |
| 响应 `replacedWith` | `"existing"`（切到已有会话）/ `"created"`（新建空白会话）/ `null`（非当前会话删除）。 |
| 错误 `500 replacement_create_failed` | 空白会话创建失败；原会话未删除，`retryable: true`。 |

**`GET /api/courses/:courseId/delete-preview`、`GET /api/courses/:courseId/plans/:planId/delete-preview`**

| 字段 | 说明 |
| --- | --- |
| `started_task_details[]` | `task_id`、`task_title`、`plan_id`/`plan_title`、`stage_id`/`stage_title`、`task_status`、`completed_at?`、`updated_at`、`session_bound`、`session_ids[]`、`b2_evidence`、`b2_evidence_count`（不可读为 `null`）、`evidence_state`。 |
| `evidence_state` | `task_progress_only`（仅任务进度）/ `session_bound`（已关联会话但无正式证据）/ `b2_evidence`（有 `evidence_recorded` 及之后的作答）。 |
| `mastery_state_count`（仅课程） | 课程范围 L1 掌握状态数量；与任务证据分开陈述。 |

`evidence_state` 只由「是否有绑定会话」+「B2 正式作答计数」决定，**任务状态从不被提升为证据**。

---

## 三、前端改动

| 文件 | 改动 |
| --- | --- |
| `web/src/api/sessions.ts` | `deleteSession(id, { createReplacement })`；`replacedWith` 增加 `"created"`。 |
| `web/src/stores/sessions-store.ts` | 删除当前会话且 `replacedWith === "created"` 时先刷新列表再以 `replace` 打开新会话（Back 不会回到已删会话）。失败不修改本地状态。 |
| `web/src/react/pages/LearnPage.tsx` | 删除当前会话时传 `createReplacement: true`；唯一会话的确认文案写明「删除后会立即新建一个空白对话并进入其中」；新增 `replacement_create_failed` 提示。删除其他会话行为不变。 |
| `web/src/react/settings/ArchivedSessionsSettings.tsx` | 归档中心遵循同一策略：删除运行时绑定的会话时传确认标志，并在对话框中说明结果；其他归档会话仍是普通文件删除。 |
| `web/src/api/courses.ts` | 同步新增类型。 |
| `web/src/react/courses/DeletionDialog.tsx` | 新增可折叠「查看涉及的具体任务（N）」列表：任务名、计划/阶段、进行中/已完成、关联会话数、B2 证据数、更新时间；三种证据徽章；有绑定会话时提供「查看学习记录」跳转；`mastery_state_count` 单独说明。 |

---

## 四、测试

新增/更新的测试：

- `src/session-delete-runtime.test.ts`（+4）：创建空白替代会话、创建失败回滚、绑定校验失败不删原文件、未确认时不创建。
- `src/server/routes/session-delete-races.test.ts`（+5）：唯一会话确认后删除并进入新会话、创建失败保留原会话、并发两个删除只创建一个替代会话、非当前会话删除不受影响。
- `src/courses/course-store.lifecycle.test.ts`（+2）：任务明细字段与证据分类、未开始任务不入列表。
- `src/server/routes/courses.lifecycle.test.ts`（+2）：HTTP 预览的任务明细与 B2 升级、课程范围 L1 单独统计。
- `web/src/react/pages/LearnPage.test.tsx`（+3 / 改 1）：唯一会话确认文案与 `createReplacement`、失败保留、非当前删除不传标志。
- `web/src/stores/sessions-store.test.ts`（+2）：确认标志透传、失败不改变当前会话。
- `web/src/react/courses/DeletionDialog.test.tsx`（+2）：三种徽章与跳转、B2 计数显示。
- `web/src/react/pages/SettingsPage.archived.test.tsx`（+2）：归档中心唯一会话策略、非当前归档会话不传标志。

**结果**

```
npm run build        → 通过（tsc + vite build）
npx vitest run       → 170 个测试文件通过，1805 通过 / 3 跳过
```

> 复验（提交前）：`vitest run --shard=1/2` 85 文件 / 1100 通过 / 3 跳过，`--shard=2/2` 85 文件 / 705 通过；合计 170 文件 / 1805 通过 / 3 跳过。跳过数随平台变化（本机为 3），用例总数 1808 与上表一致。

> 说明：某次并行全量运行中 `server.recommendations.test.ts` 曾因真实子进程的 writer-lock 竞争偶发失败（`learning_read_only` 503）；单独运行与随后两次全量运行均通过，该测试与本轮改动无交集。

---

## 五、浏览器验收

环境：隔离数据目录 + 本地确定性模型服务（`dummy` provider），`node apps/learning-agent/dist/server.js`。

| 截图 | 内容 |
| --- | --- |
| `A1-single-session.png` | 只有一个会话时打开 AI 学习页 |
| `A2-after-delete-new-session.png` | 确认删除后自动进入新建的空白对话，原会话从列表消失 |
| `A3-new-session-chat.png` | 新会话可正常继续聊天并收到回复 |
| `B1-two-sessions.png` | 两个会话，当前会话高亮 |
| `B2-menu-on-other-session.png` | 在**另一个**会话上打开菜单 |
| `B3-after-deleting-other.png` | 删除非当前会话后，当前会话保持不变 |
| `C0-today.png` | 今日学习页（含课程卡片） |
| `C1-delete-preview.png` | 课程删除预览：四条 blocker |
| `C2-task-details.png` | 展开具体任务：`B2 正式证据 1 条` 与 `仅有任务进度，证据待核实`，L1 掌握状态单独说明 |
| `C3-jump-to-record.png` | 点击「查看学习记录」跳转到对应会话，检查点正常显示 |

自动化断言（Playwright，真实浏览器）：

```
A: copy names the last conversation: true
A: copy promises a blank conversation: true
A: old file gone: true
A: new session visible: true
A: url points at the new session: true
A: new session answers: true
B: plain copy (no replacement promise): true
B: the other conversation was removed: true
B: the open conversation was kept: true
C: B2 flow: 200 200 200
C: B2 badge with count: true
C: status-only label: true
C: mastery stated separately: true
C: jump button: true
C: jump opened the bound conversation: true
C: permanent delete refused: true ["course_sessions","started_tasks","mastery_states","learning_evidence"]
```

课程删除门禁保持不变：有会话、已开始任务、L1 掌握状态或 B2 正式证据时继续 409，只提供归档。

**B2 记录不可读时**：沿用既有 fail-closed 规则，`delete-preview` 返回 503 `course_io`，不会把「无法读取」当成「没有证据」；明细里的 `b2_evidence_count: null` 分支是防御性处理（例如未注入探针的部署）。

---

## 六、范围与状态

- 未新增学习功能；未修改 L1/L2/L3/B2 的权威数据规则。
- 已提交（本地 `main`），未推送。改动文件见提交记录；新增目录 `docs/e4.7-r2/`（本报告与截图）。
