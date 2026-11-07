# E4.1 — 课程实体、数据契约、持久化与关联规则

- 完成时间：2026-11-07
- 基线：`main` @ `168be9b`（本地最新工作树，未以远程旧版覆盖任何改动）
- 范围：仅 E4.1。**未改动** L2、B2、L1 数据结构与现有 AI 对话页面。

## 0. 结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| Course 实体（`course_id`/`title`/`description`/`status`/`created_at`/`updated_at`） | 通过 | `courses/types.ts`；`POST/GET/PATCH /api/courses` |
| 状态取值 进行中/已暂停/已完成/已归档 | 通过 | `COURSE_STATUSES = in_progress / paused / completed / archived`，非法值 400 |
| 创建 / 查看 / 更新 / 归档 | 通过 | 单测 + HTTP 端到端；归档后记录与全部关联仍可读 |
| Course 不是 LearningGoal，仅显式关联 | 通过 | `CourseGoalBinding` 独立记录；L1 `LearningGoal` 结构零改动 |
| 六个实体各有独立所有者与持久化 | 通过 | 唯一写入路径 `courses/course-store.ts` → `data/courses/state.json` |
| 无课程归属的历史记录保持「未归类」 | 通过 | `GET /api/courses/unclassified`、`GET /api/courses/bindings/session/:id` 返回 `unclassified: true` |
| 不按标题/聊天内容推断课程 | 通过 | 专项测试：会话标题写着「Python 编程」仍为未归类 |
| 不删除历史 L1 数据 | 通过 | 未触碰 `memory/learner`；仅删除会话时清理其课程绑定 |
| 不重写已有 B2 证据 | 通过 | `learning/record-store.ts` 零改动 |
| 不重新生成旧会话 ID | 通过 | 绑定只引用既有 `*.jsonl` ID，不新建会话 |
| 课程归属以服务端存储为准 | 通过 | 客户端只能提交 id；服务端校验课程/任务/来源/会话存在性 |
| 已绑定会话不得被错误关联到其他课程 | 通过 | 改绑返回 409 `course_session_conflict`（单测 + HTTP） |
| 旧版本数据可正常读取 | 通过 | 无课程文件 = 空状态；缺可选字段的旧记录按默认值读取；损坏文件拒绝写入 |
| 构建 | 通过 | `npm run build` 成功（tsc + vite） |
| 全量测试 | 通过 | `npx vitest run` 139 文件 / 1438 通过 / 3 跳过（见 §4 说明） |

## 1. 数据契约

### 1.1 实体

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `Course` | `course_id, title, description, status, created_at, updated_at` | 独立实体，非 L1 目标 |
| `CourseGoalBinding` | `binding_id, course_id, goal_id, created_at` | 显式关联；一个目标可服务多门课程 |
| `StudyPlan` | `plan_id, course_id, title, description, goal_id?, status, origin, created_at, updated_at` | `origin` = `user` / `agent_suggested`；AI 草案强制 `draft` |
| `LearningTask` | `task_id, course_id, plan_id?, title, concept_ids[], source_ids[], status, created_at, updated_at` | `plan_id` 必须属于同一课程 |
| `CourseSessionBinding` | `binding_id, course_id, session_id, task_id?, origin, created_at` | 一个会话最多属于一门课程；不可改绑 |
| `CourseSourceBinding` | `binding_id, course_id, source_id, created_at` | 同一 L2 资料可绑定多门课程，每门一条显式记录 |

ID 规则：课程/计划/任务/绑定由服务端生成（`course_xxxxxxxx` 等）；引用的目标 ID 必须是 `[A-Za-z0-9][A-Za-z0-9_.:-]*`，拒绝分隔符与原型键。

### 1.2 持久化

- 文件：`<dataDir>/courses/state.json`，`schema_version: 1`，`revision` 单调递增。
- 为什么单文件：所有关系都是跨集合不变量（绑定的课程必须存在、任务的计划必须同课程）。拆成多文件会产生多条写入路径，并允许这些非法状态存在；单文件一次原子替换保持关系集合一致。
- 并发：进程内按文件路径串行队列；跨进程用 `storage/writer-lock` 的数据目录写锁（首次写入前获取，每次写入前 `assertOwned`）；写入走 `writeJsonDurable`（临时文件 + fsync + rename）。
- 读取：`readJsonStrict`，区分「不存在」与「损坏」。**损坏不会被当成空状态**，否则下一次写入会抹掉用户的课程。
- 兼容：无文件 = 空状态；缺 `description` / `plan_id` / `task_id` / 数组字段的旧记录按默认值读取，不做批量迁移。

## 2. API（`server/routes/courses.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/courses` | 列表 + 各课程关联计数 |
| POST | `/api/courses` | 创建 |
| GET | `/api/courses/:courseId` | 课程详情（单次状态快照：计数与列表来自同一次读取） |
| PATCH | `/api/courses/:courseId` | 更新标题/描述/状态 |
| POST | `/api/courses/:courseId/archive` | 归档（保留全部历史与关联） |
| GET | `/api/courses/unclassified` | 无归属的会话与资料（「未归类」） |
| GET | `/api/courses/bindings/session/:sessionId` | 某会话的课程归属；旧会话返回 `unclassified: true` |
| POST / DELETE | `/api/courses/:courseId/goals[/:goalId]` | 目标绑定（幂等 / 解除） |
| GET / POST | `/api/courses/:courseId/plans` | 计划列表 / 创建 |
| PATCH | `/api/courses/:courseId/plans/:planId` | 计划更新（确认 AI 草案即改 `status`） |
| GET / POST | `/api/courses/:courseId/tasks` | 任务列表（`?plan_id=`）/ 创建 |
| PATCH | `/api/courses/:courseId/tasks/:taskId` | 任务更新（状态、概念/资料来源） |
| GET / POST | `/api/courses/:courseId/sessions` | 会话绑定列表 / 绑定（幂等） |
| GET / POST / DELETE | `/api/courses/:courseId/sources[/:sourceId]` | 资料绑定 / 解除 |

错误码：`course_invalid` 400、`course_not_found` / `session_not_found` / `source_not_found` 404、`course_conflict` / `course_session_conflict` 409、存储不可用 503。响应只含稳定错误码与类别，不含路径或用户内容。

## 3. 关联规则（关键约束）

1. **显式归属**：只有 `CourseStore` 的绑定记录决定归属。`unclassified` 是「没有绑定」的直接结果，不读标题、不读聊天内容。
2. **会话绑定不可改绑**：同课程同任务重试返回原记录（201 → 200，`binding_id` 相同）；改绑其他课程 → 409。
3. **任务可采纳无任务会话**：`task_id` 为空时可补写一次；已有任务 → 409。
4. **计划必须同课程**：跨课程 `plan_id` → 409 `course_conflict`；任务引用跨课程计划同样拒绝。
5. **AI 草案不跳过确认**：`origin: agent_suggested` 创建时强制 `draft`，即使显式传 `status: active`。
6. **资料需存在**：绑定来源必须出现在 L2 `manifest.jsonl`；上传/索引本身不自动绑定（E4.2 的「上传 ≠ 课程资料」基础）。
7. **会话需存在**：绑定前以 `statFile` 异步检查会话文件（请求路径无同步文件 API），不存在 → 404。
8. **删除会话清理绑定**：`DELETE /api/sessions/:id` 成功后调用 `courseStore.removeSessionBinding`（尽力而为，不改变删除结果），避免悬空引用。
9. **权限**：`/api/courses` 读跟随 `learnerRead`，写跟随 `learnerManage`（与学习档案一致，不会落到已移除的 workbench capability）。

## 4. 测试

新增（全部通过）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `courses/course-store.test.ts` | 21 | 实体 CRUD/归档、校验、旧数据兼容、损坏拒绝、绑定幂等与冲突、AI 草案、跨课程计划、重启后读取、并发串行、单快照一致性、删除绑定 |
| `server/routes/courses.test.ts` | 8 | HTTP 状态码与响应体、未归类视图、标题不推断、改绑 409、会话/来源不存在、跨课程任务 |
| `server.courses.test.ts` | 1（真实子进程） | 两门课程 + 旧会话绑定 + 幂等重试 + 409 改绑 + 重启恢复 + 归档保留 + state.json 单源 |
| `server/route-dispatch.test.ts` | +1 handler | `courses` 域注册与 URL 归属（既有 46 项通过） |
| `server/capability-policy.test.ts` | +2 | 课程读写走 learner 能力 |

回归：`npx vitest run` → 139 文件通过，1438 通过 / 3 跳过。过程中 `server.session-delete-audit.test.ts` 在整套并发运行时出现过 1 次超时失败（`createSession` 无响应，5s 级等待），单跑及与相关 runtime 测试同跑均稳定通过；该文件未在本轮改动，判定为既有 e2e 时序抖动，已如实记录。

构建：`npm run build` 成功。

浏览器验证：启动真实后端（`INNO_HOME=./runtime`）用脚本验证两门课程创建、绑定幂等（201→200 同 `binding_id`）、跨课程改绑 409、AI 草案 `draft`、详情计数一致、未归类移除、归档后关联保留；验证后已删除探针写入的 `runtime/data/courses/`，未留测试数据。

## 5. 修改文件

| 文件 | 改动 |
|---|---|
| `apps/learning-agent/src/courses/types.ts` | 新增：实体、状态、ID 校验、长度上限 |
| `apps/learning-agent/src/courses/course-store.ts` | 新增：唯一所有者（读写、绑定规则、快照、删除绑定） |
| `apps/learning-agent/src/courses/course-store.test.ts` | 新增 |
| `apps/learning-agent/src/server/routes/courses.ts` | 新增：`/api/courses/*` 路由域 |
| `apps/learning-agent/src/server/routes/courses.test.ts` | 新增 |
| `apps/learning-agent/src/server.courses.test.ts` | 新增：真实进程端到端 |
| `apps/learning-agent/src/server.ts` | 实例化 `CourseStore`；注册 `courses` 域；注入异步 `sessionExists`；向 sessions 注入 `courseStore` |
| `apps/learning-agent/src/server/routes/sessions.ts` | 删除会话后清理课程绑定（可选依赖，保持既有测试上下文不变） |
| `apps/learning-agent/src/server/route-dispatch.ts` | 新增 `courses` 域 |
| `apps/learning-agent/src/server/route-dispatch.test.ts` | 同步 handler 集合 |
| `apps/learning-agent/src/server/capability-policy.ts` / `.test.ts` | 课程路由能力归属 |

## 6. E4.2–E4.6 源码影响清单

阶段划分（E4.1a 修订）：

| 阶段 | 内容 | 状态 |
|---|---|---|
| E4.1 | 课程实体与基础数据契约 | 已完成，待复核 |
| E4.1a | L1/L2/L3/B2 关联契约补充 | 已完成，见 `docs/analysis/e4_1a_memory_contracts.md` |
| E4.2 | 课程专属 L2 知识库 | 未开始 |
| E4.3 | AI 学习计划与任务生成 | 未开始 |
| E4.4 | 任务驱动会话与课程级 L3 长期记忆 | 未开始 |
| E4.5 | 多课程页面与交互 | 未开始 |
| E4.6 | 全链路测试及验收 | 未开始 |


### E4.2 课程专属 L2 知识库

| 位置 | 现状 | 需要改动 |
|---|---|---|
| `memory/l2/l2-search.ts:51` `searchL2(store, query, opts)` | 全局 BM25 + 一跳图扩展 | 增加课程命名空间过滤：先按 `source_ids` 限定页面集合再检索/扩展，而不是检索后筛结果 |
| `memory/l2/l2-memory.ts:117` `search(query, limit)` | 单一共享 `L2Memory` 实例 | 增加带课程上下文的检索入口（同一 raw 文件可共享，检索命名空间按课程） |
| `learning/knowledge-lookup.ts:198` `retrievalCandidates` / `:125` `designatedCandidates` | 只接收 `l2DataDir` | 增加课程上下文；未命中/索引不可用时保持 `empty` / `unavailable` 区分 |
| `learning/question-service.ts:155` 调用点 | 由 `sessions.ts:503-507` 传 `l2DataDir` + `searchL2` | 由服务端按会话绑定课程注入上下文；禁止客户端传课程 |
| `server.ts:537` `searchL2` 闭包 | 无课程参数 | 按请求的课程上下文构造；`server/routes/sessions.ts:87` 依赖签名同步调整 |
| `memory/l2/l2-tools.ts:458` `l2_query` | 无课程参数 | 工具从服务端会话绑定取课程；跨课程访问明确拒绝并提示 |
| `memory/l2/wiki-*.ts`（graph/linker） | 全局图 | 图扩展限定课程页面集合；`overview` 按课程汇总 |
| `memory/l2/manifest-store.ts` | `sourceId` 全局 | 复用现有 `CourseSourceBinding`（E4.1 已就绪）；上传只建 manifest，绑定仍显式 |
| `server/routes/wiki.ts:226` `/api/l2/raw/upload` | 上传即索引 | 保持「上传成功 ≠ 索引成功」；不自动建课程绑定 |

### E4.3–E4.4 计划 / 任务 / 会话

| 位置 | 现状 | 需要改动 |
|---|---|---|
| `courses/course-store.ts`（E4.1） | 计划/任务/绑定已具备 | 增加排序字段（阶段顺序）、进度汇总、AI 草案生成入口 |
| `server/routes/sessions.ts:981` `POST /api/sessions` | 仅创建会话 | 增加「开始学习/继续学习/自由提问」的服务端入口：先查任务绑定会话，存在则复用；幂等键防重复点击 |
| `agent/pi-runner.ts`（会话创建/切换） | 无课程上下文 | 会话创建后写绑定由服务端完成；不改会话 ID 生成 |
| `memory/learner/context-pack.ts:31` / `agent/learning-extension.ts:45` | 仅 L1 档案 | 注入课程、目标、任务、检索结果、掌握/薄弱点、历史；课程由服务端绑定提供 |
| `memory/l3/l3-tools.ts:130` `l3_recall` | 全局历史 | 按课程范围召回（需 L3 索引带课程标签或经绑定过滤） |
| `server/routes/chat.ts:756` `/api/chat/stream` | 无课程 | 使用会话绑定课程；不依据聊天标题推断 |

### E4.5 多课程页面与交互

| 位置 | 现状 | 需要改动 |
|---|---|---|
| `web/src/react/pages/TodayPage.tsx` | 单一目标/复习/最近会话 | 多课程卡片；空状态显式 |
| `web/src/react/pages/LearnPage.tsx` | 会话列表 + 工作区 | 显示当前课程/任务、课程内历史 |
| `web/src/react/pages/ProfilePage.tsx` + `LearnerProfilePanel.tsx` | 全局档案 | 按课程视图（读取 `/api/courses` 与绑定，不按标题推断） |
| `web/src/react/shell/navigation.ts:40` / `stores/app-store.ts:12` | 五个页面 | 新增课程详情页（计划/知识库/记录/掌握）与导航项 |
| `web/src/api/*` | 无课程客户端 | 新增 `api/courses.ts` 与 store；复用 `react/ui` 与语义 token，需验证 light/dark 与各视口 |

### E4.6 全链路测试及验收

两门课程（Python 编程、高等数学）+ 专项：同名概念跨课程、一资料绑两课程、跨课程资料访问、索引失败/检索不可用、重复建会话、旧会话无归属、重启恢复、归档保留历史。E4.1 已覆盖其中：一资料绑两课程、重复绑定、旧会话无归属、重启恢复、归档保留；其余留给 E4.2–E4.4 落地后统一验收。

## 7. 遗留问题

1. 课程删除未提供 API（仅归档）。归档满足「保留历史」要求；是否允许彻底删除需在 E4.3/E4.4 明确。
2. 计划/任务暂无排序字段；E4.3 的「调整阶段/任务顺序」需要新增 `order` 并迁移默认值（按 `created_at`）。
3. `CourseStore` 与 `SessionMetaStore` 各自获取数据目录写锁（同一进程内为引用计数复用），跨进程仍是单一写入者；若未来出现第三个写者需统一注入一个锁句柄。
4. 未做 UI。本轮按要求不触碰现有 AI 对话页面。
