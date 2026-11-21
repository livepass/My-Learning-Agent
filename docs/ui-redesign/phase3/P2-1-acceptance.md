# E4.9g-P2-1 验收报告：AI 学习页组件拆分与行为冻结

- **基准提交**：`ae917e17e0a402085b08433a393800835c2b314a`
- **工作分支**：`refactor/e49g-p2-1-learn-components`
- **代码提交**：`4b18de507c2e2f1a06d953d4aeca5c705388d238`
- **最终提交**：本报告与截图所在提交（分支 HEAD）；代码提交 `4b18de5`
- **结论**：**PASS**（组件拆分完成，业务行为、DOM 与视觉均未变化；未合并 `main`）

---

## 1. 本轮范围

只做展示层拆分，为 E4.9g-P2-2 的布局改造做准备。没有新增课程栏、历史侧栏、上下文 Sheet、移动端底部 Sheet、Composer 快捷菜单，也没有调整聊天宽度或全局导航。

未修改：

- `LearningWorkspace.tsx`（发送、流式、编辑、分支、模型选择）
- `CourseContextStrip.tsx` 及其显示位置
- 任何 Store、API、后端、路由、CSS
- `.mla-learn` 三栏布局

---

## 2. 修改文件

| 文件 | 变化 | 说明 |
| --- | ---: | --- |
| `react/pages/LearnPage.tsx` | 1101 → 641 行（+71 / −531） | 保留 Store、URL、绑定、写操作与组合职责 |
| `react/pages/learn/LearnSessionRow.tsx` | 新增 103 行 | 单条会话行展示 |
| `react/pages/learn/LearnStartPanel.tsx` | 新增 328 行 | 欢迎态与空会话引导 |
| `react/pages/learn/LearnContextPanel.tsx` | 新增 235 行 | 学习状态面板 |
| `react/pages/learn/LearnSessionRow.test.tsx` | 新增 160 行 | 6 项组件测试 |
| `react/pages/learn/LearnStartPanel.test.tsx` | 新增 187 行 | 8 项组件测试 |
| `react/pages/learn/LearnContextPanel.test.tsx` | 新增 199 行 | 12 项组件测试 |
| `docs/ui-redesign/phase3/P2-1-acceptance.md` | 新增 | 本报告 |
| `docs/ui-redesign/phase3/P2-1-assets/` | 新增 | 18 张真实页面截图 + 对比结果 |

没有 `components-v2`、`new-ui`、`backup` 或 `LearnPageV2` 一类的平行实现。

---

## 3. 组件职责与 Props

### 3.1 `LearnSessionRow`

只负责一行会话的展示与菜单入口；打开、重命名、归档、删除都由 `LearnPage` 的回调执行。

| Prop | 类型 | 作用 |
| --- | --- | --- |
| `session` | `SessionMeta` | 名称、预览、消息数、课程任务、归档标记 |
| `active` | `boolean` | 写入 `aria-current="true"` |
| `busy` | `boolean` | 任一 Store 写操作进行中，整行禁用 |
| `pending` | `boolean` | 仅当前行显示 spinner，其他行只禁用 |
| `unclassified` | `boolean` | 追加「· 未归类」后缀 |
| `onOpen` | `() => void` | 调 `openConversation` |
| `onRename` | `() => void` | 打开页面已有的重命名对话框 |
| `onArchive` | `() => void` | 调页面已有的 `archiveOne` |
| `onDelete` | `() => void` | 调页面已有的 `removeSession`（含 `window.confirm`） |

保留 `mla-session-row` / `mla-session-item` / `mla-session-more` / `mla-session-menu` 类名、`aria-current`、菜单项顺序和 danger 样式。欢迎态历史与会话态左栏共用同一组件。

### 3.2 `LearnStartPanel`

| Prop | 类型 | 作用 |
| --- | --- | --- |
| `mode` | `"welcome" \| "empty"` | 区分欢迎首页与空会话引导 |
| `onFillDraft` | `(text: string) => void` | 唯一动作：写入草稿 |
| `renderSessionRow` | `(session) => ReactNode` | 欢迎态历史复用 `LearnSessionRow` |
| `course` | `CourseSummary \| null` | 已选课程；null 时显示课程卡 |
| `coursesLoading` / `coursesError` | `boolean` / `CourseErrorRef \| null` | 加载与失败态 |
| `activeCourses` / `archivedCourses` | `CourseSummary[]` | 课程卡与空态文案 |
| `sessions` | `SessionMeta[]` | 课程卡「最近学习」日期 |
| `courseConversations` / `unclassifiedSessions` | `SessionMeta[]` | 两段历史列表 |
| `showHistory` / `showUnclassified` | `boolean` | 展开状态由页面持有 |
| `archiveEntryCount` | `number` | 归档入口是否显示 |
| `onSelectCourse` / `onCreateCourse` / `onRetryCourses` | `() => void` 系列 | 课程选择、创建、重试 |
| `onToggleHistory` / `onToggleUnclassified` / `onOpenArchive` / `onSwitchCourse` | `() => void` | 页面已有动作 |
| `courseTitle`（empty） | `string \| null` | 空会话标题；null 用通用文案 |

快捷卡与 starter 都只调用 `onFillDraft`；页面把它接到 `appStore.setChatDraft`。组件内不出现 `chatStore.send`、`ensureConversation`、`createSessionWith` 或 `learning/start`。

### 3.3 `LearnContextPanel`

| Prop | 类型 | 作用 |
| --- | --- | --- |
| `open` | `boolean` | 展开 / 收起，写入 `aria-expanded` |
| `currentSessionId` | `string \| null` | 无会话时显示提示，不提供初始化 |
| `learning` | `{ state, isLoading, isSaving, error }` | 只读快照 |
| `readOnlySession` | `LearningReadOnlyReason \| false` | 归档 / 未归类只读 |
| `canPause` / `canResume` | `boolean` | 由页面按 checkpoint 状态与保存中计算 |
| `onToggle` | `() => void` | 页面记录「学习者主动选择」后切换 |
| `onRetry` / `onInit` / `onPause` / `onResume` | `() => void` | 页面已有 Store 调用 |

`STEP_LABEL_KEY`、`STATUS_LABEL_KEY`、`ACTION_LABEL_KEY` 与 `hasRealCheckpoint` 原样迁移；`hasRealCheckpoint` 从组件模块导出，`LearnPage` 的初始折叠判断继续使用同一份规则。组件从不自动 `init`，只在按钮点击时调用 `onInit`。

---

## 4. 业务逻辑是否变化

**没有变化。** 页面仍持有全部协调职责：

- Store 订阅：`sessionsStore` / `coursesStore` / `learnWorkbenchStore` / `learningStore`。
- URL 恢复：`applyLocation` 与 `popstate` 监听未改。
- 会话绑定：仍由 `session.course` 回填，`adoptCourse` 未改。
- 首次发送：`LearningWorkspace` 内部 `ensureConversation` → `learning/start` 未改。
- 会话管理：`openSession` / `renameSession` / `archiveSession` / `deleteSession` 仍在页面层调用。
- 学习状态：`load` / `init` / `pause` / `resume` 的调用点与条件未改。
- 权限：`blocked`、`readOnlySession`、`canPause`、`canResume` 的计算未改。
- 草稿隔离：`selectCourse` 清空草稿的既有行为未改。

| 验收点 | 结果 |
| --- | --- |
| 无课程欢迎态显示创建入口 | 通过（T01） |
| 选择课程不创建会话 | 通过（T02） |
| 快捷讲解 / 练习 / 复习只填草稿 | 通过（T03 + 组件测试） |
| 首次发送成功建立绑定会话后才发送 | 通过（T04） |
| 继续历史会话 | 通过（T05） |
| 未归类历史只读、不重绑定 | 通过（T06） |
| 重命名 / 归档 / 删除 | 通过（T07–T09） |
| 无检查点不自动初始化 | 通过（T10） |
| 初始化必须显式点击 | 通过（T11） |
| 暂停 / 继续条件 | 通过（T12） |
| 已完成检查点不能恢复 | 通过（T13） |
| 归档会话不能发送或修改 | 通过（T14） |
| 切换课程草稿隔离 | 通过（T15） |
| 中英文切换 | 通过（T16，现有语言测试） |
| 开始学习失败与重试 | 通过（T17） |
| 移动端历史抽屉 | 通过（T18） |

---

## 5. 自动化测试

### 5.1 定向测试

| 时点 | 文件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 重构前 | 6 | **77** | 0 | 0 |
| 重构后 | 9（6 现有 + 3 新增） | **103** | 0 | 0 |

现有 6 个文件：`LearnPage.test.tsx`、`LearnPage.welcome.test.tsx`、`LearnPage.workbench.test.tsx`、`LearnPage.course-context.test.tsx`、`LearningWorkspace.test.tsx`、`LearningWorkspace.e1.test.tsx`。

新增 26 项分布：

- `LearnSessionRow`：6 项（名称/预览/任务标识/未归类/归档、active、busy 与 pending、三个菜单回调、打开）。
- `LearnStartPanel`：8 项（快捷只填草稿、暂停课程、课程卡选择与创建、加载/失败、历史展开、未归类与归档、空会话 starter、无标题回退）。
- `LearnContextPanel`：12 项（展开/收起、无会话、加载、失败重试、显式初始化、只读、活动检查点、暂停/继续、完成锁定、`hasRealCheckpoint` 边界）。

### 5.2 全量测试

- 第一次 `npm test`：**185 个文件，1958 通过 / 3 失败 / 3 跳过**。
- 3 个失败全部位于后端进程测试：`server.learning-http.test.ts`（1）与 `server.session-archive.test.ts`（2），错误为 `ECONNREFUSED`（临时端口未就绪），与前端拆分无关。
- 单独复跑这两个文件：**15/15 通过**。
- 第二次 `npm test`：**185 个文件，1961 通过 / 0 失败 / 3 跳过**（`EXIT:0`）。

> 3 项跳过仍为环境守卫（Node 无 SQLite FTS5、文件系统不支持符号链接、Windows 跳过 0o600 权限断言），与重构前一致。全量新增 26 项组件测试，总数由 1938 增至 1964（含 3 项跳过）。

---

## 6. 构建结果

| 命令 | 结果 |
| --- | --- |
| 重构前 `npm --workspace my-learning-agent-web run build` | 通过（用于生成视觉基线） |
| `npx tsc -p tsconfig.json --noEmit` | 通过，0 错误 |
| 重构后 `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |

---

## 7. 视觉回归

### 7.1 方法

- 使用真实 React 构建产物，不是 `prototype.html`。
- 重构前：切到 `ae917e1` 构建；重构后：切回工作分支构建。
- 同一套受控 API 数据（课程、两个进行中会话、一个归档会话、检查点、消息），同一等待与字体加载条件。
- 每个组合在截图前把主滚动区与聊天滚动区复位到顶部，避免异步 Markdown 造成的滚动抖动。
- 逐像素比较（忽略亮度 1–7 的噪声）并比较布局矩形。

### 7.2 结果

| 分辨率 | 状态 | 聊天宽度 | 状态栏宽度 | 横向溢出 | 像素差异 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1440 × 900 | 6 个状态 | 796（状态展开）/ 996（收起） | 240 / 40 | 0 | **0** |
| 1024 × 768 | 6 个状态 | 452 / 632 | 220 / 40 | 0 | **0** |
| 390 × 844 | 6 个状态 | 366 | 366（堆叠） | 0 | **0** |

- **18/18 组合像素完全相同**，布局矩形、标题、消息数、Composer、课程上下文条、底部导航全部一致；浏览器控制台错误为 0。
- 历史栏宽度保持 260 / 232；未出现新的换行、截断、遮挡或抖动。
- 截图在 `docs/ui-redesign/phase3/P2-1-assets/`，机器可读结果在 `visual-regression.json`。

状态覆盖：未选择课程、已选未开始、正在学习、学习状态展开、学习状态收起、归档只读；每个状态均在 1440 / 1024 / 390 下检查。

---

## 8. 未解决问题与风险

1. **1024px 聊天区仍为 452px（状态展开时）**。这是 P2-1 明确不处理的既有布局问题，P2-2 / P2-3 解决；本轮只保证不改坏。
2. **全量测试的后端进程用例在并发满载时会偶发 `ECONNREFUSED`**。单独运行稳定通过，且不涉及任何被修改文件；属于测试环境抖动，不是本次拆分引入的回归。
3. **欢迎态课程错误文案仍沿用原实现**：`learn.welcome.courseError` 直接插值 `CourseErrorRef` 对象。该行为在重构前已存在，本轮为保持行为冻结未改动，建议在 P2-2 统一错误文案时处理。
4. 组件测试覆盖了 Props 与回调，但未引入快照测试；DOM 等价性由现有 77 项页面测试 + 18 张像素对比截图共同保证。

---

## 9. 下一阶段建议

1. **P2-2 只改布局**：把历史栏固定为 264px、聊天列上限 880px、状态栏移出网格；不要同时改文案与交互。
2. 保留 `LearnSessionRow` / `LearnStartPanel` / `LearnContextPanel` 的 Props 不变，先换容器与断点，降低回归面。
3. 在 P2-2 开始前，把本轮 18 张截图作为视觉基线；每次布局改动后重跑同一套状态。
4. 处理欢迎态错误文案，并补一条「课程列表失败」的页面级测试。
5. 移动端底部 Sheet 放到 P2-3，与 `inert`、焦点回收、`100dvh` 一起做。

---

## 10. 合并条件

| 条件 | 结果 |
| --- | --- |
| 三个展示组件完成拆分 | 是 |
| `LearnPage` 保留 Store / API / 路由协调 | 是 |
| 未新增业务功能 | 是 |
| 未修改 API / Store | 是 |
| 页面交互与重构前一致 | 是（103 项定向测试 + 18/18 像素一致） |
| 定向与全量测试通过 | 定向 103/103；全量见第 5.2 节 |
| 完整构建通过 | 是 |
| 视觉无明显变化 | 是（0 像素差异） |
| 验收报告已提交 | 是 |

**结论：PASS。** 分支已推送到 `origin/refactor/e49g-p2-1-learn-components`。

**PR 阻塞：** 本环境的 `gh` 未登录（`You are not logged into any GitHub hosts`），无法创建 PR。按任务要求保留分支、不推送 `main`；可在 GitHub 打开 compare 页面创建：

`https://github.com/livepass/My-Learning-Agent/compare/main...refactor/e49g-p2-1-learn-components?expand=1`
