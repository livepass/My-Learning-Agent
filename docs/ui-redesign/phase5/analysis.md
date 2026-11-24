# E4.9i-P1 现状分析：我的学习档案

- **基准分支**：`main`
- **基准提交**：`432a43ad594c69d3236ba189a4de4ecfd0b29126`
- **工作分支**：`design/e49i-p1-profile-prototype`
- **分析范围**：`apps/learning-agent/web/src` 的「我的学习档案」页及其直接依赖，以及它读取的服务端字段
- **本阶段**：只分析、设计和原型。**未修改任何业务代码、API、Store 或数据库字段**
- **证据获取方式**：读取组件 / Store / API / i18n / 测试；启动 `npm run dev:server` + `web:dev`，用本机真实档案（`runtime/data/learner/profile.json`、`runtime/data/courses/state.json`）在 1440×900、1024×768、390×844、320×640 四档视口截图，并读取 DOM 实测尺寸

---

## 1. 现有组件与数据来源

### 1.1 组件树

```text
ProfilePage                      86 行   react/pages/ProfilePage.tsx
├─ 页面头：h1 + 副标题 + 课程范围 Select（全部课程 / 某门课程）
├─ coursesError 提示
└─ mla-profile-body
   ├─ selectedCourseId === null → LearnerProfilePanel     1054 行
   │  ├─ 版本行 + 「刷新」按钮
   │  ├─ SummarySection      概览：4 个统计 + 画像摘要（阅读态 / 编辑态）
   │  ├─ GoalsSection        学习目标列表 + 新增目标对话框
   │  ├─ KnowledgeSection    知识状态列表（>5 条默认折叠）
   │  │  └─ KnowledgeRow     掌握度进度条 + 百分比 + 状态徽标 + 复习时间；展开=编辑
   │  ├─ MisconceptionsSection  误解记录（状态/严重度/修复策略可改）
   │  └─ PreferencesSection     学习偏好（4 组 chip 输入）
   └─ selectedCourseId !== null → CourseLearnerPanel        253 行
      ├─ 课程卡：任务完成数 / 完成率 / 有证据知识点 / 需关注知识点 + 口径说明
      ├─ 课程学习目标（只读）
      ├─ 知识掌握（服务端 state_label + 复习时间 + 证据条数 + 诊断）
      ├─ 需要关注的知识点（state_label ∈ fragile/learning/misconception/review_due）+ next_actions
      ├─ 未归类旧记录计数
      └─ 教学偏好（共享，只读）
```

### 1.2 数据来源表

| 区块 | Store / 调用 | 接口 | 字段 | 作用域 |
| --- | --- | --- | --- | --- |
| 课程范围 | `coursesStore.selectedCourseId` + `loadCourses()` | `GET /api/courses` | `course_id`、`title`、`status` | 全局 |
| 页面头 / 课程卡 | `coursesStore.courseLearner` + `loadCourseLearner(id)` | `GET /api/courses/:id/learner` | `course`、`goals`、`knowledge_states`、`preferences`、`unclassified` | 单课程（服务端过滤） |
| 课程任务进度 | `coursesStore.courseDaily` + `loadCourseDaily(id)` | `GET /api/courses/daily?course_id=` | `courses[0].task_progress`、`courses[0].knowledge.*` | 单课程 |
| 概览统计 | `learnerStore.profile` | `GET /api/learner/profile` | `goals`、`knowledge_states`、`misconceptions` | 全部课程（不过滤 `course_id`） |
| 画像摘要 | `learnerStore.patchSummary()` | `PATCH /api/learner/profile` | `profile_summary` | 全部课程 |
| 学习目标 | `addGoal` / `patchGoal` / `deleteGoal` | `/api/learner/profile/goals*` | `title`、`type`、`priority`、`status`、`success_criteria`、`source` | 全部课程（课程视图只读已绑定目标） |
| 知识状态 | `patchKnowledge()` | `PATCH /api/learner/profile/knowledge/:id` | `mastery`、`diagnosis`、`next_actions`（服务端强制 `origin: "manual"`） | 全部课程（课程视图只读） |
| 误解 | `patchMisconception()` | `PATCH /api/learner/profile/misconceptions/:id` | `status`、`severity`、`repair_strategy` | 全部课程 |
| 学习偏好 | `patchPreferences()` | `PATCH /api/learner/profile` | `preferences.*` | 全局共享 |

### 1.3 已具备、但容易被误判为「缺失」的能力

现有页面**已经支持**：编辑画像摘要、编辑目标（含新增/删除）、编辑知识点的掌握度与诊断与下一步动作、编辑误解状态/严重度/修复策略、编辑四类学习偏好、刷新档案、按课程切换范围。P2 不得把这些能力当成新需求重做，只能重排展示。

### 1.4 两个视图的结构差异（假设 B 的事实基础）

| 维度 | 全部课程（`LearnerProfilePanel`） | 指定课程（`CourseLearnerPanel`） |
| --- | --- | --- |
| 首屏结论 | 4 个统计块 + 摘要 | 4 个统计块（含任务完成率）+ 口径说明 |
| 知识状态口径 | **前端按 `mastery` 阈值分档** | **服务端 `state_label`** |
| 知识状态列 | 名称 / 进度条 / 百分比 / 状态 / 复习时间 | 名称 / 状态 / 复习时间 / 证据条数 / 诊断 |
| 证据数量 | 不显示 | 显示「证据 N 条」 |
| 误区 | 可读可编辑 | **接口不返回，视图无此区块** |
| 画像摘要 | 有 | **接口不返回，视图无此区块** |
| 目标 | 可编辑 | 只读（仅已绑定本课程的目标） |
| 偏好 | 可编辑 | 只读（共享设置） |
| 未归类记录 | 无提示 | 有计数提示 |
| 编辑入口 | 行内展开 / 对话框 | 无（纯读） |

**结论**：假设 B（两个视图结构差异大）成立，且差异不只是视觉——两个视图的知识状态口径、可编辑范围、区块集合都不同。候选信息架构必须为「某范围没有该字段」准备显式不可用态，不能把全部课程的区块直接照搬进课程视图。

---

## 2. 掌握状态语义核查（最高优先级）

### 2.1 两套状态的定义与归属

| | 全部课程视图 | 指定课程视图 |
| --- | --- | --- |
| 代码 | `LearnerProfilePanel.tsx:642-646` `masteryStateFor()` | `CourseLearnerPanel.tsx:22-38` `STATE_LABEL_KEY` / `stateLabel()` |
| 取值 | `mastery >= 0.8` → 已掌握；`>= 0.4` → 巩固中；否则待复习 | 服务端 `state_label`：unknown / learning / fragile / review_due / stable / misconception |
| 数据来源 | `knowledge_states[].mastery`（数值） | `knowledge_states[].state_label`（字符串） |
| 计算位置 | **浏览器内，每次渲染现算** | **服务端** `memory/learner/state-engine.ts` 投影后写入 `profile.json` |
| 是否写回 | 否 | 是（`applyDerivedKnowledgeState()` 写入，`origin: "derived"`） |
| 是否参与决策 | 否 | 是（每日计划、计划建议、推荐规则都读 `state_label`） |
| 是否持久化 | 否 | 是 |
| 缺字段时 | 不会缺（mastery 必有） | `state_label` 缺失 → 显示「证据不足」 |

**第 4 问（哪一种是正式长期学习状态）**：`state_label`。它是服务端从证据账本投影出的唯一长期状态，参与每日计划、计划调整建议（`plan-adjustments.ts`）、下一步推荐（`learning/recommendations.ts`）与课程删除前的掌握度检查。`masteryStateFor` 只是前端为了让 `mastery` 这个数字看起来像状态而做的**展示分档**，不写回、不参与任何判断。

**第 5 问（哪些值是服务端存储、哪些只是前端展示映射）**：
- 服务端存储：`mastery`、`confidence`、`stability`、`estimate_confidence`、`stability_days`、`retrievability`、`state_label`、`review_due_at`、`evidence_ids`、`diagnosis`、`next_actions`、`origin`、`provenance_unknown`、`course_id`。
- 仅前端映射：`mastered / consolidating / needsReview` 三个标签及其颜色、进度条宽度、概览里的「待复习概念」计数（`review_due_at <= now`）。

### 2.2 同一知识点显示不同状态的实证

本机真实档案（`runtime/data/learner/profile.json`）：

```json
{
  "concept_id": "cet4.synonym_replacement",
  "concept_name": "replacement",
  "domain": "cet4",
  "mastery": 0.05,
  "state_label": "learning",
  "evidence_ids": ["evt_bfa313f3", "legacy_evt_bfa313f3_cet4.synonym_replacement"],
  "origin": "derived"
}
```

- 全部课程视图：`masteryStateFor(0.05)` → `needsReview` → 徽标 **「待复习」**（`current-desktop.png` 可见）。
- 该状态的真实 `state_label` 是 `learning`，在课程视图中的文案是 **「学习中」**（`course.state.learning`）。

同一个知识点、同一天，因为所在视图不同，会显示「待复习」与「学习中」两个不同结论。这不是显示瑕疵，而是两套口径并存的结果。

### 2.3 同一页面内的自相矛盾（已确认）

`SummarySection` 的「待复习概念」按 `review_due_at <= Date.now()` 计数（`LearnerProfilePanel.tsx:131`），而下方知识行按 `mastery < 0.4` 显示「待复习」。本机档案没有 `review_due_at`（该状态只有 exposure 证据、没有成功提取，`state-engine.ts` 的 `nextReviewAt()` 返回 `undefined`），于是：

- 概览：「待复习概念 **0**」
- 知识状态行：「replacement … 5% **待复习**」

同一屏内，两个「待复习」互相否定。截图 `current-desktop.png` 与 `current-mobile.png` 都能看到。

### 2.4 「待复习」一词的三重含义

| 出现位置 | 判据 | 含义 |
| --- | --- | --- |
| `profile.knowledge.masteryState.needsReview` | `mastery < 0.4` | 数值低 |
| `course.state.review_due` | `retrievability < 0.7` 且曾成功提取 | 到期待唤醒 |
| 概览「待复习概念」 | `review_due_at <= now` | 有到期时间且已过期 |

三者互不蕴含：mastery 低不一定有到期时间，有到期时间也不一定 mastery 低。P2 必须给它们不同的词，或只保留一种。

### 2.5 统一展示方案（建议，P2 实施）

1. **状态一律显示服务端 `state_label`**，全部课程视图与课程视图共用同一套 `STATE_LABEL_KEY` 文案（已存在于 `course.state.*`）。
2. `mastery` 降级为**辅助数值**：保留进度条与百分比，但不再用它生成状态徽标。`masteryStateFor()` 与 `profile.knowledge.masteryState.*` 在 P2 移除；**不改阈值**，因为阈值本身将被停用而不是调整。
3. 概览的「待复习概念」改为读服务端计数（课程视图已有 `courseDaily.knowledge.due_reviews`；全部课程视图可用 `state_label === "review_due"` 计数），并改名为「已到期复习」，与 `review_due_at` 的语义一致。
4. `state_label` 缺失（旧数据、`origin: "legacy"`）时显示「状态未知」并附来源不明标记，**不回退到阈值分档**——回退会让一个不可信的数值伪装成服务端结论。
5. 前端类型补 `state_label?: string` 与 `course_id?: string`（`types/learner.ts` 的 `KnowledgeState` 目前没有这两个字段）。**字段已由 `GET /api/learner/profile` 原样返回**（见 §3.3），补类型不是新增 API 或字段，只是让前端能读到已存在的数据。

> 第 3 问的回答：**存在**同一知识点在不同视图显示不同状态的情况，且已在本机真实数据上复现（§2.2）。

---

## 3. 证据、进度与掌握度的区别

### 3.1 六个概念，不能互相替代

| 数据 | 精确定义 | 来源 | 可以说明什么 | 不能说明什么 |
| --- | --- | --- | --- | --- |
| `task_progress` | 课程计划内任务完成数 / 总数 / 百分比 | 服务端 `buildDailyPlans` | 计划推进到哪一步 | 学会了什么。任务可被手动标记完成 |
| `evidence_ids` | 关联到该知识状态的学习证据**标识** | `state-engine` 累积、`auto-profile` 追加事件 id | 有可追溯的记录 | 记录质量。**同一事件可能有两个 id**（见 §3.2） |
| `mastery` | 固定增量累加得到的启发式分值，`[0,1]` | `auto-profile.ts` `MASTERY_DELTAS`；源码注释明确「不是校准概率」 | 相对排序（先复习谁） | 绝对掌握程度、通过率 |
| `state_label` | 由证据种类、结果、稳定度、可提取性、误区推导的分类 | `state-engine.ts` | 当前应如何对待这个知识点 | 精确水平 |
| `review_due_at` | `last_successful_retrieval_at + stability × ln(0.7)/ln(0.9)` | `state-engine.ts` `nextReviewAt()` | 何时该唤醒 | 没有成功提取时为 `undefined`，不代表「不需要复习」 |
| `next_actions` | 与 `state_label` 配套的固定建议句 | `stateDescription()`，可被人工改写 | 服务端给出的下一步 | 学习者实际执行情况 |

**「不得把任务完成率当成知识掌握率」的现状**：`CourseLearnerPanel` 已经用一行说明把两者分开（`course.learner.explanation`），并且四个统计块并列但不合并。这是现有页面的优点，P2 必须保留，不能把「任务完成率」和「掌握」做成同一个进度条。

### 3.2 证据条数会被高估（已确认）

本机档案里只有 **1 条** `concept_explained` 事件（`evt_bfa313f3`），但该知识状态有 **2 个** `evidence_ids`：

```text
evt_bfa313f3
legacy_evt_bfa313f3_cet4.synonym_replacement
```

`memory/learner/evidence.ts:183-205` 的 `legacyEvidence()` 会为旧事件生成 `legacy_<event_id>_<concept_id>` 形式的镜像 id，二者指向同一事件。因此课程视图的「证据 2 条」在这条数据上是**重复计数**。

原型与 P2 的处理：把文案从「证据 N 条」改为「证据标识 N 个」，并在详情里注明「同一事件的旧版镜像会重复计入；本阶段没有去重接口」。不得在前端自行去重（`legacy_` 前缀是内部约定，不是公开协议）。

### 3.3 数据可信度字段：已存储、已返回、但界面完全没显示

| 字段 | 服务端 | 前端类型 | 界面 |
| --- | --- | --- | --- |
| `origin`（`derived` / `manual` / `legacy`） | 有 | `KnowledgeState` 已声明 | **未使用**（grep 全仓 `react/` 无引用） |
| `provenance_unknown` | 有 | 已声明 | **未使用** |
| `confidence` | 有 | 已声明 | **未使用** |
| `course_id` | 有 | **未声明** | 未使用 |
| `state_label` | 有 | **未声明**（仅推荐快照类型里有） | 全部课程视图未使用 |

`GET /api/learner/profile` 直接 `json(res, 200, profile)` 返回整份档案，上述字段都在响应里；前端只是没有声明、没有渲染。所以「区分人工维护与系统推导」**不需要新增 API**，只需要补类型 + 展示。

另外，`PATCH /api/learner/profile/knowledge/:id` 会把该状态强制标记为 `origin: "manual"`（`server/routes/learner.ts:251`）。也就是说，学习者拖过一次掌握度滑块，这个知识点就从「系统推导」变成「人工维护」，而界面当前没有任何提示。这是 P2 必须补的可信度提示：**编辑后要显示「人工维护」，并说明它不再随证据重算**。

### 3.4 接口缺什么（原型必须标注为能力限制）

| 想展示的内容 | 现状 | 结论 |
| --- | --- | --- |
| 每条证据的时间、题型、结果、得分 | 只有 `evidence_ids`，没有证据详情接口 | **不可展示**。原型只显示标识数，详情里写明「本阶段无法列出证据明细」 |
| 「系统为什么给出这个状态」的推理链 | `diagnosis` 是一句固定模板文本，不是针对本次证据的解释 | 只能展示 `diagnosis` 原文，不能包装成「AI 解释」 |
| 指定课程视图的误区 | `CourseLearnerView` 没有 `misconceptions` | 课程视图显示「该范围不提供误区数据」 |
| 指定课程视图的画像摘要 | 同上 | 显示「画像摘要属于全部课程档案」 |
| 课程归属名称 | 知识状态只有 `course_id` | 需要课程列表映射；全部课程视图可显示课程名，但属于前端拼装，原型标注为「待确认」 |

---

## 4. 页面信息架构与已确认问题

### 4.1 当前展示顺序

全部课程：概览 → 学习目标 → 知识状态 → 误解记录 → 学习偏好。
指定课程：课程摘要 → 学习目标 → 知识掌握 → 需要关注 → 未归类 → 教学偏好。

两者顺序接近，但内容密度和可编辑性完全不同。

### 4.2 已确认问题（有截图或 DOM 实测）

| # | 问题 | 证据 |
| --- | --- | --- |
| P1 | 同一屏内「待复习概念 0」与知识行「待复习」矛盾 | `current-desktop.png`；§2.3 |
| P2 | 同一知识点在两个视图状态文案不同（待复习 / 学习中） | §2.2；`current-course-desktop.png` 中该知识点不出现（未归类），课程视图显示「还没有带证据的知识点」 |
| P3 | 概览 4 个统计块占满整行，但没有一句学习结论 | `current-desktop.png`：统计块下方只有「还没有学习画像摘要」 |
| P4 | 320px 下知识行固定列（170 + 42 + 74px）超出卡片，状态徽标被裁掉，进度条宽度为 0 | DOM 实测：320px 视口下知识行右边界 271px，徽标 `x=291, right=365`（超出视口 45px），`scrollWidth=320` → 被卡片裁切；进度条 `width: 0` |
| P5 | 390px 下进度条同样为 0（170+42+74+3×12=322px，恰好占满），「掌握度」在窄屏完全不可见 | DOM 实测：390px 视口徽标 `x=291`，进度条 `width: 0` |
| P6 | 移动端首屏被课程范围选择器和「刷新」按钮占掉两行，概览要到第二屏 | `current-mobile.png` |
| P7 | 证据数量在全部课程视图完全不出现，课程视图出现但可能重复计数 | §3.2 |
| P8 | 可信度（人工 / 系统 / 来源不明）完全不可见 | §3.3 |
| P9 | 目标优先级显示为「300%」（真实数据 `priority: 3`） | `current-desktop.png` 目标行 |
| P10 | 页面副标题「学习目标、知识掌握、薄弱点与教学偏好都来自同一份本机档案」与实际不符：课程视图的偏好是共享的、误区不可见 | 文案 vs §1.4 |
| P11 | 学习偏好直接显示内部英文 token：`immediate_feedback`、`encouraging` | `current-320-preferences.png`；`profile.json` 的 `practice_style` / `feedback_tone` |
| P12 | 展开知识点即进入编辑态：想读诊断必须面对可编辑的滑块与文本框，且保存/取消按钮常驻 | `current-mobile-expanded.png` |

### 4.3 待验证假设（P1 不宣称成立）

| 假设 | 判断 | 说明 |
| --- | --- | --- |
| A：更像信息管理面板，缺少突出的学习结论 | **部分成立** | 概览只有计数与空摘要，没有结论句；但课程视图已有口径说明，不能说完全没有解释 |
| B：两个视图结构差异大，增加理解成本 | **成立**（§1.4） | 差异包含口径与可编辑范围，不只是排版 |
| C：掌握度与复习信息缺少证据来源提示 | **成立**（§3.3） | 但这是「未展示已返回字段」，不是「没有数据」 |
| D：知识点多时页面过长 | **待验证** | 本机只有 1 个知识点。`KnowledgeSection` 在 >5 条时默认折叠，缓解了长度；但展开编辑后单行高度约 260px。原型按 6 条数据验证，不能据此断言真实用户一定遇到 |

---

## 5. 数据可信度与可用字段矩阵（按范围）

| 字段 | 全部课程 | 指定课程 | 备注 |
| --- | --- | --- | --- |
| `profile_summary` | ✅ | ❌ | 课程视图不返回 |
| `goals` | ✅ 可编辑 | ✅ 只读（仅绑定本课程） | |
| `knowledge_states` | ✅（全部，含未归类） | ✅（`course_id` 精确匹配） | 前端拼装跨课程列表被禁止 |
| `state_label` | ✅ 已返回 / 前端未声明 | ✅ | |
| `origin` / `provenance_unknown` | ✅ 已返回 / 未展示 | ✅ 已返回 / 未展示 | |
| `evidence_ids` | ✅ | ✅ | 只有 id，无明细 |
| `review_due_at` | ✅（可能缺省） | ✅（可能缺省） | 缺省 ≠ 无需复习 |
| `diagnosis` / `next_actions` | ✅ | ✅ | 模板句，可被人工改写 |
| `misconceptions` | ✅ 可编辑 | ❌ | |
| `preferences` | ✅ 可编辑 | ✅ 只读 | 全局共享 |
| `task_progress` | ❌ | ✅ | 来自 daily 快照，不是知识数据 |
| `unclassified` 计数 | ❌ | ✅ | |

---

## 6. 移动端问题（实测）

| 视口 | 现象 |
| --- | --- |
| 1440×900 | 布局正常；知识行进度条 700px、状态徽标与复习日期同排 |
| 1024×768 | 布局正常，卡片宽度收窄，统计块仍 4 列 |
| 390×844 | 进度条宽度 **0px**（固定列已占满）；课程选择器与刷新按钮各占一行；概览需滚动 |
| 320×640 | 状态徽标右边界 365px > 视口 320px，被卡片裁切；进度条 0px；目标标题换行为两行，优先级「300%」溢出到第二行 |

移动端没有横向滚动条（`scrollWidth === innerWidth`），因为溢出被卡片裁切——**这比出现滚动条更糟**，用户看不到被裁掉的状态徽标。

---

## 7. 功能冻结清单（P1 冻结，P2 不得改动）

1. **课程范围唯一来源**：`coursesStore.selectedCourseId`。页面不得另存一份 `courseId` 状态（`ProfilePage` 注释与 `ProfilePage.courses.test.tsx` 都记录了这条回归）。
2. **切换课程即丢弃旧数据**：`selectCourse()` 会递增全部 ticket、中止请求、清空 `courseLearner` / `courseDaily`。不得在切换瞬间渲染上一门课程的数据。
3. **课程已删除/归档**：`courses` 列表刷新后若 `selectedCourseId` 不在列表内，回退到全部课程视图。
4. **离开页面清除选择**：卸载时 `selectCourse(null)`。
5. **课程范围由服务端过滤**：`GET /api/courses/:id/learner` 只返回 `knowledge.course_id === courseId` 的状态；前端**不得**自行拼接多门课程的知识状态或目标。
6. **偏好共享、按课程只读**：不得在课程视图提供偏好编辑入口。
7. **目标绑定关系由服务端持有**：课程视图的目标来自 `goal_bindings`，不得按标题或类型猜测归属。
8. **长期掌握状态的计算规则**：`state-engine.ts` 的规则版本、阈值、`REVIEW_RETRIEVABILITY_THRESHOLD` 均不修改；P2 只改「显示哪一个字段」。
9. **任务完成率 ≠ 掌握率**：两者必须继续分开显示，并保留口径说明。
10. **编辑后的语义**：`PATCH knowledge` 使状态变为 `origin: "manual"`，这是服务端行为；P2 只能如实显示，不能掩盖。
11. **`ProfilePage.courses.test.tsx` 的三条课程隔离测试**是 P2 的基线，必须继续通过。

---

## 8. 交付物索引

| 文件 | 内容 |
| --- | --- |
| `analysis.md` | 本文：现状、语义核查、可信度、移动端、冻结清单 |
| `implementation-map.md` | 原型模块 ↔ 源码 ↔ 数据 ↔ 改造类型 |
| `prototype-a.html` | 方案 A「概览优先」可交互原型（10 个场景、深浅主题、移动端） |
| `prototype-b.html` | 方案 B「知识状态优先」可交互原型（同样场景） |
| `comparison.md` | 六维对比、推荐方案、P2 拆分 |
| `assets/current-*.png` | 真实页面截图（1440 / 1440-dark / 1024 / 390 / 320 / 课程视图 / 知识区） |
| `assets/option-*.png` | 两套原型的桌面与移动端截图 |

### 截图清单

**现状（真实页面，`http://localhost:5173/?page=profile`）**

| 文件 | 内容 |
| --- | --- |
| `current-desktop.png` | 1440×900，全部课程 |
| `current-desktop-dark.png` | 1440×900，深色 |
| `current-1024.png` | 1024×768 |
| `current-mobile.png` | 390×844 |
| `current-320.png` | 320×640 |
| `current-320-knowledge.png` | 320×640，知识状态（状态徽标被裁切） |
| `current-320-preferences.png` | 320×640，学习偏好显示英文 token |
| `current-mobile-expanded.png` | 390×844，展开知识点即进入编辑态 |
| `current-course-desktop.png` | 1440×900，指定课程 |
| `current-course-mobile.png` | 390×844，指定课程 |

**方案 A**

| 文件 | 内容 |
| --- | --- |
| `option-a-desktop.png` / `option-a-desktop-dark.png` | 1440×900 全部课程，浅 / 深 |
| `option-a-mobile.png` / `option-a-mobile-detail.png` | 390×844 首屏 / 详情展开 |
| `option-a-1024.png` / `option-a-320-long.png` | 1024×768 / 320×640 长名称 |
| `option-a-detail.png` / `option-a-detail-dark.png` | 知识点详情展开，浅 / 深 |
| `option-a-editing.png` | 编辑学习摘要 |
| `option-a-empty.png` | 暂无知识证据 |
| `option-a-review.png` / `option-a-misconception.png` | 待复习 / 活跃误区 |
| `option-a-error.png` | 数据读取失败 |
| `option-a-course.png` / `option-a-course-mobile.png` | 指定课程，桌面 / 移动 |
| `option-a-desktop-scrolled.png` | 薄弱知识与目标区 |

**方案 B**

| 文件 | 内容 |
| --- | --- |
| `option-b-desktop.png` / `option-b-desktop-dark.png` | 1440×900 全部课程，浅 / 深 |
| `option-b-mobile.png` / `option-b-mobile-detail.png` / `option-b-mobile-dark.png` | 390×844 首屏 / 详情 / 深色 |
| `option-b-1024.png` / `option-b-320-long.png` | 1024×768 / 320×640 长名称 |
| `option-b-detail.png` | 知识点详情展开 |
| `option-b-editing.png` | 编辑学习摘要 |
| `option-b-empty.png` | 暂无知识证据 |
| `option-b-review.png` / `option-b-misconception.png` | 待复习 / 活跃误区 |
| `option-b-error.png` | 数据读取失败 |
| `option-b-course.png` / `option-b-course-mobile.png` | 指定课程，桌面 / 移动 |
| `option-b-desktop-scrolled.png` | 误区与偏好区 |
