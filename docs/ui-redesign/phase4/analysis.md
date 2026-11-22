# E4.9h-P1 现状分析：练习与反馈

- **基准**：`main` @ `1f60153723bead690f236d6ba82812146c1ee8a1`
- **分析对象**：`PracticePage.tsx`（1361 行）、`learning-store.ts`（699 行）、`learner-store.ts`（218 行）、`api/learning.ts`（280 行）、`utils/review-intent.ts`、`utils/review-eligibility.ts`
- **本阶段不改代码**：以下全部是现状描述与设计判断。

---

## 1. 现有功能清单

### 1.1 页面形态

`PracticePage` 有两个互斥形态，由 URL 与业务状态共同决定：

| 形态 | 触发条件 | 主体内容 |
| --- | --- | --- |
| **复习准备**（`reviewPrepMode`） | URL 带 `intent=review&review_concept_id=…`，且服务端尚未保存复习题 | 概念确认、到期核查、会话选择、生成按钮 + 右侧两段说明 |
| **普通练习** | 其余情况 | 单卡片：题目 → 分隔线 → 作答 → 提交/评分/记录 → 反馈 |

普通练习内部还有 `generationMode`（`initial` / `continuation` / `null`），决定是否展示「再练一道」表单。

### 1.2 业务操作

| 操作 | Store 方法 | 服务端接口 | 前置条件 |
| --- | --- | --- | --- |
| 读取学习状态 | `learningStore.load` | `GET /learning` | 有当前会话 |
| 初始化学习记录 | `learningStore.init` | `POST /learning` | 显式点击；`exists=false` |
| 生成题目 | `learningStore.generate` | `POST /learning/questions/generate` | `generationMode !== null` |
| 提交答案 | `learningStore.submitAnswer` | `POST /learning/attempts` | `step === "awaiting_answer"` 且无已有 attempt |
| 评分 | `learningStore.evaluateAnswer` | `POST /attempts/:id/evaluate` | `pending_attempt_id` 存在 |
| 记录证据 | `learningStore.finalizeAttempt` | `POST /attempts/:id/finalize` | `stage === "evaluated"` |
| 暂停 / 继续 | `learningStore.pause/resume` | `POST /learning/pause|resume` | 检查点状态允许 |
| 长期建议 | `learnerStore.loadConceptRecommendation` | `GET /learner/recommendations?concept_id=` | 证据记录完成后 |
| 复习到期核查 | 直接调 `getLearningRecommendations(3, conceptId)` | 同上 | 进入复习准备时 |

### 1.3 页面状态（完整枚举）

```
无当前会话                 → 提示「选择课程并开始一段学习对话」
读取中                     → 加载态
读取失败                   → 错误 + 重试
无学习记录（exists=false）  → 显式「初始化学习记录」按钮
有记录、无题目、step=conversation → 出题表单（概念 / 目标 / 题型 / 允许回退）
生成中                     → 按钮 spinner + 禁用表单
生成失败                   → 错误文案（服务端 message 优先）
有题目、step=awaiting_answer → 题目 + 输入框 + 提交
提交中                     → 按钮 spinner
提交失败                   → 错误提示，草稿保留
已提交、stage=answer_saved → 「开始评分」
评分中                     → 「评分中」
评分失败、retryable=true    → 「重新评分」+ 失败原因
评分失败、retryable=false   → 不可重试提示
已评分、stage=evaluated    → 分数 + 反馈 + 评价维度 + 「记录学习证据」
记录中                     → 「记录中」
记录失败                   → 错误提示，可重试
已完成、stage=completed    → 「已记录」+ 查看学习档案 + 再练一道
```

---

## 2. 数据来源表

| 展示内容 | 来源 | 关键约束 |
| --- | --- | --- |
| 题目正文 `prompt` | `checkpoint.question` → `state.questions[]` | 原样渲染，`white-space: pre-wrap`，不重排 |
| 题型 / 来源徽章 | `question.kind` / `checkpoint.knowledge.kind` | 仅类型，不含原文 |
| 技术身份（ID / 版本 / 修订） | `details` 折叠 | 默认收起 |
| 作答输入 | `draftsByQuestion[sessionId::questionId::version]` | 按「会话 + 题目身份」分键 |
| 已提交答案 | `currentAttempt.answer` | 服务端持久值，只读 |
| 评分结果 | `currentAttempt.assessment`，回退 `learningStore.assessment` | 含 `result` / `score` / `feedback` / `criteria` |
| 评分失败原因 | `currentAttempt.failure.message` | 仅在未评分时展示 |
| 长期建议 | `learnerStore.conceptRecommendation` | **仅** `attemptCompleted` 且概念匹配时展示 |
| 知识点候选 | `learnerStore.profile.knowledge_states` | 用于 datalist 与可信名称 |
| 会话列表（复习） | `sessionsStore.sessions` | 全部会话 |
| 到期状态 | `getLearningRecommendations` 的 `reason_code` | `review_due` 或 `also_matches` 含 `review_due` |
| 复习题身份 | `question.review === true`（服务端 B2 保存） | URL 只能收窄，不能提升 |

---

## 3. 业务流程

### 3.1 普通练习

```
学习会话（/learn 已建立会话）
   ↓
进入练习页 → GET /learning
   ↓
exists=false → 显式「初始化学习记录」→ POST /learning
   ↓
step=conversation 且无题目 → 出题表单（概念必填，题型可选）
   ↓
POST /questions/generate → 服务端保存题目，step=awaiting_answer
   ↓
作答 → 提交 → POST /attempts（保存答案，step 仍为 awaiting_answer，pending_attempt_id 出现）
   ↓
「开始评分」→ POST /evaluate → stage=evaluated（分数与反馈）
   ↓
「记录学习证据」→ POST /finalize → stage=completed，L1 profile 更新
   ↓
再练一道（continuation，需带 after_attempt_id）或 查看学习档案
```

**四个必须保留的区分**：

1. **提交 ≠ 已评分**：提交后按钮变为「开始评分」，`pending_action` 为 `evaluate`。
2. **已评分 ≠ 已记录证据**：`stage=evaluated` 时仍有独立的「记录学习证据」按钮，`evidence` 卡片徽章为「待记录」。
3. **一次分数 ≠ 长期掌握**：分数来自本次 attempt；长期状态只在 `finalize` 之后由 `learnerStore` 重新读取。
4. **新题不继承旧结果**：`currentAttempt` 按题目身份过滤，`last_completed_attempt_id` 刻意不参与「是否已回答」的判断。

### 3.2 到期复习

```
今日学习 / 学习档案 → 点击复习 → navigate("practice", { intent: review, review_concept_id, session })
   ↓
进入复习准备（reviewPrepMode）
   ↓
GET /learner/recommendations?concept_id=… → 核查是否仍到期
   ├─ 不再到期 → 「该知识点当前不需要复习」（红色提示，不生成）
   ├─ 读取失败 → 503 专属文案 / 通用失败文案
   └─ 仍到期   → 显示到期日与证据数
   ↓
确认概念名称（profile 有可信名则直接显示，否则需手动输入 + 勾选确认）
   ↓
选择会话（需 ready：无题目且 step=conversation，或已完成的 feedback）
   ↓
生成复习题 → POST /questions/generate（intent: "review"）
   ↓
服务端在 B2 记录 provenance → 返回 question.review === true
   ↓
作答 → 评分 → 记录复习证据（同普通练习）
```

**复习身份的权威来源**：`question.review === true`，来自服务端持久化的题目。URL 里的 `review_question_id` 只能用来「收窄匹配」——如果它指向一个普通题，页面仍按普通题渲染，不会因为改了地址就变成复习。

---

## 4. 问题分析

### 4.1 结构问题

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| 单文件 1361 行，含两种页面形态、一个生成器表单、复习准备的全部逻辑 | `PracticePage.tsx` | 与 P2-1 之前的 `LearnPage` 同类问题；任何 UI 调整都要在一个巨型文件里定位 |
| 复习准备与普通练习共用一套 `mla-page-head` + `mla-split` 布局 | 页面顶部 | 两种形态的头部信息密度差异大，但外观一致，切换时缺少「模式」的视觉信号 |
| 生成器表单被复用于「首次出题」与「再练一道」 | `generatorForm()` | 好设计，但表单字段（概念/目标/题型/回退）一次全展开，首次使用有压力 |
| 证据卡片与建议卡片各占一张卡 | 主列下方 | 完成一次练习后纵向堆 4–5 张卡，信息层级被拉平 |

### 4.2 交互问题

| 问题 | 现状 | 影响 |
| --- | --- | --- |
| 「提交答案」后没有明显的状态跃迁 | 按钮原地换成「开始评分」 | 学习者可能以为提交即完成评分 |
| 评分与记录是两个按钮，中间没有进度感 | 「已评分」+「记录学习证据」并列 | 容易漏掉最后一步，导致证据未记录 |
| 反馈与评价维度挤在同一个灰底块 | `mla-practice-feedback` | 长反馈时分数、维度、正文混在一起 |
| 复习准备页右侧两段说明占 224px | `mla-rail` | 在 1024px 下挤压主表单 |

### 4.3 响应式现状

- `.mla-practice` 最大宽 860px，居中。
- `.mla-split` 在 1024px 以下仍是 `1fr + 224px`，没有断点降级。
- 复习准备页在手机上右侧栏仍在文档流中，排在表单下方。
- 题目 `white-space: pre-wrap` + `overflow-wrap: anywhere`，长文本不会横向溢出（已正确）。

### 4.4 已做对的部分（必须保留）

- 单卡片承载「题目 → 作答 → 反馈」，题目不会在作答时滚出视野。
- 技术 ID 折叠在 `details` 里。
- 草稿按「会话 + 题目身份」分键，切题不串稿。
- 复习身份以服务端题目为准，URL 只能收窄。
- 证据记录后才读长期建议，且按 `concept_id` 精确匹配。

---

## 5. 可改造与不可改造边界

### 可以改造（展示层）

- 页面骨架、卡片分组、间距、字号、徽章位置
- 出题表单的展开方式（默认折叠 vs 全展开）
- 反馈区的层次（分数 / 维度 / 正文分开表达）
- 进度提示（提交 → 评分 → 记录 三步的可见状态）
- 复习准备页的布局（右栏折叠或移除）
- 空态、加载态、错误态的措辞与视觉
- 移动端断点

### 不可改造（业务协议）

| 约束 | 原因 |
| --- | --- |
| `generationMode` 的三态判定 | 镜像服务端 `canCommitNextQuestion`；放宽会允许在中间态出题 |
| `after_attempt_id` 只在 continuation 传 | 服务端独立校验；多传会被拒 |
| 复习身份只看 `question.review` | URL 可伪造，B2 provenance 不可伪造 |
| 到期核查每次进入都重读 | 链接可能过期；缓存会导致误称「需要复习」 |
| 提交后答案只读 | 服务端已保存；再编辑会造成两份答案 |
| `finalize` 必须独立点击 | C3 协议：评分不等于记录证据 |
| 长期建议只在 `attemptCompleted` 后读 | 否则会把「本次分数」当成「长期状态」 |
| 草稿分键包含 question identity | 否则 A 题草稿会出现在 B 题 |
| 初始化只由显式点击触发 | 进入页面不能创建记录 |
