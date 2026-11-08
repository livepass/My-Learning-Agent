# E4.4-R1 课程学习上下文与会话归属完整性修复

基线：`763afe4`（E4.4）。只修审查发现的三个问题，不改 L1/L2/L3/B2 的判定规则，也不提前做 E4.5 页面。

## P1-1 课程级 L1 上下文隔离

### 问题

`before_agent_start` 无条件执行 `buildContextPack(profile, [])`。这个包是“全学习者”的：活跃目标取全库优先级最高者，薄弱概念、误区、到期复习都来自 `profile.knowledge_states` 全表。结果是一个已绑定 Python 的会话可以在系统提示里看到高数的掌握状态、误区和复习时间，模型很容易把另一门课的进度当成当前课程的证据。

### 修复

- `memory/learner/context-pack.ts` 新增 `scopeProfileToCourse(profile, { courseId, goalIds })`：
  - 目标只保留 `goalIds` 中显式绑定到本课程的；
  - `knowledge_states` 只保留 `course_id === courseId` 的；
  - 误区只保留“所属概念在本课程状态集合内”的；无归属概念一律排除，不猜测。
  - **教学偏好原样保留**（`preferences` 属于学习者，不属于某一科）。
- `agent/learning-extension.ts` 每轮只解析一次 `resolveCourseContext`，按结果三态处理：

| 会话归属 | 注入的通用 L1 包 | 课程上下文 |
|---|---|---|
| 已绑定课程 | 课程裁剪后的包 | `buildCourseLearningContext` 正常注入 |
| 未归类（有效 ID、无绑定） | 旧版全量包（兼容） | 不注入课程段 |
| 身份缺失 / 绑定不可读 | **不注入** | 不注入课程段 |

- 课程归属不可读时不再退回全量包：这正是跨课程泄漏最容易发生的时刻。该轮只保留系统教学提示，属于可降级而不是“猜一门课”。

## P1-2 一个学习任务的默认会话唯一性

### 问题

`CourseStore.bindSession` 只按 `session_id` 查重。同一任务可以先绑 A，再绑 B，得到两个任务会话；`learning-start` 与手动绑定接口都能触发。并发（两个进程或一次重试）时，调用方先读后写根本挡不住。

### 修复

- **写入事务内校验**：`bindSession` 在 `mutate` 回调里、插入之前执行 `assertTaskHasSingleSession`。同一任务已有其他会话 → `COURSE_SESSION_CONFLICT`（409），`mutate` 抛错不落盘、不递增 revision。
  - 同一会话重复绑定仍幂等（返回 `created: false`）。
  - “把无任务会话认领为任务会话”同样走这条校验，不能借认领绕开唯一性。
- **API 行为**：`POST /api/courses/:courseId/sessions` 现在会返回 409 `course_session_conflict`。
- **历史重复绑定**：新增 `listDuplicateTaskBindings(courseId)`，按任务分组、会话按 `created_at` 升序；`GET /api/courses/:courseId/sessions` 返回 `duplicate_task_bindings`（含说明），**不删除、不改写**任何绑定或 B2 记录。
- **继续学习**：存在多个历史会话时，确定性地继续最早的那个，并在 `warnings` 里说明“共 N 个历史会话，其余保持不变”，不做“修复”。
- **并发收敛**：如果另一个进程先完成了绑定，本次 `bindSession` 会冲突；`learning-start` 会撤销自己新建的空会话，转而激活并返回已存在的那个会话，而不是把一次点击变成错误。

## P1-3 会话身份缺失时不得扩大检索

### 问题

`resolveRecallScope` 对 `sessionId` 为空/非法的情况返回 `unclassified`，而 `unclassified` 的语义是“旧版全局召回”。于是“拿不到会话身份”被当成了“这是一段旧会话”，L3 会跨课程搜索；L2 的解析器同样把空 ID 当成 unclassified。

### 修复

- `memory/l3/recall-scope.ts`：
  - 无 store（未启用课程域的部署）→ `unclassified`（保持旧行为）；
  - 有效 ID + 无绑定 → `unclassified`（确认过的旧会话，兼容）；
  - **ID 缺失 → `unavailable{reason: missing_session_id}`**；
  - **ID 非法 → `unavailable{reason: invalid_session_id}`**；
  - 课程存储不可读 → `unavailable`（原有）。
- `memory/l2/l2-tools.ts`：范围解析新增 `unavailable` 态，`l2_query` 返回“无法确定课程归属，已停止检索（不会回退到全局资料）”，不发起检索。
- `agent/learning-extension.ts`：L2 解析器对缺失/非法 ID 与存储异常统一返回 `unavailable`；L3 继续使用同一解析器。
- 空课程范围仍是 `sourceIds: []` / 空集合，SQL/召回层按空集合直接返回空，绝不落到全局。
- 课程 ID 仍只来自服务端 `CourseSessionBinding`；`l2_query` / `l3_recall` 都没有 `course_id` 参数。

## 测试

新增/更新：

- `agent/learning-extension.test.ts`（5，真实 Extension 注册 + 真实课程存储 + 真实 profile 文件）：
  1. Python 会话的系统提示包含本课程目标/薄弱概念/共享偏好，**不含**高数目标、`导数` 状态与误区；
  2. 已确认未归类会话仍得到全量包（含高数状态）；
  3. 绑定指向不存在课程 → 不注入全量包，也不注入任何课程段；
  4. 无会话 ID → 不注入全量包；
  5. 无会话 ID 时 `l2_query` 返回 `course_scope_unavailable`，不检索。
- `courses/course-store.binding.test.ts`（8）：第二个会话被拒且不写入、同会话幂等、认领任务被拒、并发只有一个成功、跨课程互不影响、历史重复报告且保留、重复存在时拒绝第三个、删除一个只移除自己的绑定。
- `courses/learning-start.test.ts`（+3）：历史重复会话继续最早并给出警告、不删除任何绑定；最早的重复会话文件缺失时跳过它并继续下一个可用会话；并发先绑定者胜出时收敛到胜者会话。
- `server.course-learning.test.ts`（+3）：手动绑定第二个任务会话 409 且原归属不变、两个不同 `request_id` 并发开始收敛为同一会话、历史重复绑定在 API 中报告且继续最早会话。
- `memory/l3/recall-scope.test.ts`：缺失/非法 ID → `unavailable`。
- `memory/l2/l2-query-scope.test.ts`：`unavailable` → 不检索、返回明确错误。

## 剩余限制（E4.5 前）

- 历史重复绑定只报告与确定性续接，没有“合并/清理”入口；清理需要产品决策（可能涉及 B2 记录归档）。
- `duplicate_task_bindings` 只出现在会话列表接口，课程详情 `GET /api/courses/:courseId` 的 `snapshot` 尚未带该字段。
- 课程裁剪按 `course_id` 归属；E4.1a 之前产生的未归类知识状态不会被任何课程看到（这是既有契约，不是本次回归）。
- 无会话 ID 的轮次只能降级（无 L1 包、无课程记忆）；真正修复要保证运行时始终有会话文件，属于会话创建路径的约束，不在本次范围。
- 并发收敛依赖“恰好一个”竞争会话；若历史上已有多个，仍按最早会话继续并给出警告，不自动择一删除。
