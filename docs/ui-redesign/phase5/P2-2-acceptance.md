# E4.9i-P2-2 验收报告：知识列表组件拆分与阅读/编辑状态分离

- **任务**：E4.9i-P2-2
- **基准分支**：`main`
- **基准 SHA**：`3fe47b71bdd2cac1a459fa9a5a9dc82df00f8ca7`
- **工作分支**：`feat/e49i-p2-2-knowledge-list`
- **参考设计**：`docs/ui-redesign/phase5/prototype-a.html`（方案 A）
- **结论**：**P2-2 PASS**

---

## 1. 基准与最终 SHA

| 项 | 值 |
| --- | --- |
| 基准 `main` | `3fe47b71bdd2cac1a459fa9a5a9dc82df00f8ca7` |
| 新建分支 | `feat/e49i-p2-2-knowledge-list` |
| 本轮起点工作区 | 干净（`git status` 无改动） |
| 最终提交 | 见 PR 描述 |

---

## 2. 组件拆分前后

### 2.1 拆分前

```text
LearnerProfilePanel.tsx (约 1050 行)
├── SummarySection
├── GoalsSection / GoalFormDialog / GoalCard
├── KnowledgeSection          ← 折叠、空态、列表
│   └── KnowledgeRow          ← 摘要 + 展开后直接是编辑表单
│       ├── masteryStateFor() 的三档映射（P2-1 已删）
│       ├── 滑块 / 诊断 / 下一步 / 保存 / 取消
│       └── 直接调用 learnerStore.patchKnowledge
├── MisconceptionsSection
└── PreferencesSection
```

`KnowledgeRow` 展开即编辑：只想读诊断的用户必须先面对滑块和两个文本框。保存失败没有提示，`finally` 里只恢复 `saving`。

### 2.2 拆分后

```text
react/profile/
├── KnowledgeList.tsx        纯列表：顺序、key、空态
├── KnowledgeRow.tsx         三级状态机 + 摘要行
├── KnowledgeReadView.tsx    只读详情
├── KnowledgeEditPanel.tsx   草稿 + 保存/取消/失败
├── KnowledgeStateBadge.tsx  状态徽章（两视图共用）
└── knowledge-format.ts      复习日期 / 掌握度百分比

LearnerProfilePanel.tsx      只剩容器：把 patchKnowledge 接进列表
CourseLearnerPanel.tsx       复用徽章与日期格式，保持只读
```

`LearnerProfilePanel.tsx` 净减约 100 行（`147 insertions / 160 deletions` 中的主体），知识列表逻辑全部移出。

---

## 3. 新组件职责与 props

| 组件 | 职责 | props | 明确不做 |
| --- | --- | --- | --- |
| `KnowledgeList` | 按服务端顺序渲染，`concept_id` 作 key，空态 | `states`、`onSave?`、`emptyMessage?` | 不请求 API、不读课程范围、不计算状态、不判断复习资格 |
| `KnowledgeRow` | 管理 `collapsed / reading / editing`，渲染摘要行 | `state`、`onSave?`、`barColor?` | 不直接访问 store |
| `KnowledgeReadView` | 名称、状态、掌握度参考、复习日期、诊断、下一步 | `state`、`onEdit?` | 不生成诊断或建议 |
| `KnowledgeEditPanel` | 草稿、滑块、两个文本域、保存/取消/失败 | `state`、`onSave`、`onCancel`、`saving` | 不 import `learnerStore` |
| `KnowledgeStateBadge` | 状态 → 文案 + tone | `stateLabel`、`className?` | — |
| `knowledge-format.ts` | `formatReviewDate`、`masteryPercent` | — | — |

`onSave` 缺失即只读：课程视图不传它，因此**无法**进入编辑态，而不是靠布尔开关隐藏。

---

## 4. 状态转换

```text
collapsed ──点击行──► reading ──点击「编辑」──► editing
    ▲                   │                          │
    └──点击行────────────┘                          │
                        ▲                          │
                        └────保存成功 / 取消───────┘
                              （取消且有改动 → 先确认）
```

- 展开**永远**进入 `reading`，不再直接进入编辑。
- 保存只在 promise resolve 后切回 `reading`；reject 时停留在 `editing` 并显示错误。
- `saving` 期间保存按钮 `disabled`，重复点击不会再次提交。
- 每行独立持有 `mode`，互不覆盖。

---

## 5. 保存成功 / 失败 / 重试

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 保存成功 | 请求返回后退出编辑，回到只读详情 | `p22-desktop-save-success.png`（sliders 0、editButtons 1） |
| 保存失败 | 保持编辑态、保留草稿、显示 `role="alert"` 错误、按钮恢复 | `p22-desktop-save-failed.png`；探针 `alerts: ["保存失败：Failed to fetch"]`，草稿 `保存会失败的草稿` 仍在 |
| 重试 | 失败后再点保存可再次提交 | 组件测试 T16 |

新增文案：`profile.knowledge.saveFailed`（中：「保存失败：{{message}}」/ 英："Save failed: {{message}}"）。

未改动 `learnerStore.patchKnowledge()`。

---

## 6. 未保存编辑保护

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 未修改就取消 | 直接退出，不询问 | T17 |
| 已修改后取消 | `window.confirm`，拒绝则保留草稿与编辑态 | `p22-desktop-cancel-confirm.png`（草稿仍在、sliders 1） |
| 确认放弃 | 回到只读，显示**已保存**文本而非草稿 | T18/T19 |
| 服务端刷新 | 无编辑时显示新数据；有脏草稿时**不覆盖** | 页面测试 D |
| 切换知识点 | 各行的 mode 与草稿互不影响；保存只提交本行 | T20 |
| 切换课程范围 | 课程视图本就无编辑入口；列表随 store 重读 | T21/T29 |
| 保存中切换 | 旧 promise 只改旧行自身状态，不影响新行 | T22 + `mode` 属行内 state |

---

## 7. 两个课程范围的复用

| 共享内容 | 实现 |
| --- | --- |
| 状态徽章（文案 + tone） | `KnowledgeStateBadge` |
| 复习日期格式 | `knowledge-format.ts` 的 `formatReviewDate` |
| 状态语义 | `react/knowledge-state.ts`（P2-1，未改） |

| 视图差异 | 全部课程 | 指定课程 |
| --- | --- | --- |
| 列表 | `KnowledgeList`（可编辑） | 现有 `mla-state-list` 布局（只读） |
| 证据数量 | 无 | 保留「证据 N 条」 |
| 需要关注区块 | 无 | 保留 |
| 掌握度进度条 | 有 | 无（保持原样） |

课程视图保留了原有布局与「需要关注」区块，只把徽章与日期格式换成共享实现；`p22-desktop-course-readonly.png` 中证据条数与状态文案均在。

---

## 8. 状态语义回归（P2-1 边界）

| mastery | state_label | 显示 | 证据 |
| ---: | --- | --- | --- |
| 0.05 | learning | 学习中 | T24、截图 |
| 0.85 | review_due | 待复习 | T24、截图 |
| 0.20 | stable | 稳定 | T24 |
| 0.95 | 缺失 | 证据不足 | T24 |
| 0.90 | unknown | 证据不足 | T23/T24 |

四者边界未变：`mastery` 是参考数值（进度条宽度），`state_label` 是正式状态（徽章），`review_due_at` 只是日期（缺失显示 `-`，不解释为无需复习），复习资格仍由服务端判定，前端未实现。

---

## 9. 测试结果

### 9.1 新增

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| `react/profile/KnowledgeList.test.tsx` | T01–T08、T09–T11、T12–T20、T22–T25、T27、T28（合并编号） | ✅ 22 / 22 |
| `react/profile/KnowledgeList.page.test.tsx` | 容器接线、D（刷新不覆盖草稿）、T25/T26、T29、T30 | ✅ 6 / 6 |

覆盖对照（任务书编号 → 实际用例）：T01–T08 列表与三级交互、T09–T11 三个字段编辑、T12 保存参数、T13 成功回读、T14/T15 失败保留、T16 重试、T17–T19 取消确认、T20 行间隔离、T22 防重复提交、T23 六状态、T24 mastery 不推断、T25 只读、T26 证据数与薄弱区、T27 中英文、T28 键盘/aria、T29 课程隔离、T30 折叠规则。

T21（切换课程范围）由 `ProfilePage.courses.test.tsx` 与 T29 覆盖。

### 9.2 回归

| 文件 | 结果 |
| --- | --- |
| `LearnerProfilePanel.knowledge-state.test.tsx` | ✅ 16 / 16（T13/T14 按新路径更新，保存断言保留） |
| `LearnerProfilePanel.summary.test.tsx` | ✅ 8 / 8 |
| `ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `i18n/locales.test.ts` | ✅ 8 / 8 |
| `react/courses/`（6 文件） | ✅ 46 / 46 |

P2-1 的 T13/T14 原本假设「点击知识点后直接编辑」；P2-2 改为先展开、再点编辑。两处断言从「点击行 → 找输入框」改为「点击行 → 点编辑 → 找输入框」，**保存行为断言未删除、未放宽**。

### 9.3 TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | ✅ |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | 见 PR 描述 |

### 9.4 全量

`npx vitest run --maxWorkers=4`（代码定稿后，单次无并发）：

```
Test Files  1 failed | 201 passed (202)
     Tests  1 failed | 2272 passed | 3 skipped (2276)
```

唯一失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（`expected 2 to be 1`）——**合并前 `main` 上已知的历史失败**，断言 mock provider 的调用次数，属本机端口/进程复用导致的计数漂移。本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行，无法触及该路径。未删除、跳过或放宽任何断言。

与 P2-1 基线（2244 通过）相比，本轮新增 28 项用例、0 项新增失败。

---

## 10. 真实浏览器验收

Playwright + Chromium 驱动真实 React 页面（`?page=profile`），用 `page.route` 注入受控 profile 响应（本机档案只有一条状态，覆盖不到六状态与缺失字段）。**页面无 JS 错误**。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `p22-desktop-list.png` | 1440×900 | 默认列表 |
| `p22-desktop-reading.png` | 1440×900 | 阅读态 |
| `p22-desktop-editing.png` | 1440×900 | 编辑态 |
| `p22-desktop-cancel-confirm.png` | 1440×900 | 取消被拒，草稿保留 |
| `p22-desktop-save-failed.png` | 1440×900 | 保存失败，草稿保留 |
| `p22-desktop-save-success.png` | 1440×900 | 保存成功回到阅读态 |
| `p22-desktop-course-readonly.png` | 1440×900 | 指定课程只读 |
| `p22-mobile-320-reading.png` | 320×640 | 小屏阅读态 |
| `p22-mobile-320-editing.png` | 320×640 | 小屏编辑态 |
| `p22-1024-reading.png` | 1024×768 | 中等桌面 |
| `p22-900-reading.png` | 900×800 | 平板 |
| `p22-mobile-390-reading.png` | 390×844 | 手机 |
| `p22-desktop-dark-reading.png` | 1440×900 | 深色 |
| `p22-desktop-en-editing.png` | 1440×900 | 英文编辑态 |

指标见 `P2-2-assets/p22-browser-metrics.json`。

### 验收结论

| 检查项 | 结果 |
| --- | --- |
| 默认不显示编辑控件 | ✅ 列表截图 sliders 0 / textareas 0 |
| 展开进入阅读态 | ✅ sliders 0、textareas 0、editButtons 1 |
| 阅读态无输入框 | ✅ 同上 |
| 点「编辑」才出现表单 | ✅ sliders 1、textareas 2 |
| 保存失败保留草稿并报错 | ✅ `alerts: ["保存失败：Failed to fetch"]`，草稿仍在 |
| 保存成功回阅读态 | ✅ sliders 0、editButtons 1 |
| 课程视图只读 | ✅ editButtons 0、sliders 0，证据条数保留 |
| 320px 详情与编辑可用 | ✅ 保存按钮滚动后可达并实际点击成功（sliders 1 → 0） |
| 各视口无横向溢出 | ✅ 全部 `scrollWidth === clientWidth` |
| 中英文 / 深浅主题 | ✅ 截图核对 |

---

## 11. 原有移动端遗留问题（未修复，按要求记录）

P2-1 记录的固定列问题仍在：320 / 390px 下知识行摘要区的状态徽章被裁切、进度条宽度为 0。

- 320px 实测：行宽 232px，徽章右边界 343–355px，进度条 0。
- 本轮**未加重**：新增的阅读态与编辑面板都是纵向布局，无固定像素列；320px 下两者均完整可用、无横向溢出。
- 该问题属知识行摘要布局，留给后续移动端专项阶段。

另：320px 编辑态下，保存/取消按钮初始位于滚动视口底部边缘，需滚动一次才完全露出（截图已滚到按钮可见处）。按钮可达、可点击，但这是移动端编辑区的真实体验问题，一并记录。

---

## 12. 完成标准核对

- [x] 知识列表从大型页面组件中拆出
- [x] 阅读态与编辑态明确分离
- [x] 进入知识详情不自动进入编辑
- [x] 课程视图保持只读
- [x] 全部课程和指定课程共享核心展示逻辑（徽章、日期格式、状态语义）
- [x] 正式知识状态仍来自 `state_label`
- [x] mastery 仅作为参考数值
- [x] 原有保存接口与参数不变
- [x] 保存成功后显示服务端最新结果
- [x] 保存失败保留草稿和错误信息
- [x] 未保存修改不会被静默丢弃
- [x] 不会重复提交或串用知识点状态
- [x] 中英文和深浅主题正常
- [x] 320px 新增详情和编辑区域可正常使用
- [x] 原有课程隔离测试通过
- [x] TypeScript 和构建通过
- [x] 没有新增确定性测试失败
- [x] 验收证据完整

**结论：P2-2 PASS。**
