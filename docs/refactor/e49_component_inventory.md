# E4.9a — UI 组件复用与重复情况

- 基准：`5068b53`
- 依据：`react/ui/`、`app.css`、`themes.css`、`design.md`、`docs/ui-guidelines.md`
- 统计范围：`react/` 下非测试文件

## 1. 现有共享组件（`react/ui/`）

| 组件 | 导出 | 业务引用 | 状态 |
| --- | --- | ---: | --- |
| `Button` / `IconButton` | `Button.tsx` | 28 个文件从 barrel 导入 | 正常使用 |
| `Input` / `Textarea` / `Checkbox` / `Radio` | `FormControls.tsx` | 10 处直接使用 | 正常使用 |
| `Dialog` | `Dialog.tsx` | 3 处 | 正常使用 |
| `DropdownMenu*` | `Menu.tsx` | 5 个文件 | 正常使用 |
| `Select*` | `Select.tsx` | 7 个文件 | 正常使用 |
| `SearchableSelect` | `SearchableSelect.tsx` | 3 处 | 正常使用 |
| `Tabs` / `SegmentedControl` | `Tabs.tsx` | 7 处 | 正常使用（`SegmentedControl` 的 `toolbar`/`rail` 变体仅 Markdown/Inno 使用） |
| `Tooltip` | `Tooltip.tsx` | 38 处 | 正常使用 |
| `Spinner` | `Spinner.tsx` | 6 处 | 正常使用 |
| `Switch` | `Switch.tsx` | 8 处 | 正常使用 |
| `Separator` | `Separator.tsx` | 20 处 | 正常使用 |
| `ContextMenu` | `ContextMenu.tsx` | 7 处 | 正常使用 |
| `Popover` / `PopoverSurface` | `Popover.tsx` / `PopoverSurface.tsx` | `PopoverSurface` 仅 barrel 导出，无业务引用 | `PopoverSurface` **未确认** |
| `ResizeHandle` | `ResizeHandle.tsx` | 仅 barrel 导出 | **未确认**（Inno 侧栏拖拽遗留） |
| `checkbox.ts` / `dnd-backend.tsx` / `long-press.ts` | 工具 | 无 import | **未确认** |

### 1.1 缺失的共享组件（P0-4）

`react/ui/index.ts` **没有** `Badge`、`Card`、`EmptyState`、`Status`、`PageContainer`、`FormField` 的导出。当前业务通过复制 CSS 类实现：

| 语义 | 当前实现 | 使用次数 |
| --- | --- | ---: |
| 状态标签 | `<span className="mla-badge mla-badge--accent">` | 118 处 / 13 文件 |
| 卡片 | `<section className="mla-card">` / `.mla-practice-card` / `.mla-archive-group` / `.mla-course-card` / `.mla-course-pick` / `.mla-quick-card` | 6 种 |
| 空状态 | `<div className="mla-empty">` + 手写 `<strong>`/`<p>` | 19 处 |
| 加载 | `<Loader2 className="mla-spin" /> + 文案` | 32 处 |
| 错误 | `<p role="alert" className="mla-small" style={{color: danger}}>` | 32 处 |
| 表单字段 | 手写 `<label className="mla-small">` + `inputCls` / `mla-field` | 15+ 处 |

**结论**：应新增 `Badge`、`EmptyState`、`AsyncSection`（loading/error/empty 三态）、`Field` 四个共享组件，而不是为每个页面继续复制。`Card` 建议先统一为 `Card` + `variant`（`default` / `selectable` / `group` / `practice`），避免推翻现有 6 种视觉。

## 2. 重复实现清单

### 2.1 按钮

- `Button` 的变体使用分布：`primary` 41、`secondary` 17、`danger` 14、`ghost` 9，尺寸 `xs` 67、`sm` 35、`md` 1。**没有**未定义变体（`toolbar`/`rail` 属于 `SegmentedControl`）。
- 业务代码仍有 **51 个原生 `<button>`**（含 `react/markdown/` 等非学习模块）：
  - `LearnPage` 9 处（会话行、归档入口、快捷卡）
  - `LearnerProfilePanel` 3 处、`AppShell` 2 处、`ArchiveSettings` 2 处、`TodayPage` 2 处、其余各 1 处。
  - 其中一部分是列表行（整行可点）与可展开标题，**应保留原生 button**（语义不同）；另一部分（如「查看归档」）应换成 `Button variant="ghost"`。
- `PracticePage` 的快捷卡、`LearnPage` 的课程卡是**新的业务组件**（可选择的卡片），不是 Button 的变体，应作为 `Card variant="selectable"` 复用。

### 2.2 输入框

| 现状 | 位置 | 问题 |
| --- | --- | --- |
| `inputCls` + 原生 `<input>` | `PracticePage` 5 处、`CourseLibraryPanel` 1 处 | 应使用 `Input`（带 `size`/`variant`） |
| 原生 `<select>` | `PracticePage` 4 处、`ThinkingLevelField` 1 处 | 应使用 `Select` |
| 原生 `<textarea>` | `PracticePage` 1 处 | **已按 E4.8g 使用专用类 `mla-practice-input`**，应改为 `Textarea` 的 `variant="prose"` |
| `mla-practice-input` | `shell.css` | 与 `.inno-ui-textarea` 重复定义边框/圆角/字号 |
| 摘要编辑框 | `LearnerProfilePanel` | 使用 `Textarea` + 内联 `style={{resize:"none"}}`，与其他输入不一致 |

### 2.3 卡片

6 种卡片类各自定义边框、圆角、内边距：

| 类 | 定义位置 | 与基础卡片的差异 |
| --- | --- | --- |
| `.mla-card` | shell.css | 基准：1px 边框、10px 圆角、20px 内边距 |
| `.mla-practice-card` | shell.css（E4.8g） | 22/24px 内边距，其余相同 |
| `.mla-archive-group` | shell.css（E4.8e） | 有内部头/子列表，`overflow:hidden` |
| `.mla-course-card` / `.mla-course-pick` / `.mla-quick-card` | shell.css（E4.8c） | 共享基类 + 行为变体，已收敛 |
| `.mla-learn-sidebar` / `.mla-chat-card` | shell.css | 布局容器，非内容卡片 |

E4.8c 已经把课程卡收敛为一个族；练习卡和归档分组仍是独立实现，应在 E4.9c 收敛到 `Card` 的 `variant`。

### 2.4 状态标签

- `mla-badge` + 4 个 tone 变体（accent/success/warning/danger），但业务里常直接拼接 `className={\`mla-badge${cond ? " mla-badge--accent" : ""}\`}`。
- 同样的「课程状态 → 标签」逻辑在 `CourseCard`、`CourseDetailPage`、`LearnPage`（2 处）、`ArchiveSettings` 各写一遍。
- **应新增 `<StatusBadge tone={…}>`**，tone 由状态映射函数统一（与 i18n 键一起放进 `course.status.*`）。

### 2.5 空状态 / 加载 / 错误

- 19 处 `mla-empty`、32 处 `Loader2 + mla-spin`、32 处 `role="alert"`。
- 语义相同但文案不同（「还没有课程」「课程都在归档中」「暂无归档内容」），适合抽成 `<EmptyState icon title description action>` 与 `<AsyncSection loading error empty>`。
- `ArchiveSettings` 已实现「读取失败 ≠ 空」的正确分支，应作为标准模式推广。

### 2.6 页面容器与导航

- `AppShell` 统一了导航（E4.8c 已把侧栏收敛为 64px 图标栏），但导航文案硬编码在 `navigation.ts`。
- 页面容器：`.mla-page`（普通内容页）、`.mla-main--flush`（沉浸式）、`.mla-learn--welcome`（欢迎态）、`.mla-practice`（E4.8g）。规则清晰，但类名分散在 `shell.css` 一处，无组件封装。

## 3. 此前已知问题的现状

| 问题 | 现状 | 结论 |
| --- | --- | --- |
| 练习题目与作答分离 | **已修复**（E4.8g：`mla-practice-card`） | 已完成 |
| 原生 Textarea 样式粗糙 | **已修复**（E4.8g：自动增高、无拖拽手柄），但样式仍私有 | 视觉已修，样式待收敛 |
| 学习档案摘要长期编辑形态 | **已修复**（摘要改为阅读卡片 + 按需编辑） | 已完成 |
| 按钮图标和文案重复 | **已修复**（「+ 新增目标」去重） | 已完成 |
| 同语义卡片/状态/按钮不同样式 | **部分**：课程卡已统一；徽章、空态、练习卡、归档分组仍未统一 | P0-4 / P1 |

## 4. 应复用 vs 应新增

### 应复用（不新建）

- 所有按钮 → `Button` / `IconButton`；列表行与可展开标题保留原生 `<button>`（语义需要）。
- 所有输入 → `Input` / `Textarea` / `Select` / `Checkbox`。
- 所有弹层 → `Dialog` / `DropdownMenu` / `Popover` / `Tooltip`。
- 所有页签 → `Tabs` / `SegmentedControl`。

### 应新增（确实缺少的业务组件）

| 组件 | 位置 | 理由 |
| --- | --- | --- |
| `Badge` / `StatusBadge` | `react/ui/` | 118 处复制，且 tone 规则重复 |
| `EmptyState` | `react/ui/` | 19 处结构相同 |
| `AsyncSection` | `react/ui/` | 32 + 32 处三态手写 |
| `Field`（label + hint + error） | `react/ui/` | 15+ 处表单字段重复 |
| `CourseCardFamily` | `react/courses/` | 已有 CSS 族，缺组件封装（`CourseCard` 只覆盖信息卡） |
| `PracticeCard` | `react/pages/` 或 `react/practice/` | 练习卡结构复杂，值得抽组件以便 i18n 与测试 |

## 5. 组件边界规则（后续实施约束）

1. `react/ui/*` **不得** import `stores/*` 或 `api/*`；只接受 props 与 `children`。
2. 业务组件（`courses/`、`settings/`、`pages/`）可以读 store，但**不得**重新定义按钮/输入/卡片的边框、圆角、字号。
3. 新增视觉差异必须先判断是「已有组件的 variant」还是「新的业务组件」；前者加 variant，后者放业务目录。
4. 状态标签的颜色只来自 `--inno-success/warning/danger/accent` 语义 token，不写裸色值。
5. 任何共享组件的新增都要同步 `docs/ui-guidelines.md`。
