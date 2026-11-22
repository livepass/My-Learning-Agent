# E4.9h-P1 源码映射：原型 → 正式代码

- **原型**：`docs/ui-redesign/phase4/prototype.html`（方案 A · 单题专注式）
- **目标**：`apps/learning-agent/web/src/react/pages/PracticePage.tsx`（1361 行）
- **原则**：本轮只设计。C1–C4 的业务协议、Store 方法签名、API 端点一律不动。

---

## 1. 直接复用（不改）

| 原型区域 | 现有实现 | 说明 |
| --- | --- | --- |
| 页面标题 + 返回按钮 | `.mla-page-head` | 结构不变，只调整文案层级 |
| 题目正文 | `.mla-practice-prompt` | `white-space: pre-wrap` + `overflow-wrap: anywhere` 已正确 |
| 技术信息折叠 | `details.mla-practice-meta` | 默认收起，保持不变 |
| 作答输入 | `Textarea variant="prose"` + 自适应高度 effect | 保持 `scrollHeight` 上限 320px 的逻辑 |
| 草稿分键 | `draftsByQuestion[sessionId::questionId::version]` | 必须原样保留 |
| 评分反馈数据 | `currentAttempt.assessment` → `learningStore.assessment` | 回退顺序不变 |
| 评价维度列表 | `assessment.criteria[]` | 数据不变，视觉分层 |
| 复习准备的数据与判定 | `reviewCheck` / `reviewIsDue` / `reviewSessionReadiness` | 全部逻辑不变 |
| 复习身份判定 | `reviewQuestionActive`（`question.review === true`） | 必须原样保留 |

---

## 2. 建议提取的展示组件

从 1361 行的单文件里拆出三个展示组件，**不新增 API、不碰 Store**：

### 2.1 `PracticeQuestionCard.tsx`

| 项 | 内容 |
| --- | --- |
| 职责 | 题目头（徽章 + 技术信息）、题目正文、提示、分隔线 |
| Props | `question`、`sourceKind`、`reviewActive`、`checkpointRevision` |
| 现有代码位置 | `PracticePage.tsx` 的 `<Card variant="practice">` 内 `question` 分支 |
| 对应原型 | `.prompt` / `.hint` / `details.meta` |

### 2.2 `PracticeAnswerPanel.tsx`

| 项 | 内容 |
| --- | --- |
| 职责 | 作答框、三步进度、提交/评分/记录按钮组、错误提示 |
| Props | `draft`、`attempt`、`isSubmitting`、`isEvaluating`、`isFinalizing`、各回调 |
| 现有代码位置 | `.mla-practice-answer` 整块 |
| 对应原型 | `.answer` / `.steps` / `.actions` |
| 新增展示逻辑 | 三步进度条（**纯展示**，状态全部来自 `attempt.stage`） |

### 2.3 `PracticeFeedback.tsx`

| 项 | 内容 |
| --- | --- |
| 职责 | 评分结果、分数、维度、反馈正文三层 |
| Props | `assessment` |
| 现有代码位置 | `.mla-practice-feedback` 整块 |
| 对应原型 | `.feedback` 三段结构 |

### 2.4 `PracticeGeneratorForm.tsx`

| 项 | 内容 |
| --- | --- |
| 职责 | 概念 / 目标 / 题型 / 允许回退 + 生成按钮 |
| Props | 与现有 `generatorForm()` 参数一致，外加 `mode: "initial" \| "continuation"` |
| 现有代码位置 | `generatorForm()` 函数 |
| 对应原型 | `#generator` |

> 这四个组件都是**纯展示**：不调用 Store，不读 URL，不发请求。所有状态与回调由 `PracticePage` 传入。

---

## 3. 继续由 `learningStore` 管理的状态

| 状态 | 字段 | 理由 |
| --- | --- | --- |
| 当前会话的学习记录 | `sessionId` / `state` | 服务端唯一权威 |
| 生成题目 | `isGenerating` / `generateError` | 与请求生命周期绑定 |
| 提交答案 | `isSubmitting` / `submitError` | 同上 |
| 评分 | `isEvaluating` / `evaluateError` / `assessment` | 同上 |
| 记录证据 | `isFinalizing` / `finalizeError` | 同上 |
| 当前尝试 | `currentAttempt`（含 `stage`） | 三步进度的唯一数据源 |

**不得**把 `attempt.stage` 复制成组件内部状态——那样会出现「本地以为已评分、服务端仍是 answer_saved」的分叉。

## 4. 继续由 `learnerStore` 管理的长期状态

| 状态 | 字段 | 约束 |
| --- | --- | --- |
| 学习档案 | `profile` | 知识点候选、可信名称 |
| 单概念建议 | `conceptRecommendation` | **仅**在 `attemptCompleted` 且 `concept_id` 匹配时展示 |
| 建议加载/错误 | `conceptRecommendationLoading/Error` | 失败时清空而非沿用旧值 |

复习准备页的到期核查是页面直接调 `getLearningRecommendations(3, conceptId)`，不经过 `learnerStore`——**保持现状**，因为它是页面级的一次性核查，不适合放进共享 Store。

---

## 5. 必须保留的复习身份规则

| 规则 | 代码位置 | 为什么不能动 |
| --- | --- | --- |
| 复习徽章只认 `question.review === true` | `reviewQuestionActive` | URL 可伪造；B2 provenance 不可伪造 |
| URL 的 `review_question_id` 只能收窄 | `reviewIntent.questionId === question.question_id` | 防止改地址把普通题变成复习题 |
| URL 指向普通题时不隐藏该题 | `reviewIntentPointsAtPlainQuestion` | 否则学习者看不到自己真实的题 |
| 每次进入复习准备都重读到期状态 | `useEffect([reviewConceptId])` | 链接可能过期；缓存会误称「需要复习」 |
| 不再到期时显示红色提示且不生成 | `reviewIsDue === false` 分支 | 任务要求「不误称需要复习」 |
| 复习题生成走 `intent: "review"` | `learningStore.generate` 调用点 | 服务端据此记录 provenance |

---

## 6. 需要新增的展示能力（无需新 API）

| 能力 | 实现方式 | 数据来源 |
| --- | --- | --- |
| 三步进度条 | 纯 CSS + `attempt.stage` 映射 | 已有字段 |
| 反馈三层结构 | 拆 `assessment` 的三个字段分别渲染 | 已有字段 |
| 出题表单默认折叠 | 本地 `useState`（UI 状态） | 无 |
| 移动端底部留白与 `scroll-margin` | CSS | 无 |
| 复习准备页去掉右侧 224px 栏 | 删除 `.mla-split`，改单列 | 无 |

以上全部是展示层改动，**不新增端点、不新增 Store 方法、不改数据结构**。

---

## 7. 实施顺序建议（P2）

1. **先拆组件**（`PracticeQuestionCard` / `PracticeAnswerPanel` / `PracticeFeedback` / `PracticeGeneratorForm`），行为完全冻结，用现有 64 项测试守护。
2. **再加三步进度条**，仍然只读 `attempt.stage`。
3. **再调反馈层次**，只改 JSX 结构与 CSS。
4. **最后处理复习准备页布局**（去掉右栏）与移动端留白。

每一步都可以独立验证，不需要一次性替换 1361 行。

---

## 8. 与既有 UI 规范的一致性

| 规范 | 原型采用 | 正式代码现状 |
| --- | --- | --- |
| 语义 token | `--inno-*` 同名变量 | 一致 |
| 卡片圆角 | 10px | `.mla-practice-card` 10px |
| 主按钮 | `--inno-primary-bg` 深色底 | 一致 |
| 徽章 | 999px 胶囊 | `Badge` 组件 |
| 阅读列宽 | 860px | `.mla-practice` max-width 860px |
| 深浅主题 | 两套 token 切换 | `themes.css` |
| 字号层级 | 13/12.5/12/11.5 | 与 `design.md` 一致 |

原型没有引入新的视觉语言，只是重新组织了现有元素的顺序与分组。

---

## 9. 明确不做的事

- 不新增「练习历史」「练习统计」等页面或接口
- 不改变 `generationMode` 三态判定
- 不改变 `after_attempt_id` 的传递条件
- 不把 `finalize` 合并进 `evaluate`
- 不在前端推断掌握度或复习到期
- 不引入新的 UI 框架或图标库
