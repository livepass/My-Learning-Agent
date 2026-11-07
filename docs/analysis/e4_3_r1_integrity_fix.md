# E4.3-R1 — 学习计划数据完整性与边界修复

- 完成时间：2026-11-07
- 基线：`e615faa`（E4.3）
- 范围：只修 E4.3 的数据完整性与边界，不新增课程 UI、不开发 E4.4、不改 L1/B2 规则与模型接入。
- 结论：PASS（范围内）。

## 1. 审查发现的问题与复现

| # | 问题 | 复现（修复前） | 后果 |
|---|---|---|---|
| P1-1 | 幂等检查在模型调用之后 | 先成功生成计划；把 provider 改为不可用；用同一 `request_id` 重发 → 仍调用模型并返回 502 | 重放依赖模型；重复点击产生无谓模型调用 |
| P1-1b | 重复保存会写文件 | 同一计划保存两次 → `courses/state.json` 的 `revision` 增加 | 无意义的存储版本变更 |
| P1-2 | 草稿 ID 不校验重复 | `PUT /plans/:id/draft` 传两个相同 `stage_id` 或 `task_id` → 写入两行同 ID 记录 | 后续更新/删除指向不确定的行 |
| P1-3 | 跨计划移动只更新目标计划 | PATCH task 把任务从 A 移到 B → A 的 revision 不变、A 的顺序出现空洞 | 旧计划并发检查失效，顺序不连续 |
| P1-4 | 删除已绑定任务产生悬空 task_id | 会话绑定任务后 DELETE，或 `PUT draft` 省略该任务 → 任务被删除，binding 仍指向它 | 会话与 B2 历史断链 |
| P1-5 | 计划目标未校验课程绑定 | 课程 A 的计划直接关联课程 B 的 `goal_id` → 保存成功 | 课程关系被伪造 |
| P1-5b | 任务来源/引用未校验 | 手动任务写入其他课程 `source_ids`，或自造 `source_refs.page_path` → 保存成功 | 伪装成课程已验证教材引用 |
| 次-1 | 前置建议读取全局概念页 | 课程只允许 Python 资料，建议仍可读到高数概念页的前置边 | 跨课程建议泄漏 |
| 次-2 | `defer_task` 对末尾任务也执行 | 对已是最后一个的任务 apply → revision +1、记录一条无效果调整 | 无意义变更 |
| 次-3 | 指纹缺少课程/材料版本 | 修改 manifest 的 `contentHash`/`updatedAt` 后重发同参数 → 返回旧计划 | 资料更新后继续复用过期计划 |

## 2. 修复

### 2.1 生成请求幂等

- 新增 `CourseStore.lookupGeneratedPlan(courseId, requestId, fingerprint, { matchFingerprint, requestFingerprint })`：
  - `PlanGeneration` 同时保存完整指纹与**意图指纹**（课程、目标、预算、日期、依据、基础），资料/L1 版本变化不影响同一请求的重放；
  - 同 `request_id` 同意图 → `found`（`request_id`），即使材料已更新；
  - 同 `request_id` 不同意图 → `conflict`；
  - 新 `request_id` 但完整指纹相同 → `found`（`fingerprint`）；
  - `force: true` 只关闭完整指纹匹配，不关闭 `request_id` 冲突。
- 路由在调用模型前执行该查询；命中直接返回已存计划，模型不可用也能重放。
- E4.4 起，`request_id` 重放判定进一步前移到**读取教材之前**：来源被全部解绑或 L2 短暂不可用，也不会把一次成功请求变成 409/503，仍返回原计划且不调用模型。
- 同一指纹的并发请求通过 `singleFlightPlanGeneration` 合并为一次模型调用（进程内 Map，完成后释放）。
- 持久化仍在 `saveGeneratedPlanDraft` 内做最终原子重查；重复时走新的 `mutateOptional` 回调 `write: false`，**不写文件、不递增 revision**。
- `ctx.completeModel` 的“未配置”检查移到幂等查询之后：已有计划的重放不需要模型。

### 2.2 草稿 ID 唯一性

- `replacePlanDraft` 在写入前校验：
  - 所有非空 `stage_id` 在整份请求中唯一；
  - 所有非空 `task_id` 在阶段内、跨阶段、独立任务列表之间唯一；
  - 重复返回 `COURSE_INVALID`（HTTP 400），`mutate` 未执行，旧状态不变。
- `replacePlanStages` 同样拒绝重复 `stage_id`。

### 2.3 跨计划任务移动

- `updateTask` 跨计划移动时：
  - 必须提供 `expected_revision`（原计划版本），可选 `expected_target_revision`；
  - 旧计划校验通过后才移动；
  - 任务从旧计划移除后 `reindexTasks` 关闭空洞，再追加到新计划末尾；
  - 旧、新计划 revision 各 +1（同一计划只加一次）；
  - 跨计划时 `stage_id` 置空，避免阶段跨计划悬空。
- 路由 `PATCH /tasks/:id` 支持 `expected_revision` / `expected_target_revision`。

### 2.4 已绑定会话的任务保护

- `deleteTask`：存在 `CourseSessionBinding.task_id` 引用时返回 409，不删除任务。
- `replacePlanDraft`：提交的任务集合若遗漏任何已绑定任务，返回 409，不写任何部分结果。
- `replacePlanStages` 只解除任务的 `stage_id`，不删除任务。
- 会话绑定、AI 会话与 B2 记录均未被删除。

### 2.5 课程归属与来源校验

- 计划 `goal_id`：`createPlan`、`createPlanWithStructure`、`updatePlan`、`replacePlanDraft`、`saveGeneratedPlanDraft` 均要求存在 `(course_id, goal_id)` 的 `CourseGoalBinding`，否则 409。
- 手动任务 `source_ids`：必须是该课程 active `CourseSourceBinding`，且 manifest 状态为 `indexed`；否则 409。
- 手动任务 `source_refs`：一律拒绝（400）。草稿编辑只能原样回传已存在的引用；新任务带引用、修改引用字段、删除后重建引用都会被拒绝。
- 存储层 `replacePlanDraft` 再做一次防御：新任务带 `source_refs` 或引用内容变化 → 400。
- 任务编辑只改标题时，未提交的 `concept_ids` / `source_ids` / `source_refs` / 预计时长 / 难度 / 说明保持不变；修改 `source_ids` 时自动移除指向已删除来源的引用。

### 2.6 次要修复

- **前置知识范围**：`loadPrerequisiteEdgesAsync` 新增 `allowedSourceIds`；概念页的 `source_ids` 必须全部在当前课程 active 来源内，无来源归属的页面在有范围时跳过。建议路由传入当前课程来源。
- **无效调整**：`applyPlanAdjustment` 对 `defer_task` / `reorder_task` 比较调整前后的任务顺序签名，相同则 409；`adjust_difficulty` 相同难度 409；同一知识点已有未完成的「复习：/练习：」任务时拒绝重复插入。建议层也不再对“已经是最后一个”的任务生成暂缓建议，改为选择最长的可移动任务。
- **指纹版本**：`planFingerprint` 增加 `course.updated_at`、目标标题、`material.material_version`（来源 id + contentHash + updatedAt + passage 数）。资料或课程元数据变化后，**新 request_id** 生成新计划，不返回旧草稿；**同 request_id** 仍按意图指纹重放，不会因资料更新误报冲突。

## 3. 新增测试

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `courses/course-store.integrity.test.ts` | 10 | 重放不递增 revision、request id 冲突、重复 stage/task ID、跨计划移动与旧 revision、删除/替换绑定任务、目标绑定、defer 无效、重复支持任务、草稿编辑保留字段 |
| `memory/learner/prerequisite-store.test.ts` | +1（共 2） | 课程来源范围内的前置边；全局读取保持旧行为 |
| `server.course-plans-r1.test.ts` | 10 | 模型不可用时重放、不同意图冲突、并发单飞、重复 ID 400、跨计划移动、绑定任务删除 409、跨课程目标/来源、伪造引用 400、资料版本变化后重新生成、会话绑定保留 |

关键断言：

- 重放：`providerCalls === 0`，`state.json revision` 不变，计划/任务 ID 不变。
- 并发：两个同指纹请求只产生 **1** 次模型调用，返回同一 `plan_id`。
- 重复 ID：HTTP 400，计划 revision 不变，任务列表保持原样。
- 跨计划：旧计划 `[A2:0]`，新计划 `[B1:0, A1:1]`，两边 revision 各 +1。
- 绑定任务：DELETE 409，任务仍在，`CourseSessionBinding.task_id` 仍在。
- 来源：跨课程 `source_ids` 409；自造 `source_refs` 400；合法来源 201。
- 资料更新：manifest `contentHash` 变化后，同 `request_id` 仍 200 重放（0 次模型调用）；新 `request_id` 同参数 201 新计划，而不是 duplicate。

## 4. 测试结果

```
npx vitest run apps/learning-agent/src/courses \
  apps/learning-agent/src/memory/learner/prerequisite-store.test.ts \
  apps/learning-agent/src/server.course-plans.test.ts \
  apps/learning-agent/src/server.course-plans-r1.test.ts \
  apps/learning-agent/src/server.course-daily.test.ts
# 11 文件 / 107 通过 / 0 失败
```

全量：`npx vitest run --maxWorkers=4` → **154 文件 / 1574 通过 / 3 跳过 / 0 失败**。
构建：`npm run build` → 通过。

## 5. 兼容性

- E4.1 课程实体、E4.1a 四层记忆契约、E4.2 索引级来源隔离未改。
- B2 评分/证据、L1 掌握度、C1–C4 流程未改。
- 模型接入方式未改；仅侧通道失败日志增加一条 warning（不含凭据/提示词）。
- 既有 E4.3 行为变化（有意的）：
  - 跨计划移动任务现在必须带 `expected_revision`；
  - 手动任务不能自定义 `source_refs`；
  - 计划 `goal_id` 必须已绑定课程；
  - 已绑定会话的任务不能删除，草稿替换不能遗漏它。

## 6. 遗留

1. 单飞是**进程内**的；多进程/多实例部署仍可能各调用一次模型，最终由存储层幂等收敛为一套计划。若需要跨进程单飞，需要外部锁或队列，本轮未做。
2. `mutateOptional` 的重复保存路径仍会获取写锁（实际不会写文件）；常规重放已由路由预检查避免。
3. 任务来源校验依赖 manifest 的 `indexed` 状态；索引失败但绑定 active 的来源会被拒绝，符合“可信来源”要求，但用户需先重试入库。
4. 前置知识页若没有 `source_ids`，在课程范围内不会参与建议；这是有意的 fail-closed，可能漏掉手工维护的全局概念页。
5. 指纹包含课程 `updated_at`，仅修改课程描述也会触发新计划；这是保守策略，可能产生额外草稿。
