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

唯一失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（`expected 2 to be 1`）。该用例在合并前 `main` 上即失败，且本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行，无法触及该路径。**具体根因尚未独立确认**（先前记为「端口/进程复用」缺乏证据，此处撤回）。未删除、跳过或放宽任何断言。

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
| `p22-mobile-320-course.png` | 320×640 | 指定课程 · 小屏 |

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
- [x] 未保存修改不会被静默丢弃（R1 补齐全部退出路径，见 §13）
- [x] 不会重复提交或串用知识点状态
- [x] 中英文和深浅主题正常
- [x] 320px 新增详情和编辑区域可正常使用
- [x] 原有课程隔离测试通过
- [x] TypeScript 和构建通过
- [x] 没有新增确定性测试失败
- [x] 验收证据完整

**结论：P2-2 PASS。**

---

## 13. E4.9i-P2-2-R1 交互安全修正

### 13.1 本轮提交

| 项 | 值 |
| --- | --- |
| 基准 | `main` @ `3fe47b71bdd2cac1a459fa9a5a9dc82df00f8ca7` |
| 分支 | `feat/e49i-p2-2-knowledge-list`（沿用） |
| R1 起点 | `37cc2a00cb6ede212940eab4a788317c09aba6da` |
| R1 提交 | 见 PR 描述 |

### 13.2 四条问题的复现（修改前，实测）

用一次性测试在真实组件上复现，随后删除该测试文件：

| 路径 | 修改前行为 | 复现结果 |
| --- | --- | --- |
| R01 编辑中点击知识行标题 | `onClick={() => setMode(expanded ? "collapsed" : "reading")}` 直接折叠 | ✅ 未弹确认，草稿消失，`onSave` 未被调用 |
| R02 编辑中折叠整个知识状态区块 | 通用 `Section` 直接 `setCollapsed(!collapsed)` | ✅ 源码确认无任何校验（组件卸载即丢草稿） |
| R03 编辑中切换课程范围 | `onValueChange={(v) => coursesStore.selectCourse(...)}` 无条件调用 | ✅ 源码确认无条件；切换会卸载整个面板 |
| R04 保存中折叠 | `save()` 成功后无条件 `setMode("reading")` | ✅ 折叠后迟到的 resolve 把行重新展开（`aria-expanded` 由 `false` 变回 `true`） |
| 附带 | `dirty` 是「是否触发过 onChange」的布尔值 | ✅ 改回原值后取消仍弹确认 |

### 13.3 修改后

| 路径 | 修改后行为 |
| --- | --- |
| R01 行标题 | 走 `guard.confirmLeave()`：未修改直接折叠；有修改先确认一次；保存中拒绝 |
| R02 区块折叠 | `Section` 新增 `onBeforeCollapse`，仅知识区块传入 `guard.confirmLeave`；其它区块行为不变 |
| R03 课程切换 | `changeScope()` 先取 verdict：`saving` 直接拒绝，`dirty` 确认一次，否则切换 |
| R04 保存中折叠 | 行标题与区块折叠在 `saving` 时都不改 `mode`；`save()` 只在 `modeRef.current === "editing"` 时回到 reading |
| dirty 判定 | 与进入编辑时的快照逐字段比较（`mastery` / `diagnosis` / `nextActions`），改回原值即不脏 |

### 13.4 草稿状态管理

新增 `react/profile/KnowledgeDraftGuard.tsx`：

```ts
type KnowledgeEditingStatus = { conceptId: string; dirty: boolean; saving: boolean };
type LeaveVerdict = "ok" | "dirty" | "saving";
```

- `KnowledgeEditPanel` 在 `useEffect` 中注册自己的状态，卸载时注销。
- 基线是**打开编辑器时的快照**（`useRef`），后续 props 刷新不会重设基准，因此「未修改」的定义在编辑期间保持稳定。
- 判定聚合在一处：`verdict()` 只要发现任一编辑器 `saving` 即返回 `saving`，否则任一 `dirty` 返回 `dirty`。
- 三个退出路径（行折叠、区块折叠、课程切换）都调用同一个 `confirmLeave()`，**不会各自实现不同的确认规则**，也不会为每个知识点各弹一次。
- 组件在无 Provider 环境（组件测试）下退化为安全兜底：自己的确认，无聚合。

### 13.5 保存中的阻断规则

| 动作 | 保存中 |
| --- | --- |
| 保存按钮 | 禁用（文案「保存中…」） |
| 取消按钮 | 禁用 |
| 掌握度滑块 / 两个文本域 | 禁用 |
| 点击行标题 | 不改 `mode` |
| 折叠知识区块 | 拒绝，不弹确认 |
| 切换课程范围 | 拒绝，不弹确认，Select 保持原值 |

请求已在途，因此这一层不询问、直接拒绝：放弃一个已发出的请求不是折叠按钮该做的决定。

### 13.6 课程范围切换保护

- 单一权威仍是 `coursesStore.selectedCourseId`，没有新增第二份选择状态。
- Select 受 `selectedCourseId` 控制，拒绝时自然回显原课程，编辑器保持挂载，草稿继续存在，也不发起新课程读取。
- 确认放弃后正常切换，**不发送保存请求**。
- 课程视图仍只读（`CourseLearnerPanel` 不传 `onSave`，结构上无法进入编辑）。

### 13.7 新增测试

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| `profile/KnowledgeDraftGuard.test.tsx` | G01–G07、G10、G14、G17–G21、G23、G24 | ✅ 16 / 16 |
| `profile/KnowledgeDraftGuard.page.test.tsx` | G08、G09、G11–G13、G15、G16、G22 + 两条正向路径 | ✅ 10 / 10 |

G01–G24 覆盖对照：

| 编号 | 覆盖位置 |
| --- | --- |
| G01 未修改折叠不弹确认 | guard.test |
| G02 修改诊断后折叠触发确认 | guard.test |
| G03 拒绝放弃保留草稿与编辑态 | guard.test |
| G04 确认放弃后恢复已保存内容 | guard.test |
| G05 改回原值不需确认 | guard.test |
| G06 下一步建议同样受保护 | guard.test |
| G07 掌握度同样受保护 | guard.test |
| G08 区块折叠检查 dirty | page.test |
| G09 区块折叠取消后保持展开 | page.test |
| G10 多知识点 dirty 只弹一次 | guard.test |
| G11 切换课程被拒时不切换 | page.test |
| G12 确认放弃后正常切换 | page.test |
| G13 取消切换后 Select 保持原值 | page.test |
| G14 保存中禁止行折叠 | guard.test |
| G15 保存中禁止区块折叠 | page.test |
| G16 保存中禁止切换课程 | page.test |
| G17 保存中输入控件不可改 | guard.test |
| G18 延迟保存成功回阅读态 | guard.test |
| G19 延迟保存失败保留草稿 | guard.test |
| G20 重试不重复提交 | guard.test |
| G21 旧请求不影响其他知识点 | guard.test |
| G22 指定课程只读不变 | page.test |
| G23 页面刷新不覆盖脏草稿 | guard.test |
| G24 中英文确认文案与键盘 | guard.test（英文 dialog 文案断言）+ page.test |

`ProfilePage.courses.test.tsx` 仍保留原有 3 条课程隔离用例；**新增的草稿保护覆盖放在 `KnowledgeDraftGuard.page.test.tsx`**，因为它需要真实的知识编辑上下文，而原文件只覆盖范围切换的数据隔离。

### 13.8 浏览器验收

Playwright + Chromium，真实 React 页面，受控 profile fixture，**真实 `window.confirm`**：脚本监听 `dialog` 事件，记录文案与 accept/dismiss 结果，而不是从截图推断。

| 截图 | 视口 | 场景 | 记录到的 dialog |
| --- | --- | --- | --- |
| `r1-desktop-edit-dirty.png` | 1440×900 | 编辑态有脏草稿 | — |
| `r1-desktop-collapse-cancel.png` | 1440×900 | 点行标题，选择取消 | 「放弃未保存的知识点修改？」dismissed |
| `r1-desktop-section-collapse-cancel.png` | 1440×900 | 折叠整个区块，选择取消 | 同上，dismissed |
| `r1-desktop-scope-switch-cancel.png` | 1440×900 | 切换课程，选择取消 | 同上，dismissed |
| `r1-desktop-saving.png` | 1440×900 | 保存中（请求挂起） | — |
| `r1-desktop-saving-collapse-blocked.png` | 1440×900 | 保存中点行标题 | **无 dialog**，行保持展开 |
| `r1-desktop-save-failed.png` | 1440×900 | 保存失败 | — |
| `r1-desktop-dark-edit-dirty.png` | 1440×900 | 深色 | — |
| `r1-desktop-en-collapse-cancel.png` | 1440×900 | 英文，选择取消 | "Discard the unsaved changes to this concept?" dismissed |
| `r1-mobile-320-edit-dirty.png` | 320×640 | 小屏编辑态 | — |
| `r1-mobile-320-scope-switch.png` | 320×640 | 小屏切换课程，选择取消 | 同上，dismissed |

指标（`r1-browser-metrics.json`）：

- 所有取消场景：`sliders 1`、`textareas 2`、`expandedRows 1`、`sectionExpanded "true"`、`scope "全部课程"` → 草稿与编辑态均保留。
- 保存中折叠后：`expandedRows 1`，无 dialog → 阻断生效。
- 保存失败：`alerts: ["保存失败：Failed to fetch"]`，草稿仍在。
- 所有视口 `scrollWidth === clientWidth`，无横向溢出。
- `page errors: none`。

**未覆盖**：浏览器级离开（刷新、关闭标签、地址栏跳转）。这些路径没有 `beforeunload` 保护，本轮也未宣称覆盖。

### 13.9 原有移动端遗留问题（不变）

320 / 390px 知识行摘要区的状态徽章仍被裁切、进度条宽度为 0 —— P2-1 记录的固定列布局问题。R1 未触及该布局；新增的编辑面板在 320px 下完整可用（`r1-mobile-320-edit-dirty.png`），保存按钮滚动一次即可点击。

### 13.10 测试与构建

| 命令 | 结果 |
| --- | --- |
| `npx vitest run apps/learning-agent/web/src/react/profile` | ✅ 2 个新文件 + 2 个既有文件全通过 |
| `npx vitest run .../ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `npx vitest run .../LearnerProfilePanel.knowledge-state.test.tsx` | ✅ 16 / 16 |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | ✅ |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | ✅ |
| 全量 `npx vitest run --maxWorkers=4` | 见 §13.11 |

### 13.11 全量结果

`npx vitest run --maxWorkers=4`（R1 定稿后单次运行）：

```
Test Files  1 failed | 203 passed (204)
     Tests  1 failed | 2298 passed | 3 skipped (2302)
```

唯一失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`。

- 该用例在合并前 `main` 上即失败，本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行。
- **具体根因尚未独立确认**；先前记作「端口/进程复用」缺乏证据，已撤回。
- 未删除、跳过或放宽任何断言。

与 P2-2 基线（2272 通过 / 1 失败 / 3 跳过）相比：本轮新增 26 项用例，失败数不变。

### 13.12 结论

**P2-2-R1 PASS_WITH_KNOWN_BASELINE_FAILURE**

四条退出路径全部闭合；未修改直接退出、有修改确认一次、保存中拒绝。原有 14 项 P2-2 截图与 15 张归档图片已核对一致。历史失败的具体根因已撤回未经证实的推断，只保留可验证事实。
