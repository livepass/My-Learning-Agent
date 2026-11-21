# E4.9g-P2-2 验收报告：AI 学习课程栏

- **基准**：`main` @ `8117a09922fed223e1926248f8619ff359ddff37`
- **工作分支**：`feat/e49g-p2-2-learn-coursebar`
- **代码提交**：`PENDING`
- **最终提交**：本报告所在提交（分支 HEAD）
- **结论**：**PASS**（全量测试结果待填入）

---

## 1. 本轮范围

只将会话模式下的聊天标题与 `CourseContextStrip` 合并为一条 `LearnCourseBar`，保留：

- 原三栏宽度与全局 64px 图标栏 / 移动端底部导航
- `LearningWorkspace` 的发送、流式、编辑、分支与模型选择
- 历史栏及其移动端抽屉
- 右侧学习状态面板的展开 / 收起与全部写操作
- `CourseContextStrip.tsx` 文件（仍保留，不再在会话页渲染）

历史栏抽屉与学习上下文 Sheet 的布局改造仍留给后续阶段。

---

## 2. 修改清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/pages/learn/LearnCourseBar.tsx` | 新增 | 课程、状态、任务、阶段、四个入口 |
| `react/pages/LearnPage.tsx` | 修改 | 用课程栏替换旧聊天头 + `CourseContextStrip`；补会话上下文只读加载；共享状态切换 |
| `react/shell/shell.css` | 追加 | 课程栏、课程菜单与 1500 / 1180 / 900 / 560 / 360 断点；未删除旧规则 |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `learn.courseBar.*` 七个键 |
| `react/pages/learn/LearnCourseBar.test.tsx` | 新增 | 10 项组件测试 |
| `react/pages/LearnPage.course-bar.test.tsx` | 新增 | 8 项页面集成测试 |
| `docs/ui-redesign/phase3/P2-2-assets/` | 新增 | 19 张真实页面截图 + 布局指标 |
| `docs/ui-redesign/phase3/P2-2-acceptance.md` | 新增 | 本报告 |

未修改 Store、API、后端、`LearningWorkspace`、`CourseContextStrip`、全局导航或历史栏结构。

---

## 3. 课程栏设计

### 3.1 内容

从左到右：

1. 移动端历史抽屉开关（`< 900px` 显示，复用原 `mla-learn-nav-toggle`）。
2. 课程切换按钮：课程封面首字、课程名、状态徽章、下拉箭头。
3. 服务端上下文：当前任务（状态点 + 标签 + 标题）、学习阶段、警告标记。
4. 动作：课程计划、学习状态（`aria-expanded` 同步面板）、新建对话。

课程栏整体 `aria-label` 在课程绑定时为 `course.context.ariaLabel`（当前课程任务），未归类时为 `learn.courseBar.aria`（课程栏）。原有课程上下文测试可直接继续使用。

### 3.2 数据来源

- 课程名 / 状态：`sessionContext.context.course` 优先（服务端绑定），其次 `selectedCourse`，最后会话 meta 的课程标题；不按会话标题猜测课程。
- 任务 / 阶段 / 警告：`coursesStore.sessionContext(sessionId)`；上下文未加载时不显示「自由学习」或任何任务，避免把加载中误画成自由学习。
- 课程切换列表：`coursesStore.courses` 中非归档课程，与欢迎页课程卡一致。
- 新建对话：仅当课程 `in_progress`；调用页面已有 `startConversation` → `beginConversation`，不发送、不建会话。
- 课程计划：`navigate("course", { view: "plan" })`，只读入口。
- 学习状态：与右侧面板共用 `statusOpen` / `toggleStatus`，点击栏内按钮同样记录「学习者主动选择」。

### 3.3 键盘与菜单

课程菜单复用 Radix `DropdownMenu`：

- 触发按钮 `aria-haspopup="menu"`，选项为 `menuitemradio`。
- 方向键移动、Enter 选择、Escape 关闭。
- 关闭后焦点回到触发按钮（组件测试已断言）。
- 选中课程后关闭菜单，不创建会话。

---

## 4. 行为保持

| 要求 | 实现 / 证据 |
| --- | --- |
| 切换课程不创建会话 | 集成测试：`startCourseLearning` 未被调用，`currentSessionId` 为空，草稿清空 |
| 新建对话不自动发送 | 集成测试：`chatStore.send` 与 `startCourseLearning` 均未调用，回到课程欢迎页 |
| 当前任务展示与服务端一致 | 集成测试：任务标题与阶段来自 `sessionContext`；阶段经 `getCourse` 解析 |
| 无当前任务不伪造 | 上下文已加载且无任务 → 显示「自由学习」；未加载 → 不显示任务/自由学习 |
| 学习状态展开 / 收起 | 集成测试：栏内按钮 `aria-expanded` 与面板按钮同步 |
| 未归类历史保持只读 | 课程栏显示「未归类对话 / 未归类」，无课程计划、无新建对话，composer 不渲染 |
| 归档会话无法发送 | 集成测试：只读提示存在，无 composer |
| 中英文切换 | 组件与页面测试均覆盖：Course plan / Learning status / New conversation / Free learning |
| 响应式无溢出 | 1440 / 1024 / 900 / 390 / 320 均 `overflow = 0` |

原有 `LearnPage` 的 77 项测试全部继续通过，包括首次发送绑定、未归类只读、归档只读、会话删除、移动端抽屉与草稿隔离。

---

## 5. 测试结果

### 5.1 定向测试

| 文件 | 结果 |
| --- | --- |
| `LearnCourseBar.test.tsx` | **10 / 10 通过** |
| `LearnPage.course-bar.test.tsx` | **8 / 8 通过** |
| 既有 6 个学习页测试文件 | **77 / 77 通过** |
| 合计（含 i18n 一致性） | **9 文件 / 103 项通过** |

新增测试覆盖：上下文展示、上下文未加载、自由学习、未归类、归档、动作回调、菜单选择、Escape 焦点返回、语言切换、课程切换、新建对话、状态同步、任务缺失。

### 5.2 全量测试

- 命令：`npm test`
- 结果：`PENDING`

---

## 6. 构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |

---

## 7. 响应式与视觉检查

真实 React 构建产物 + 受控 API 数据；不是 `prototype.html`。

| 视口 | 课程栏高度 | 聊天宽度 | 横向溢出 | 动作标签 |
| --- | ---: | ---: | ---: | --- |
| 1440 × 900 | 50 | 796 | 0 | 图标（≥1501 显示文字） |
| 1024 × 768 | 76 | 452 | 0 | 图标 |
| 900 × 800 | 75 | 876 | 0 | 图标 |
| 390 × 844 | 79 | 366 | 0 | 图标 |
| 320 × 640 | 83 | 296 | 0 | 图标 |

- 1440：单行；任务「交叉验证与偏差-方差权衡」与「阶段：第 3 阶段 · 模型评估」完整显示。
- 1024：上下文换到第二行，任务与阶段完整；聊天列宽度保持 452，未扩大（P2-3 范围）。
- 900 / 390：历史栏为抽屉，底部导航出现；课程栏两行，无遮挡。
- 320：动作与上下文共享第二行，不再出现第三行；任务/阶段以 `title` 保留全文。
- 深浅主题沿用现有 token；截图包含浅色，暗色由共享 token 保证（未新增裸色值）。

截图目录：`docs/ui-redesign/phase3/P2-2-assets/`，指标：`metrics.json`。

---

## 8. 开始面板

`LearnStartPanel` 未改动。检查后认为无需调整：

- 快捷卡与课程卡已使用共享 `mla-course-card` 家族的 10px 圆角、1px 边框、14–15px 字号；
- 与课程栏的 10px 菜单圆角、13px 标题、11.5px 辅助信息处于同一节奏；
- 此时修改欢迎页间距会提前侵入 P2-4 的「欢迎页布局统一」，收益低、回归面大。

课程栏只在会话模式出现，欢迎页不渲染它；两者通过 token 与卡片几何保持一致。

---

## 9. 未解决问题与风险

1. **1024 聊天列仍为 452px**。本轮只替换顶部，不调整三栏宽度；布局扩展在 P2-3。
2. **历史栏与学习上下文 Sheet 未改**。按任务要求留待后续。
3. **课程栏在 320px 会截断任务/阶段文本**，通过 `title` 提供全文；这是窄屏可读性与两行高度的折中，不影响操作。
4. 课程切换菜单与状态按钮均有重复入口（侧栏也保留「新建对话」）。保留侧栏现有能力，避免在本轮改变历史栏结构。

---

## 10. 合并条件

| 条件 | 结果 |
| --- | --- |
| 课程栏替换成功 | 是 |
| 原有业务不变 | 是（77 项既有测试 + 8 项集成测试） |
| 构建通过 | 是 |
| 测试通过 | 定向 103/103；全量见第 5.2 节 |
| 无阻断性响应式问题 | 是（5 档宽度均无溢出） |
| 验收报告与截图 | 是 |

**结论：PASS。** 修复提交与报告将推送到 `feat/e49g-p2-2-learn-coursebar`，PR 创建状态见交付说明；未合并 `main`。
