# E4.9i-P1 原型与源码映射

- **基准提交**：`432a43ad594c69d3236ba189a4de4ecfd0b29126`
- **原型**：`prototype-a.html`（概览优先）、`prototype-b.html`（知识状态优先）
- **本阶段**：映射与改造分级；**未改任何业务代码**

改造类型图例：

| 标记 | 含义 |
| --- | --- |
| ✅ 直接复用 | 现有组件/函数原样使用，原型只重排位置 |
| ✂️ 拆分展示组件 | 从现有大组件中抽出纯展示部分，行为不变 |
| 🎨 仅调 CSS | 结构不变，改 `shell.css` 的布局与断点 |
| 🧪 需补测试 | 新结构或新状态需要回归用例 |
| 🚧 数据暂不支持 | 接口缺字段，原型只能标注不可用 |

---

## 1. 模块映射（两套方案共用）

| 原型模块 | 数据来源 | 当前组件 / 文件 | 改造类型 | P2 说明 |
| --- | --- | --- | --- | --- |
| 页面标题 + 副标题 | 静态文案 | `ProfilePage.tsx:53-57`，`profile.page.*` | 🎨 | 副标题需按范围区分（课程视图不提供误区与摘要） |
| 课程范围选择 | `coursesStore.selectedCourseId`、`courses` | `ProfilePage.tsx:64-75` | ✅ | 保持 Select 与 store 唯一选择，不加本地状态 |
| 课程读取失败提示 | `coursesError` + `useCourseErrorText` | `ProfilePage.tsx:78-80` | ✅ | 文案已本地化 |
| 学习概览（计数 + 结论句） | `learnerStore.profile` | `SummarySection`（`LearnerProfilePanel.tsx:101-232`） | ✂️ + 🧪 | 结论句由计数派生，需单测覆盖 0 / 仅弱项 / 有误区三种分支 |
| 画像摘要（阅读 / 编辑） | `profile_summary` + `patchSummary()` | `SummarySection` 内联 | ✂️ | 现有脏缓冲、取消确认、失败保留逻辑**整体搬移**，不改语义 |
| 知识掌握情况 | `profile.knowledge_states` | `KnowledgeSection` / `KnowledgeRow`（`:660-788`） | ✂️ + 🧪 | 状态徽标改读 `state_label`；`masteryStateFor()` 删除 |
| 知识点详情展开 | 同上 | `KnowledgeRow` 展开区（`:743-785`） | ✂️ | 阅读态与编辑态分离（当前展开即编辑） |
| 薄弱知识与复习 | `knowledge_states` 过滤 | 课程视图 `CourseLearnerPanel` 的 weak 区块（`:189-213`），全部课程视图**没有** | ✂️ + 🧪 | 全部课程视图新增该区块，复用 `isWeak` 判据 |
| 学习目标 | `profile.goals` + `addGoal/patchGoal/deleteGoal` | `GoalsSection` / `GoalCard` / `GoalFormDialog`（`:259-617`） | ✅ + 🎨 | 行为不动；优先级显示需修（见 §3） |
| 误解记录 | `profile.misconceptions` + `patchMisconception` | `MisconceptionsSection` / `MisconceptionRow`（`:790-907`） | ✅ | 行为不动 |
| 学习偏好 | `profile.preferences` + `patchPreferences` | `PreferencesSection` / `ChipInput`（`:909-998`） | ✅ | 行为不动 |
| 指定课程摘要 | `courseLearner` + `courseDaily.task_progress` | `CourseLearnerPanel.tsx:85-120` | ✅ + 🎨 | 四个 fact 与口径说明保留 |
| 指定课程目标（只读） | `courseLearner.goals` | `CourseLearnerPanel.tsx:122-155` | ✅ | |
| 指定课程知识状态 | `courseLearner.knowledge_states` + `state_label` | `CourseLearnerPanel.tsx:157-187` | ✂️ | 与全部课程视图共用同一个知识行组件 |
| 未归类旧记录 | `courseLearner.unclassified` | `CourseLearnerPanel.tsx:215-225` | ✅ | |
| 数据读取失败 | `learnerStore.error` / `courseLearnerError` | `LearnerProfilePanel.tsx:1040`、`CourseLearnerPanel.tsx:80-82` | 🎨 + 🧪 | 改为独立错误卡；不填充旧数据 |
| 空状态（无知识点） | `knowledge_states.length === 0` | `KnowledgeSection` 空态（`:665-671`） | ✅ | |
| 长名称 | 无 | 现状 `truncate`（`:726`） | 🎨 | 改为换行（`overflow-wrap: anywhere`） |
| 移动端布局 | 无 | `shell.css:2088-2165` | 🎨 + 🧪 | 见 §4 断点问题 |

---

## 2. 方案差异映射

| 能力 | 方案 A | 方案 B |
| --- | --- | --- |
| 首屏第一块 | 学习概览（结论 + 4 计数 + 摘要） | 紧凑计数条 + 知识状态列表 |
| 知识行信息 | 名称 / 领域 / 状态 / 证据数 / 复习日期 | 名称 / 状态 / 来源徽标 / 领域 / 证据数 / 掌握度 / 复习日期 + 左侧状态色条 |
| 筛选 | **R1 A 原型已加入六类状态筛选**（全部 / 需要关注 / 待复习 / 存在误区 / 稳定 / 证据不足） | B 原型也有相同筛选 |
| 摘要位置 | 概览卡内 | 列表之后独立卡 |
| 弱点与下一步 | 独立「薄弱知识与复习」卡（含「去练习」） | 合并进知识行详情 |
| 课程视图 | 课程卡 → 目标 → 知识 → 薄弱 → 误区不可用 → 未归类 → 偏好只读 | 课程卡 → 计数条 → 知识 → 目标 → 误区不可用 → 摘要不可用 → 偏好只读 |
| 新增组件 | `ProfileConclusion`、`WeakKnowledgeSection` | `KnowledgeFilterBar`、`CompactCountStrip` |
| 触及的现有组件 | `LearnerProfilePanel` 拆分较多 | `LearnerProfilePanel` 拆分更多（摘要下移） |

---

## 3. 必须一并修掉的显示缺陷（两方案共同）

| 缺陷 | 位置 | 修法 | 依据 |
| --- | --- | --- | --- |
| 「待复习」一词三种含义 | `profile.knowledge.masteryState.needsReview`、`course.state.review_due`、概览 `dueReviews` | 概览分类改名为「待复习状态知识点」（`state_label` 计数），**不得**冒充服务端正式「已到期」数；知识行状态只用 `state_label` | analysis §2.4、§9.1 |
| 同一知识点两视图状态不一致 | `masteryStateFor()` | 全部课程视图改用 `state_label`，删除 `masteryStateFor` 与三个 i18n 键 | analysis §2.2 |
| 证据数被高估 | `evidence_ids.length` | 文案改「证据标识 N 个」，详情注明镜像重复；不做前端去重 | analysis §3.2 |
| 可信度不可见 | 未渲染 `origin` / `provenance_unknown` | 详情显示「系统推导 / 人工维护 / 来源不明」徽标 | analysis §3.3 |
| 优先级显示 300% | `(goal.priority * 100).toFixed(0)`（`:514`） | 超出 `[0,1]` 时显示「数据异常」并保留原值，不静默换算 | 实测 `priority: 3` |
| 320px 状态徽标被裁切 | `.mla-profile` 内知识行固定列（`LearnerProfilePanel.tsx:725-741`） | 窄屏改为纵向堆叠；删除固定 `w-[170px]` / `w-[42px]` / `w-[74px]` | DOM 实测徽标右边界 365 > 320 |
| 课程视图不提示缺失区块 | `CourseLearnerPanel` | 补「误区 / 摘要 当前范围不提供」说明 | analysis §1.4 |
| 偏好显示内部英文 token | `ChipInput` 直接渲染 `preferences.*` 原始值 | 加一层可选显示映射（`immediate_feedback` → 「即时反馈」），未知值原样显示 | `current-320-knowledge.png`；i18n 中无对应键 |

---

## 4. CSS 与断点

现有 `.mla-profile` 相关规则（`react/shell/shell.css:2088-2165`）在 900px 处切换内边距，但知识行内部使用**固定像素列**，因此断点对它无效——这正是 320/390 下徽标被裁的原因。

P2 建议：

```css
/* 新：知识行按容器宽度而非视口切换 */
.knowledge-row { display: grid; grid-template-columns: minmax(0,1fr) auto; }
@container (max-width: 560px) {
  .knowledge-row { grid-template-columns: minmax(0,1fr); }
}
```

- 新增 class 用语义名（如 `.mla-knowledge-*`），不复用 `w-[170px]` 之类的一次性任意值。
- 颜色全部走 `--inno-*`；原型已按 `themes.css` 的 24 个语义 token 验证浅/深两套。
- 原型使用 `container-type: inline-size` 演示，P2 落地时若目标浏览器不支持容器查询，用同一组断点的 `@media` 兜底。

---

## 5. 数据能力限制（原型中已显式标注，P2 不得绕过）

| 想展示 | 现状 | 原型处理 |
| --- | --- | --- |
| 证据明细（时间 / 题型 / 结果 / 得分） | 无接口 | 「本阶段没有证据明细接口」说明 |
| 状态推理链 | `diagnosis` 是模板句 | 原样展示，不包装成解释 |
| 课程视图误区 | `CourseLearnerView` 无该字段 | 显示「当前范围不提供」 |
| 课程视图画像摘要 | 同上 | 同上 |
| 知识点的课程名称 | 只有 `course_id` | 原型用课程列表映射；P2 需确认是否允许前端映射 |
| 前端读取 `state_label` / `course_id` | 类型未声明，接口已返回 | 补 `types/learner.ts` 两个可选字段（非新增 API 字段） |

**明确列为后续独立研发需求（不在 P2 范围）**：

1. `GET /api/learner/evidence/:id` 或批量证据摘要接口 —— 支撑证据明细。
2. 课程视图返回 `misconceptions` / `profile_summary` —— 若产品确认课程档案应包含它们。
3. 证据标识去重（服务端返回 `evidence_count` 已去重） —— 解决 `legacy_` 镜像重复。

---

## 6. P2 建议拆分

| 步骤 | 内容 | 触及文件 | 风险 |
| --- | --- | --- | --- |
| P2-1 | 语义统一：全部课程视图改读 `state_label`，停用 `masteryStateFor` 与三个旧展示状态；概览改称「待复习状态知识点」，不等于正式到期数 | `LearnerProfilePanel.tsx`、`zh-CN.json`、`en.json`、`types/learner.ts` | 中：影响现有 `LearnerProfilePanel.summary.test.tsx` 断言 |
| P2-2 | 抽出 `KnowledgeList` / `KnowledgeRow` 纯展示组件，供两个视图共用；阅读态与编辑态分离 | 新 `react/profile/KnowledgeList.tsx` | 中：需迁移现有行内编辑逻辑 |
| P2-3 | 概览结论句 + 薄弱知识区块（方案 A）或紧凑计数条 + 筛选（方案 B） | 新 `ProfileOverview.tsx` / `KnowledgeFilterBar.tsx` | 低 |
| P2-4 | 移动端：知识行纵向堆叠、断点由固定列改容器查询 | `shell.css` | 低 |
| P2-5 | 可信度徽标 + 证据标识文案 + 优先级异常提示 | `KnowledgeRow`、`GoalsSection` | 低 |
| P2-6 | 课程视图补「当前范围不提供」说明 | `CourseLearnerPanel.tsx` | 低 |
| P2-7 | 回归：`ProfilePage.courses.test.tsx` 三条课程隔离用例 + 新增状态语义用例 | 测试 | 必做 |

**不要**在 P2 一次性重写 `LearnerProfilePanel.tsx`（1054 行）。按上表逐个抽出展示组件，每一步都保持现有编辑行为与测试通过。


---

## 7. P1-R1 约束补充

- 最终选定 **方案 A + B 的六类状态筛选器**。R1 已更新 `prototype-a.html`，但尚无 R1 后新浏览器截图与互动验收证据，不能引用旧 42 张图片证明新增筛选已通过。
- 知识状态与正式复习资格边界：`state_label` 决定分类标签；`review_due_at` 是日期；课程 `courseDaily.knowledge.due_reviews` 使用 `daily-plan.ts:reviewable`，要求证据、来源、可信度和有效到期时间。P2 不得新增独立前端资格算法。
- 「跨视图同一知识点冲突」目前源自真实档案字段 + 两套渲染逻辑核查，不是两张同时可见该知识点的截图复现。
- P2 开始前先合并 P1 文档 PR，再执行 P2-1 语义统一；组件拆分和 CSS 布局仍按原 P2-2 以后分阶段实施。
