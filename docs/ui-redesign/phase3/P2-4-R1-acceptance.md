# E4.9g-P2-4-R1 验收报告：历史抽屉焦点与背景隔离修复

- **分支**：`feat/e49g-p2-4-history-start-panel`
- **基准提交**：`1b704b404a79481620e5a641698b877d7e921499`（P2-4）
- **结论**：**P2-4-R1 增量 PASS，项目全量仍存在基线失败**（见第 9 节）

---

## 1. 修复前的缺陷与复现方式

### 1.1 关闭抽屉时内部控件仍可聚焦

P2-4 关闭抽屉只做了两件事：`aria-hidden="true"`，以及 CSS 把面板移出屏幕。

| 布局 | 关闭时的隐藏方式 | 问题 |
| --- | --- | --- |
| 901–1279px | `transform: translateX(-102%)` + `visibility: hidden` | `visibility: hidden` 会移出 Tab 顺序，但只在部分浏览器/部分子元素上可靠；`aria-hidden` 本身不阻止聚焦 |
| ≤900px | 仅 `transform: translateX(-102%)` | **没有** `visibility`，抽屉只是被推到屏幕外，所有按钮仍在 Tab 顺序里 |

复现（修复前，390px）：打开页面后连续按 Tab，焦点会进入屏幕外的「新建对话」「会话操作」等按钮；读屏也不会播报这些控件，因为 `aria-hidden` 已把它们从无障碍树中移除——焦点落在了一个「不存在」的元素上。

### 1.2 打开抽屉时不是真正的模态

P2-4 已有：打开时焦点进入、关闭时焦点返回、Escape 关闭。缺少：

- `role="dialog"` / `aria-modal="true"`；
- Tab 在抽屉内循环；
- 背景 `inert` 与滚动锁；
- 背景控件仍可用 Tab 到达（只是被遮罩盖住）。

### 1.3 修复过程中新发现的缺陷

真实浏览器验收（Playwright 键盘操作）暴露了一个 jsdom 无法发现的问题：**打开抽屉时焦点落在 `<body>`**。

原因：`inert` 的清理 effect 与模态层的 effect 顺序反了。浏览器拒绝把焦点移入 `inert` 子树，而模态层先执行，于是 `focus()` 静默失败。jsdom 不实现 `inert` 的焦点语义，所以自动化测试当时是通过的。已调整 effect 声明顺序（清理 `inert` 在前），并重新验收确认焦点落在抽屉内。

---

## 2. 修改文件清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/ui/modal-layer.ts` | 新增 | 共享模态层：背景 `inert`、引用计数的滚动锁、焦点移入/回收、Tab 循环；跳过 overlay portal，避免与 Radix 菜单/对话框互相干扰 |
| `react/pages/learn/LearnHistoryRail.tsx` | 修改 | 抽屉关闭时设 `inert`；打开时 `role="dialog" aria-modal="true"` + `useModalLayer`；Escape 在无子弹层时才关闭；焦点回收带可见性兜底 |
| `react/shell/shell.css` | 修改 | 打开态抽屉 `z-index: 50`，使 Radix portal 菜单（`z-index: 100`）在其之上正常显示 |
| `react/pages/learn/LearnHistoryRail.test.tsx` | 修改 | 新增 11 项模态与隔离测试（12 → 23） |
| `react/pages/LearnPage.course-bar.test.tsx` | 修改 | 新增 3 项页面级测试（36 → 39） |
| `docs/ui-redesign/phase3/P2-4-R1-assets/` | 新增 | 20 张真实页面截图 + `metrics.json` |
| `docs/ui-redesign/phase3/P2-4-R1-acceptance.md` | 新增 | 本报告 |

**未修改**：`LearningWorkspace.tsx`、`LearnStartPanel.tsx` 的欢迎态与最近学习逻辑、Store、API、后端、课程绑定与权限规则、其他页面、`Sheet.tsx`。

### 2.1 为什么新增 `modal-layer.ts` 而不是复用 `Sheet`

`Sheet` 在关闭时**卸载**面板，所以它可以把所有模态逻辑放在一个以 `open` 为键的 effect 里。历史栏不能这样做：常驻与抽屉是同一个 `<aside>`，必须留在 DOM 里让滑动过渡生效。因此模态能力要能施加到已存在的节点上，并在关闭或窗口变宽时完全撤除。

`Sheet.tsx` 一行未改，它的 21 项测试全部通过。

---

## 3. 模态语义与焦点管理

| 状态 | `role` | `aria-modal` | `inert` | 焦点 |
| --- | --- | --- | --- | --- |
| ≥1280px 常驻 | 无 | 无 | `false` | 普通区域，Tab 自由进出 |
| 抽屉关闭 | `dialog` | 无 | **`true`** | 不可达 |
| 抽屉打开 | `dialog` | **`true`** | `false` | 进入抽屉，Tab 内循环 |

Tab 循环实现（`useModalLayer`）：

- Tab 在最后一个可聚焦控件 → 第一个；
- Shift+Tab 在第一个控件 → 最后一个；
- 焦点不在抽屉内时**不介入**——菜单/对话框自己管 Tab 顺序。

焦点回收：优先回到打开前的元素；若它已不可见（例如窗口变宽后抽屉按钮被移除），回退到课程栏第一个按钮，而不是停在 `<body>`。

---

## 4. 背景 `inert` 与滚动锁

**背景隔离**：从抽屉向上遍历祖先，把每一层的兄弟元素设为 `inert`，跳过：

- 包含抽屉自身的祖先（否则抽屉自己也会被禁用）；
- overlay portal（`[data-radix-popper-content-wrapper]`、`dialog`、`[role=dialog|menu|listbox]`）——它们有独立的模态语义，被 `inert` 会直接废掉刚打开的菜单。

**滚动锁**：`modal-layer.ts` 内用引用计数，而不是布尔值。

- 第一个模态层进入时记录原始 `body.style.overflow` 并设为 `hidden`；
- 最后一个离开时恢复原始值；
- 因此「关闭一层弹层不能解除另一层仍需要的隔离」这条要求是结构性满足的，而不是靠调用顺序碰运气。

---

## 5. 嵌套菜单与对话框兼容性

浏览器实测（1279 / 1024 / 901 / 900 / 390 / 320 六档一致）：

| 检查 | 结果 |
| --- | --- |
| 抽屉内「会话操作」菜单可用键盘打开 | 是 |
| 菜单显示在抽屉之上（`elementFromPoint` 命中菜单） | 是（`z-index: 50` 抽屉 vs `100` portal） |
| 菜单未被抽屉的背景 `inert` 波及 | 是（portal 跳过） |
| Escape 关闭菜单后抽屉仍在 | 是（`drawerSurvivedMenuEscape: true`） |
| 重命名对话框可打开、保存 | 是（页面级测试，`renameSession` 收到新标题） |
| 归档 / 删除回调正常 | 是（既有 `LearnPage.test.tsx` 全部通过） |
| Escape 同时关闭两层 | 否（`hasOpenOverlay()` 检查，菜单先处理） |

---

## 6. 关闭与视口切换后的状态清理

| 场景 | 结果 |
| --- | --- |
| 关闭按钮 / 遮罩 / Escape 关闭 | 抽屉 `inert` 恢复，`body` 滚动恢复，焦点回到触发按钮 |
| 1024 → 1440（抽屉 → 常驻） | `role`/`aria-modal` 清除、`inert=false`、滚动锁解除、焦点留在常驻栏的「返回课程选择」 |
| 1440 → 1024（常驻 → 关闭抽屉） | 抽屉回到关闭态（`inert`），**不抢焦点**（落在 `body`，不是隐藏控件） |
| 900 ↔ 901 | 两侧都是抽屉，语义一致（`dialog` / 关闭时 `inert`），没有两个焦点管理器 |

浏览器实测数据见第 10 节。

---

## 7. 与学习上下文 Sheet 的互斥

- 打开历史抽屉会清除 `contextSessionId`，Sheet 关闭；
- 打开 Sheet 会 `setMobileNavOpen(false)`，抽屉关闭；
- 两者各自调用 `useModalLayer` / `Sheet` 的滚动锁，计数叠加，关闭其中一个不会解除另一个仍需要的锁；
- 页面级测试 `T13` 断言：打开 Sheet 后抽屉 `aria-modal` 消失、`inert` 恢复，且 `body.style.overflow` 回到空值（桌面 Sheet 非模态）。

---

## 8. 自动化测试结果

| 文件 | 用例数 | 结果 |
| --- | ---: | --- |
| `learn/LearnHistoryRail.test.tsx` | 23 | 通过 |
| `LearnPage.course-bar.test.tsx` | 39 | 通过 |
| `learn/LearnContextSheet.test.tsx` | 21 | 通过 |
| **定向合计** | **83** | **全部通过** |

全 Web 目录：44 文件 / 534 项通过。

### 新增用例对照

| 编号 | 用例 |
| --- | --- |
| T01 | 关闭的抽屉 `inert`，控件仍在 DOM 但不可达 |
| T02 | 打开后是 `dialog` + `aria-modal`，焦点在内部 |
| T03 / T04 | Tab 从最后回到第一；Shift+Tab 反向 |
| T05 / T08 | 背景 `inert`、`body` 滚动锁；卸载后恢复 |
| T06 | Escape 关闭 |
| T07 | 遮罩关闭（页面级 T13 覆盖互斥，组件级覆盖回调） |
| T09 / T10 | 菜单 portal 不被 inert；重命名对话框可用 |
| T11 / T12 | 常驻列无模态语义、不可聚焦问题；窗口变宽后清理 |
| T13 | 与上下文 Sheet 互斥、滚动锁不串扰 |
| T14 | 关闭后 Tab 不进入抽屉（浏览器实测 `afterCloseFocusIntoRail: false`） |

### 测试局限（如实说明）

jsdom 不实现 `inert` 的焦点语义，也不做布局。组件测试只能证明**契约**（`inert` 标志、`role`/`aria`、焦点目标、Tab 循环、滚动锁）。真实的 Tab 顺序与原生 `inert` 行为由第 10 节的浏览器键盘验收证明——**正是这一步发现了第 1.3 节的 effect 顺序缺陷**。

---

## 9. TypeScript、构建与全量测试

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |
| `npm test` | 189 文件 / 2066 通过 / 1 失败 / 3 跳过 |

唯一失败：

| 文件 | 用例 | 判定 |
| --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2） | **基线既有失败**：P2-2-R1 起在 `853d470` 复现，P2-3、P2-4 均记录在案，本轮未改后端 |

用例总数从 P2-4 的 2056 增至 2070（+14：历史栏 11、页面 3）。没有删除、跳过或放宽任何失败测试。

**结论：P2-4-R1 增量 PASS，项目全量仍存在基线失败。**

---

## 10. 浏览器键盘验收证据

真实构建 + 真实服务端（`:3104`）+ Playwright 实际按键，不是模拟。

| 视口 | 模式 | 打开后焦点 | Tab 离开抽屉 | Shift+Tab 离开 | 菜单 | 菜单在抽屉之上 | Escape 关闭抽屉 | 焦点回触发按钮 | 关闭后 Tab 进入抽屉 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1440 | 常驻 | — | 正常（普通区域） | — | — | — | — | — | 否 |
| 1280 | 常驻 | — | 正常（普通区域） | — | — | — | — | — | 否 |
| 1279 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |
| 1024 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |
| 901 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |
| 900 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |
| 390 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |
| 320 | 抽屉 | 返回课程选择 | **否** | 否 | 打开 | 是 | 是 | **是** | 否 |

其他指标：

| 检查 | 结果 |
| --- | --- |
| 关闭态 `inert` | `true`（六档抽屉） |
| 打开态 `aria-modal` | `"true"`（六档） |
| 打开态 `body.style.overflow` | `"hidden"`，关闭后 `""` |
| 视口切换 1024→1440 | 模态语义清除、`inert=false`、滚动锁解除 |
| 视口切换 1440→1024 | 回到关闭抽屉、不抢焦点 |
| 900 ↔ 901 | 语义一致 |
| 控制台错误 | 0 |
| 横向溢出 | 0（全部视口） |
| 1024px 聊天宽 | **928px**（与 P2-4 一致，未回退） |

截图（`docs/ui-redesign/phase3/P2-4-R1-assets/`，20 张 + `metrics.json`）：

| 组 | 文件 |
| --- | --- |
| 常驻 | `{1280,1440}-permanent.png` |
| 抽屉打开 | `{1279,1024,901,900,390,320}-drawer-open.png` |
| 抽屉关闭 | `{1279,1024,901,900,390,320}-drawer-closed.png` |
| 菜单展开 | `{1279,1024,901,900,390,320}-menu-open.png` |
| 指标 | `metrics.json` |

---

## 11. 已知问题

1. **`server.e48-workbench` 基线失败**仍然存在，与前端无关。
2. **焦点回到 `<body>` 的两种情形**：抽屉关闭后若无可见的打开按钮（常驻模式），或 1440 → 1024 切换时，焦点停在 `body`。这是「不抢焦点」的预期行为，不是残留。
3. **`inert` 的浏览器支持**：Chrome 102+、Safari 15.5+、Firefox 112+ 原生支持。更老的浏览器会退化为「仅 `aria-hidden`」，即回到修复前的行为，不会更差。本轮不引入 polyfill（任务要求不新增依赖）。
4. **常驻栏的 `escaped=true` 指标**是验收脚本的口径问题：它检查「焦点是否在历史栏内」，而常驻栏本来就是普通区域，Tab 会继续遍历全局导航。真正相关的「关闭后 Tab 是否进入隐藏抽屉」为 `false`。

---

## 12. Git

- 继续提交到 `feat/e49g-p2-4-history-start-panel`
- 未合并 `main`，未推送 `main`
- PR 目标：`main`

### PASS 判定

| 条件 | 结果 |
| --- | --- |
| 关闭抽屉时内部控件不能获得焦点 | 是（`inert`，六档实测） |
| 打开抽屉后焦点限制在合法模态交互范围内 | 是 |
| 背景无法被键盘操作 | 是（`inert`） |
| Escape、遮罩、关闭按钮正常 | 是 |
| 焦点返回和背景滚动状态正确恢复 | 是 |
| 更多菜单、重命名、归档、删除正常 | 是 |
| 视口切换没有模态状态残留 | 是 |
| 与学习上下文 Sheet 保持互斥 | 是 |
| 1024px 聊天区宽度不回退 | 是（928px） |
| 原有学习业务规则不变 | 是（全 Web 534 项通过） |
| 定向测试与构建通过 | 是（83/83，构建通过） |
| 无新增确定性全量测试失败 | 是 |
| 浏览器键盘验收通过 | 是 |
| 验收报告完整 | 是 |

**结论：P2-4-R1 增量 PASS，项目全量仍存在基线失败。**
