# E4.9g-P2-2-R2 验收报告：AI 学习会话权限一致性修复

- **基准分支**：`main`
- **基准提交**：`5e1d48e1856443514a71361e7983a07d27d76045`
- **工作分支**：`fix/e49g-p2-2-r2-session-authority`
- **结论**：**R2 增量验收通过，项目全量测试仍存在基线失败**（见第 7 节）

---

## 1. 修复前权限不一致的可复现条件

`LearnPage` 里三处判断各自为政：

| 判断点 | 修复前依据 | 问题 |
| --- | --- | --- |
| 课程栏显示 | 服务端 `sessionContext` 优先 | 正确 |
| 只读权限 | `currentSession.course`（会话列表缓存） | 服务端已说未归类时，缓存里的绑定仍让它可写 |
| Composer 是否可发 | `workbench.courseId` + `selectedCourse` | 课程暂停/完成时，缓存状态仍可能放行 |

复现条件（已用真实构建产物 + Playwright 受控数据验证，见第 8 节）：

| 场景 | 会话缓存 | 服务端回答 | 修复前表现 |
| --- | --- | --- | --- |
| 未归类覆盖缓存 | 已绑定 Python | `unclassified: true` | 课程栏显示「未归类」，但 Composer 仍在（只读判断看缓存） |
| 暂停覆盖缓存 | 课程 `in_progress` | 课程 `paused` | 课程栏显示「已暂停」，侧栏「新建对话」仍在 |
| 服务端绑定 B | 缓存写 Python | 绑定 English | 侧栏标题/徽章、新建对话都指向 Python |

触发条件都是同一个：**服务端 `sessionContext` 已返回，但其它判断仍读缓存**。缓存只会在会话列表刷新时更新，因此这个窗口不是一帧，而是持续到下一次列表刷新。

---

## 2. 最终课程与权限判断优先级

一次派生，三处共用（`conversationCourse` / `conversationUnclassified` / `authorityStatus`）：

```
会话已归档                        → 只读（session）
服务端 unclassified = true        → 只读（unclassified），不回退任何缓存课程
服务端/缓存任一说课程已归档        → 只读（course），fail-closed，只收紧不放宽
服务端 course.status
  ├─ paused                       → 阻断发送 + 「继续课程」
  └─ completed                    → 阻断发送
上下文未返回
  ├─ 会话缓存有绑定，且 course_id 在课程列表中精确命中
  │    └─ 且等于 workbench 已采纳的课程 → 用它（等待已结束）
  └─ 否则                          → 阻断，提示「正在确认课程权限…」
无打开会话（欢迎态）               → 沿用原有课程选择与首次发送规则
```

要点：

- **服务端回答优先于缓存**：`sessionContext` 存在时，`authorityStatus` 只取它的 `course.status`；`unclassified` 直接为 `null`。
- **缓存只在读取已结束后才可用**：`contextSettledFor` 记录「本会话的上下文读取已结束」（失败也算结束）。在此之前一律阻断，因此不存在「用上一门课程的缓存放行」的窗口。
- **缓存还必须与 workbench 已采纳的课程一致**：这是 A→B 切换中 URL 仍指向 A 的窗口，`metaConfirmed` 为 false，写入保持关闭。
- **`selectedCourse` 完全不参与权限**：它只表示「workbench 指向哪门课」，不再作为任何写入依据。
- **归档 fail-closed**：服务端或缓存任一说已归档即只读。这个并集只会收回权限，不会授予权限，因此不与「服务端优先」冲突。
- **列表读取失败**：未确认时给出可重试的「课程列表读取失败」，而不是永远等待的「正在确认」。

---

## 3. 修改代码清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/pages/LearnPage.tsx` | 修改 | 单一权限派生；`blocked` 在会话模式下直接采用 `conversationBlock`；`readOnly` 不再被 `blocked` 掩盖；侧栏标题/徽章/新建对话改用会话绑定；上下文读取结束后记录 settled |
| `react/pages/learn/LearnContextPanel.tsx` | 修改 | 新增 `canInitialize` Prop，初始化入口与暂停/继续共用同一权限 |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `learn.blocked.confirming.{title,description}` |
| `react/pages/LearnPage.course-bar.test.tsx` | 修改 | 新增 8 项权限测试 + 1 项新建对话测试（12 → 21） |
| `react/pages/LearnPage.test.tsx` | 修改 | 修正夹具：会话声明绑定 Python，服务端上下文却返回 `unclassified`（见 4.1） |
| `react/pages/learn/LearnContextPanel.test.tsx` | 修改 | 补 `canInitialize: true` 默认值，保持原有显示态测试语义 |
| `docs/ui-redesign/phase3/P2-2-R2-assets/` | 新增 | 8 张真实页面截图 + `metrics.json` |
| `docs/ui-redesign/phase3/P2-2-R2-acceptance.md` | 新增 | 本报告 |

**未修改**：`LearningWorkspace.tsx`（发送、流式、模型选择）、`LearnCourseBar.tsx` 结构、Store、API、后端、CSS、三栏布局、全局导航。

### 3.1 一处超出「优先修改」清单的改动

`LearnContextPanel.tsx` 增加了一个 `canInitialize` Prop。原因：初始化学习检查点是一次课程内写入，原先只判断 `readOnlySession`，因此「课程暂停」或「权限确认中」时仍会显示初始化按钮。不新增 Store、不改视觉结构，只把已有权限传进去。

### 3.2 `blocked` 与 `readOnly` 的优先级

原代码是 `readOnly={blocked ? false : readOnlySession}`：只要有任何 `blocked`，`readOnly` 就被抹成 false。R2 让 `conversationBlock` 在 `readOnlySession` 有值时必为 `null`，于是 `readOnly` 直接传 `readOnlySession`，两者不再互相掩盖。

---

## 4. 新增测试及结果

### 4.1 修正的测试夹具

`LearnPage.test.tsx` 的 `beforeEach` 把会话声明为绑定 Python，却让 `getSessionCourseContext` 返回 `unclassified: true`。旧实现三处判断各自读不同字段，这个矛盾被掩盖；R2 之后服务端明确的 `unclassified` 会正确关闭所有写入口，两个学习状态用例因此失败。夹具改为返回真实绑定（`unclassified: false`，`binding.course_id = course_python`），断言未改动。

这不是「改夹具掩盖回归」：它描述的是一个自相矛盾的场景，而产品规则明确服务端未归类即只读。

### 4.2 新增用例（`LearnPage.course-bar.test.tsx`）

| 编号 | 用例 | 验证 |
| --- | --- | --- |
| T01 | `server unclassified overrides a cached course binding` | 课程栏「未归类对话」；无 Composer、无发送、无课程计划/新建对话、无初始化；`initLearning` / `startCourseLearning` 未被调用 |
| T02 | `a server-paused course blocks sending even when the cache says in_progress` | 显示「课程已暂停」；无 Composer；「继续课程」调用 `resumeCourse("course_python")` |
| T03 | `a server binding to course B never inherits course A's permission` | 课程栏为 B；课程计划跳转 `course=course_english` 且不含 `course_python`；Composer 可用 |
| T04 | `a bound in-progress course still accepts a normal conversation` | Composer 可用、无「正在确认」；发送调用 `chatStore.send` |
| T05 | `an archived conversation stays read-only even when its course is in progress` | 只读提示；无 Composer、无初始化/暂停/继续 |
| T06 | `a delayed context never opens writes on the previous course` | 上下文延迟时课程栏为 B、无 Composer；到达后 Composer 出现 |
| T07 | `a completed course cannot continue and offers no resume entry` | 「课程已完成」；无 Composer、无「继续课程」、无初始化/暂停 |
| 补充 | `offers no new-conversation entry unless the server confirms an in-progress course` | 进行中时存在；暂停/完成/未归类时均不存在 |
| 补充 | `keeps checkpoint writes available for a bound in-progress course` | 「暂停学习」存在，点击调用 `pauseLearning("s1.jsonl", 4)` |

### 4.3 定向测试结果

| 文件 | 用例数 | 结果 |
| --- | ---: | --- |
| `learn/LearnCourseBar.test.tsx` | 16 | 通过 |
| `LearnPage.course-bar.test.tsx` | 21 | 通过 |
| `LearnPage.test.tsx` | 24 | 通过 |
| `LearnPage.welcome.test.tsx` | 8 | 通过 |
| `LearnPage.workbench.test.tsx` | 15 | 通过 |
| `LearnPage.course-context.test.tsx` | 3 | 通过 |
| `learn/LearnContextPanel.test.tsx` | 12 | 通过 |
| `learn/LearnSessionRow.test.tsx` | 6 | 通过 |
| `learn/LearnStartPanel.test.tsx` | 11 | 通过 |
| `i18n/locales.test.ts` | 8 | 通过 |
| **合计** | **124** | **10 文件全部通过** |

全 Web 目录：`npx vitest run apps/learning-agent/web/src/react/` → **41 文件 / 460 项通过**。

---

## 5. 原有正常学习行为回归

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 进行中课程正常对话 | 通过 | T04；`LearnPage.workbench` 首次发送用例 |
| 选择课程不创建会话 | 通过 | `switches course without creating a session and clears the draft` |
| 新建对话不自动发送 | 通过 | `starts a new conversation at the course start without sending` |
| 快捷操作只填草稿 | 通过 | `LearnPage.welcome` / `LearnPage.workbench` 空会话用例 |
| 首次发送才创建绑定会话 | 通过 | `creates the course-bound conversation on the first send` |
| 归档会话只读 | 通过 | T05；`LearnPage.test.tsx` 归档用例 |
| 未归类会话只读 | 通过 | T01 |
| 任务与阶段来自服务端 | 通过 | `shows the server-bound task and stage inside the bar` |
| 学习状态展开/收起 | 通过 | `keeps the existing status panel toggle in sync with the bar button` |
| 中英文切换 | 通过 | `switches the course bar copy with the language`；`locales.test.ts` 8 项 |

---

## 6. 完整构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |

---

## 7. 全量测试与既有失败对照

### 7.1 执行

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 第一次全量 | `npm test` | 187 文件 / 1997 通过 / 3 失败 / 3 跳过 |
| 第二次全量 | `npm test` | 187 文件 / 1999 通过 / 2 失败 / 3 跳过 |
| 隔离复跑 | `npx vitest run <失败文件>` | 见 7.2 |

### 7.2 失败项判定

| 文件 | 用例 | 判定 |
| --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2） | **基线既有失败**：P2-2-R1 已在本轮前的 `853d470` 基线复现，本轮未改后端；两次全量均出现 |
| `react/LearningWorkspace.test.tsx` | `shows the conversation read-only, without a composer` | **本轮修复**：夹具声明课程已归档、服务端却说 `in_progress`。归档现在 fail-closed，该用例恢复通过，第二次全量未再失败 |
| `src/server.course-plans.test.ts` | `still supports a manual plan when the model endpoint is unreachable` | 并行负载下的超时；隔离复跑 11/11 通过，本轮未改后端 |
| `react/pages/PracticePage.test.tsx` | `does not claim a refreshed long-term state when finalize fails` | 并行负载下的异步时序断言；隔离复跑 64/64 通过，本轮未改该页 |

### 7.3 结论

**R2 增量验收通过，项目全量测试仍存在基线失败。** 唯一确定性失败是 `server.e48-workbench` 的 `providerCalls` 断言，它在 R2 之前就存在，按任务要求未修改该后端测试。

本轮没有删除、跳过或放宽任何失败测试。

---

## 8. 视觉检查

真实构建产物（`npm run build`）+ 真实服务端（`:3101`，独立 `INNO_HOME`）+ Playwright 拦截 `/api/**`。只读，不发送、不创建、不写设置。全部页面控制台 0 错误。

| 场景 | 课程栏 | Composer | 新建对话 | 课程计划 | 初始化 | 暂停 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 未归类覆盖缓存 | 未归类对话 | 无 | 无 | 无 | 无 | 无 |
| T02 暂停覆盖缓存 | Python · 已暂停 | 无 | 无 | 有 | 无 | 无 |
| T03 服务端绑定 B | 英语学术写作 · 进行中 | 有 | 有 | 有 | 无 | 有 |
| T04 正常绑定 | Python · 进行中 | 有 | 有 | 有 | 无 | 有 |
| T05 归档会话 | Python · 进行中 | 无 | 无 | 有 | 无 | 无 |
| T06 上下文延迟 | 英语学术写作 · 进行中 | 无 | 无 | 有 | 无 | 无 |
| T07 课程完成 | Python · 已完成 | 无 | 无 | 有 | 无 | 无 |
| T01（390px） | 未归类对话 | 无 | 无 | 无 | 无 | 无 |

- 所有宽度 `document.scrollWidth - innerWidth = 0`。
- 侧栏标题与状态徽章现在与会话绑定一致：T01 显示「未归类历史」，T02 显示「已暂停」而不是缓存的「进行中」。
- 「课程计划」在暂停/完成/归档时仍然存在：它是只读入口，不写课程状态。
- 截图：`docs/ui-redesign/phase3/P2-2-R2-assets/`（8 张 + `metrics.json`）。

### 8.1 是否发生视觉变化

**是，但都是权限收紧的结果，不是布局改动。**

| 变化 | 场景 |
| --- | --- |
| 未归类会话不再显示 Composer / 课程计划 / 新建对话 | T01 |
| 暂停、完成、确认中不再显示「新建对话」 | T02 / T06 / T07 |
| 未确认时出现「正在确认课程权限…」提示 | T06 |
| 侧栏标题与徽章跟随会话绑定 | T01 / T02 |
| 归档课程下的 Composer 消失（此前被 `blocked` 掩盖为可写） | T05 |

课程栏、三栏宽度、学习状态面板布局均未改变。

---

## 9. 未解决的风险

1. **`server.e48-workbench` 基线失败**：`providerCalls` 实得 2、期望 1。与前端无关，本轮未修。
2. **上下文读取失败时的回退**：`loadSessionContext` 吞掉错误并保留旧条目，页面以「读取已结束 + 缓存精确匹配」兜底。若会话缓存本身也过期，页面会按缓存状态判断——但只在读取已结束之后，且归档是 fail-closed 的并集，因此最坏情况是「按旧状态放行一次发送」，而服务端 `chat-write-guard` 仍会拒绝。没有引入新的客户端写路径。
3. **欢迎态未改动**：没有打开会话时仍按 `selectedCourse` 判断，这是任务要求的「沿用现有首次发送规则」。
4. **归档 fail-closed 是并集判断**：若缓存过时地标了归档而服务端已恢复，页面会短暂只读，直到会话列表刷新。这是有意选择：宁可多收一次权限，也不放行。

---

## 10. 最终 Git SHA

- 代码与报告提交：`fix/e49g-p2-2-r2-session-authority` 分支 HEAD（见提交记录）
- 未合并 `main`，未推送 `main`
- PR 目标：`main`

### PASS 条件核对

| 条件 | 结果 |
| --- | --- |
| 当前会话的服务端权限优先 | 是 |
| 未归类和归档会话保持只读 | 是 |
| 暂停、完成课程不能错误发送 | 是 |
| 课程 A/B 切换不产生错误权限 | 是 |
| 正常课程仍可继续学习 | 是 |
| 新增及原有相关测试通过 | 是（定向 124/124；全 Web 460/460） |
| TypeScript 和完整构建通过 | 是 |
| 无新增确定性测试失败 | 是（唯一确定性失败在基线即存在） |
| 不修改业务发送机制 | 是（`LearningWorkspace.tsx` 未改） |
| 验收报告完整 | 是 |

**结论：R2 增量验收通过，项目全量测试仍存在基线失败。**
