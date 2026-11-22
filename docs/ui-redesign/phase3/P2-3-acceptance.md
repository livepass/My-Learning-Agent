# E4.9g-P2-3 验收报告：AI 学习上下文 Sheet 改造

- **基准分支**：`main`
- **基准提交**：`34b7c9e8ab4cec2287b5f32276cb388a2e9bf9e2`（PR #3 合并后的 `main`，与任务给出的基准一致）
- **工作分支**：`feat/e49g-p2-3-learning-context-sheet`
- **设计依据**：`docs/ui-redesign/phase3/analysis.md`、`index.html`、`prototype.html`、`implementation-map.md`（方向 A「专注书桌」）
- **结论**：**P2-3 增量 PASS，全项目测试仍存在基线失败**（见第 7 节）

---

## 1. 修改文件清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/shell/shell.css` | 修改 | `.mla-learn` 改为两列；删除 `--status-collapsed` 与右栏 40px 规则；新增 sheet 样式（桌面右侧覆盖、手机底部、`dvh`、安全区、动效降级） |
| `react/ui/Sheet.tsx` | 新增 | 最小共享基元：桌面非模态、手机模态，Escape/关闭按钮/外部点击/遮罩关闭，焦点移入与回收，模态时背景 `inert` + 滚动锁 + Tab 约束 |
| `react/ui/index.ts` | 修改 | 导出 `Sheet` |
| `react/pages/learn/LearnContextSheet.tsx` | 新增 | 组合课程/任务区块与 `LearnContextPanel`，标题与关闭按钮 |
| `react/pages/learn/LearnContextPanel.tsx` | 修改 | 由「可折叠第三栏」改为纯内容（`<section>`），删除自身开合状态与切换按钮 |
| `react/pages/LearnPage.tsx` | 修改 | `statusOpen` → `contextOpen`（默认关闭）；新增 `narrowViewport`（`matchMedia`）驱动模态语义；会话切换关闭 sheet；历史抽屉与 sheet 互斥 |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `learn.context.*` 六个键 |
| `react/pages/learn/LearnContextSheet.test.tsx` | 新增 | 21 项组件测试 |
| `react/pages/LearnPage.course-bar.test.tsx` | 修改 | 新增 11 项 sheet 集成测试（21 → 32），并更新 2 项旧断言 |
| `react/pages/learn/LearnContextPanel.test.tsx` | 修改 | 2 项开合测试改为内容测试（12 → 11） |
| `react/pages/LearnPage.test.tsx` / `.welcome.test.tsx` / `.workbench.test.tsx` | 修改 | 依赖旧自动展开行为的断言改为「先打开 sheet」 |
| `react/shell/shell.css.test.ts` | 修改 | 布局契约改为两列，并断言旧折叠规则不再出现 |
| `docs/ui-redesign/phase3/P2-3-assets/` | 新增 | 19 张真实页面截图 + `metrics.json` |
| `docs/ui-redesign/phase3/P2-3-acceptance.md` | 新增 | 本报告 |

**未修改**：`LearningWorkspace.tsx`、后端 API、Store、会话绑定机制、课程栏业务规则、历史会话管理、全局导航、其他页面。

---

## 2. Sheet 的桌面与移动端行为

| 维度 | 桌面（≥901px） | 手机（≤900px） |
| --- | --- | --- |
| 呈现 | 聊天卡片内右侧覆盖，宽 360px | 底部 Sheet，宽 100%，高 ≤ `min(86dvh, 640px)` |
| 角色 | `role="region"`，无 `aria-modal` | `role="dialog"`，`aria-modal="true"` |
| 遮罩 | 无 | 半透明遮罩，本身是关闭目标 |
| 背景 | 可读、可滚动 | `inert` + `body` 滚动锁 |
| 关闭 | 关闭按钮、Escape、点击面板外部 | 关闭按钮、Escape、点击遮罩 |
| 焦点 | 打开时移入面板，关闭后回触发按钮 | 同上，且 Tab 被限制在 Sheet 内 |
| 滚动 | 仅面板内部滚动 | 仅 Sheet 内部滚动；`dvh` 与 `env(safe-area-inset-bottom)` 处理键盘与安全区 |
| 关闭后 | 卸载，控件不留在 Tab 顺序中 | 同上 |

模态判定由 `matchMedia("(max-width: 900px)")` 驱动，与 CSS 断点一致，因此 `aria-modal`、焦点陷阱与滚动锁不会与实际呈现不符。桌面**没有**使用 `aria-modal`——它本来就不是模态。

---

## 3. 右栏移出网格前后的宽度对比

改造前（`main` @ `34b7c9e`）`.mla-learn` 为 `260px minmax(0, 1fr) 240px`，≤1100px 为 `232px … 220px`，折叠态再让出 40px。

改造后为 `260px minmax(0, 1fr)`（≤1100px 为 `232px minmax(0, 1fr)`）。

| 视口 | Sheet 关闭时聊天宽 | Sheet 打开时聊天宽 | 差值 | Sheet 尺寸 | 横向溢出 |
| --- | ---: | ---: | ---: | --- | ---: |
| 1440 × 900 | 1052 | 1052 | **0** | 360 × 825 | 0 |
| 1280 × 800 | 892 | 892 | **0** | 360 × 725 | 0 |
| 1024 × 768 | **684** | 684 | **0** | 360 × 693 | 0 |
| 900 × 800 | 876 | 876 | **0** | 900 × 496（底部） | 0 |
| 390 × 844 | 366 | 366 | **0** | 390 × 534（底部） | 0 |
| 320 × 640 | 296 | 296 | **0** | 320 × 550（底部） | 0 |

**1024px 重点**：聊天列从 P2-2 记录的 452px 提升到 **684px**（+232px，正好是移除的 220px 右栏加上 12px 间隙）。这里只报告浏览器实测值，不推断理论最大值。

Sheet 打开前后聊天宽完全相同，说明它确实以覆盖方式呈现，没有重新分配列宽。

---

## 4. 自动化测试结果

### 4.1 定向

| 文件 | 用例数 | 结果 |
| --- | ---: | --- |
| `learn/LearnContextSheet.test.tsx` | 21 | 通过 |
| `learn/LearnContextPanel.test.tsx` | 11 | 通过 |
| `LearnPage.course-bar.test.tsx` | 32 | 通过 |
| **合计** | **64** | **3 文件全部通过** |

全 Web 目录：`npx vitest run apps/learning-agent/web/src/react/` → **43 文件 / 499 项通过**。

### 4.2 新增 sheet 测试（组件级）

| 覆盖 | 用例 |
| --- | --- |
| 桌面非模态 / 手机模态 | `is a non-modal region on desktop and a modal dialog on a phone` |
| 关闭即卸载 | `renders nothing at all while closed, so no hidden control stays in the Tab order` |
| 焦点移入与回收 | `moves focus into the sheet and gives it back to the trigger on close` |
| 关闭按钮 / Escape / 外部点击 / 遮罩 | 4 项 |
| 模态 Tab 约束 | `keeps Tab inside the sheet when it is modal` |
| 内容分层与空态 | 课程、任务、阶段、自由学习、未归类、绑定未确认、加载、错误、无会话 |
| 检查点与动作 | 步骤/修订/题目/待处理动作；初始化仅在显式点击；`canInitialize=false` 时不显示；暂停/继续回调；已完成不可恢复 |
| 中英文 | `switches all of its copy with the language` |

### 4.3 新增页面集成测试

| 编号 | 用例 |
| --- | --- |
| T01 | 有真实检查点时 Sheet 仍默认关闭 |
| T02 | 课程栏按钮打开 Sheet 并显示当前会话上下文 |
| T03 | 关闭按钮关闭，焦点回到课程栏按钮 |
| T04 | Escape 关闭 |
| T05 | 桌面点击外部关闭 |
| T06 | 关闭后 Sheet 控件不留在 Tab 顺序中 |
| T07 | 打开 Sheet 不自动初始化 |
| T10 | 未归类会话在 Sheet 内无初始化/暂停 |
| T11 | 暂停课程在 Sheet 内无初始化 |
| T12 | 切换会话关闭 Sheet，不显示旧数据 |
| T14 | 历史抽屉与 Sheet 互斥 |

T08/T09（初始化、暂停/继续）由 `LearnPage.test.tsx`、`LearnPage.course-bar.test.tsx` 的既有用例覆盖（点击后断言 `initLearning` / `pauseLearning` 调用参数），本轮改为先打开 Sheet。T13（手机模态）由组件级模态用例 + 浏览器验收覆盖。T15/T16 由组件级语言与空/错误态用例覆盖。

### 4.4 更新的旧断言（均为交互规则变化，不是放宽）

| 文件 | 旧断言 | 新断言 | 原因 |
| --- | --- | --- | --- |
| `LearnContextPanel.test.tsx` | 折叠态无标题、有「展开学习状态」按钮 | 面板始终渲染内容、不再有开合按钮 | 开合职责移到 Sheet |
| `LearnPage.course-bar.test.tsx` | 「展开/收起学习状态」按钮同步 | 课程栏按钮 `aria-expanded` 同步 Sheet | 入口未变，被控对象变了 |
| `LearnPage.welcome.test.tsx` | 打开会话后存在「本次学习状态」区域 | 打开会话后 Sheet 仍关闭 | 覆盖式面板不得自动出现 |
| `LearnPage.workbench.test.tsx` | 无检查点时自动折叠 | Sheet 默认关闭，点击后显示 | 同上 |
| `shell.css.test.ts` | 三列 + 折叠 40px | 两列，且旧折叠规则不得回归 | 布局契约变化 |

所有原有业务断言（发送、绑定、只读、归档、删除、重命名、草稿、语言）均未删除或放宽。

---

## 5. 完整构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过（24.8s） |
| `npm run build` | 通过（server + web，22.7s） |

---

## 6. 全量测试与基线失败对照

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `npm test` | 188 文件 / 2031 通过 / 1 失败 / 3 跳过 |

唯一失败：

| 文件 | 用例 | 判定 |
| --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2） | **基线既有失败**：P2-2-R1 已在 `853d470` 基线复现，R2 记录为未修复，本轮未改后端 |

用例总数从 R2 的 2004 增至 2035（+31：Sheet 21、集成 11、面板 −1、CSS 契约 ±0）。没有删除、跳过或放宽任何失败测试。

**结论：P2-3 增量 PASS，全项目测试仍存在基线失败。**

---

## 7. 焦点、键盘、关闭与背景交互验证

真实构建 + 真实服务端 + Playwright 受控数据，全部页面控制台 0 错误。

| 检查 | 桌面 1440 | 手机 390 |
| --- | --- | --- |
| 打开后焦点在 Sheet 内 | 是 | 是 |
| Escape 关闭 | 是（6 档视口全部 `closedByEscape: true`） | 是 |
| 焦点回到课程栏按钮 | 是（6 档视口全部 `focusReturned: true`） | 是 |
| 关闭按钮 | 是 | 是 |
| 外部点击 / 遮罩关闭 | 是 | 是（`closedByBackdrop: true`） |
| 背景 `inert` | 不适用（非模态，背景必须可读） | 是（`backgroundInert: true`） |
| `body` 滚动锁 | 不适用 | 是（打开 `hidden`，关闭恢复空） |
| 关闭后控件不在 Tab 顺序 | 是 | 是 |
| 横向溢出 | 0 | 0 |

---

## 8. 各分辨率截图（`docs/ui-redesign/phase3/P2-3-assets/`，19 张 + `metrics.json`）

| 组 | 文件 |
| --- | --- |
| 六档视口 × 关闭 / 打开 | `{1440,1280,1024,900,390,320}-closed.png`、`…-open.png` |
| 内容状态（1440） | `1440-real-checkpoint.png`、`1440-no-checkpoint.png`、`1440-unclassified.png`、`1440-archived.png`、`1440-paused-course.png` |
| 深色 | `dark-1440-open.png`、`dark-390-open.png` |
| 指标 | `metrics.json` |

状态核对（浏览器实测）：

| 场景 | 初始化 | 暂停 | 继续 | 只读提示 |
| --- | --- | --- | --- | --- |
| 有真实检查点 | 无 | 有 | 无 | 无 |
| 无检查点 | 有 | 无 | 无 | 无 |
| 未归类 | 无 | 无 | 无 | 有 |
| 归档会话 | 无 | 无 | 无 | 有 |
| 暂停课程 | 无 | 无 | 无 | 无（页面级提示为「课程已暂停」） |

深色：面板表面 `rgb(56,56,56)`、正文 `rgb(236,236,236)`，来自共享语义 token，无新增裸色值。

---

## 9. 已知问题与下一阶段建议

1. **交互变化（有意为之）**：状态栏不再自动展开。即使 `hasRealCheckpoint()` 为 true，Sheet 也保持关闭，必须点击课程栏「学习状态」。这是从固定栏改为覆盖式面板的必要变化。
2. **桌面 Sheet 覆盖聊天右侧 360px**：正在阅读的段落可能被遮住，需要手动关闭。设计文档已将其列为可接受权衡（默认关闭 + 外部点击关闭 + 不锁滚动）。
3. **1024px 历史栏仍常驻**（232px）：按任务要求，历史栏改抽屉属于 P2-4。
4. **`server.e48-workbench` 基线失败**仍然存在，与前端无关。
5. **建议 P2-4**：历史栏在 1024px 变成抽屉后，聊天列还能再增加约 232px；同时可复用本轮 `Sheet` 基元，避免再写一套抽屉逻辑。

---

## 10. Git

- 代码与报告提交在 `feat/e49g-p2-3-learning-context-sheet`
- 未合并 `main`，未推送 `main`
- PR 目标：`main`（`gh` 未登录时无法直接创建，见提交说明）

### PASS 判定

| 条件 | 结果 |
| --- | --- |
| 状态栏不再占用固定网格列 | 是 |
| Sheet 开关不会重新挤压聊天区 | 是（6 档视口差值均为 0） |
| 桌面右侧 Sheet 正常 | 是 |
| 手机底部 Sheet 正常 | 是 |
| 焦点、Escape、关闭和背景交互正确 | 是 |
| 学习检查点功能保持一致 | 是 |
| P2-2-R2 权限机制无回归 | 是（未归类/归档/暂停/完成全部无写操作） |
| 不自动初始化学习记录 | 是 |
| 定向测试全部通过 | 是（64/64） |
| 完整构建通过 | 是 |
| 无新增确定性全量测试失败 | 是（唯一失败在基线即存在） |
| 无阻断性响应式或可访问性问题 | 是 |
| 验收报告与截图完整 | 是 |

**结论：P2-3 增量 PASS，全项目测试仍存在基线失败。**
