# E4.9h-P2-3 验收报告：评分反馈三层视觉优化

- **基准分支**：`main`
- **基准 SHA**：`8f361c5b182fcf6259be612f4283f37863e9a94f`（PR #9 合并后，与任务给定一致）
- **工作分支**：`feat/e49h-p2-3-practice-feedback`
- **最终提交**：见第 12 节与 PR
- **方案**：继续 P1 的「单题专注式」，反馈仍属于题目与作答所在的同一张卡片
- **结论**：**E4.9h-P2-3 增量 PASS**

---

## 1. 基准与最终 SHA

| 项 | 值 |
| --- | --- |
| 远端 `main` | `8f361c5b182fcf6259be612f4283f37863e9a94f` |
| PR #9（P2-2） | 已合并，`PracticeProgress.tsx` 存在 |
| 起点工作区 | 干净（无未提交修改，未做任何重置） |
| 基线定向测试 | 6 文件 / 146 项全部通过（practice/ + PracticePage） |

---

## 2. 目标与实际完成内容

| 目标 | 实际 |
| --- | --- |
| 第一层：结果 + 得分 | `PracticeFeedback` 顶部一行：`评分反馈` + 结果徽章（按 `result` 映射 tone）+ `得分 N / 100` |
| 第二层：评价维度 | 新增「评价维度」区，按服务端 `criteria` 顺序逐条展示 `criterion_id`、judgment 文案与 `explanation`，以分隔线列表呈现，无嵌套卡片 |
| 第三层：AI 反馈 | 新增「AI 反馈」区，`assessment.feedback` 原样渲染（`white-space: pre-wrap`，不截断） |
| 无法判定 | 结果徽章「无法判定」+ 独立「无法判定的原因」区块，不显示分数，不显示为答错 |
| 消除重复结果标签 | 删除 `PracticeAnswerPanel` 的 `resultLabel` 徽章与 Prop，以及页面中生成它的代码；同一次评分只显示一份结果标签 |
| 保留 P2-2 与所有操作 | 三步进度、提交/评分/记录/查看档案按钮全部保留；`PracticeProgress` 零改动 |
| 复习与普通练习一致 | 同一组件、同一映射，未区分 |

**未做**：未引入新的评分算法、分数归一化、掌握度推断，也未新增任何页面。

---

## 3. 修改文件清单

| 文件 | 变化 |
| --- | --- |
| `react/pages/practice/PracticeFeedback.tsx` | 重构为三层结构；结果 tone 映射；judgment 文案/图标/tone 映射 |
| `react/pages/practice/PracticeFeedback.test.tsx` | 重写为 20 项，覆盖 T01–T15 |
| `react/pages/practice/PracticeAnswerPanel.tsx` | 移除重复结果徽章与 `resultLabel` Prop |
| `react/pages/practice/PracticeAnswerPanel.test.tsx` | 移除 `resultLabel` 用法，断言改为「面板不再显示结果标签」 |
| `react/pages/PracticePage.tsx` | 删除已无用的 `resultLabel` 计算与传参（仅展示层） |
| `react/pages/PracticePage.test.tsx` | 新增 6 项（T16–T20 + unknown）；`afterEach` 恢复中文，避免英文用例污染后续断言 |
| `react/shell/shell.css` | 新增 `.mla-practice-feedback-*` / `.mla-practice-criterion-*` 与 480px 响应式 |
| `i18n/locales/zh-CN.json` / `en.json` | 新增 `criteriaTitle` / `aiFeedbackTitle` / `judgment.*` / `unknownReasonLabel` |
| `docs/ui-redesign/phase4/P2-3-assets/` | 新增：79 张真实截图 + `metrics.json` |
| `docs/ui-redesign/phase4/P2-3-acceptance.md` | 新增（本文） |

**未修改**：`learning-store.ts`、`learner-store.ts`、`sessions-store.ts`、`api/learning.ts`、后端、数据库与记忆结构、出题/评分/记录写入、复习调度、全局导航、`PracticeProgress.tsx`。未新增依赖。

---

## 4. 改造前后评分反馈结构对比

**改造前**：一个浅色块内依次是标题、反馈正文、无法判定原因、分数、维度列表；主次不清，分数在正文之后，结果徽章在作答标题旁。

**改造后**（三层，自上而下）：

1. **概览行** — `评分反馈` · 结果徽章（success/warning/danger/neutral）· `得分 N / 100`（右对齐）
2. **无法判定原因**（仅 `unknown_reason` 存在时）— 弱警示底色的独立区块
3. **评价维度** — 标题 + 分隔线列表，每行：状态图标 + `criterion_id`（等宽）+ 状态词 + 解释
4. **AI 反馈** — 标题 + 原文（`pre-wrap`）

DOM 仍是 `PracticeFeedback` 内的一个 `section`，外层题目卡不变，无新增卡片容器。

---

## 5. 结果、分数与判断状态映射表

### 评分结果（`assessment.result` → `practice.result.*` + Badge tone）

| 服务端 | 中文 | 英文 | tone |
| --- | --- | --- | --- |
| `correct` | 答对 | Correct | `success` |
| `partial` | 部分答对 | Partially correct | `warning` |
| `incorrect` | 答错 | Incorrect | `danger` |
| `unknown` | 无法判定 | Can't be judged | `neutral` |

### 评价维度（`judgment` → 文案 + 图标 + tone）

| 服务端 | 中文 | 英文 | 图标 | tone |
| --- | --- | --- | --- | --- |
| `met` | 已满足 | Met | Check | success |
| `partially_met` | 部分满足 | Partially met | Minus | warning |
| `not_met` | 未满足 | Not met | X | danger |
| `unknown` | 未判定 | Not judged | CircleDashed | neutral |

### 分数

| 输入 | 展示 |
| --- | --- |
| `score: 0` | `得分 0 / 100`（`typeof === "number"`，不被假值隐藏） |
| `score: 1` | `得分 100 / 100` |
| `score: 0.75` | `得分 75 / 100`（`Math.round`） |
| `score: undefined` | 不渲染分数行，不填 0 |
| `result: unknown` | 服务端不下发分数，界面不显示分数 |

> 分数行使用既有 `practice.evaluate.score` 键格式化，中英文都读作一句话；组件不做任何重新评分。

---

## 6. 数据来源与业务冻结检查

| 规则 | 证据 |
| --- | --- |
| `shownAssessment` 来源不变 | `PracticePage.tsx` 中 `isCurrentSession ? (currentAttempt?.assessment ?? learning.assessment) : null` 一字未改 |
| 上一题评分不外溢 | 页面测试 T17：新题 `feedback` 块为 `null`，无「A 的评分反馈」、无「答对」、无分数 |
| 其他会话评分不外溢 | 页面测试 T18：切到 B 后 `feedback` 块为 `null` |
| `PracticeFeedback` 仍是纯展示 | 只接收 `assessment`；无 Store、API、URL、状态或持久化 |
| P2-2 三步进度无回归 | `PracticeProgress.tsx` 未改；页面 T19/T20 断言进度仍为「待记录」→「证据已记录」 |
| 提交/评分/记录仍独立 | T19 显示反馈同时仍保留「记录本次学习结果」；T20 记录后反馈仍在且出现档案入口 |
| `unknown` 不等于答错 | 组件 T05 与页面 unknown 用例：显示「无法判定」、无分数、有原因 |
| 不重算 judgment | 直接读 `item.judgment`；无前端规则推导 |
| 不推断掌握度 | 无任何掌握度/长期状态字段或文案 |
| 不篡改 `criterion_id` | 原样渲染，等宽显示，未替换为自然语言名称 |

---

## 7. T01–T20 覆盖情况

| 编号 | 场景 | 覆盖位置 |
| --- | --- | --- |
| T01 | 无 assessment | `PracticeFeedback` T01 |
| T02 | correct | 组件 T02；页面 correct 场景截图 |
| T03 | partial | 组件 T03；页面 partial 场景 |
| T04 | incorrect | 组件 T04；页面 incorrect 场景 |
| T05 | unknown | 组件 T05；页面 unknown 用例 |
| T06 | score=0 | 组件 T06；页面 incorrect-zero 场景 |
| T07 | score=1 | 组件 T07 |
| T08 | score 缺失 | 组件 T08 |
| T09 | 多个 criteria | 组件 T09 |
| T10 | 四种 judgment | 组件 T10（中）+ 英文用例（英）；浏览器长场景含三种 |
| T11 | criteria 为空 | 组件 T11 |
| T12 | unknown_reason | 组件 T12；页面 unknown 用例 |
| T13 | 长反馈正文 | 组件 T13；浏览器 long 场景（2240 字符） |
| T14 | 超长 criterion_id | 组件 T14；浏览器 long 场景（57 字符 id，320px 无溢出） |
| T15 | 英文界面 | 组件 T15 与英文 judgment 用例；浏览器 `-en` 截图 |
| T16 | 结果徽章不重复 | 页面 T16（`getAllByText("部分答对")` 长度 1）；浏览器 `duplicateResultLabels` 为空 |
| T17 | 新题不继承评分 | 页面 T17 |
| T18 | 会话切换不继承反馈 | 页面 T18 |
| T19 | 已评分未记录 | 页面 T19 |
| T20 | 已完成 | 页面 T20 |

> 「空评价维度」（criteria=[]）无法由真实 C2 端点产生：服务端要求判定条数等于 rubric 条数。该分支由组件 T11 确定性覆盖，浏览器侧不构造。

---

## 8. TypeScript 与构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build`（server + web） | 通过 |

---

## 9. 全量测试与 P2-2 基线对照

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4` | **194 文件通过 / 1 失败；2172 通过 / 1 失败 / 3 跳过** |

| 轮次 | 文件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| P2-2 基线 | 194 | 2153 | 1 | 3 |
| P2-3 本轮 | 194 | **2172** | 1 | 3 |

差值 +19 恰为本轮新增用例（`PracticeFeedback` +13、`PracticePage` +6），**没有删除或跳过任何既有用例**。

**唯一失败**仍是基线既有：`apps/learning-agent/src/server.e48-workbench.test.ts` 的 `providerCalls` 断言（期望 1 实得 2）。本轮未修改后端测试，不将其描述为通过。

---

## 10. 真实浏览器截图与响应式数据

真实 React 页面 + 真实服务端（隔离数据目录 + 桩 provider），每个反馈状态都由真实 C2 端点产生，不是静态原型。

### 方法

- 5 视口（1440×900 / 1024×768 / 900×800 / 390×844 / 320×640）× 浅色/深色 × 8 个场景 = 80 次；其中 `correct` 与 `unknown` 另加英文 2 视口。
- 场景：correct、partial、incorrect（0 分）、unknown、long（长文本 + 长 id）、已评分未记录、证据已记录。
- 每次记录：概览文本、分数、每维度 id/状态/解释长度、正文长度与 `white-space`、结果徽章数量、进度文本、可用按钮、横向溢出、卡片数、控制台错误。

### 结果

| 指标 | 结果 |
| --- | --- |
| 捕获数 | 74（含 4 张英文） |
| 横向溢出 | **0**（5 视口全部 `scrollWidth <= innerWidth`） |
| 结果徽章重复 | **0** |
| 缺失反馈 | **0** |
| `.mla-practice-card` 数量 | 恒为 **1** |
| 反馈块内嵌套卡片 | **0** |
| 控制台错误 / 页面异常 | **0** |
| 长正文保留 | 2240 字符完整渲染，`white-space: pre-wrap` |
| 320px 概览换行 | 分数行落到第二行（`headH` 52px vs 24px），无溢出 |

### 重点确认

| 检查 | 结果 |
| --- | --- |
| 三层清晰 | 是（概览 → 评价维度 → AI 反馈） |
| 320px 自动换行 | 是（分数换行，长 id 折行） |
| 长文本不截断 | 是（2240 字符全文） |
| 深浅主题可读 | 是（各场景两种主题） |
| 中英文无异常 | 是 |
| 题目与作答同卡 | 是（卡片数恒为 1） |
| 无嵌套卡片 | 是 |
| P2-2 进度正确 | 是（已评分→「待记录」；已记录→「证据已记录」） |
| 记录按钮可用 | 是（已评分未记录场景可用） |
| 无重复结果标签 | 是 |
| 无上一题评分残留 | 是（页面测试 T17/T18） |

截图：`P2-3-assets/`（`<宽>x<高>-<主题>-<场景>.png`，另有 `-scrolled` 特写），指标：`P2-3-assets/metrics.json`。

---

## 11. 遗留问题与已知限制

1. **`server.e48-workbench` 基线失败**仍在，与前端无关，本轮未改。
2. **空评价维度无法在浏览器构造**：服务端要求每条 rubric 都被判定，`criteria=[]` 会被拒绝。该分支由组件 T11 覆盖；页面层不会出现空列表。
3. **`unknown` 也带三条「未判定」维度**：真实服务端在 `unknown` 时仍要求逐条判定，因此界面会同时显示「无法判定」与三条「未判定」；这是服务端语义，前端如实展示，未合并或隐藏。
4. **英文场景的 AI 正文仍是桩返回的中文**：桩 provider 的反馈文本为中文，英文界面只翻译界面标签；这是验收桩的数据，不是产品缺陷。真实模型的反馈语言由模型决定，组件原样展示。
5. **`active`/`pending` 等进度文案未改动**：P2-2 已冻结，本轮未触碰。

---

## 12. PASS 判定

| 条件 | 结果 |
| --- | --- |
| 三层反馈结构完成 | 是 |
| 四种评分结果展示正确 | 是 |
| 四种评价维度判断展示正确 | 是 |
| 零分、缺失分数、空维度、无法判定均正确处理 | 是 |
| AI 原始反馈未截断/篡改/重新生成 | 是 |
| 不重复展示结果徽章 | 是 |
| `PracticeFeedback` 仍是纯展示组件 | 是 |
| `shownAssessment` 来源与隔离规则不变 | 是 |
| P2-2 三步进度无回归 | 是 |
| 提交、评分、记录证据仍独立 | 是 |
| 原有业务测试全部保留 | 是 |
| 新增测试通过 | 是（组件 20、页面 6） |
| TypeScript、Web 构建、完整构建通过 | 是 |
| 无新增确定性测试失败 | 是（唯一失败为基线） |
| 目标视口与中英文、深浅主题验收通过 | 是（74 捕获，0 溢出，0 错误） |
| 验收报告和证据完整 | 是 |
| 未修改无关模块 | 是 |

**结论：E4.9h-P2-3 增量 PASS。** 本轮到此结束，不开始 P2-4。
