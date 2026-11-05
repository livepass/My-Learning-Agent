# E1.1 历史消息编辑与学习证据保护 — 独立验收报告

- 验收时间：2026-11-05
- 验收方式：只读代码审查 + 仓库外独立运行时探针 + 全量自动化回归
- 本轮未修改任何产品代码、测试代码或配置；仓库工作区在验收开始时为空

## 1. 仓库与提交

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `e317d3c1caf3a21aac5adec8f61773a069af8dfd` |
| E1.1 提交 | `e317d3c fix(chat): E1.1 历史消息编辑的服务端学习记录保护` |
| E1 基线 | `82b2079 feat(chat): E1 对话消息与输入框体验优化` |
| 远程状态 | `main...origin/main [ahead 1]`，E1.1 提交**尚未推送** |
| 工作区 | 干净（验收前）；本报告是本轮唯一新增文件 |

E1.1 提交包含 17 个文件、`+1069 / -38`：产品代码 9 个（含新增 `branch-edit-guard.ts`）、测试 7 个、文档 1 个。

## 2. 实现审查：保护是否在服务端执行

**结论：是。** 前端检查只是提前提示，真正的拒绝发生在服务端分支路由内。

### 2.1 调用链

```
POST /api/sessions/:id/branch-before-message
  └─ sessions.ts: handleSessionsRoutes
       └─ runQueueOpWithTimeout → Agent 共享队列槽
            └─ branchSessionBeforeUserMessage(sessionPath, entryId, { beforeBranch })
                 ├─ assertSessionFileUsable（删除/墓碑保护）
                 ├─ switchToSession
                 ├─ 校验 entry 存在、是用户消息、在当前活动分支
                 ├─ beforeBranch()  ← 服务端 B2 判定
                 │    └─ learningRecordStore.withRecordLock(sessionId, record => {
                 │         const verdict = evaluateBranchEditSafety(record)
                 │         if (!verdict.allowed) throw BranchEditRefusedError
                 │       })
                 └─ manager.branch(parentId) / resetLeaf + appendCustomEntry(marker)
```

### 2.2 关键代码证据

| 文件 | 位置 | 证据 |
|---|---|---|
| `apps/learning-agent/src/learning/branch-edit-guard.ts` | 43–79 | 纯函数策略：`pending_attempt_id` → `learning_attempt_pending`；任意 attempt 未完成 → `learning_attempt_pending`，已完成 → `learning_evidence_locked`；`last_completed_attempt_id` / `status=completed` → `learning_evidence_locked`；`step!==conversation`、`question`、`questions[]`、`exposures[]` → `learning_task_pending`；仅完全空白的 B2 记录允许 |
| `apps/learning-agent/src/learning/record-store.ts` | 1237–1249 | `withRecordLock` 在同一记录的文件队列（`runExclusive`）与写入锁（`ensureWriteLock`）内读取权威记录并执行回调 |
| `apps/learning-agent/src/server/routes/sessions.ts` | 847–862 | 分支路由把判定放进 `beforeBranch`，在 Agent 队列槽内执行；拒绝时抛 `BranchEditRefusedError` |
| 同上 | 871–875 | 映射为 `409 { error, code, message }`，中文提示来自策略函数 |
| 同上 | 887 | B2 损坏/关闭/锁冲突沿用 `422 learning_corrupt`、`503 learning_unavailable/read_only`，不伪装成 409 |
| `apps/learning-agent/src/agent/pi-runner.ts` | 160–166 | `assertActiveBranchMarker`：队列槽内比对当前分支叶子与 `branchMarkerId`，不一致抛 `stale_branch` |
| 同上 | 1223–1229、1250–1262 | `beforeBranch` 在树变更前执行；抛错时 `manager.branch` / `appendCustomEntry` 均未执行 |
| `apps/learning-agent/src/server/routes/chat.ts` | 509–516、577–586、600–602 | 非流式重发接收 `branchMarkerId`，过期返回 `409 stale_branch` |
| 同上 | 762–766、1057–1063、1116 | 流式重发同样携带标记；过期以 `aborted` + `code:"stale_branch"` 终止，不追加消息 |
| `apps/learning-agent/web/src/react/LearningWorkspace.tsx` | 81–112 | 前端 `editingBlockReason` 只做提前提示；与服务器同口径，但不是执行边界 |
| 同上 | 561–573 | 重发传入 `branchMarkerId`；`stale_branch` 显示专门提示 |
| `apps/learning-agent/web/src/stores/chat-store.ts` | 89、155、437 | `lastTerminalCode` 只记录本次发送的终止码，新发送/加载历史时清空 |

### 2.3 保护语义核对

| 要求 | 实现 | 判定 |
|---|---|---|
| 不能只依赖前端 | 分支路由在服务端按 B2 判定，前端仅提示 | 满足 |
| 无 B2 可编辑 | `evaluateBranchEditSafety(undefined) → allowed` | 满足 |
| 有正式证据禁止 | `last_completed_attempt_id` / 已完成 attempt / `status=completed` → 409 | 满足 |
| 待处理作答禁止 | `pending_attempt_id` / 非 completed attempt → 409 | 满足 |
| 不破坏 L1 | 分支与拒绝路径均不写 L1；无事件追加、无投影 | 满足（探针逐字节比对） |
| 分支后重发不得落到别的上下文 | `branchMarkerId` 在队列槽内比对叶子 | 满足（真实 HTTP 验证） |
| 重复/非法请求 | 未知 entry → 404；同一 entry 二次分支 → 404/409；无会话的标记 → 400 | 满足 |

## 3. 已执行的验证

### 3.1 构建与类型检查

```bash
npm run build
# exit 0，tsc 无错误，vite 构建成功（52.74s）
```

### 3.2 全量自动化测试

```bash
npx vitest run
# Test Files  132 passed (132)
# Tests       1345 passed | 3 skipped (1348)
# Duration    196.91s
```

关键回归子集（同一轮全量运行内）：

| 范围 | 文件 | 结果 |
|---|---|---|
| E1.1 策略 | `learning/branch-edit-guard.test.ts` | 8 passed |
| E1.1 队列边界 | `session-branch-runtime.test.ts` | 6 passed |
| E1.1 记录锁 | `learning/record-store.test.ts` | 56 passed（含新增 2 项） |
| E1.1 真实 HTTP | `server.session-branch.test.ts` | 9 passed |
| E1 对话体验 | `LearningWorkspace.e1.test.tsx` | 16 passed |
| E1 对话体验 | `LearningWorkspace.test.tsx` / `chat-store.test.ts` | 10 / 20 passed |
| D 系列 | `server.session-archive.test.ts` / `server.session-delete-audit.test.ts` / `session-delete-runtime.test.ts` / `session-delete-races.test.ts` | 3 / 9 / 12 / 9 passed |
| D 系列前端 | `LearnPage.test.tsx` / `sessions-store.test.ts` | 19 / 20 passed |
| C1/C2/C3 | `server.learning-generate.test.ts` / `server.learning-http.test.ts` / `server.learning-answer.test.ts` | 4 / 12 / 6 passed |
| C4 | `server.review-loop.test.ts` / `PracticePage.test.tsx` / `TodayPage.test.tsx` / `review-intent.test.ts` | 1 / 61 / 9 / 9 passed |

未观察到 E1.1 引入的失败。

### 3.3 仓库外独立运行时探针

探针脚本：`D:/wo/code/tmp-e11-acceptance.mjs`（**不在仓库内**，不参与构建）。真实服务进程 + 真实临时 home + 确定性 Provider（普通对话 / 出题 / 评分三种回复）。结果：**10 个场景、13 项断言全部通过**。

| # | 场景 | 结果 |
|---|---|---|
| 1 | 无 B2 记录时编辑历史 | 200，后续消息清空 |
| 2 | 有正式证据时分支 | 409 `learning_evidence_locked` |
| 3 | 拒绝后聊天/B2/L1 | 三者逐字节不变 |
| 4 | 拒绝后消息列表 | entryId 序列不变 |
| 5 | 重启服务后再次分支 | 仍 409，三处文件仍逐字节不变 |
| 6 | 不存在的 entryId | 404，会话文件字节不变 |
| 7 | 同一 entry 二次分支 | 首次 200，二次 404/409，未重复变更 |
| 8 | 真实出题 + 作答后分支 | 409 `learning_attempt_pending`，B2 字节不变 |
| 9 | **评分请求在途时分支** | 409 `learning_attempt_pending`；聊天文件字节不变（2 项断言） |
| 10 | 评分完成 + finalize 后分支 | 409 `learning_evidence_locked` |

其中第 9 项是真实并发：Provider 被 Promise gate 暂停在评分模型调用内，B2 已持久化 `evaluating`，此时 HTTP 分支请求到达并被拒绝。

## 4. 并发安全性判断

### 4.1 已被实际执行证明

1. **B2 写入在途时分支被拒**：评分进入 `evaluating` 后，分支返回 409；聊天文件未变（探针 #9）。
2. **证据完成后分支被拒**：evaluate + finalize 后返回 `learning_evidence_locked`（探针 #10、`server.session-branch.test.ts`）。
3. **同一记录的读判定与写入串行**：`record-store.test.ts` 用 Promise barrier 证明第二个 `withRecordLock` 与同记录 `create` 在首个回调释放前不会进入。
4. **检查与分支之间无异步等待**：`pi-runner.ts:1250-1262` 中 `await beforeBranch()` 返回后，`manager.branch()` 同步执行，中间没有新的 await。
5. **分支提交校验**：分支后若另一请求追加消息，旧 `branchMarkerId` 重发被拒（非流式 409、流式 aborted+code），消息数不变。

### 4.2 仅由代码路径确认、未做“精确边界”注入

1. **守卫读与 `manager.branch()` 之间的微任务窗口**：`withRecordLock` 的回调只包含判定，返回后文件队列槽即释放，树变更在下一个微任务继续。按 `runExclusive` 的 Promise 链接顺序，树变更先于下一个排队的 B2 写者；但这依赖微任务顺序，不是“锁一直持有到树变更”。本轮没有在该精确点位注入并发写者。
   - 对**证据**的影响：可忽略。要产生证据必须先有 attempt，而 attempt 必须先有 question；这两者在判定时都会触发拒绝。因此在空白记录上无法凭空写入证据。
2. **跨进程 B2 写锁**：`withRecordLock` 会持有进程级 writer lock；若另一进程（CLI）正持锁，预期返回 503。本轮未启动第二个写入进程验证。
3. **Agent 初始化期间的分支请求**：代码路径上 `initSession` 不绑定目标会话；未注入慢初始化。

### 4.3 实测复现的未覆盖窗口

**出题在途（pre-commit）不被守卫看见。** 探针附加观察（场景 8）：

```
branch during generation: status=200 generation=200 b2_questions=1 step=awaiting_answer
```

流程：B2 已初始化但仍是空白记录 → 出题模型调用被 gate 暂停（此时 B2 无 question）→ 分支请求到达，守卫看到空白记录，允许并完成分支 → 释放模型，出题提交成功 → B2 出现 1 道题、`step=awaiting_answer`，但该题所属的对话已被分支改写。

- 不是“证据被改写”：L1 与 `last_completed_attempt_id` 均未产生。
- 但会产生“题目任务与对话上下文不对应”的状态；若随后作答并 finalize，证据会记录到已被改写的对话分支上。
- 现有 `branchMarkerId` 只保护“编辑后重发”，不保护“出题提交”。

## 5. 未解决风险

| 编号 | 风险 | 等级 | 依据 |
|---|---|---|---|
| R1 | 出题在途时允许分支，随后提交的题目与分支后的对话不对应 | 中低（需在出题秒级窗口内编辑） | 探针实测复现 |
| R2 | `sessions.ts` 注释称“branch while the lock is still held”，实际树变更在 `withRecordLock` 回调返回之后；保证依赖“证据无法凭空产生”与微任务顺序 | 低（注释/证明强度问题） | 代码阅读 |
| R3 | 跨进程 writer lock 冲突时的 503 路径未实测 | 低 | 未执行 |
| R4 | `MarkdownArtifact.test.tsx` 的 SVG 清洗用例本轮耗时 4850ms，接近 5000ms 默认超时；属于既有重渲染用例，与 E1.1 无关 | 低（测试稳定性） | 全量日志 |
| R5 | 未做真实 Chrome 双标签并发编辑/分支截图；并发结论来自进程内 barrier 与真实 HTTP 探针 | 低 | 未执行 |

## 6. 最小修复建议（不扩大范围）

1. **R1**：在 C1 出题请求开始时记录 `sessionRevision`（或活动分支叶子 id），在 `commitQuestion` 落盘前复核；不一致则放弃提交并返回 409（例如 `conversation_changed`）。不需要新表、新队列，也不改 B2 结构。
2. **R2**：把树变更作为回调传入 `beforeBranch`，在 `withRecordLock` 内执行 `manager.branch()` / `appendCustomEntry()`（同步操作），使“判定 + 变更”处于同一记录临界区；同时修正注释。该调整不改变锁顺序。
3. **R4**：给该 SVG 用例显式设置 10s 超时，避免全量并行时偶发超时（仅测试稳定性）。

以上均建议作为 E2 的前置小项或独立补丁，不与本轮验收混合。

## 7. 最终结论

**CONDITIONAL PASS**

- E1.1 声明范围内的行为全部通过：无 B2 可编辑；有证据/待评分/已发布题目时服务端拒绝；拒绝不改变聊天、B2、L1；重启后保护仍有效；过期分支标记不能追加消息；构建与 132 文件 / 1345 项测试全绿。
- 条件：R1（出题在途窗口）已实测复现，虽不修改既有证据，但可能生成与分支后对话不对应的题目任务，进而让后续证据落到错误上下文。建议在进入 E2 前用第 6 节的最小修复关闭，或明确接受该风险并记录在 E2 的验证范围。
- R2/R3/R4/R5 不影响本次验收结论，但应在 E2 或测试维护中处理。

> 说明：单元测试通过本身不构成并发安全性证明。本报告的并发结论来自“真实 HTTP + gated Provider”的评分在途用例、`withRecordLock` 的 barrier 用例与代码路径核对；未执行的注入点已在 4.2 / 4.3 明确标记。
