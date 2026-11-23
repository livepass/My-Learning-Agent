## E4.9h-P2-2 — 提交、评分、记录证据三步进度展示

基准：`main` @ `90e12b8`（P2-1 合并后）。本轮只加三步进度展示，不改 C1–C4 业务行为。

### 做了什么

- **新增** `pages/practice/PracticeProgress.tsx`：纯展示组件 + `derivePracticeProgress` 纯函数，不调用 Store / API / URL / navigate，也不写入。
- **`PracticeAnswerPanel`** 用现有 Props 推导并渲染进度，**未新增 Props**，未把 `learningStore` 传给子组件；`hasAttempt` 仍由页面以 `pending_attempt_id || currentAttempt` 传入。
- **`PracticePage.tsx` 零改动**，P2-1 修复的重复提交按钮问题不会回归。

### 语义（关键约束）

| 服务端 / 本地状态 | 提交 | 评分 | 记录 |
| --- | --- | --- | --- |
| 未提交 | 待提交 | 待评分 | 待记录 |
| `isSubmitting` | 正在保存 | 待评分 | 待记录 |
| `answer_saved` / pending 未刷新 | 答案已保存 | 待评分 | 待记录 |
| `evaluating` / `isEvaluating` | 答案已保存 | 评分中 | 待记录 |
| `evaluation_failed`（含重试耗尽） | 答案已保存 | 评分失败 | 待记录 |
| `evaluated` | 答案已保存 | 评分完成 | 待记录 |
| `evidence_recorded` / `profile_projected` | 答案已保存 | 评分完成 | 记录处理中 |
| `isFinalizing` | 答案已保存 | 评分完成 | 正在记录 |
| `completed` | 答案已保存 | 评分完成 | 证据已记录 |

- 请求开始不等于成功；`evidence_recorded` / `profile_projected` **不**提前宣称完成，只有 `completed` 三步全绿。
- 新题 / 切换会话不继承旧进度（页面集成测试 T15 / T16）。
- 复习题与普通练习同一语义（T17）。

### 测试与验证

| 项 | 结果 |
| --- | --- |
| 定向（practice + 页面 + store + i18n） | **187 / 187 通过** |
| 新增 `PracticeProgress` | 22 项 |
| 扩展面板 / 页面 | +9 / +8 |
| `tsc --noEmit` | 0 错误 |
| `npm run build` | 通过 |
| 全量 `vitest run --maxWorkers=4` | 194 文件 / **2153 通过** / 1 失败 / 3 跳过 |

唯一失败是基线既有 `server.e48-workbench.test.ts` 的 `providerCalls` 断言，与本轮前端改动无关。全量通过数相对基线 2114 增加 39，恰为新增用例数。

### 真实浏览器验收

5 视口（1440×900 / 1024×768 / 900×800 / 390×844 / 320×640）× 浅色深色 × 10 状态，共 102 张真实 React 页面截图：

- 横向溢出 **0**，控制台错误 **0**，状态映射不符 **0**
- 320px 三列堆叠，无横向溢出；深色 / 英文均正确
- 截图与指标：`docs/ui-redesign/phase4/P2-2-assets/`，报告：`docs/ui-redesign/phase4/P2-2-acceptance.md`

### 修改范围

仅新增 `PracticeProgress.tsx(.test.tsx)`，修改 `PracticeAnswerPanel.tsx(.test.tsx)`、`PracticePage.test.tsx`、`shell.css`、中英文案、验收文档。未改 store、API、后端、复习身份、出题/评分/记录写入机制、全局导航，未新增依赖。

**不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
