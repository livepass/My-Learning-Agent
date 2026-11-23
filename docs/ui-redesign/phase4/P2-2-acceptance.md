# E4.9h-P2-2 验收报告：提交、评分、记录证据三步进度展示

- **基准分支**：`main`
- **基准提交**：`90e12b8250073a76b2becb92ee51c088e9d83e22`（P2-1 合并后，PR #8）
- **工作分支**：`feat/e49h-p2-2-practice-progress`
- **最终提交**：见本文第 12 节与 PR
- **方案**：继续采用方案 A「单题专注式」，不改 C1–C4 业务行为
- **结论**：**E4.9h-P2-2 增量 PASS**

---

## 1. 基准与最终 Git SHA

| 项 | 值 |
| --- | --- |
| 基准 `main` | `90e12b8250073a76b2becb92ee51c088e9d83e22`（即 P2-1 的合并提交） |
| 新建分支 | `feat/e49h-p2-2-practice-progress`（从上述提交切出） |
| 本轮起点工作区 | 干净（`git status` 无改动） |
| 基线定向测试 | 5 文件 / 107 项全部通过（见第 8 节） |

---

## 2. 三步进度状态映射表

状态推导集中在纯函数 `derivePracticeProgress`（`PracticeProgress.tsx`），输入为当前题目的服务端 `stage`、页面已有的 `hasAttempt`（`pending_attempt_id || currentAttempt`）、三个请求标志与三个错误标志。

| 当前状态 | 提交答案 | AI 评分 | 记录证据 |
| --- | --- | --- | --- |
| 尚未提交 | `active`（待提交） | `pending`（待评分） | `pending`（待记录） |
| 正在提交（`isSubmitting`） | `working`（正在保存） | `pending` | `pending` |
| 已有 `pending_attempt_id`，尝试视图尚未刷新 | `done`（答案已保存） | `active` | `pending` |
| `answer_saved` | `done` | `active` | `pending` |
| `evaluating` / `isEvaluating` | `done` | `working`（评分中） | `pending` |
| `evaluation_failed` | `done` | `failed`（评分失败） | `pending` |
| `evaluated` | `done` | `done`（评分完成） | `active` |
| `evidence_recorded` | `done` | `done` | `working`（记录处理中） |
| `profile_projected` | `done` | `done` | `working`（记录处理中） |
| `isFinalizing`（学习者点击记录） | `done` | `done` | `working`（正在记录） |
| 记录失败（`finalizeError`） | `done` | `done` | `failed`（记录失败） |
| `completed` | `done`（答案已保存） | `done` | `done`（证据已记录） |

**优先级规则**：

1. 真实服务端 `stage` 优先于本地按钮标志；
2. `isSubmitting` 只能表示「正在保存」，`isEvaluating` 只能表示「评分中」，`isFinalizing` 只能表示「正在记录」，请求开始**不等于**成功；
3. `evidence_recorded` / `profile_projected` 一律显示为 `working`，**不**提前宣称完成；
4. `evaluation_failed` 即使重试耗尽仍是 `failed`，绝不显示为「评分完成」；
5. 当前步骤（`active`）只在没有失败阻塞时高亮；失败步骤之后的步骤保持中性；
6. 不使用任何本地计数器。

> `active` 与 `pending` 使用**相同文案**，只有强调色不同——「突出显示」不能被误读为「已完成」，因此完成态必须是独立的 `done`（带对勾图标）。

---

## 3. 所有阶段的完成与失败语义

| 语义 | 实现 | 证据 |
| --- | --- | --- |
| 提交 ≠ 评分 ≠ 记录 | 三个按钮保持独立，进度只读状态 | `PracticeAnswerPanel` 既有测试 + 新增 T03/T05/T06/T12 |
| 请求开始 ≠ 成功 | `working` 与 `done` 是不同状态，文案不同 | `PracticeProgress.test` T02/T05/T10 |
| 失败步骤保留可执行重试 | `failed` 只改第二步，按钮仍是「重新评分」 | T07/T08/T09 + 页面 `scored-failed` 截图 |
| 重试耗尽不开放重试 | `retryable=false` 时按钮禁用；进度仍是 `failed` | T09 + 既有「评分重试次数已用尽」用例 |
| 记录失败不显示完成 | `finalizeError` → 第三步 `failed` | T11 + 面板 T07/T11 |
| 内部阶段不提前宣称完成 | `evidence_recorded`/`profile_projected` → `working` | T12/T13 |
| 只有 `completed` 三步全绿 | 第三步 `done` 仅由 `stage === "completed"` 触发 | T14 |
| 新题不继承旧进度 | 进度完全由当前题目的 `attempt` 与 checkpoint 派生 | 页面 T15 + `new-question` 截图 |
| 会话切换不显示他人进度 | 页面把 `currentAttempt` 按会话过滤后传入 | 页面 T16 |
| 复习与普通练习同一语义 | 同一组件、同一映射，只改完成徽章文案 | 页面 T17 + 面板 T17 |
| 刷新后从服务端重建 | 无本地持久化，全部来自 `getLearningState` | 页面 T20 |

---

## 4. 组件职责及 Props

### `PracticeProgress.tsx`（新增，纯展示）

| 导出 | 说明 |
| --- | --- |
| `PracticeProgressStepState` | `"pending" \| "active" \| "working" \| "done" \| "failed"` |
| `PracticeProgressState` | `{ submit, evaluate, record }` |
| `PracticeProgressInput` | 推导输入：`stage`、`hasAttempt`、三个 busy、三个 failed |
| `derivePracticeProgress(input)` | **唯一**状态推导纯函数，可单独测试 |
| `PracticeProgress({ state, recording })` | 只渲染；`recording` 仅用于区分「正在记录 / 记录处理中」文案 |

**禁止项全部满足**：不调用 Store、不调用 API、不读 URL、不导航、不写入。组件只接收已推导的 `state`。

### `PracticeAnswerPanel.tsx`（修改）

新增逻辑仅为：调用 `derivePracticeProgress` 并在答案框与操作区之间渲染 `<PracticeProgress>`。**未新增 Props**——它已经持有 `attempt`、`hasAttempt`、三个 busy、三个错误，正好是推导所需的全部输入。页面未把 `learningStore` 传入子组件。

### `PracticePage.tsx`

**未修改**。`hasAttempt = pending_attempt_id || currentAttempt` 原样保留，没有重新引入 P2-1 修复的重复提交按钮问题。

### 文案（i18n）

新增 `practice.progress.*`：`label`、三步各自的 `name` 与 `pending/working/done/failed`，外加 `record.processing`。中英双语，变量一致（无变量）。

---

## 5. 修改文件清单

| 文件 | 变化 |
| --- | --- |
| `react/pages/practice/PracticeProgress.tsx` | 新增 |
| `react/pages/practice/PracticeProgress.test.tsx` | 新增（22 项） |
| `react/pages/practice/PracticeAnswerPanel.tsx` | 修改：引入推导与渲染进度 |
| `react/pages/practice/PracticeAnswerPanel.test.tsx` | 扩展（+9 项，共 23 项） |
| `react/pages/PracticePage.test.tsx` | 扩展（+8 项，共 72 项） |
| `react/shell/shell.css` | 新增 `.mla-practice-progress*` 规则与两档响应式 |
| `i18n/locales/zh-CN.json` / `en.json` | 新增 `practice.progress.*` |
| `docs/ui-redesign/phase4/P2-2-assets/` | 新增：102 张真实截图 + `metrics.json` |
| `docs/ui-redesign/phase4/P2-2-acceptance.md` | 新增（本文） |

**未修改**：`learning-store.ts`、`learner-store.ts`、`sessions-store.ts`、`api/learning.ts`、后端、复习身份判定、出题/续题协议、评分与证据写入机制、全局导航、其他页面、`PracticePage.tsx`。未新增依赖或状态管理框架。

---

## 6. C1–C4 业务冻结证明

| 规则 | 证据 |
| --- | --- |
| **C1** 没有会话不能生成 | 页面既有用例；本轮未改 `generationMode` |
| C1 没有记录不自动初始化 | 页面既有用例；本轮未改初始化入口 |
| C1 生成失败保留错误 | 页面既有用例 |
| **C2** 提交是独立操作 | 面板既有「enables submit… does not evaluate」+ 新增 T03 |
| C2 评分失败不丢答案 | 面板 T07/T10：`readOnly` 时答案仍是服务端值，重试独立 |
| C2 不显示上一题评分 | 页面 T15 + 既有 B 题不继承 A 题用例 |
| **C3** 评分后仍需显式记录 | 面板 T06/T12：`evaluated` 仍有「记录本次学习结果」 |
| C3 记录失败不显示完成 | 面板 T07/T11：第三步 `failed`，不出现「证据已记录」 |
| C3 只有 `completed` 才算完成 | 进度 T12/T13/T14：内部阶段 `working`，仅 `completed` 三步全绿 |
| **C4** 续题需合法完成 | 页面既有用例；本轮未改 `after_attempt_id` 条件 |
| C4 新题不继承答案/评分/进度 | 页面 T15 |

`PracticePage.tsx` 本轮零改动，页面仍是唯一业务控制入口。

---

## 7. 到期复习身份和题目隔离证明

| 检查 | 状态 |
| --- | --- |
| 复习身份由服务端 `question.review` 决定 | 未改：`reviewQuestionActive` 原样，进度组件不读 URL |
| URL 只能收窄复习意图 | 未改：`reviewIntentFromLocation` / `reviewQuestionActive` 仍在页面 |
| 复习题使用相同进度语义 | 页面 T17：`evaluated` 复习题显示「答案已保存 / 评分完成 / 待记录」 |
| 复习完成仍走同一 `completed` 判定 | 面板 T17：`completed` 复习题三步全绿 + 「本次复习作答已记录」 |
| 新题隔离 | 页面 T15：A 的 `completed` 历史不染到 B，B 显示「待提交」 |
| 会话隔离 | 页面 T16：切到 B 后进度为「待提交」，无 A 的「证据已记录」 |
| 浏览器实测复习题 | `1440x900-*-review.png`：真实 C1 `intent: "review"` 生成的复习题，进度从「待提交」开始 |

---

## 8. 新增测试及回归结果

### 新增 / 扩展

| 文件 | 本轮前 | 本轮后 |
| --- | ---: | ---: |
| `practice/PracticeProgress.test.tsx` | — | 22 |
| `practice/PracticeAnswerPanel.test.tsx` | 14 | 23 |
| `pages/PracticePage.test.tsx` | 64 | 72 |
| 其余三个展示组件测试 | 29 | 29（未改） |

### 任务 T01–T20 覆盖

| 编号 | 场景 | 覆盖位置 |
| --- | --- | --- |
| T01 | 尚未作答，三步均未完成 | `PracticeProgress` T01；页面 T01 |
| T02 | 正在提交，第一步处理中 | `PracticeProgress` T02；面板 T02 |
| T03 | 提交成功，仅第一步完成 | `PracticeProgress` T03；面板 T03 |
| T04 | pending attempt 未刷新不闪回可提交 | `PracticeProgress` T04；页面 T04 |
| T05 | 正在评分，第二步处理中 | `PracticeProgress` T05/T05b；面板 T05；页面 T05 |
| T06 | 评分成功，前两步完成、第三步待记录 | `PracticeProgress` T06；面板 T05/T06 |
| T07 | 评分失败，第二步失败、第三步未完成 | `PracticeProgress` T07；面板 T07/T11 |
| T08 | 评分允许重试，重试按钮正确 | `PracticeProgress` T08；面板 T07 |
| T09 | 评分重试耗尽，不开放重试 | `PracticeProgress` T09；面板既有「已用尽」用例 |
| T10 | 正在记录，第三步处理中 | `PracticeProgress` T10；面板 T10 |
| T11 | 证据记录失败，不显示完成 | `PracticeProgress` T11；面板 T07/T11 |
| T12 | `evidence_recorded` 不提前宣称完成 | `PracticeProgress` T12；面板 T12/T13 |
| T13 | `profile_projected` 不提前宣称完成 | `PracticeProgress` T13；面板 T12/T13 |
| T14 | `completed` 三步全部完成 | `PracticeProgress` T14；面板 T14 |
| T15 | 新题替换旧题，旧进度不继承 | 页面 T15 |
| T16 | A/B 会话切换，不显示其他会话进度 | 页面 T16 |
| T17 | 复习题使用相同进度语义 | 页面 T17；面板 T17 |
| T18 | 英文界面文案完整 | `PracticeProgress` T18；页面 T18；浏览器英文截图 |
| T19 | 320px 无横向溢出 | 浏览器验收：5 视口 × 2 主题，`overflow` 全为空 |
| T20 | 刷新恢复，从服务端状态重建 | 页面 T20 |

> T19 是布局断言，用真实浏览器几何数据验证（见第 11 节），比 jsdom 更可信。

### 定向测试（实测）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run pages/practice/` | **91 / 91 通过**（5 文件） |
| `npx vitest run PracticePage.test.tsx` | **72 / 72 通过** |
| `npx vitest run learning-store.test.ts` | **41 / 41 通过**（未改） |
| `npx vitest run i18n/` | **11 / 11 通过** |
| 定向合计（practice + 页面 + store + i18n） | **187 / 187 通过** |

没有删除、跳过或放宽任何既有用例；`learningStore` 测试断言未改。

---

## 9. TypeScript、Web、完整构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build`（server + web） | 通过 |

---

## 10. 全量测试与基线失败对照

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4` | **194 文件通过 / 1 失败；2153 通过 / 1 失败 / 3 跳过** |

| 轮次 | 文件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| P2-1 基线（`90e12b8`） | 194 | 2114 | 1 | 3 |
| 本轮 | 194 | **2153** | 1 | 3 |

差值 +39 恰为本轮新增用例（`PracticeProgress` 22 + 面板 +9 + 页面 +8 = 39），**没有吞掉任何既有用例**。

**唯一失败**仍是基线既有失败：`apps/learning-agent/src/server.e48-workbench.test.ts` → 「allows an in_progress course to continue chatting」的 `providerCalls` 断言（期望 1 实得 2），自 `853d470` 即可复现，与本轮前端改动无关。本轮未修改后端测试，不将其描述为新回归。

---

## 11. 各视口真实截图

真实 React 页面 + 真实服务端（隔离数据目录 `.p22-acceptance/data` + 桩 provider 返回结构化题目/评分），**不是** `prototype.html`。

### 方法

- 5 个视口 × 2 主题（浅色 / 深色）× 10 个状态 = 100 张，另加 2 张英文（1440 / 320）与 3 张窄屏滚动特写。
- 每个状态都由真实 API 构建（出题 → 提交 → 评分 / 失败 / 记录），再用页面自身导航进入练习页。
- 每次截图记录：进度文案、每步 `data-state`、可用按钮、横向溢出、控制台错误、实际主题。

| 视口 | 尺寸 |
| --- | --- |
| 桌面 | 1440 × 900 |
| 桌面 | 1024 × 768 |
| 平板 | 900 × 800 |
| 手机 | 390 × 844 |
| 小屏 | 320 × 640 |

### 覆盖状态

待作答、正在提交、已提交未评分、评分中、评分失败、评分成功未记录、记录中、记录失败（内部阶段）、完整记录成功、新题、到期复习题。

> 记录失败（`finalizeError`）由 `PracticeProgress` T11 与面板 T07/T11 以确定性用例覆盖；浏览器侧的可执行记录失败需要服务端写入失败注入，本轮未在浏览器中构造（见第 13 节）。

### 结果

| 指标 | 结果 |
| --- | --- |
| 捕获数 | 102 |
| 横向溢出 | **0**（5 视口全部 `scrollWidth <= innerWidth`） |
| 控制台错误 | **0** |
| 页面异常 | **0** |
| 状态映射不符 | **0**（100 个状态逐一比对期望映射） |
| 深色主题实际生效 | 50 张 `data-theme=dark`，50 张 `light` |

### 重点确认

| 检查 | 结果 |
| --- | --- |
| 进度在作答区内、操作按钮附近 | 是（答案框下方、提交/评分/记录按钮上方） |
| 进度不取代按钮 | 是（三个操作按钮原样保留） |
| 当前操作仍用现有按钮 | 是（可用按钮列表与改造前一致） |
| 不新增重复入口 | 是（进度组件无按钮、无回调） |
| 失败步骤与错误文案对应 | 是（评分失败→「评分失败」+「重新评分」；错误行仍在） |
| 已完成保留学习档案入口 | 是（`completed` 后「查看我的学习档案」可见） |
| 860px 阅读列宽 | 是（`.mla-practice` 未改） |
| 不新增卡片容器 | 是（进度是答案区内的 `ol`，无新卡片） |
| 题目与答案同卡片 | 是（DOM 结构未动外层 Card） |
| 不遮挡评分反馈 | 是（进度在反馈之上，反馈完整可见） |
| 320px 无整页横向溢出 | 是（三列堆叠，`overflow: false`） |
| 不只靠颜色表达 | 是（对勾 / 加载 / 警告图标 + 文字状态） |
| 图标与文字对应 | 是（每步「序号或图标 + 步骤名 + 状态词」） |
| 浅色 / 深色 | 是（各 50 张） |
| 中英文长度适配 | 是（英文 320px 三列换行无溢出） |
| `prefers-reduced-motion` | 是（沿用全局 `.mla-shell` 关闭动画规则，加载图标不旋转） |

截图：`P2-2-assets/`（命名 `<宽>x<高>-<主题>-<状态>.png`），指标：`P2-2-assets/metrics.json`。

---

## 12. 已知风险及下一阶段建议

### 已知风险 / 限制

1. **`server.e48-workbench` 基线失败**仍在，与前端无关，本轮未改。
2. **浏览器侧未构造「记录失败」**：需要服务端 finalize 写入失败注入。该路径由 `PracticeProgress` T11 与面板 T07/T11 以确定性用例覆盖；页面语义（`finalizeError` → 第三步 `failed`）已锁定。
3. **浏览器侧未构造「重试耗尽」**：需要连续 3 次评分失败（`MAX_EVALUATION_ATTEMPTS = 3`），成本高。该路径由 `PracticeProgress` T09 与面板既有「已用尽」用例覆盖。
4. **进度条为纯展示，不持久化**：刷新后由服务端 `stage` 重建（T20 与浏览器实测均验证），符合设计；不会出现本地与服务端分叉。
5. **`active` 与 `pending` 同文案**：这是刻意选择——突出当前步骤但不使用完成语义；若后续希望更强区分，可改为更强的边框或左侧标记，而不引入百分比。

### 下一阶段建议（P2-3）

- 评分反馈分层：`PracticeFeedback` 的结果 / 维度 / 正文三层视觉层次，只改该组件与样式。
- 出题表单与复习准备布局优化：默认折叠、去掉复习准备页右栏、移动端底部留白。
- 进度条与反馈卡的间距可随 P2-3 一并微调，仍只动 CSS。

---

## 13. PASS 判定

| 条件 | 结果 |
| --- | --- |
| 三步状态来自当前题目的真实服务端状态 | 是 |
| 提交、评分、记录仍为三个独立操作 | 是 |
| 请求开始不等于成功 | 是（`working` ≠ `done`） |
| 失败和重试的文案准确 | 是 |
| 未完成的内部阶段不提前宣称证据正式记录完成 | 是（`evidence_recorded`/`profile_projected` → `working`） |
| 切换题目或会话不继承旧进度 | 是（T15/T16） |
| 正常练习与复习使用一致语义 | 是（T17 + 浏览器复习截图） |
| 无新增业务写入逻辑 | 是（组件纯展示，无 Store/API） |
| 原有页面及 Store 测试通过 | 是（页面 72、store 41） |
| 新增测试通过 | 是（进度 22、面板 23） |
| TypeScript 和完整构建通过 | 是 |
| 没有新增确定性全量测试失败 | 是（唯一失败为基线） |
| 所有目标视口无阻断性问题 | 是（102 捕获，0 溢出，0 错误） |
| 验收报告完整 | 是 |

**结论：E4.9h-P2-2 增量 PASS。** 可进入 P2-3。
