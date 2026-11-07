# E4.1a — 多课程 L1/L2/L3/B2 架构补充与数据契约修订

- 完成时间：2026-11-07
- 基线：`main` @ `45d0b55`（E4.1 课程实体、`/api/courses`、课程详情与归档）
- 范围：只补四层记忆与课程的关联契约、最小实现和测试。**未改动** L1 掌握度算法、B2 评分与证据状态机、C1 出题规则、C2 评分规则、C3 幂等写入、C4 复习闭环、模型供应商接入。
- 结论：PASS（范围内）。真实浏览器 UI 未新增；课程页面与课程级 L3 自动召回按计划留给 E4.4 / E4.5。

## 0. E4.1 现状审计

| 能力 | 状态 | 证据 |
|---|---|---|
| `Course` 课程实体 | **已实现，可复用** | `courses/types.ts`；`courses/course-store.ts`；`POST/GET/PATCH /api/courses` |
| 课程 ↔ `LearningGoal` 关系 | **已实现** | `CourseGoalBinding`，显式绑定；L1 `LearningGoal` 零改动 |
| `StudyPlan` 学习计划 | **已实现** | 归属单课程；`agent_suggested` 强制 `draft` 待确认 |
| `LearningTask` 学习任务 | **已实现** | `plan_id` 必须同课程；`concept_ids` / `source_ids` 显式列表 |
| 课程 ↔ Session 关联 | **已实现** | `CourseSessionBinding`；不可跨课程改绑；删除会话清理绑定 |
| 课程 ↔ L2 资料关联 | **部分实现** | E4.1 有 `CourseSourceBinding`，但只有 `created_at`，无关联状态与审计字段，解除即删除记录 |
| 持久化 / API / 测试 | **已实现** | 单文件 `data/courses/state.json`，进程内串行 + 数据目录写锁；21 + 8 + 1 项测试 |
| L1 按课程查看 | **缺失** | L1 只有全局 `knowledge_states` / `goals`，没有课程视图；知识点 ID 只按名称哈希 |
| 同名知识点隔离 | **缺失（真实碰撞）** | `deriveConceptId(label)` 只对标签做 sha256：Python 的「函数」与高数的「函数」得到同一个 `concept_id`，会合并掌握度 |
| L2 课程范围检索 | **缺失** | `searchL2` 全局 BM25 + 图谱扩展；`retrieveCandidates` 只按 manifest 归属，不按课程 |
| L3 课程范围召回 | **缺失** | `recall` 只支持 `excludeSessionId`；`l3_recall` 无课程参数；索引有 `session_id` 可过滤 |
| B2 课程溯源 | **部分实现** | B2 记录本身不含 `course_id`；`GET /api/courses/bindings/session/:id` 可反查，但未提供任务/资料/目标上下文 |
| 课程页面 / 任务驱动会话 | **未实现（E4.3–E4.5）** | 本轮不触碰 UI 与调度 |

审计结论：**不重复创建课程实体**，只补 L1 知识点作用域、L2 检索范围、L3 召回范围、B2 溯源与统一课程上下文。

## 1. 四层记忆的数据契约

### 1.1 L1 学习者档案

| 契约 | 实现 |
|---|---|
| 课程维度 | `KnowledgeState.course_id?: string`；仅在该知识点的**首条证据**写入时确定，旧状态永不追溯归入课程 |
| 课程目标 | 课程通过 `CourseGoalBinding` 显式关联 L1 `LearningGoal`；一个目标可服务多门课程；L1 目标结构不变 |
| 教学偏好 | `LearnerPreferences` 保持全局共享，不按课程拆分 |
| 同名知识点 | `deriveConceptId(label, { courseId })` 把 `course_id` 纳入哈希；无课程时保持旧公式逐字节一致 |
| 旧数据 | 无 `course_id` 的状态保持「未归类」；旧 concept_id、历史掌握度、`evidence_ids`、事件账本全部不变 |
| 聊天不改掌握度 | 未改动：掌握度仍只由 C3 证据投影写入 |

关键行为：
- 课程内新建题目：`concept_id = concept_<sha256(course_id + normalized_label)>`。
- 复用客户端传来的旧 `concept_id`：若该 ID 在 L1 中已属于另一门课程 → `409 concept_course_mismatch`；若属于本课程或无课程归属 → 允许。无归属的旧状态不会被追认成本课程。
- `DerivedKnowledgeState` 透传 `course_id`，推荐与课程视图可据此过滤。

新增只读接口 `GET /api/courses/:courseId/learner`：
```json
{
  "course": { "course_id": "course_xxxxxxxx" },
  "goals": [ /* 通过 CourseGoalBinding 解析出的 L1 目标 */ ],
  "knowledge_states": [ /* course_id 等于本课程的知识点 */ ],
  "preferences": { /* 全局共享 */ },
  "unclassified": { "knowledge_states": 3, "goals": 1 }
}
```
课程视图不会把未归类知识点混入；未归类数量单独给出。

### 1.2 L2 课程知识库

`CourseSourceBinding` 补充为：

```ts
interface CourseSourceBinding {
  binding_id: string;
  course_id: string;            // 课程
  source_id: string;            // L2 manifest id
  status: "active" | "detached";// 关联状态
  created_at: string;
  updated_at: string;           // 最近一次状态变化
  detached_at?: string;         // 最近一次解除的审计时间
}
```

规则：
- 一门课程多份资料、一份资料多门课程：每对 `(course_id, source_id)` 一条记录。
- 解除关联是 `status → detached`，**不删除绑定、不删除 manifest、不删除 raw/wiki**；重新绑定复用原 `binding_id`。
- 旧记录缺少 `status` / `updated_at`：读取时按 `active` 与 `updated_at = created_at` 归一，不写回、不迁移。
- 检索范围：只使用 `active` 绑定；`detached` 是历史，不进入候选。

**课程隔离检索契约**（`searchL2` / `retrievalCandidates` / `resolveDesignation`）：

| 参数 | 语义 |
|---|---|
| `sourceIds === undefined` | 未归类会话，保持 E4.1 之前的全局范围 |
| `sourceIds === []` | 课程没有资料：**检索结果为空**，不得退化为全局 |
| `sourceIds === [...]` | 只允许这些 L2 `source_id` 的页面进入词法候选、排序与一跳图谱扩展 |

实现方式：在 `searchL2` 内先按 `source_id` 过滤页面集合，再构建链接图与词法候选；词法命中在**赋排名之前**过滤；`retrievalCandidates` 再做一次来源校验（防御陈旧索引）。显式指定资料同样受范围约束：`source_id` 不在范围、或 `content_hash`/`source_identity` 只匹配到范围外条目 → `409 designated_out_of_scope`，不会“先全局找到再前端过滤”。

E4.2 已把过滤下推到 SQLite：`page_sources` 表 + `searchLexical` 的 WHERE 谓词，在 bm25 排序与 LIMIT 之前完成；混合来源页面（部分来源越界）按保守规则整体排除。

### 1.3 L3 长期对话记忆

会话归属只来自持久化的 `CourseSessionBinding(course_id, session_id, task_id?, origin)`：
- 一门课程多个 AI 会话；`task_id` 让「继续学习」找回同一任务的已有会话（E4.3 实现入口）。
- 会话绑定不可改绑；课程切换不改变旧会话归属。
- 未归类会话不会被推断进任何课程。
- 客户端可以提交课程选择意图，但服务端用 `assertClientCourseIntent` 对照绑定：未绑定会话声称课程、或绑定会话声称另一门课程，一律 `409 course_intent_mismatch`。

召回契约（本阶段实现过滤原语，E4.4 接线）：
```ts
recall(store, query, {
  excludeSessionId,                 // 当前会话
  allowedSessionIds?: ReadonlySet<string>, // 课程内会话；undefined = 未归类，保持全局
})
```
- 过滤发生在词法候选进入覆盖率评分之前；空集合表示「本课程没有历史」，不回退全局。
- L3 索引已按 `session_id` 存储 chunk，无需改表；E4.4 只需在 `createL3Tools` 的 `resolveRecallScope` 回调中，用会话绑定查出该课程的 `session_id` 集合。
- `l3_recall` 的工具参数不增加 `course_id`：模型不能通过参数扩权，范围只由服务端回调决定。
- 启动时 `before_agent_start` 的 L1 上下文注入未改；课程上下文注入与课程级自动召回留在 E4.4。

### 1.4 B2 正式学习证据

- B2 仍是唯一权威记录：题目、作答、评分、检查点、幂等写入规则全部未改。
- 题目新增**私有** `generation.course_id?`：出题时由服务端从会话绑定解析并冻结。它不进入公开题目投影。
- C3 写证据时从 `question.generation.course_id` 读取课程，写入 `LearningEvidence.course_id?`；不从聊天内容、L3 召回或客户端参数推断。
- 旧题目没有该字段 → 证据不写 `course_id`，保持未归类；旧证据内容不改。
- 从 B2 `session_id` 追溯课程：`GET /api/courses/bindings/session/:sessionId` 返回 `course`、`task`、`source_ids`、`goal_ids`；未归类明确返回 `unclassified: true`。
- L3 只读对话摘要，不参与评分或证据写入；本轮未新增任何从 L3 生成证据的路径。

## 2. 统一课程上下文

新增 `courses/course-context.ts`：

```ts
resolveCourseContext(store, sessionId)
  → { status: "course", courseId, courseTitle, taskId, sourceIds, goalIds }
  | { status: "unclassified", sessionId }
```

- 唯一来源：`CourseStore.getSessionContext` 一次读取绑定、课程、任务、有效资料来源、目标绑定。
- 绑定指向不存在的课程 → `COURSE_CONFLICT`（409），**不退化为未归类**。
- 未绑定 → 未归类；未归类不是错误，保持旧行为。
- 课程存储损坏/不可读 → 503，不允许“当作未归类”继续跨课程检索。
- 客户端课程意图只用于校验，不参与解析；任何一层都不再单独维护“当前课程”。

四层使用同一 `course_id`：
| 层 | 使用方式 |
|---|---|
| L1 | 知识点作用域、课程档案视图 |
| L2 | `allowedSourceIds`；空集合是有效范围 |
| L3 | `allowedSessionIds`（E4.4 接线） |
| B2 | 题目 `generation.course_id` → 证据 `course_id` → 绑定反查 |

## 3. 实际改动

| 文件 | 改动 |
|---|---|
| `src/courses/types.ts` | `CourseSourceBinding.status/updated_at/detached_at`；状态枚举与校验 |
| `src/courses/course-store.ts` | 资料来源软解除与复用、`getSessionContext`、活动来源计数、旧记录归一 |
| `src/courses/course-context.ts`（新增） | 统一课程上下文、客户端意图校验、检索范围、知识点跨课程校验 |
| `src/learning/question-request.ts` | `deriveConceptId(label, { courseId })`；`parseQuestionRequest(value, scope)`；无课程时保持旧哈希 |
| `src/learning/question-service.ts` | 解析课程范围；`allowedSourceIds` 下推到检索/指定资料；题目冻结 `generation.course_id`；`designated_out_of_scope` |
| `src/learning/knowledge-lookup.ts` | 指定资料与检索结果的课程范围校验；`out_of_scope` 与 `not_found` / `unavailable` 区分 |
| `src/learning/evidence-adapter.ts` | 从题目冻结的课程写入证据 `course_id`（安全 ID 校验） |
| `src/memory/learner/types.ts` | `KnowledgeState.course_id`、`LearningEvidence.course_id`、`LearningQuestionGeneration.course_id`、`DerivedKnowledgeState.course_id` |
| `src/memory/learner/auto-profile.ts` | 仅新建状态时确定课程；旧状态不追认 |
| `src/memory/learner/state-engine.ts` | 派生状态透传 `course_id` |
| `src/memory/l2/l2-search.ts` | `sourceIds` 候选级过滤（含图谱扩展）；空范围返回空 |
| `src/memory/l2/l2-memory.ts` | `search(query, limit, { sourceIds })` |
| `src/memory/l3/recall.ts` | `allowedSessionIds` 候选过滤 |
| `src/memory/l3/l3-tools.ts` | `recall(..., { allowedSessionIds })`；`createL3Tools` 预留 `resolveRecallScope`（服务端回调） |
| `src/server/routes/sessions.ts` | 出题前解析课程上下文、课程化 concept ID、显式知识点跨课程拒绝、L2 范围注入、课程错误映射 |
| `src/server/routes/courses.ts` | 会话绑定响应增加 task/source_ids/goal_ids；新增 `GET /api/courses/:courseId/learner` |
| `src/server.ts` | L2 搜索闭包接受 `sourceIds` |
| 测试 | 见 §5 |

## 4. 兼容与迁移

1. **无批量迁移**。`courses/state.json` 仍是 `schema_version: 1`；新字段读取时补默认值，下一次真实写入才落盘。
2. **旧 concept_id 不变**：无课程范围的哈希公式与 E4.1 完全一致；已有 L1 状态、B2 题目、L1 证据的引用继续有效。
3. **旧知识点不追认**：没有 `course_id` 的状态不进入任何课程视图，也不会因后续课程内练习被改写归属。
4. **旧 B2 题目无 `generation.course_id`**：证据保持未归类；评分、反馈、检查点、幂等行为不变。
5. **旧 L2 绑定**：无状态字段的 `CourseSourceBinding` 读取为 `active`，不影响既有资料关联。
6. **未归类会话**：L2 保持全局范围、L3 保持全局召回、B2 无课程字段——与 E4.1 之前一致；接口显式返回 `unclassified: true`。
7. **不做课程推断**：标题、聊天内容、L2 文本都不参与归属；不存在“测试方便”的自动绑定。

## 5. 测试与结果

新增/扩展：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `courses/course-context.test.ts` | 12 | 未归类、绑定解析、空资料范围、课程缺失冲突、客户端意图、知识点跨课程 |
| `courses/course-store.test.ts` | 23（+3） | 来源解除/复用、`getSessionContext`、旧记录默认 `active` |
| `learning/question-request.test.ts` | 27（+4） | 旧哈希冻结、两课程同名不同 ID、重试稳定、客户端 ID 保留 |
| `learning/question-service.test.ts` | 38（+4） | 题目/证据/L1 状态课程溯源、无课程未归类、指定资料越界、范围下推到检索 |
| `learning/knowledge-lookup.test.ts` | 17（+5） | 指定资料越界、content hash 越界、范围内可用、检索结果二次校验、空范围 |
| `learning/evidence-adapter.test.ts` | 10（+3） | 课程写入证据、旧题目未归类、非法课程 ID 忽略 |
| `memory/learner/auto-profile.test.ts` | 15（+3） | 同名知识点不合并、旧事件未归类、不追认旧状态 |
| `memory/l2/l2-search.test.ts` | 6（+3） | 词法+图谱范围、空范围、多来源页面 |
| `memory/l3/recall.test.ts`（新增） | 4 | 课程内召回、空课程不回退、未归类全局、当前会话排除 |
| `server.courses.test.ts` | 2（+1） | 两课程多目标、课程档案视图、资料共享/解除、会话上下文、B2 反查、重复请求、状态文件单行 |
| `server.learning-generate.test.ts` | 5（+1） | 真实进程：两课程同名「函数」得到不同 concept_id，题目冻结各自 course_id |

构建与全量测试（真实执行）：

```
npm run build   → 通过（tsc + vite）
npx vitest run  → 141 文件 / 1480 通过 / 3 跳过 / 0 失败
```

补充说明（如实记录）：在本机高负载状态下复跑全量时，`server.session-archive`、`server.session-delete-audit`、`server.learning` 三个既有会话 e2e 文件出现过 5s/60s 超时（会话创建在负载下耗时 12–25 秒）；这三个文件单独复跑 15/15 通过，且本轮未改动其被测路径。该现象与 E4.1a 代码无关，属于既有 e2e 的固定超时对机器负载敏感。

## 6. 已验证 / 仅契约 / 未实现

**已通过真实测试**
- 课程实体、目标/计划/任务/会话/资料绑定与持久化；重启后一致；重复绑定幂等。
- 两门课程同名知识点不合并（单元 + 真实服务出题）。
- 一份资料绑定两门课程；解除只影响该课程；旧绑定默认 `active`。
- 课程内出题冻结课程；C3 证据与 L1 状态带课程；无课程保持未归类。
- 指定其他课程资料被拒绝；检索范围下推到 `searchL2`。
- 会话与课程绑定持久化；跨课程改绑 409；课程切换不改变旧会话。
- 未归类会话/旧数据可读取；B2 可反查课程。
- L3 召回过滤原语：跨课程历史不会进入结果，空课程不回退全局。

**仅完成契约定义**
- L3 课程级自动召回接线（`resolveRecallScope` 已预留，E4.4 从绑定构建集合）。
- B2 → 课程的批量审计视图（当前按单个 `session_id` 反查）。
- 课程上下文注入 Agent 系统提示（E4.4）。

**尚未实现**
- 课程页面、课程切换 UI、计划/任务生成与执行、任务驱动会话、课程级 L3 自动召回（E4.2–E4.6）。
- 课程删除（仅归档）。

## 7. E4 阶段计划（更新后）

| 阶段 | 内容 | 状态 |
|---|---|---|
| E4.1 | 课程实体与基础数据契约 | 已完成，待复核 |
| E4.1a | L1/L2/L3/B2 关联契约补充 | 本轮完成 |
| E4.2 | 课程专属 L2 知识库（索引级来源过滤、上传与绑定流程、课程内检索） | 已完成 |
| E4.3 | AI 学习计划与任务生成（草案确认、任务排序、开始/继续学习入口） | 未开始 |
| E4.4 | 任务驱动会话与课程级 L3 长期记忆（绑定会话复用、课程上下文注入、`resolveRecallScope` 接线） | 未开始 |
| E4.5 | 多课程页面与交互（今日学习、课程详情、档案课程视图、导航） | 未开始 |
| E4.6 | 全链路测试及验收（两课程端到端、隔离、恢复、异常） | 未开始 |
