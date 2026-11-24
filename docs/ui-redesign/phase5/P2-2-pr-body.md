## 概要

E4.9i-P2-2：把知识列表从 1000+ 行的 `LearnerProfilePanel` 中抽出，并实现「默认阅读 → 展开详情 → 主动编辑」三级交互。

- 基准：`main` @ `3fe47b71bdd2cac1a459fa9a5a9dc82df00f8ca7`
- 工作分支：`feat/e49i-p2-2-knowledge-list`
- 参考设计：`docs/ui-redesign/phase5/prototype-a.html`

**未修改**后端状态计算、证据账本、复习调度、`learner-store.ts`、`courses-store.ts`、数据库、课程归属规则、P1 原型、今日学习/AI 学习/练习页面。

## 修复的问题

P2-1 之后，展开一个知识点会**直接进入编辑态**：只想读诊断的用户必须先面对一个掌握度滑块和两个文本框。保存失败也没有任何提示。

## 改动

新增 `apps/learning-agent/web/src/react/profile/`：

| 文件 | 职责 |
| --- | --- |
| `KnowledgeList.tsx` | 顺序、`concept_id` key、空态。不请求 API、不读课程范围 |
| `KnowledgeRow.tsx` | `collapsed / reading / editing` 三级状态机 + 摘要行 |
| `KnowledgeReadView.tsx` | 只读详情：状态、掌握度参考、复习日期、诊断、下一步 |
| `KnowledgeEditPanel.tsx` | 草稿、滑块、两个文本域、保存/取消/失败。不 import store |
| `KnowledgeStateBadge.tsx` | 状态徽章（两个视图共用） |
| `knowledge-format.ts` | 复习日期 / 掌握度百分比 |

- `LearnerProfilePanel.tsx`：知识区改为容器，只负责把 `learnerStore.patchKnowledge` 接进列表（净减约 100 行）。
- `CourseLearnerPanel.tsx`：复用共享徽章与日期格式；**只读**——不传 `onSave`，因此无法进入编辑态，而不是用布尔开关隐藏。
- i18n 中英文同步新增 7 个键（`reviewDate`、`edit`、`noDiagnosis`、`noNextActions`、`saveFailed`、`discardConfirm`、`manualNotice`）。

## 交互

```
collapsed ──点击行──► reading ──点「编辑」──► editing
    ▲                   │                      │
    └──点击行────────────┘                      │
                        ▲                      │
                        └───保存成功 / 取消─────┘
```

- 展开**永远**进入阅读态。
- 保存只在 promise resolve 后回到阅读态；reject 时停在编辑态、保留草稿、显示 `role="alert"` 错误、按钮恢复可点。
- `saving` 期间保存按钮 `disabled`，重复点击不会二次提交。
- 取消时若有改动先 `confirm`；拒绝则保留草稿与编辑态，确认则回到**已保存**文本。
- 每行独立持有 mode，行间草稿互不影响；保存只提交本行。

编辑区显示「保存修改后，该知识记录将标记为人工维护。」（P2-1 已确认服务端 PATCH 会置 `origin: manual`）。本轮不做完整来源徽章系统。

## 验证

| 项 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | ✅ |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | ✅ |
| 新增 `profile/KnowledgeList.test.tsx` | ✅ 22 / 22 |
| 新增 `profile/KnowledgeList.page.test.tsx` | ✅ 6 / 6 |
| `LearnerProfilePanel.knowledge-state.test.tsx` | ✅ 16 / 16 |
| `LearnerProfilePanel.summary.test.tsx` | ✅ 8 / 8 |
| `ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `i18n/locales.test.ts` | ✅ 8 / 8 |
| `react/courses/`（6 文件） | ✅ 46 / 46 |
| 全量 `npx vitest run --maxWorkers=4` | 见下 |

```
Test Files  1 failed | 201 passed (202)
     Tests  1 failed | 2272 passed | 3 skipped (2276)
```

唯一失败是 `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`，合并前 `main` 上已知的历史问题；本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行。未删除或跳过任何断言。

**P2-1 的 T13/T14 已按新交互更新**：由「点击行 → 找输入框」改为「点击行 → 点编辑 → 找输入框」。保存行为断言原样保留，未删除、未放宽。

## 真实页面验收

Playwright + Chromium 驱动真实 React 页面，用 `page.route` 注入受控 profile 响应（本机档案只有一条状态，覆盖不到六状态与缺失字段）。**页面无 JS 错误。**

14 张截图在 `docs/ui-redesign/phase5/P2-2-assets/`，指标在 `p22-browser-metrics.json`：

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `p22-desktop-list.png` | 1440×900 | 默认列表 |
| `p22-desktop-reading.png` | 1440×900 | 阅读态 |
| `p22-desktop-editing.png` | 1440×900 | 编辑态 |
| `p22-desktop-cancel-confirm.png` | 1440×900 | 取消被拒，草稿保留 |
| `p22-desktop-save-failed.png` | 1440×900 | 保存失败，草稿保留 |
| `p22-desktop-save-success.png` | 1440×900 | 保存成功回阅读态 |
| `p22-desktop-course-readonly.png` | 1440×900 | 指定课程只读 |
| `p22-mobile-320-reading.png` | 320×640 | 小屏阅读态 |
| `p22-mobile-320-editing.png` | 320×640 | 小屏编辑态 |
| `p22-1024-reading.png` | 1024×768 | 中等桌面 |
| `p22-900-reading.png` | 900×800 | 平板 |
| `p22-mobile-390-reading.png` | 390×844 | 手机 |
| `p22-desktop-dark-reading.png` | 1440×900 | 深色 |
| `p22-desktop-en-editing.png` | 1440×900 | 英文编辑态 |

关键指标：阅读态 `sliders 0 / textareas 0 / editButtons 1`；编辑态 `sliders 1 / textareas 2`；保存失败时 `alerts: ["保存失败：Failed to fetch"]` 且草稿仍在；课程视图 `editButtons 0`；所有视口 `scrollWidth === clientWidth`。

## 已知遗留（按要求记录，不阻断本轮）

320 / 390px 下知识行摘要区的状态徽章仍被裁切、进度条宽度为 0 —— P2-1 已记录的固定列布局问题。本轮**未加重**：新增的阅读态与编辑面板都是纵向布局，320px 下完整可用、无横向溢出，保存按钮滚动一次即可点击（实测点击成功）。

另记录：320px 编辑态下保存/取消按钮初始位于滚动视口底缘，需滚动一次才完全露出。

完整报告：`docs/ui-redesign/phase5/P2-2-acceptance.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
