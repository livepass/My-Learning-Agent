# E4.9i-P2-6-R1 验收报告：数据可信度语义与目标编辑安全修正

- **任务**：E4.9i-P2-6-R1
- **开发基准**：`main@7d7a04accd6f9a64f475c575405fe6db0c4484ca`（PR #22 合并提交，已核对）
- **本轮起点**：`6ea2eeae62e86947d30cd146744cd4e83bdaf2bc`（P2-6 已审查 HEAD）
- **开发分支**：`feat/e49i-p2-6-profile-provenance`（沿用，未新建分支）
- **结论**：**P2-6-R1 PASS_WITH_KNOWN_BASELINE_FAILURE**
  （唯一稳定失败为 P2-5 起已记录的 `server.e48-workbench.test.ts` 历史基准失败）

未重做 P2-6，未开始 P2-7。

---

## 1. 基准核对

| 项 | 值 |
| --- | --- |
| `git fetch origin` 后 `origin/main` | `7d7a04accd6f9a64f475c575405fe6db0c4484ca`（与任务书一致） |
| 本轮起点 HEAD | `6ea2eeae62e86947d30cd146744cd4e83bdaf2bc`（与任务书一致） |
| 远程开发分支（开工时） | `origin/feat/e49i-p2-6-profile-provenance` = `6ea2eea`（与本地一致） |
| 远程开发分支（本轮结束前） | `826915c`：另一个执行环境已推送 19 个 R1 提交，其自述状态为「未运行 / NOT VERIFIED」（见 §9.4） |
| 开工工作区 | 干净 |
| PR 状态 | **无法创建/更新**：`gh` 未登录（见 §9.3） |

---

## 2. F01：目标优先级的隐式写入（最高优先级）

### 2.1 问题依据（读源码确认，非推断）

两处代码共同造成「未修改优先级也会被视为人工维护」：

1. **客户端无条件发送**。`LearnerProfilePanel.tsx` 的 `GoalCard.save()` 原先固定发送
   `{ title, type, priority, status, success_criteria }`，`priority` 取 `draft.priority`，
   与用户是否动过控件无关。
2. **服务端按「字段是否出现」判定归属**。`server/routes/learner.ts:184-187`：

   ```ts
   if (body.title !== undefined) manual.title = nextManualStamp(current);
   if (body.priority !== undefined) manual.priority = nextManualStamp(current);
   ```

   判定键是 `!== undefined`，不是值是否变化。因此发送一个未改动的 `priority: 3`
   与用户真的把滑块拖到 30% 在服务端**不可区分**：两者都会刷新 `manual.priority`
   （`nextManualStamp` 递增 `manual_edit_seq`），并把该字段标记为人工维护。

结论：客户端正确的修法是**不发这个键**，而不是「发回旧值以保持一致」——后者仍会刷新
归属戳，并可能覆盖编辑期间服务端收到的新值。

### 2.2 修复

**新增纯函数**（`react/profile/knowledge-provenance.ts`）：

```ts
goalPatchFromDraft(goal, draft, priorityTouched) → Partial<LearningGoal>
```

- `title` / `type` / `status` / `success_criteria`：仅在与存储记录**不同**时发送。
- `priority`：仅在 `priorityTouched === true` 且值是 `[0,1]` 内有限数时发送。
- 结果为空对象表示「没有可保存的改动」，调用方**不得发请求**。

**`GoalCard` 改动**（`react/LearnerProfilePanel.tsx`）：

| 状态 | 行为 |
| --- | --- |
| 打开编辑器 | `startEditing()` 重置草稿、`priorityTouched=false`、清错误 |
| 只改标题/状态/类型/成功标准 | 请求体不含 `priority` |
| 拖动滑块 | `onChange` 置 `priorityTouched=true` |
| 点击端点按钮 | 置 `priorityTouched=true` 并写入端点值 |
| 保存成功 | 用服务端返回记录（`learnerStore.patchGoal` 的返回值刷新 store） |
| 保存失败 | 保留草稿、保留 `priorityTouched`，显示错误 |
| 取消 | 重置草稿与触摸标记，不发请求 |
| 重新打开 | `startEditing()` 再次清零，不继承上一轮状态 |

`priorityTouched` 不能由 diff 代替：异常值（如 3）在滑块上没有位置，
「未动」与「拖到轨道末端」都会让 `draft.priority` 看起来没变。

### 2.3 端点问题（任务书 §2.2 明确要求）

`priority = 3` 时滑块手柄被浏览器钳在 100。点击该端点**不产生 `change` 事件**
（值未变），所以用户无法显式选择 100%。

修复方式按任务书建议采用**明确的确认操作**，不增加复杂交互：当格式化为
`anomaly` / `unavailable` 时，编辑器在滑块下方多渲染一个按钮
「将优先级设为 100%」（负值时为 0%），点击即写入端点并置 `priorityTouched`。

该按钮**位于 `<label>` 之外**：嵌在 label 内的按钮同时是 label 所关联滑块的点击目标，
一次点击会被两个控件争抢。按钮只在非正常值时出现，正常值（0/0.5/1）的编辑器与改动前完全一致。

### 2.4 必须核查项逐条结论

客户端（jsdom，断言**请求体**）与浏览器（R01–R05）两侧都覆盖；
服务端归属规则由真实路由集成测试单独证明（§2.5）。

| # | 场景 | 客户端测试 | 浏览器 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 仅改标题（异常 3） | `editing only the title omits priority from the PATCH` | R01、B09 | 请求体 `["title"]`，`priority` 键**不存在**，存储仍 3，戳不变 |
| 2 | 仅改状态（正常 0.5） | `editing only the status omits priority from the PATCH` | R02 | 请求体 `["status"]`，戳不变 |
| 3 | 仅改标题（正常 0.5） | `a title-only edit on a normal goal does not send priority either` | — | `Object.keys(sent)` 恰为 `["title"]` |
| 4 | 存储值 3 | `shows an out-of-range value as an anomaly with its raw value, not 300%` | R01、B09 | 显示「优先级异常 · 原始值 3」 |
| 5 | 存储值 −0.2 | `shows a negative value as an anomaly`；`a title-only edit on a negative anomaly does not send priority` | — | 显示原始值；标题保存不发 priority |
| 6 | 存储值 0.5 | `shows 0, 50 and 100 percent for normal values` | R02、R04 | 「优先级 50%」 |
| 7 | 缺失 / 非法 | `a goal whose priority is missing saves a title without inventing one`；`... invalid ...` | — | 保存标题，**不发明**一个 priority |
| 8 | 用户改为 0 | `accepts 0 and 0.4 as chosen values by moving the slider` | R03 第 1 跑 | 发送 `priority: 0`，戳 7→21 |
| 9 | 用户改为 0.4 | 同上 | R03 第 2 跑 | 发送 `priority: 0.4`，戳 7→21 |
| 10 | 用户改为 1 | `the endpoint button makes 100% an explicit choice on an anomalous goal` | R03 第 3 跑 | 发送 `priority: 1`，戳 7→21 |
| 11 | 取消 | `cancelling keeps the original value and sends nothing` | R05/cancel | 0 次 PATCH |
| 12 | 保存失败 | `a failed save keeps the draft and the chosen priority` | R05/failure | 1 次 PATCH，草稿「没保存的标题」与滑块 40 保留，存储仍 3 |
| 13 | 编辑期间服务端被动更新 | `a priority updated on the server while editing is not overwritten by a title save`；异常值变体 | R04 | 服务端 0.5→0.9、戳 `edit:99` 全部存活 |

**测试写法**：所有「未修改」断言写的是 `expect(Object.keys(sent)).not.toContain("priority")`，
不是「发回了旧值」。B09 的旧断言（`titleOnlySavePriority: 3`）已按任务书要求改正为
「键不存在且存储值仍为 3」（见 §6.3）。

### 2.5 服务端半场：真实路由集成测试

新增 `apps/learning-agent/src/server/routes/learner.goal-priority.test.ts`，**7 项**。
它不是 mock：直接调用真实的 `handleLearnerRoutes`，写入真实的临时 learner store，
再从**落盘的 profile** 读回归属戳。

| 用例 | 断言 |
| --- | --- |
| 仅标题 PATCH | `manual.priority` 保持 `{at_seq:0, edit:7}`，存储值不变 |
| 仅状态 PATCH | 同上 |
| 显式 priority PATCH | `manual.priority` 刷新（7→21）且值落盘 |
| 异常值 3 + 仅标题 | 3 存活，戳不变 |
| 负值 −0.2 + 仅状态 | −0.2 存活，戳不变 |
| 显式端点值 | 落盘并重新打戳 |
| 完全没有 priority 字段 + 仅标题 | 不会被补出一个 priority |

种子数据把 `profile.manual_edit_seq` 设为 20（高于种子戳的 `edit: 7`），
这样「发出了新戳」在数值上可观测；否则 `nextManualStamp` 会返回 1 而掩盖刷新。

**服务端规则本身零改动**：`server/routes/learner.ts` 的 diff 为空（见 §8.3）。

### 2.6 浏览器半场与真实路由的区别（如实声明）

R01–R05 使用 `page.route` 固定数据，其中 goal PATCH 的 mock **复刻**了服务端规则：
只有当请求体包含某字段时才推进 `manual.<field>.edit`。

- 浏览器场景证明的是：**请求体确实不含 `priority`**，以及界面在成功/失败/取消/被动刷新下的表现。
- 浏览器场景**不能**证明真实路由的打戳行为；这一点由 §2.5 的真实 handler 测试证明。

两者合起来才是完整契约；报告不把 mock 结果当作路由证据。

---

## 3. F02：课程视图的证据口径说明

### 3.1 问题

P2-6 只在「全部课程」的阅读态里解释「证据标识数量 ≠ 独立练习次数」。
指定课程的 `CourseLearnerPanel` 与课程概览 `CourseOverviewPanel` 只显示数量，没有说明；
紧凑行又不适合每行一段话。

### 3.2 修复

新增导出组件 `ProvenanceRegionNotes`（`react/profile/KnowledgeProvenance.tsx`），
从与阅读态**相同的 i18n key** 渲染两段说明：

- `profile.knowledge.provenance.originNote`：来源只说明记录由谁产生，不代表证据质量或可信度认证。
- `profile.knowledge.provenance.evidenceNote`：证据标识数量不等于独立学习或练习次数，旧版镜像记录可能重复计入。当前暂不提供证据明细。

渲染位置（**每个知识区域一次，不在每行**）：

| 文件 | 位置 |
| --- | --- |
| `courses/CourseLearnerPanel.tsx` | 筛选行之前 |
| `courses/CourseOverviewPanel.tsx` | `.mla-state-list` 之前 |
| `profile/KnowledgeProvenance.tsx` | 组件定义（阅读态原有的 `withNotes` 保持不变） |

样式 `shell.css` 新增 `.mla-provenance__region-notes`（`flex column` + `gap:2px` + `min-width:0`），
排版沿用 `.mla-provenance__hint`，**未新增颜色或字号**。

### 3.3 验收

| 要求 | 证据 |
| --- | --- |
| 每个知识区域一次 | `ProvenanceRegionNotes` 单测 4 项（两段都在、各一次、不渲染计数、英文文案）；`E04` 断言课程卡片内 `.mla-provenance__region-notes` 恰为 1，且「不等于独立学习或练习次数」全文出现 1 次；`CourseDetailPage.test.tsx` 概览页签同款断言 |
| 不在每行重复 | 同上（按出现次数断言，不是存在性） |
| 无需切到全部课程 | R06 直接进入「同义替换 → 知识掌握」，未切换范围 |
| 课程视图仍只读、数据作用域隔离 | 未改数据读取路径；R06 未产生任何写请求；P2-6 B10 的作用域冲突用例继续通过 |
| 320px 可读 | R06：noteBox 262×72.375，`clippedBy: []`，文档无横向溢出 |
| 暗色可读 | R06/dark 实测对比度 **4.52:1**（≥ 4.5） |
| 来源标签不被读成质量认证 | 第一段说明就在区域顶部；`originNote` 原文「不代表证据质量或可信度认证」 |

---

## 4. F03：「来源不明」语义修正

### 4.1 真实定义（读源码）

`apps/learning-agent/src/memory/learner/types.ts:117-118`：

```ts
/** True when a legacy value was kept as-is because its source is unknown. */
provenance_unknown?: boolean;
```

即：该记录是一条**来源无法确认的历史值被原样保留**。它不是「服务端尝试追溯并失败了」，
也不表示证据或内容有误。旧文案「服务端未能追溯这条记录的证据来源」把这两点都说过头了。

### 4.2 新文案（按任务书原文）

| 语言 | 文案 |
| --- | --- |
| zh-CN | 此记录包含来源无法确认的历史信息，不能据此判断证据质量或知识判断的准确性。 |
| en | This record contains historical information whose provenance cannot be confirmed. This flag does not establish evidence quality or the accuracy of the knowledge assessment. |

### 4.3 语义边界（有测试守住）

| 要求 | 守住方式 |
| --- | --- |
| 不声称执行过追溯 | 文案测试断言不含「服务端未能追溯」/「could not trace」；浏览器 B03、R07 同样断言旧词不再渲染 |
| 不声称所有关联证据都不可靠 | 断言不含「所有」/「有误」；文案只说「不能据此判断」 |
| 来源与标记相互独立 | `describeProvenance` 的既有语义未改；`manual + true` 仍同时显示 |
| 不推断准确性 | 文案明确「不能据此判断…准确性」 |
| 更新文案测试 | `knowledge-provenance.test.ts` 的中英文精确匹配；`KnowledgeProvenance.test.tsx` 的渲染断言同步更新 |

---

## 5. F04：证据标识数组边界保护

### 5.1 修复

`describeEvidenceCount()` 现在的规则：

| 输入 | 结果 |
| --- | --- |
| 合法字符串数组 | `length` 原样（`["evt_1","evt_1"]` → 2，**不去重**） |
| 空数组 | 0（可读） |
| 非数组（缺失 / null / 字符串 / 数字 / 对象） | 不可用 |
| 含非字符串元素（`null`、`123`、`{}`、`true`、嵌套数组） | 不可用 |
| 含空串或纯空白串 | 不可用 |

### 5.2 空串/空白串的依据（任务书要求记录依据）

两类坏元素的依据不同，必须分开说：

**非字符串元素（`null` / 数字 / 对象）**：写入路径不会产生它们。
`patchProfile()` 把追加的 id 过 `uniqueStrings()`，先 `trim()` 再丢弃空值
（`profile-updater.ts:52-54,176`）；自动路径推送的是自己生成的 id
（`auto-profile.ts:307`、`state-engine.ts:277`）。出现非字符串只能是损坏数据。

**空串/纯空白串**：这一条**不能说「不可能被写入」**。已核实：
`KnowledgeStateSchema.evidence_ids` 是 `Type.Array(Type.String())`，没有 `minLength`
（`learner-tools.ts:49`），而 `updateProfile()` 合并 `knowledge_states` 时
直接透传 `evidence_ids`，没有规范化（`profile-updater.ts:111-117`）。因此 `""`
**可以**被存进 profile。

把它判为「不可用」的真正依据是：**服务端自己统计证据时就不算空白 id**。
`courses/daily-plan.ts:133` 与 `learning/recommendations.ts:97` 都写作
`typeof id === "string" && id.trim().length > 0`。展示层若把空白 id 计入，
屏幕上就会出现一个服务端自己都不使用的数字——这正是本模块拒绝做的「静默纠正」的反面：
宁可说「不可用」，也不给出一个与服务端口径不一致的计数。

### 5.3 明确未做（任务书禁止项）

- 未过滤非法元素后重新计数（`["evt_1", null]` 不会显示 1）。
- 未去重（`["evt_1","evt_1"]` 显示 2）。
- 未修改传入数组（`does not mutate the array it is given` 逐元素比对副本）。

### 5.4 测试

`knowledge-provenance.test.ts`：

- `reports an array with non-identifier elements as unavailable`：覆盖任务书要求的
  `[null]`、`[123]`、`[{}]`、`["evt_1", null]`、`["evt_1", 123]`，另加 `[true]`、`[["nested"]]`。
- `reports blank strings as unavailable`：`[""]`、`["   "]`、`["evt_1",""]`、`["evt_1"," \t "]`。
- `counts a valid array as stored, whatever the identifier shape`：合法形状与重复项原样计数。
- `does not mutate the array it is given`。
- `KnowledgeProvenance.test.tsx`：`reports an array with non-identifier elements as unavailable`（渲染层）。

浏览器 R08 用六种坏形状与一个合法数组实测：六种全部显示「证据标识数量不可用」，
合法数组显示「证据标识 2 个」。

---

## 6. 浏览器验收

脚本：`docs/ui-redesign/phase5/scripts/qa_p2_6_r1.py`
指标：`P2-6-assets/r1-browser-metrics.json`
截图：`P2-6-assets/r1/`（12 张 `r1-r0*.png`，2 张改正后的 B 场景
`r1-b03-320-unknown.png` / `r1-b09-priority.png`，以及 B01、B02、B04–B08、B10 的
8 张 `p26-*.png` 复跑）

隔离 Vite（`127.0.0.1:5193`）+ Playwright Chromium + `page.route` 固定数据，
无后端、无真实数据、无写入。**全部 19 个场景 `pageErrors` 为空**，页面级横向溢出为 0。

### 6.1 R01–R08

| 场景 | 视口 / 主题 / 语言 | 实测 |
| --- | --- | --- |
| R01 异常优先级仅改标题 | 1440 / light / zh | PATCH 字段 `["title"]`，`prioritySubmitted: false`，存储 3，戳 `{at_seq:0,edit:7}` 前后一致 |
| R02 正常 0.5 仅改状态 | 1440 / light / zh | PATCH `["status"]`，`prioritySubmitted: false`，戳不变 |
| R03 主动修改 0 / 0.4 / 1 | 1440 / light / zh | 三跑均发送 `["priority"]`，值 0 / 0.4 / 1，戳 7→21 |
| R04 编辑期间被动更新 | 1440 / light / zh | 服务端置 0.9、戳 `edit:99`；保存后仍是 0.9 与 99，PATCH 仅 `["title"]` |
| R05 取消与失败 | 1440 / light / zh | 取消 0 次 PATCH；失败 1 次 PATCH（`{title, priority:0.4}`），草稿与滑块 40 保留，存储仍 3 |
| R06 课程说明 320px | 320 / light / zh | 说明块 1 个，262×72.375，未裁剪；暗色对比度 4.52 |
| R07 320px 英文来源不明 | 320 / light / en | 新文案逐字命中，旧「could not trace」不存在，中文零泄漏 |
| R08 坏证据数组 | 1440 / light / zh | 六种坏形状全部「不可用」，合法数组仍 2 |

R03 的滑块输入用键盘（`Home` + N×`ArrowRight`）驱动：直接赋值 `el.value` 后派发
`change` 会被 React 的 value tracker 丢弃，脚本化赋值证明不了真实拖动。
`priority = 3` 时手柄已停在 100，因此 1 只能通过端点按钮达成——这正是 §2.3 要解决的场景。

### 6.2 B01–B10 复跑

原 P2-6 的 10 个场景从同一脚本复跑，写入 `r1/`，**不覆盖**原 `P2-6-assets/`。

- B01、B02、B04–B08、B10：原断言全部继续通过（含 B05 暗色对比度 6.59:1）。
- **B03 期望已改正**：原脚本断言提示文案含「服务端未能追溯」，F03 已按任务书替换。
  R1 版本改为断言「来源无法确认的历史信息」存在、旧词不存在。
- **B09 期望已改正**：原脚本断言「仅改标题保存写回 `priority: 3`」，那正是 F01 要移除的行为。
  R1 版本改为断言 `priority` 键**不存在**、存储值仍为 3、界面仍显示「优先级异常 · 原始值 3」；
  取消仍 0 次 PATCH，正常目标仍显示「优先级 50%」。

### 6.3 两处改动的性质

| 项 | 原断言 | 现状 | 原因 |
| --- | --- | --- | --- |
| B03 | 提示含「服务端未能追溯」 | 断言新文案、断言旧词不存在 | F03 主动替换文案，旧断言描述的是被删除的行为 |
| B09 | 标题保存发送 `priority: 3` | 断言键不存在、存储不变 | F01 主动移除该行为 |

两处都是**跟随任务书要求的期望更新**，不是为了让失败变绿而放宽；B03 同时增加了
「旧词不得出现」的反向断言，B09 增加了「存储值不变」的断言，严格程度是上升的。
其余断言（含 jsdom 既有断言）**未删除、未放宽**。

### 6.4 原始证据未被覆盖

```text
$ git status --short docs/ui-redesign/phase5/P2-6-assets/
?? docs/ui-redesign/phase5/P2-6-assets/r1-browser-metrics.json
?? docs/ui-redesign/phase5/P2-6-assets/r1-test-log.txt
?? docs/ui-redesign/phase5/P2-6-assets/r1/
$ git diff --stat -- docs/ui-redesign/phase5/scripts/qa_p2_6.py
(空)
```

原 `qa_p2_6.py`、`p26-browser-metrics.json`、`p26-test-log.txt`、`p26-*.png` 全部未改动。

---

## 7. 冻结范围核对

| 冻结项 | 是否触碰 |
| --- | --- |
| 知识状态引擎 | 否 |
| 学习证据生成与重放 | 否 |
| 学习记忆机制 | 否 |
| 服务端 API 规则 | **否**（`server/routes/learner.ts` diff 为空） |
| 数据库 | 否 |
| 掌握度 / 置信度 / 稳定性计算 | 否 |
| 正式复习资格 | 否 |
| 六类筛选规则 | 否（`KnowledgeStateFilters` 未改） |
| `KnowledgeDraftGuard` | 否 |
| P2-5 响应式布局机制 | 否（未改容器查询、断点、网格区域） |
| 可信度评分 | **未新增**（无综合评分、无证据质量分级） |
| 其他学习目标字段的全面编辑架构重构 | **未做**（`goalPatchFromDraft` 只做「发不发这个键」的判定，不改编辑架构） |

---

## 8. 测试与构建

真实日志：`P2-6-assets/r1-test-log.txt`。

### 8.1 结果

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（web） | `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | exit 0（最后一次编辑器改动后重跑） |
| 定向回归 | `npx vitest run`（profile / courses / pages / i18n / server routes） | 59 文件 / 933 通过（合并后重跑） |
| 全量构建 | `npm run build` | 通过（41.31s，合并后重跑） |
| 全量测试 | `npx vitest run` | 2601 用例：**2597 通过 / 1 失败 / 3 跳过**（见 §8.4） |
| 浏览器验收 | `python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_6_r1.py` | 19 个场景全部通过 |

### 8.2 与历史基准对比

| | 总数 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- | --- |
| P2-6 基准 | 2554 | 2550 | 1 | 3 |
| 本轮 | 2601 | 2597 | 1 | 3 |

新增 **44** 项（合并后统计；另有 `server.smoke.test.ts` 1 项不计入默认集合）：

| 文件 | 新增 |
| --- | --- |
| `knowledge-provenance.test.ts` | 17（F03 文案、F04 数组边界含空白串、`goalPatchFromDraft` 9 项） |
| `KnowledgeProvenance.test.tsx` | 6（新文案、不推断、坏数组、`ProvenanceRegionNotes` 4 项） |
| `GoalPriority.test.tsx` | 净增 14（16 项新增 + 2 项改写为更强断言；文件从 9 项变为 23 项） |
| `KnowledgeProvenance.lifecycle.test.tsx` | 2（E04 + 对方新增的课程作用域说明断言） |
| `CourseDetailPage.test.tsx` | 1（概览页签 F02） |
| `server/routes/learner.goal-priority.test.ts` | 7（新文件） |
| `server.smoke.test.ts` | 1（对方新增，被 vitest 配置排除，单独实跑通过，见 §9.4） |

### 8.3 服务端 diff 核对

```text
$ git diff --stat 6ea2eea HEAD -- apps/learning-agent/src/server/routes/learner.ts
(空)
```

本轮**未改任何服务端生产代码**——`server/routes/learner.ts` 的归属规则与 P2-6 审查时逐字相同。
`apps/learning-agent/src/` 下的改动只有测试：新增 `server/routes/learner.goal-priority.test.ts`，
以及合并进来的 `server.smoke.test.ts` 中对方新增的那一个用例（§9.4）。

### 8.4 全量测试的实际结果

```text
$ npx vitest run
 FAIL  node apps/learning-agent/src/server.e48-workbench.test.ts
       > E4.8a — course status gates chat writes
       > allows an in_progress course to continue chatting
       AssertionError: expected 2 to be 1
       ❯ apps/learning-agent/src/server.e48-workbench.test.ts:253:25

 Test Files  1 failed | 216 passed (217)
      Tests  1 failed | 2597 passed | 3 skipped (2601)
```

这是合并远程分支之后的干净运行。此前有两次不干净的全量运行，都发生在浏览器验收
（Playwright + Vite）同时运行的时候：

- 一次多出 3 个失败（`server.learning-answer.test.ts` 2 项、`server.session-archive.test.ts` 1 项），
  这三个文件单独重跑 17/18 通过（唯一失败仍是 `e48-workbench` 的历史基准）。
- 一次多出 21 个失败，集中在 `learning/answer-service`、`learning/evidence-recovery`、
  `learning/question-service`、`learning/record-store` 与 `MarkdownArtifact.test.tsx`；
  单独跑 `npx vitest run apps/learning-agent/src/learning` 是 **14 文件 / 398 全通过**。

三次运行之间**没有任何代码改动**，因此判定为并发/端口竞争（与 P2-5-R1 §9.2 记录的现象一致），
不是回归。本报告只采用不与其他重负载并行的这一次结果。

定向回归（profile / courses / pages / i18n / shell / stores / server routes / memory.learner，
80 文件）中出现过一次 `PracticePage.test.tsx > does not claim a refreshed long-term state
when finalize fails` 失败；该文件单独运行 89/89 通过，完整套件中也通过。同样判为并发抖动，
与本轮改动的文件无关（本轮未改 `PracticePage`、未改任何 practice 相关代码）。

---

## 9. 交付

### 9.1 新增文件

```text
docs/ui-redesign/phase5/
├── P2-6-R1-acceptance.md                  本报告
├── P2-6-assets/
│   ├── r1-browser-metrics.json            19 个场景的实测数据
│   ├── r1-test-log.txt                    真实测试/构建日志
│   └── r1/                                R1 截图 + B 系列复跑截图
└── scripts/
    └── qa_p2_6_r1.py                      R01–R08 + B01–B10 复跑
```

### 9.2 与任务书的一处偏离（如实说明）

任务书 §9 的交付物写的是 `scripts/qa_p2_6.py`。本轮新增的是 **`scripts/qa_p2_6_r1.py`**，
`qa_p2_6.py` 原样保留。

原因：`qa_p2_6.py` 是 P2-6 的证据脚本，直接改写它会使原 `p26-browser-metrics.json`
与截图无法复现，等同于覆盖原始 P2-6 证据——而任务书同时要求「不得覆盖原始 P2-6 证据」。
两个要求冲突时，采用「新增独立命名文件」这一条：`qa_p2_6_r1.py` 通过 `import qa_p2_6`
复用同一套 fixture 与测量探针，没有复制漂移，并把输出重定向到 `r1/`。

### 9.3 提交与 PR

| 项 | 值 |
| --- | --- |
| 分支 | `feat/e49i-p2-6-profile-provenance`（沿用） |
| 推送 | 已推送至 `origin/feat/e49i-p2-6-profile-provenance`，本地与远程一致（提交哈希见 `git log -1`：写入本文件后再 amend 会让哈希自我指涉） |
| PR | 已存在：[livepass/My-Learning-Agent#23](https://github.com/livepass/My-Learning-Agent/pull/23)（由另一执行环境创建，**Draft**，body 仍是「NOT VERIFIED」）。本分支已推送到该 PR 的 head，所以 PR 现在指向本轮已验证的提交；**但无法更新其标题/描述/草稿状态**：`gh auth status` → `You are not logged into any GitHub hosts`。 |
| 自动合并 | **未开启**（任务书禁止；当前也无法操作） |

PR 描述草稿：`P2-6-R1-pr-body.md`（本轮增补，接在 P2-6 的 `P2-6-pr-body.md` 之后）。

### 9.4 与远程分支的合并（必须知道）

开工时远程开发分支与本地同为 `6ea2eea`。本轮验证全部完成后执行 `git fetch`，发现远程已被
**另一个执行环境**推送到 `826915c`：19 个提交，内容是与本轮同一个 R1 任务，但其自述状态是
「代码已提交；验收阻塞（NOT VERIFIED）」，理由是那个容器无法解析 github.com、
无法检出仓库与安装依赖，因此**所有测试、构建、浏览器验收都未运行**，其
`r1-browser-metrics.json` 是一份 `"executed": false` 的占位文件。

处理方式：把本轮已验证的提交 rebase 到 `826915c` 之上（不改写对方的提交历史），
逐项解决冲突，**每一处冲突都取本轮已实跑验证的实现**：

| 冲突项 | 取舍 |
| --- | --- |
| `LearnerProfilePanel.tsx` | 取本轮（`priorityTouched` + `goalPatchFromDraft`）；对方的 `priorityEdited` 版本不发送未改动字段，但会在异常值时用错误文案挡住保存 |
| `knowledge-provenance.ts` | 取本轮（空白串也判为不可用，依据见 §5.2）；对方只判元素类型 |
| 两个课程面板 | 自动合并把说明渲染了两次（对方的内联 `<p>` + 本轮的共享组件），已删除对方的内联版本，保留单一组件 |
| i18n | 取本轮文案，保留对方新增的 `priorityUnavailableHint`（已接到「优先级不可用」分支上使用），删除随内联按钮一起废弃的 `setPriorityZero` / `setPriorityMax` |
| 证据 JSON / 日志 / 脚本 / 报告 | 取本轮实跑产物；对方的占位文件被替换（其内容仍可在 `826915c` 历史中查到） |

对方在 `server.smoke.test.ts` 里新增的真实 HTTP 用例**保留并已实跑通过**（1 项）。
注意：该文件被 `vitest.config.ts` 排除在默认测试集合之外（README 亦说明它依赖已移除的
full 模式接口），所以它既不在全量统计里，也不能用 `npx vitest run <path>` 直接跑；
本轮用一份临时 config 单独执行，结果：`R1 F01: PATCH without priority preserves value and
manual ownership stamp` ✓。同文件的其余用例有 32 项失败（403/404 等），是它被排除的既有原因，
与本轮改动无关，未改动它们。

合并后重跑：`tsc --noEmit` exit 0；profile / courses / pages / i18n / server routes
共 59 文件 / 933 通过；受影响 6 文件 132 通过；全量 2601 用例 2597 通过（§8.4）。

---

## 10. 剩余缺陷与已知限制

1. **`gh` 未登录**：PR #23 的标题/描述/草稿状态无法更新。它现在指向本轮已验证的提交，
   但 body 仍写着「NOT VERIFIED / Draft」——**这已经不准确**。需人工 `gh auth login` 后
   用 `P2-6-R1-pr-body.md` 替换描述并取消 Draft。这是环境阻塞，不是代码缺陷。
2. **历史基准失败** `server.e48-workbench.test.ts > allows an in_progress course to continue chatting`
   （`expected 2 to be 1`，`server.e48-workbench.test.ts:253`）：P2-5 起已记录，
   与本轮改动无关（本轮未触碰任何 server 生产代码），断言未删除、未跳过、未放宽。
3. **全量并发下的偶发失败**：与浏览器验收（Playwright + Vite）同时运行全量套件时，
   `learning/*` 与 `server.learning-answer` / `server.session-archive` 等真实端口测试会成批失败
   （404 / 500 / 超时）。单独重跑 `apps/learning-agent/src/learning` 是 14 文件 / 398 全通过，
   其余文件单独跑也通过；原因与 P2-5-R1 记录的一致（各自拉起真实监听端口）。
   本轮未改动相关代码，最终数字取不并行的干净运行（§8.4）。
4. **浏览器验收使用 mock API**：R01–R05 的归属戳行为由 mock 复刻，真实路由行为由
   `learner.goal-priority.test.ts` 证明（§2.6）。报告不把两者混为一谈。
5. **端点按钮的措辞**：「将优先级设为 100%」是新增 i18n key，与「优先级异常 · 原始值 3」
   并列显示。若后续要合并成一个控件，需要重新设计异常值的编辑交互——本轮按任务书
   「不增加复杂交互」的要求，只加了这一个显式确认按钮。

---

## 11. 结论

**PASS_WITH_KNOWN_BASELINE_FAILURE**

- **F01**：客户端不再隐式发送 `priority`，服务端归属戳不再被未修改的保存刷新；
  真实路由集成测试与浏览器请求体断言两侧都有证据；端点值可显式选择。
- **F02**：两个课程视图各有一处区域级说明，320px 与暗色下可读，未改为逐行重复。
- **F03**：「来源不明」改为记录级语义，不声称追溯、不推断准确性，中英文均更新并有测试。
- **F04**：坏数组一律「不可用」，不过滤、不去重、不改原数组；空串判定有服务端写入依据。
- 冻结范围零触碰；服务端生产代码 diff 为空；原始 P2-6 证据未被覆盖；未开启自动合并。
