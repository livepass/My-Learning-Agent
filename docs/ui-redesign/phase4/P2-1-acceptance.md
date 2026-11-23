# E4.9h-P2-1 验收报告：练习页展示组件拆分与业务行为冻结

- **基准**：`main` @ `82b5848b295bfff13b2d159ecfbdeb825127bf80`（PR #7 合并后）
- **工作分支**：`refactor/e49h-p2-1-practice-components`
- **结论**：**E4.9h-P2-1 增量 PASS**
- **本轮目标**：只拆展示组件，不改页面外观与业务行为。

---

## 1. 拆分前后组件职责

### 拆分前

`PracticePage.tsx` 1361 行，一个文件里包含：页面骨架、复习准备页、生成器表单、题目区、作答区、评分反馈、证据说明、长期建议、导航。

### 拆分后

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `pages/PracticePage.tsx` | 1130 | **唯一业务控制入口**：读三个 Store、判定身份与资格、发请求、管草稿、URL 与复习意图、导航 |
| `pages/practice/PracticeGeneratorForm.tsx` | 184 | 出题表单（知识点/目标/题型/回退/生成/取消/错误） |
| `pages/practice/PracticeQuestionCard.tsx` | 145 | 题目区（标题/徽章/技术信息/正文/提示），并把作答区作为 children |
| `pages/practice/PracticeAnswerPanel.tsx` | 212 | 作答框、提交、评分、重评、记录、完成态与各步错误 |
| `pages/practice/PracticeFeedback.tsx` | 45 | 评分反馈（结果/分数/维度/正文） |

`PracticePage` 减少 231 行，四个组件合计 586 行（含 Props 与注释）。

**保留在 `PracticePage` 的部分**（按任务要求本轮不拆）：复习准备页、到期核查、长期建议区、证据说明卡、页面导航。

---

## 2. 组件 Props 与回调

### `PracticeGeneratorForm`

| Props | 用途 |
| --- | --- |
| `conceptInputId` | 每个挂载实例唯一的输入 id（页面上同时可能有两个表单） |
| `concept` / `kind` / `goalId` / `allowModelFallback` | 表单当前值 |
| `concepts` / `goals` | datalist 与目标下拉的选项 |
| `generating` / `generateError` | 请求中与失败文案 |
| `canGenerate` | 服务端 `canCommitNextQuestion` 的镜像（**已含 `!isGenerating`**） |
| `conceptIsUsable` / `conceptIsSynthetic` | 可信名称规则 |
| `continuation` / `actionLabel` | 首次出题 vs 再练一道 |
| 回调 | `onConceptChange` / `onKindChange` / `onGoalChange` / `onAllowFallbackChange` / `onGenerate` / `onCancel` |

`after_attempt_id` 仍由页面决定，组件不接触。

### `PracticeQuestionCard`

`question` / `reviewActive` / `sourceLabel` / `checkpointRevision` / `loading` / `noSessionCopy` / `noRecord` / `onInit` / `initBusy` / `children`。

`children` 是作答面板——**题目与作答在同一张卡片内**，外层 `<Card variant="practice">` 仍由页面持有。

### `PracticeAnswerPanel`

`answerRef` / `answer` / `draft` / `readOnly` / `disabled` / `attempt` / `hasAttempt` / `resultLabel` / `reviewActive` / 三个 busy 标志 / 三个错误 / 六个回调 / `feedback`。

**`hasAttempt` 是独立 prop 的原因**：页面用 `checkpoint.pending_attempt_id || currentAttempt` 的并集，两者时序不同——提交后 checkpoint 先带 pending id，attempt 视图稍后才重新读取。组件若自行从 `attempt` 推导，会在那一瞬间重新放出提交按钮。这一条是拆分过程中发现并修正的真实缺陷。

### `PracticeFeedback`

只有一个 prop：`assessment`。没有状态，因为第二份分数正是「上一题结果重现」的来源。

---

## 3. 修改文件清单

| 文件 | 变化 |
| --- | --- |
| `react/pages/PracticePage.tsx` | 修改：`generatorForm()` 改为组件包装；卡片内部改为两个组件 |
| `react/pages/practice/PracticeGeneratorForm.tsx` | 新增 |
| `react/pages/practice/PracticeQuestionCard.tsx` | 新增 |
| `react/pages/practice/PracticeAnswerPanel.tsx` | 新增 |
| `react/pages/practice/PracticeFeedback.tsx` | 新增 |
| 上述四个对应的 `.test.tsx` | 新增 |
| `docs/ui-redesign/phase4/P2-1-assets/` | 新增：改造前后各 35 张截图 + 两份 `metrics.json` |
| `docs/ui-redesign/phase4/P2-1-acceptance.md` | 新增 |

**未修改**：`learning-store.ts`、`learner-store.ts`、`sessions-store.ts`、`api/learning.ts`、后端、`shell.css`、导航、i18n 文案、其他页面。`PracticePage.test.tsx` 一个字符都没改。

---

## 4. C1–C4 业务冻结检查

| 规则 | 证据 |
| --- | --- |
| **C1** 没有会话不能生成 | `canGenerate` 含 `Boolean(currentSessionId)`；页面测试通过 |
| C1 没有记录不自动初始化 | 卡片渲染显式「初始化学习记录」按钮；`PracticeQuestionCard.test` T「offers an explicit initialise action」 |
| C1 允许回退 ≠ 实际来源 | 来源徽章由 `sourceLabel`（服务端 `knowledge.kind`）决定，组件不读回退开关 |
| C1 生成失败保留错误 | `PracticeGeneratorForm.test` T03 |
| **C2** 提交是独立操作 | `PracticeAnswerPanel.test`「enables submit once there is a draft, and does not evaluate」 |
| C2 评分失败不丢答案 | T10：`readOnly` 时答案仍是服务端值，重试按钮独立 |
| C2 不显示上一题评分 | 页面把 `currentAttempt` 按题目过滤后传入；`PracticePage.test.tsx` 的 B 题不继承 A 题用例通过 |
| **C3** 评分后仍需显式记录 | T12：`stage=evaluated` 时仍有「记录本次学习结果」 |
| C3 记录失败不显示完成 | T「surfaces each step's own error」 |
| **C4** 续题需合法完成 | `generationMode` 判定完全留在页面 |
| C4 新题不继承答案/评分 | 页面在生成成功后清空 attempt 与 draft；页面测试覆盖 |

---

## 5. 到期复习身份与并发保护

| 检查 | 状态 |
| --- | --- |
| URL 只表示复习意图 | 未改：`reviewIntentFromLocation` + `parseReviewIntent` 仍在页面 |
| 进入时重新核查到期 | 未改：`useEffect([reviewConceptId])` |
| 不再到期不生成 | 未改：`reviewIsDue === false` 分支 |
| 复习身份由服务端 `question.review` 决定 | 未改：`reviewQuestionActive` 仍在页面，只把布尔值传给卡片 |
| 切换会话/知识点后旧结果不污染 | 未改：`reviewTicketRef` 与 `learningStore` 的 ticket 机制 |
| 只有证据记录成功才提示已记录 | 未改：`attemptCompleted` 来自服务端 `stage` |

复习准备页整体保留在 `PracticePage`，本轮没有触碰。

---

## 6. 定向测试结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run PracticePage.test.tsx` | **64 / 64 通过**（与拆分前基线一致） |
| `npx vitest run pages/practice/` | **43 / 43 通过**（4 个新文件） |
| `npx vitest run learning-store.test.ts` | 通过 |
| 定向合计 | **107 项通过** |

> 任务提到「62 个 `it(...)`」，实际执行为 **64 项**；以 Vitest 输出为准。没有删除、跳过或放宽任何用例。

### 新增组件测试覆盖（对应任务 T01–T16）

| 编号 | 覆盖位置 |
| --- | --- |
| T01 表单回传值 | `PracticeGeneratorForm` T01 |
| T02 生成中禁用 | T02 |
| T03 生成失败 | T03 |
| T04 题目来源 | `PracticeQuestionCard` T04 |
| T05 复习徽章 | T05 |
| T06 技术信息折叠 | T06 |
| T07 未提交可编辑 | `PracticeAnswerPanel` T07 |
| T08 已提交只读 | T08 |
| T09 评分前无结果 | T09（在 T08 内断言） |
| T10 评分失败保留答案 | T10 |
| T11 评分成功展示分数与维度 | `PracticeFeedback` T11 |
| T12 已评分未记录 | T12 |
| T13 已记录完成态 | T13 |
| T14 切换后无旧答案/评分 | 页面测试既有用例 + 组件 `hasAttempt` 契约 |
| T15 中英文 | 四个组件各有英文用例 |
| T16 深浅主题 | 样式未改，由第 8 节视觉对比覆盖 |

---

## 7. 构建与全量测试

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |
| `npx vitest run --maxWorkers=4` | 见下方 |

**基线对照**：本轮拆分前的 `main`（`82b5848`）在 `--maxWorkers=4` 下为 190 文件 / 2071 通过 / 1 失败 / 3 跳过。唯一失败是 `server.e48-workbench.test.ts` 的 `providerCalls` 断言，自 P2-2-R1 起在 `853d470` 即可复现，与本轮无关。

本轮新增 4 个测试文件（43 项），用例总数应为 2071 + 43 = 2114 通过。

### 7.1 本轮全量执行（实测）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4` | **194 文件 / 2114 通过 / 1 失败 / 3 跳过**（2118 项） |

与基线对照：

| 轮次 | 文件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 拆分前（`main` @ `82b5848`） | 190 | 2071 | 1 | 3 |
| 拆分后（本轮） | 194 | **2114** | 1 | 3 |

差值正好是新增的 4 个测试文件与 43 项用例（2071 + 43 = 2114），**没有吞掉任何既有用例**。

唯一失败仍是 `server.e48-workbench.test.ts` 的 `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2），自 P2-2-R1 起在 `853d470` 即可复现。本轮未修改该后端测试。

**没有新增确定性失败。**

---

## 8. 视觉冻结验收

真实 React 页面 + 真实服务端（隔离数据目录 + 桩 provider 返回结构化题目/评分），**不是** `prototype.html`。

### 方法

同一脚本跑两遍：一遍在拆分后的代码上，一遍 `git checkout` 回 `main` 的 `PracticePage.tsx` 后重跑。两套各 35 个状态 = 7 个页面状态 × 5 个视口。

| 视口 | 状态 |
| --- | --- |
| 1440 × 900 / 1024 × 768 / 900 × 800 / 390 × 844 / 320 × 640 | 可以出题、等待作答、已提交、评分成功、证据已记录、复习准备、复习不再到期 |

### 结果

| 比较项 | 差异数 |
| --- | ---: |
| 横向溢出 | 0 |
| `.mla-practice-card` 数量 | 0 |
| 嵌套卡片数量（必须为 0） | 0 |
| 底部导航可见性 | 0 |
| CSS 类名计数（head/tags/meta/divider/answer/submit/status） | 0 |
| 几何位置（card/prompt/submit/feedback） | 0 |
| **合计 35 个状态 × 7 类指标** | **0 差异** |

### 重点确认

| 检查 | 结果 |
| --- | --- |
| 题目与答案仍在同一卡片 | 是（`PracticeQuestionCard` 用 children 承载作答面板） |
| 现有 CSS 类名与 DOM 结构兼容 | 是（7 类类名计数全部一致） |
| 文本换行一致 | 是（几何尺寸一致） |
| 作答框高度行为不变 | 是（`answerRef` 仍由页面持有，自适应 effect 未动） |
| 按钮位置无明显移动 | 是（submit 几何一致） |
| 无新增横向溢出 | 是（5 档全部 0） |
| 移动端不被底部导航遮挡 | 是 |
| 深浅主题正常 | 是（截图含深色） |

截图：`P2-1-assets/before/` 与 `P2-1-assets/after/` 各 35 张 + `metrics.json`。

---

## 9. 已知问题

1. **`server.e48-workbench` 基线失败**仍然存在，与前端无关，本轮未修改。
2. **桩 provider 需要按请求返回 JSON**：出题与评分走结构化输出，纯文本桩会报「模型输出不是单个对象」。本轮把测试桩扩展为按请求内容返回题目/评分 JSON，只影响验收脚本，不影响产品。
3. **`POST /learning` 幂等**：视觉脚本不能用它「重置」检查点，因此每个状态改用新会话。这是产品的正确行为，脚本据此调整。
4. **拆分过程中出现并修正的一处回归**：`PracticeAnswerPanel` 最初自行从 `attempt` 推导「是否已提交」，导致提交后 attempt 视图未刷新的瞬间重新放出提交按钮，3 个页面测试失败。改为由页面传入 `hasAttempt`（`pending_attempt_id || currentAttempt` 的并集）后恢复。

---

## 10. 下一步建议

- **P2-2**：在 `PracticeAnswerPanel` 内加入「提交 → AI 评分 → 记录证据」三步进度条。数据源已经就位（`attempt.stage`），组件边界清晰。
- **P2-3**：调整 `PracticeFeedback` 的三层视觉层次（结果/维度/正文），只需改该组件与其样式。
- 复习准备页与长期建议区尚未拆分，可在 P2-2/P2-3 之后再评估是否需要独立组件。

---

## 11. Git

- 提交到 `refactor/e49h-p2-1-practice-components`
- 未合并 `main`

### PASS 判定

| 条件 | 结果 |
| --- | --- |
| 四个展示组件提取完成 | 是 |
| `PracticePage` 仍是唯一业务控制入口 | 是（新组件无 Store/API/navigate 调用） |
| 不新增 Store 和 API | 是 |
| C1–C4 行为保持一致 | 是（64 项页面测试全通过） |
| 复习身份与到期核查不变 | 是（相关代码未动） |
| 会话、题目、答案、评分不互相污染 | 是 |
| 原有页面用例无回归 | 是（64/64） |
| 新增组件测试通过 | 是（43/43） |
| TypeScript 和构建通过 | 是 |
| 无新增确定性测试失败 | 是（唯一失败为基线） |
| 页面外观与响应式布局保持一致 | 是（35 状态 × 7 指标，0 差异） |
| 验收报告完整 | 是 |

**结论：E4.9h-P2-1 增量 PASS。** 可以启动 P2-2。
