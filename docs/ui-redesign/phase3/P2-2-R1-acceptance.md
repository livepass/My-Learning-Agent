# E4.9g-P2-2-R1 验收报告：课程栏边界与可访问性修复

- **基准**：`853d4707258fb9a3732ba4114b0a17f58957061d`（`feat/e49g-p2-2-learn-coursebar` HEAD，与 `origin` 一致）
- **工作分支**：`feat/e49g-p2-2-learn-coursebar`
- **代码提交**：`96e6a44`（代码、测试、截图与本报告同一提交）
- **结论**：**PASS**（全量测试存在 1 项既有确定性失败，与本轮无关，见 7.2）

---

## 1. 原始问题与触发条件

| 编号 | 问题 | 触发条件 | 证据 |
| --- | --- | --- | --- |
| R1-1 | 学习警告无法在触屏与键盘下查看 | 服务端 `learning/start` 返回 `warnings` 后 | 旧实现是 `role="img"` 的 `span`，内容只在 `title` / `aria-label`；触屏不显示 `title`，键盘无法打开 |
| R1-2 | 切换历史会话时课程栏短暂使用上一门课程 | 从课程 A 的会话切到课程 B 的会话，且 B 的 `sessionContext` 尚未返回 | `barCourse` 在服务端上下文到达前回退到页面级 `selectedCourse`（此时仍是 A） |
| R1-3 | 验收报告测试统计对不上 | 阅读 `P2-2-acceptance.md` 5.1 节 | 10 + 8 + 77 = 95，但合计写 103，漏记一个 8 项测试文件 |

R1-1 的触发条件需要说明：`warnings` 只由 `POST /api/courses/:id/learning/start` 产生，并由今日学习页在启动会话后写入 `coursesStore`（`TodayPage.startCourseLearning` → `recordStartWarnings`）。直接打开 `?session=` 不会产生警告，因此视觉验收必须走「今日学习 → 开始/继续学习」这条真实路径。

---

## 2. 代码修改清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/pages/learn/LearnCourseBar.tsx` | 修改 | 警告标记由不可交互 `span` 改为 `Popover` + `PopoverTrigger` 按钮；弹层用 `<ul><li>` 逐条列出服务端原文 |
| `react/pages/LearnPage.tsx` | 修改 | 重写 `barCourse` 选择顺序；移除 `selectedCourse` 回退；空态提示改用 `barCourse`；新增 `barUnclassified` |
| `react/shell/shell.css` | 追加 | 警告按钮（24px 命中区、focus-visible、open 态）与警告弹层（换行、视口内宽度、暗色可读） |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `learn.courseBar.warnings`、`learn.courseBar.warningsOpen` |
| `react/pages/learn/LearnCourseBar.test.tsx` | 修改 | 新增 6 项警告可访问性测试（10 → 16） |
| `react/pages/LearnPage.course-bar.test.tsx` | 修改 | 新增 4 项绑定过渡测试（8 → 12） |
| `react/pages/LearnPage.workbench.test.tsx` | 修改 | 修正空会话夹具的服务端上下文（见 3.4），测试数不变（15） |
| `docs/ui-redesign/phase3/P2-2-R1-assets/` | 新增 | 14 张真实页面截图 + `metrics.json` |
| `docs/ui-redesign/phase3/P2-2-R1-acceptance.md` | 新增 | 本报告 |

未修改 Store、API、后端、`LearningWorkspace`、`LearnContextPanel`、全局导航或历史栏结构。

---

## 3. 课程绑定优先级

### 3.1 新顺序

```
sessionContext 已返回
  ├─ unclassified === true        → 不显示课程（未归类），不回退任何课程
  ├─ course 存在                  → 用它的 course_id / title / status
  └─ 否则（无 course）            → 不显示课程
sessionContext 未返回
  ├─ 当前会话 meta 有 course      → 用 meta 的 course_id / title；
  │                                 status 仅按 course_id 精确匹配课程列表，未命中为 null
  └─ 无                          → 不显示课程
```

`selectedCourse` 不再是任何一步的回退。

### 3.2 为什么去掉 `selectedCourse`

`learnWorkbenchStore.courseId` 在打开会话时由 `adoptCourse` 采纳绑定，但采纳发生在 `sessions` 列表含该会话之后。从 A 切到 B 的瞬间，`courseId` 仍是 A，`selectedCourse` 就是 A —— 这正是旧实现把 A 的名称、任务和「课程计划」入口画在 B 下面的窗口。会话自身的 meta 绑定属于同一份服务端绑定（只是先一步读到），可以安全地顶替这个窗口；`selectedCourse` 不能。

### 3.3 不做什么

- 不按会话标题猜课程，不按「最近学习课程」猜绑定。
- 不把历史会话重新绑定到其他课程，不向 Store 写入伪造绑定。
- 未确认课程时，「课程计划」和「新建对话」不渲染（`LearnCourseBar` 只在 `course` 存在时渲染它们），因此不会指向其他课程。
- 服务端上下文到达后以服务端结果为准（`sessionContext` 存在时只看 `boundContext`）。
- `learnWorkbenchStore` 的课程选择与 URL 恢复逻辑未改。

### 3.4 一处测试夹具的修正

`LearnPage.workbench.test.tsx` 的「空会话」用例把会话声明为绑定 Python，却让 `getSessionCourseContext` 使用默认 mock 返回 `unclassified: true`。旧回退把这个矛盾藏住了：`selectedCourse` 提供了课程名。修复后服务端明确的 `unclassified` 会正确阻止课程名，因此该夹具改为返回真实绑定（`unclassified: false`，`binding.course_id = course_python`）。这是夹具纠错，断言与业务行为未放宽。

---

## 4. 警告交互与无障碍

| 要求 | 实现 | 证据 |
| --- | --- | --- |
| 无警告不显示入口 | `warnings.length > 0` 才渲染 `Popover` | 组件测试 T01；截图 `1440-no-warning.png`（`trigger: null`） |
| 单条警告显示完整原文 | 弹层内 `<li>` 文本节点 | 组件测试 T02 |
| 多条全部可读 | `warnings.map` 逐条 `<li>` | 组件测试 T03（`getAllByRole("listitem")` 顺序与原文一致） |
| Enter / Space 打开 | 原生 `<button>` + Radix `PopoverTrigger` | 组件测试断言 `tagName === "BUTTON"`、`aria-haspopup="dialog"`、`aria-expanded` 变化 |
| Escape 关闭 | Radix 默认行为 | 组件测试 + 浏览器：`Escape` 后 `popover: false` |
| 关闭后焦点返回 | Radix 默认行为 | 组件测试 `document.activeElement === trigger`；浏览器 5 档宽度 `focusIsTrigger: true` |
| 触屏可点 | 24×24 命中区（视觉 16px），负边距不改变行高 | 浏览器 390 / 320 截图与指标 |
| 超长警告换行不横向溢出 | `overflow-wrap: anywhere`，`max-width: min(340px, calc(100vw - 16px))` | 5 档宽度 `overflow = 0`、`popoverOverflow = 0` |
| 深色可读 | 复用 `--inno-text` / `--inno-text-muted` / `--inno-border`，无裸色值 | 暗色截图 + 计算样式（见 8.3） |
| 不把服务端字符串当 HTML | 仅作为 React 文本子节点渲染 | 组件测试断言 `li.textContent` 等于原文 |
| 文案 | 新增 `learn.courseBar.warnings` / `warningsOpen`，中英结构一致 | `i18n/locales.test.ts` 8/8 通过 |

警告正文保持后端原文，未翻译、未改写、未编造。

---

## 5. 测试统计（R1-3）

### 5.1 核对结论

`P2-2-acceptance.md` 5.1 节的「合计 103」并不只是加法错误：它漏记了一个 8 项测试文件。实际执行结果为：

| 文件 | 用例数 | 归属 |
| --- | ---: | --- |
| `react/pages/learn/LearnCourseBar.test.tsx` | 10 | P2-2 新增 |
| `react/pages/LearnPage.course-bar.test.tsx` | 8 | P2-2 新增 |
| `react/pages/LearnPage.test.tsx` | 24 | 既有 |
| `react/pages/LearnPage.welcome.test.tsx` | 8 | 既有 |
| `react/pages/LearnPage.workbench.test.tsx` | 15 | 既有 |
| `react/pages/LearnPage.course-context.test.tsx` | 3 | 既有 |
| `react/pages/learn/LearnContextPanel.test.tsx` | 12 | 既有 |
| `react/pages/learn/LearnSessionRow.test.tsx` | 6 | 既有 |
| `react/pages/learn/LearnStartPanel.test.tsx` | 11 | 既有 |
| `i18n/locales.test.ts` | 8 | 既有（漏记的 8 项） |
| **合计** | **105** | 10 文件 |

即：报告中的 77 项只统计了 6 个学习页测试文件，漏掉了 `i18n/locales.test.ts` 的 8 项；「合计 103」= 10 + 8 + 77 + 8。原始日志未改动，也没有为对齐数字修改任何断言。原报告保留原样，本节作为更正说明。

### 5.2 本轮后的定向测试

| 文件 | 用例数 |
| --- | ---: |
| `learn/LearnCourseBar.test.tsx` | **16**（+6） |
| `LearnPage.course-bar.test.tsx` | **12**（+4） |
| 其余 8 个文件 | 87 |
| **合计** | **10 文件 / 115 项通过** |

命令：

```bash
npx vitest run apps/learning-agent/web/src/react/pages/learn/LearnCourseBar.test.tsx \
  apps/learning-agent/web/src/react/pages/LearnPage.course-bar.test.tsx \
  apps/learning-agent/web/src/react/pages/LearnPage.test.tsx \
  apps/learning-agent/web/src/react/pages/LearnPage.welcome.test.tsx \
  apps/learning-agent/web/src/react/pages/LearnPage.workbench.test.tsx \
  apps/learning-agent/web/src/react/pages/LearnPage.course-context.test.tsx \
  apps/learning-agent/web/src/react/pages/learn/LearnContextPanel.test.tsx \
  apps/learning-agent/web/src/react/pages/learn/LearnSessionRow.test.tsx \
  apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.test.tsx \
  apps/learning-agent/web/src/i18n/locales.test.ts
```

结果：`Test Files 10 passed (10)`，`Tests 115 passed (115)`。

### 5.3 新增回归测试

| 编号 | 场景 | 用例 |
| --- | --- | --- |
| T01 | 没有警告 | `renders no warning entry when the server sent no warnings` |
| T02 | 单条警告显示完整原文 | `opens a single warning with its full server text on click` |
| T03 | 多条警告全部可读 | `lists every warning instead of only the first` |
| T04 | 键盘可访问 | `exposes a native button so Enter and Space activate it` + `closes with Escape and returns focus to the trigger` |
| T05 | A→B 上下文延迟 | `does not show the previous course while B's context is still loading` |
| T06 | B 的上下文返回 | `switches to B's task and stage once the server context arrives` |
| T07 | 未归类 + 本地旧课程 | `keeps an unclassified conversation unbound even with a stale course selected` |
| T08 | 服务端与本地缓存不一致 | `prefers the server binding over the cached session meta` |

另有一项中英文标签测试（`keeps the warning entry labelled in both languages`）。

### 5.4 既有行为回归

原有测试全部继续通过：选择课程不创建会话、新建对话不自动发送、快捷操作只填草稿、首次发送才创建绑定会话、归档与未归类会话只读、任务与阶段来自服务端、学习状态展开/收起、中英文切换。

---

## 6. TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过（45.8s） |
| `npm run build` | 通过（server + web，26.7s） |

---

## 7. 全量测试

### 7.1 执行

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 第一次全量 | `npm test` | 187 文件，1990 通过 / 2 失败 / 3 跳过 |
| 第二次全量 | `npm test` | 187 文件，1991 通过 / 1 失败 / 3 跳过 |
| 第三次全量 | `npm test` | 187 文件，1991 通过 / 1 失败 / 3 跳过（仅 `server.e48-workbench`） |
| 隔离复跑（后端） | `npx vitest run apps/learning-agent/src/server.e48-workbench.test.ts` | 1 失败 / 8 通过（同一项） |
| 基线对照（stash 本轮改动后复跑同一文件） | 同上 | **同样 1 失败** |

### 7.2 失败项判定

| 文件 | 用例 | 失败形态 | 判定 |
| --- | --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting` | `providerCalls` 为 2，断言期望 1 | **既有确定性失败**：在 `853d470` 基线（本轮改动全部 stash）上同样失败，单独运行稳定复现 2 次 |
| `react/MarkdownArtifact.test.tsx` | 与 SVG artifact 同页的时序断言 | 仅在第一次全量的默认并发下出现 | 环境/时序抖动；该文件本轮未修改，第二、三次全量均未复现 |

`server.e48-workbench` 的失败不在本轮修改范围内（本轮未改后端、未改 provider 调用路径），按「不顺手修复范围外问题」保留原状并记录在此。本轮没有删除、跳过或放宽任何失败测试。

与基线的用例总数对照：

- 基线 `853d470` 的全量总数是 **1985**（P2-2 报告 5.2 节记录的受限并发运行：187 文件 / 1982 通过 / 3 跳过）。
- 本轮新增 10 项测试（6 + 4），全量用例总数 **1995 = 1985 + 10**，与两次运行的 `1990 + 2 + 3` / `1991 + 1 + 3` 一致。
- 本轮无既有用例被删除或跳过：3 项跳过与基线一致（Node 无 SQLite FTS5、文件系统不支持符号链接、Windows 跳过 0o600 权限断言）。

---

## 8. 响应式与视觉检查

真实构建产物（`npm run build` 的 `dist/`）+ 真实服务端（`node apps/learning-agent/dist/server.js`，端口 3100，独立 `INNO_HOME`）+ Playwright 拦截 `/api/**` 提供受控数据。没有发送消息、没有创建会话、没有写设置。

### 8.1 警告弹层（浅色）

| 视口 | 课程栏高度 | 弹层尺寸 | 弹层在视口内 | 弹层横向溢出 | 页面横向溢出 |
| --- | ---: | --- | --- | ---: | ---: |
| 1440 × 900 | 50 | 340 × 110 | 是 | 0 | 0 |
| 1024 × 768 | 76 | 340 × 110 | 是 | 0 | 0 |
| 900 × 800 | 75 | 340 × 110 | 是 | 0 | 0 |
| 390 × 844 | 79 | 340 × 110 | 是 | 0 | 0 |
| 320 × 640 | 83 | 304 × 110 | 是 | 0 | 0 |

- 课程栏高度与 P2-2 基线完全一致（50 / 76 / 75 / 79 / 83）：24px 命中区用 `-4px` 负边距抵消，没有把栏撑高。
- 5 档宽度 Escape 关闭后 `popover: false`、`focusIsTrigger: true`。
- 320px 弹层自动收窄到 304px，两条警告都完整换行显示。

### 8.2 无警告

`1440-no-warning.png`：`trigger: null`，课程栏只显示课程、任务、阶段与三个动作。

### 8.3 深色主题

| 视口 | 弹层在视口内 | 正文颜色 | 表面色 | 边框色 |
| --- | --- | --- | --- | --- |
| 1440 × 900 | 是 | `rgb(197, 197, 197)` | `rgb(56, 56, 56)` | `rgb(59, 59, 59)` |
| 390 × 844 | 是 | `rgb(197, 197, 197)` | `rgb(56, 56, 56)` | `rgb(59, 59, 59)` |

全部来自共享语义 token（`--inno-text-muted` / `--inno-surface-raised` / `--inno-border`），无新增裸色值；标题与列表标记在深色下清晰可读。

### 8.4 课程绑定过渡

| 场景 | 课程栏文本 | 结果 |
| --- | --- | --- |
| A→B，B 上下文延迟 8s（会话 meta 已绑 B） | `英语学术写作 进行中 课程计划 学习状态 新建对话` | 不出现「Python 编程」、不出现 A 的任务与阶段；URL 已由 `adoptCourse` 改为 `course=course_english` |
| 上下文到达后 | `英语学术写作 … 当前任务 搭建论证结构 阶段：第二阶段：论点与证据 …` | 正确切换到 B 的任务与阶段，无 A 残留 |
| 本地缓存仍写 Python、服务端绑定 B 且延迟 | `Python 编程 进行中 课程计划 学习状态 新建对话` | 会话 meta 是此刻唯一可用绑定，显示 Python 但**不显示任务/阶段**；服务端到达后切换为 B。这是「服务端优先于本地缓存」的过渡态，不是回退到 `selectedCourse` |
| 未归类会话（URL 仍带 `course=course_python`） | `未归类对话 未归类 学习状态` | 无课程名、无任务；`课程计划` 与 `新建对话` 均不存在 |

### 8.5 课程菜单与警告弹层

390px：打开警告弹层后再点「切换课程」，菜单打开时弹层已关闭（`popoverOpenWithMenu: false`、`menuOpen: true`），两者不叠放、不互相遮挡；Composer 与底部导航可见。

### 8.6 截图索引（`docs/ui-redesign/phase3/P2-2-R1-assets/`，14 张）

| 名称 | 内容 |
| --- | --- |
| `1440-warning-open.png` | 桌面警告弹层展开 |
| `1024-warning-open.png` / `900-warning-open.png` | 中间宽度弹层展开 |
| `390-warning-open.png` / `320-warning-open.png` | 手机警告弹层展开 |
| `dark-1440-warning-open.png` / `dark-390-warning-open.png` | 深色主题弹层 |
| `1440-no-warning.png` | 无警告时无入口 |
| `1440-transition-pending.png` / `1440-transition-settled.png` | A→B 过渡与到达后 |
| `1440-stale-cache-pending.png` / `1440-stale-cache-settled.png` | 本地缓存与服务端不一致 |
| `1440-unclassified.png` | 未归类会话 |
| `390-warning-then-menu.png` | 弹层与课程菜单不遮挡 |
| `metrics.json` | 全部布局与状态指标 |

所有页面控制台 0 错误（`errors: []`）。

---

## 9. 修复前后差异

| 方面 | 修复前 | 修复后 |
| --- | --- | --- |
| 警告入口 | 不可交互 `role="img"` span，内容在 `title` | 原生 button + Popover，触屏/鼠标/键盘均可打开 |
| 多条警告 | 合并成一行 `" · "` 字符串塞进 `title` | 逐条 `<li>`，可完整阅读与换行 |
| 键盘 | 无法打开 | Enter / Space 打开，Escape 关闭，焦点返回 |
| 绑定过渡 | `sessionContext` 未到时回退 `selectedCourse`（可能是上一门课程） | 只用服务端上下文或当前会话 meta；`selectedCourse` 不参与 |
| 未归类 | 服务端未返回时可能借 `selectedCourse` 显示课程 | 服务端明确未归类即不显示课程，且不回退 |
| 空会话提示 | `selectedCourse` 优先 | 与课程栏同一份 `barCourse` |
| 课程状态 | `selectedCourse` 或 meta 归档推断 | 按 `course_id` 精确匹配课程列表，未命中为 `null` |
| 测试统计 | 漏记 `i18n/locales.test.ts` 的 8 项 | 第 5 节列出 10 个文件与 105 项的完整构成 |

---

## 10. 未解决与风险

1. **`server.e48-workbench` 既有失败**：基线即失败，非本轮引入；本轮未修改后端，按范围约束保留并记录。
2. **会话 meta 与服务端绑定不一致的过渡窗口**：本地缓存写错课程时，上下文到达前会显示缓存课程（不显示任务/阶段），到达后纠正。这是「当前会话绑定优先于 `selectedCourse`」的直接结果；彻底消除需要服务端列表先于页面渲染返回，超出本轮范围。
3. 1024px 聊天列宽度仍为 452px，本轮按要求未扩大（P2-3 范围）。
4. 警告弹层的 `align="end"` 在极窄屏由 Radix 视口避让自动调整，320px 实测 304px 宽、距左右各 8px，未溢出。

---

## 11. 提交与合并建议

- **最终提交**：`96e6a44`（分支 `feat/e49g-p2-2-learn-coursebar`，已推送，`origin` 指向该提交）。
- 未合并 `main`，未推送 `main`。
- 建议合并：**是**。PASS 判定项全部满足；唯一的全量失败在基线即存在且与本轮无关。
- PR 目标：`main`。本环境 `gh` 未登录（`You are not logged into any GitHub hosts`），无法直接创建 PR，可从以下地址创建：

`https://github.com/livepass/My-Learning-Agent/compare/main...feat/e49g-p2-2-learn-coursebar?expand=1`

### PASS 判定表

| 条件 | 结果 |
| --- | --- |
| 警告可通过触摸、鼠标和键盘访问 | 是 |
| 真实警告内容没有丢失 | 是（服务端原文逐条渲染） |
| 会话切换期间不显示错误的课程绑定 | 是（A 的名称/任务/阶段/计划入口均不出现） |
| 未归类会话不发生错误绑定或跳转 | 是 |
| 原有学习业务逻辑没有回归 | 是（定向 115/115） |
| 新增测试全部通过 | 是（+10 项） |
| 完整构建通过 | 是 |
| 全量测试没有新增确定性失败 | 是（唯一确定性失败在基线即存在） |
| 响应式验收通过 | 是（5 档无溢出，弹层在视口内） |
| 测试统计与执行结果一致 | 是（第 5 节） |
| R1 验收报告已提交 | 是 |

**结论：PASS。**
