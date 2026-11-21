# E4.9g-P1 实施映射：原型 → 现有 React 源码

- **基准提交**：`1f324efef5110c0e9bdad86e7af9756ebd2622ff`
- **原型**：`docs/ui-redesign/phase3/prototype.html`（推荐 A · 专注书桌）
- **本阶段**：只做展示层设计，不修改 `LearnPage.tsx`、Store、API 或全局导航
- **原则**：复用现有 Store / API / `LearningWorkspace`；只新增展示组件与样式；不伪造数据

---

## 1. 组件映射总表

| 原型区域 | 现有实现 / 数据来源 | P2 建议 | 复用方式 |
| --- | --- | --- | --- |
| 顶部栏、64px 图标栏、底部导航 | `react/shell/AppShell.tsx`（47–133） | 不改 | 直接复用 |
| 课程栏 | 现无；课程名来自 `learnWorkbenchStore.courseId` + `coursesStore.courses` | 新增 `react/pages/learn/LearnCourseBar.tsx` | 读现有 Store；新增展示 |
| 课程切换菜单 | 现无；欢迎页 `mla-course-picker` 卡片 | 新增 `LearnCourseSwitcher`（可放在 CourseBar 内） | `learnWorkbenchStore.selectCourse(id)` |
| 当前任务 / 阶段 | `CourseContextStrip.tsx`（20–72）读 `coursesStore.sessionContext(sessionId)` | 数据保留，视觉移入 CourseBar + ContextPanel | 复用 `sessionContext`，不再渲染旧 strip |
| 历史栏 | `LearnPage.conversationRow`（469–533）与 `.mla-learn-sidebar` | 新增 `react/pages/learn/LearnHistoryRail.tsx`；抽出 `SessionRow` | 复用 `sessionsStore` 与现有行结构 |
| 新建对话 | `learnWorkbenchStore.beginConversation()` | 历史栏按钮 | 直接复用 |
| 未归类历史 | `LearnPage.unclassifiedSessions`（266–270） | 历史栏分组 | 复用 `isDailyVisible` 与绑定规则 |
| 归档入口 | `openArchive()` → `navigate("settings", { settingsTab: "archive" })` | 历史栏底部 | 直接复用 |
| 会话头 | `LearnPage` 904–926 | 新增 `LearnChatHeader.tsx` | 复用当前会话与状态徽标 |
| 消息列表 / Markdown / 流式 | `LearningWorkspace.tsx` 703–841 | **不改** | 直接复用 |
| 编辑用户消息 / 分支 | `LearningWorkspace.tsx` 586–693 | **不改** | 直接复用 |
| Composer / 模型选择 / 停止 | `LearningWorkspace.tsx` 870–935 | **不改** | 直接复用 |
| 快捷操作 | `LearnPage.QUICK_ACTIONS`（75–99）与 `appStore.setChatDraft` | 新增大卡（开始面板）与 composer 内的快捷菜单 | 复用 prompt 键与 `setChatDraft` |
| 空会话 starter | `LearnPage.STARTER_PROMPTS`（102–106） | `LearnStartPanel.tsx` 的空会话分支 | 复用 prompt 键 |
| 学习状态 | `learningStore` + 现右栏 938–1060 | 新增 `react/pages/learn/LearnContextPanel.tsx` | 复用 `learning.state` / `init` / `pause` / `resume` |
| 学习上下文 sheet | 现无 | 新增 `LearnContextPanel` + 可选 `react/ui/Sheet.tsx` | 展示层 |
| 课程计划链接 | `navigate("course", { course: { id, view: "plan" } })` | ContextPanel 链接 | 直接复用 |
| 只读 / 阻塞说明 | `LearnPage.blocked`（308–357）与 `LearningReadOnlyReason` | 保留文案与状态机 | 直接复用 |
| 加载 / 失败 | `coursesLoading` / `coursesError` / `CourseErrorText` | 欢迎区骨架 / 错误卡 | 复用状态与文案 |
| 移动端抽屉 | 现 `.mla-learn-sidebar` fixed 抽屉 | 新布局复用同一 CSS 路径 | 现有模式 |
| 移动端上下文 sheet | 现状态面板排在聊天下方 | 新增底部 sheet | 新展示层 |
| 主题与 token | `app.css` / `themes.css` 的 `--inno-*` | 只使用语义 token | 直接复用 |

---

## 2. 数据与动作映射

### 2.1 课程栏

| 原型动作 | 现有方法 | 副作用 |
| --- | --- | --- |
| 切换课程 | `learnWorkbenchStore.selectCourse(id)` | 关闭当前会话、清空草稿、更新 URL；**不创建会话** |
| 打开课程计划 | `navigate("course", { course: { id, view: "plan" } })` | 路由跳转 |
| 打开学习上下文 | 本地 `contextOpen` | 只开/关 sheet |
| 新建对话 | `learnWorkbenchStore.beginConversation()` | 关闭当前会话；进入当前课程的空起点 |
| 查看归档 | `navigate("settings", { settingsTab: "archive" })` | 路由跳转 |

课程栏上的「进行中 / 已暂停 / 已完成」来自 `CourseSummary.status`；任务与阶段来自 `coursesStore.sessionContext(sessionId)`，无会话时不显示任务。不要用课程标题猜测绑定。

### 2.2 历史栏

```ts
const courseSessions = sessions.filter((session) =>
  session.course?.course_id === selectedCourse.course_id
  && (isDailyVisible(session) || session.id === currentSessionId)
);
```

- 点击会话：`sessionsStore.openSession(session.id)`；课程由 `session.course` 回填，URL 用 `replace` 修正。
- 未归类历史：`!session.course && isDailyVisible(session)`；打开后只读，不重绑定。
- 归档会话不在本课列表中；从归档中心查看。
- 新建对话只调用 `beginConversation`，不调用 `learning/start`。

### 2.3 开始面板

| 元素 | 数据 | 动作 |
| --- | --- | --- |
| 课程问候 | `selectedCourse.title` / `status` | 无 |
| 3 个快捷卡 | `learn.quick.*` 文案与 prompt | `appStore.setChatDraft(t(promptKey, { title }))` |
| 上次学习 | `courseSessions[0]`（最近更新时间） | `openSession(id)` |
| 输入框 | `appStore.chatDraft` | 首次发送才 `ensureConversation` |

**禁止**：快捷卡不得调用 `chatStore.send`、`sessionsStore.createSessionWith` 或 `learning/start`。

### 2.4 学习上下文 sheet

| 区块 | 数据 | 动作 |
| --- | --- | --- |
| 课程 / 任务 / 阶段 | `coursesStore.sessionContext(sessionId)` | 查看课程计划 |
| 检查点状态 / 阶段 / 修订 | `learningStore.state.checkpoint` | 无 |
| 当前题目 | `learningStore.state.questions` 按 `checkpoint.question` 匹配 | 无 |
| 待处理动作 | `learningStore.state.pending_action` | 只展示文案 |
| 暂停 / 继续 | `learningStore.pause()` / `resume()` | 显式写入 |
| 初始化 | `learningStore.init()` | **只在用户点击时** |
| 说明 | 静态文案 | 无 |

无当前会话时显示「选择课程并开始一段学习对话后，这里会显示学习检查点」，**不显示初始化**。归档会话显示只读说明，不显示暂停/继续/初始化。

### 2.5 Composer

`LearningWorkspace` 原样保留：

- `send()` 内部先 `ensureConversation`，成功后才 `chatStore.send`。
- `composerDisabled` 继续用于未选课程 / 课程状态不允许。
- `readOnly` 继续用于归档会话、归档课程、未归类历史。
- `blocked` 继续用于课程加载/失败/不存在/归档/暂停/完成。
- `emptyState` 继续用于「会话已创建但无消息」。

新增只读能力：在 composer 上方加一个「快捷」菜单，点击只 `setChatDraft`，不发送。

---

## 3. 建议的新增文件

```text
apps/learning-agent/web/src/react/pages/learn/
├─ LearnCourseBar.tsx       课程切换、任务/阶段、状态入口、新对话
├─ LearnHistoryRail.tsx     本课会话、未归类、归档入口
├─ LearnSessionRow.tsx      会话行（从 LearnPage 抽出）
├─ LearnStartPanel.tsx      课程问候、快捷卡、上次学习、空会话 starter
├─ LearnChatHeader.tsx      会话标题、消息数、会话菜单、状态入口
└─ LearnContextPanel.tsx    课程与任务、检查点、说明、只读/空态
```

可选：

```text
apps/learning-agent/web/src/react/ui/Sheet.tsx
```

如果现有 `Dialog` 不适合做非模态侧边 sheet，可新增一个共享 `Sheet`（桌面右侧 / 手机底部），统一 `aria-modal`、焦点陷阱、Escape、`inert` 和滚动锁。若不想新增 UI 基元，也可以在 `LearnPage` 内用局部 CSS 实现，但不要复制三套抽屉逻辑。

样式继续放在 `react/shell/shell.css` 的 learn 区块，或拆出 `react/pages/learn/learn.css` 并由 `LearnPage` 引入；不要新建第二套颜色 token。

---

## 4. 状态映射

| 原型状态 | 真实来源 | 判断 |
| --- | --- | --- |
| 未选择课程 | `learnWorkbenchStore.courseId === null` 且无 `session`，课程列表非空 | 欢迎区课程卡 |
| 无课程（列表为空） | `coursesStore.courses.length === 0` 且无错误 | 还没有课程 + 创建入口 |
| 已选未开始 | `courseId` 有值、`currentSessionId === null` | 开始面板 |
| 空会话 | `currentSessionId` 有值、`chatStore.messages.length === 0` | `emptyState` |
| 进行中 | `currentSessionId` + 消息 + `chatStore` 状态 | 消息列表 |
| 继续历史 | `openSession(id)` 后的消息 | 同上 |
| 学习状态展开 | 本地 `contextOpen` | sheet |
| 无检查点 | `learning.state.exists === false` | 初始化入口 |
| 归档只读 | `session.archived` / `course.archived` / `!session.course` | `LearningReadOnlyReason` |
| 课程暂停 | `selectedCourse.status === "paused"` | `blocked` |
| 加载 / 失败 | `coursesLoading` / `coursesError` | 骨架 / 错误卡 |
| 流式 | `chatStore.isSending` | 停止按钮 + 流式 Markdown |
| 移动抽屉 | `<900px` 或容器宽度 | `drawerOpen` |

---

## 5. P2 落地顺序

### 阶段 1：抽出展示组件（无行为变化）

1. 从 `LearnPage` 抽出 `LearnSessionRow`、`LearnStartPanel`，保持现有 DOM 结构与测试可查询的名称。
2. 从 `learningStore` 抽出 `LearnContextPanel`，先放在现有右栏位置。
3. 保持 `LearningWorkspace` 原样。
4. 跑 `TodayPage` 之外的 `LearnPage*.test.tsx`、`LearningWorkspace*.test.tsx`，确认无回归。

### 阶段 2：课程栏替换聊天头 + ContextStrip

1. 新增 `LearnCourseBar`，数据来自 `coursesStore` + `learnWorkbenchStore` + `sessionContext`。
2. 删除聊天卡内的 `CourseContextStrip` 渲染（组件文件保留，确认无其他引用后再清理）。
3. 保留现有三栏网格，先只减少垂直 chrome。
4. 测试：切换课程不创建会话；任务/阶段与 `sessionContext` 一致；会话头标题不重复。

### 阶段 3：右栏 → 上下文 sheet

1. 把 `.mla-learn` 从 `260 / 1fr / 240` 改为 `264 / 1fr`（≥1280），右栏移出网格。
2. `LearnContextPanel` 改为 `position:absolute` 的 360px sheet；桌面无遮罩、手机底部 sheet。
3. 关闭时 `inert` + `aria-hidden`；打开时 `aria-expanded`。
4. 测试：打开/关闭焦点；暂停/继续/初始化仍然只由显式点击触发；无检查点不自动初始化。
5. 运行 1440 / 1024 / 900 / 390 / 320 视觉检查。

### 阶段 4：历史栏与开始面板

1. 宽屏保留 264px 历史栏；1024–1279 变 320px 抽屉；手机 86% 抽屉。
2. 开始面板加入快捷卡与「上次学习」；快捷卡只填草稿。
3. 统一欢迎态与会话空态：都使用同一课程栏与开始面板。
4. 测试：切换会话、未归类只读、新建对话、草稿清空。

### 阶段 5：移动端与收尾

1. 底部 sheet、抽屉关闭按钮、`inert`、焦点回收。
2. 移动端 composer 位于底部导航之上；`100dvh` 处理。
3. 删除旧的 `.mla-learn-status` 右栏 CSS 与旧 `mla-welcome-*` 中不再使用的规则。
4. 更新 i18n 中英文键，确保变量一致。
5. 全量 `npm run build` + `npm test`。

---

## 6. 需要新增的 i18n 键（建议）

```text
learn.context.title                 学习上下文
learn.context.courseTask            课程与任务
learn.context.session               本次学习
learn.context.note                  任务完成不等于知识掌握……
learn.context.openPlan              查看课程计划
learn.context.noSession             选择课程并开始一段学习对话后……
learn.coursebar.switch              切换课程
learn.coursebar.status              学习状态
learn.coursebar.newChat             新对话
learn.start.title                   今天想弄懂什么？
learn.start.hint                    助手会结合课程资料与学习档案回答……
learn.start.lastStudied             上次学到
learn.quick.menu                    快捷
```

已有键优先复用：`learn.quick.*`、`learn.empty.start.*`、`learn.status.*`、`learn.sidebar.*`、`learn.welcome.*`、`course.context.*`。新增键必须同时写入 `zh-CN.json` 与 `en.json`，插值变量一致。

---

## 7. 可以直接复用 / 需要新增 / 无法实现

### 可以直接复用

- `LearningWorkspace.tsx`：消息、Markdown、流式、停止、复制、编辑/分支、模型选择、composer。
- `sessionsStore`：`load` / `openSession` / `renameSession` / `archiveSession` / `deleteSession`。
- `learnWorkbenchStore`：`selectCourse` / `beginConversation` / `ensureConversation` / `applyLocation` / `adoptCourse`。
- `learningStore`：`load` / `init` / `pause` / `resume`。
- `coursesStore.sessionContext` 与 `loadSessionContext`。
- `appStore.chatDraft`。
- `Button` / `IconButton` / `Badge` / `Card` / `DropdownMenu` / `Dialog` / `Input` / `Textarea` / `Spinner` / `Tooltip`。
- `MarkdownArtifact`、`isDailyVisible`、`currentLocale`、`useStoreSnapshot`。

### 需要新增

- 课程栏、历史栏、开始面板、上下文 sheet、会话头。
- 可选共享 `Sheet` 基元。
- 新的展示型 i18n 键。
- 只读/阻塞状态在 sheet 中的紧凑表达（仍需复用现有 `LearningBlock` / `LearningReadOnlyReason` 文案）。

### 当前无法实现（不做假）

| 需求 | 原因 |
| --- | --- |
| 课程完成百分比 / 知识掌握度 | 学习页只读 `learning.state`（检查点阶段/修订/题目），没有掌握度字段；`CourseSummary.counts` 只有总数，没有完成数；加载 `daily` 也会引入新的读路径与语义。 |
| 会话搜索 | `sessionsStore` 一次性加载列表，没有后端搜索；前端过滤可行但不在本轮范围，且会话很多时仍需分页策略。 |
| 标签 / 文件夹 | 没有 schema 与 API。 |
| 附件上传 | `LearningWorkspace` 的 composer 未暴露附件入口；`chat` API 有附件能力，但不属于本轮 UI 集成。 |
| 自动总结 / 自动评价 | 没有对应 API；也会破坏「不伪造学习证据」的约束。 |
| 全局导航改造（248px 文字侧栏） | 会同时影响今日学习、练习、档案、设置；应单独排期。 |

---

## 8. 测试计划（P2）

### 必须保持的现有测试

- `LearnPage.test.tsx`：学习状态、暂停/继续、会话删除、归档只读。
- `LearnPage.workbench.test.tsx`：课程门禁、首次发送绑定、草稿切换、空会话、未归类只读。
- `LearnPage.welcome.test.tsx`：欢迎页课程卡、禁用 composer、快捷开始。
- `LearnPage.course-context.test.tsx`：课程/任务/阶段条。
- `LearningWorkspace.test.tsx`：导航、草稿保留、归档只读。
- `LearningWorkspace.e1.test.tsx`：复制、编辑、分支、模型切换、流式。

### 新增测试

1. 切换课程只更新 `courseId`，不调用 `startCourseLearning`，草稿清空。
2. 历史栏只列当前课程会话；未归类会话不重绑定。
3. 上下文 sheet 打开/关闭的 `aria-expanded` 与 `inert`。
4. 无检查点时只显示初始化，不自动初始化。
5. 归档会话/课程不显示暂停/继续/初始化。
6. 快捷卡只写 `appStore.chatDraft`，不调用 `send`。
7. 移动端抽屉关闭后焦点回到触发按钮；sheet 关闭后焦点回收。
8. 1024 / 390 下无横向滚动；composer 不被底部导航遮挡。

---

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 右栏移出网格后，状态入口不可见 | 用户找不到检查点 | 课程栏放状态摘要 + 会话头保留图标；首次进入可短暂提示 |
| 历史栏在 1024 变抽屉 | 历史可发现性下降 | 课程栏保留历史图标；开始面板提供「上次学习」 |
| 上下文 sheet 覆盖聊天 | 遮挡正在阅读的内容 | 默认关闭；桌面非模态、点击外部关闭；不锁滚动 |
| 移动端底部 sheet 与键盘 | composer 被键盘顶起 | 使用 `dvh` 与 `env(safe-area-inset-bottom)`；sheet 打开时锁背景滚动 |
| 课程切换清空草稿 | 用户输入丢失 | 保持现有行为；切换前不自动清空，`selectCourse` 统一处理 |
| 旧 `CourseContextStrip` 与新栏重复 | 信息重复 | 阶段 2 删除学习页的旧渲染，组件文件保留到确认无引用 |
| i18n 键缺失 | 英文界面回退中文 | 两套 JSON 同步，locale 测试兜底 |

---

## 10. 结论

- **可以直接复用**：`LearningWorkspace`、所有 Store/API、共享 UI 组件、今日学习 B 的 token。
- **必须新增**：课程栏、历史栏、开始面板、上下文 sheet、移动抽屉/底部 sheet。
- **不能做**：掌握度、课程完成百分比、会话搜索、标签、附件上传、自动总结——没有数据或会破坏业务语义。
- **推荐落地顺序**：先抽展示组件，再换课程栏，再把右栏改成 sheet，最后做移动端与清理。
- 本阶段所有产物都在 `docs/ui-redesign/phase3/`，未修改任何 `apps/` 源码。
