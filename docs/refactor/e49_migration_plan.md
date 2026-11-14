# E4.9a — E4.9b/c/d 迁移计划

- 基准：`5068b53`
- 顺序原则：先做国际化基础设施与共享组件（底层），再逐页迁移（上层），最后清理旧代码。避免多页面反复修改同一底层组件。

## 0. 总体顺序与依赖

```
E4.9b  i18n 基础设施 + 学习页文案抽取
   ├─ 资源校验用例（键集合 / 引用 / 硬编码）
   ├─ 新增学习命名空间 today/learn/practice/course/archive
   └─ 6 个页面 + 10 个课程组件 + 归档中心接入 t()
        ↓
E4.9c  共享 UI 组件 + 页面样式收敛
   ├─ Badge / StatusBadge / EmptyState / AsyncSection / Field
   ├─ Card 变体收敛（practice / group / selectable）
   ├─ Textarea variant="prose" 替代 mla-practice-input
   └─ 原生 input/select/textarea → 共享控件
        ↓
E4.9d  旧代码清理（仅限已证明无运行时依赖）
   ├─ ui/checkbox.ts、dnd-backend.tsx、long-press.ts（需构建产物确认）
   ├─ i18n 中已移除功能的分组
   └─ react/ 根组件的目录归位（可选）
```

依赖关系：E4.9c 的 `StatusBadge` 需要 E4.9b 提供的 `course.status.*` 等键；E4.9d 的 i18n 清理必须等 E4.9b 完成键审计。因此 **b → c → d 串行**，b 内部可按页面并行。

---

## 1. E4.9b — 国际化基础设施与学习页翻译

### 1.1 目标

- 所有学习页面的界面文字走 `t()`；英文界面无硬编码中文。
- 建立可持续的缺失翻译检测，随测试运行。

### 1.2 修改文件

| 文件 | 变更 |
| --- | --- |
| `web/src/i18n/locales/zh-CN.json` / `en.json` | 新增 `today.*`、`learn.*`、`practice.*`、`course.*`、`archive.*`；补齐 `nav.learning.*`；补 `files.fileCount` |
| `web/src/i18n/locales.test.ts`（新增） | 键集合一致性、代码引用存在性 |
| `web/src/react/shell/navigation.ts` | `SHELL_PAGE_META` 改为返回键而非文案（或提供 `pageMetaKey`） |
| `web/src/react/shell/AppShell.tsx` | 顶栏「设置」、跳转链接 |
| `web/src/react/pages/TodayPage.tsx` | 76 条固定文案 + 3 组标签 |
| `web/src/react/pages/LearnPage.tsx` | 125 条 + 3 组标签 |
| `web/src/react/LearningWorkspace.tsx` | 49 条 |
| `web/src/react/pages/PracticePage.tsx` | 144 条 + 4 组标签 |
| `web/src/react/pages/ProfilePage.tsx` | 6 条 |
| `web/src/react/pages/CourseDetailPage.tsx` | 14 条 |
| `web/src/react/courses/*.tsx`（10 个） | ~230 条 + 5 组标签 |
| `web/src/react/settings/ArchiveSettings.tsx` | 36 条 |
| `web/src/react/pages/SettingsPage.tsx` | 9 条（页标题、tab 名） |
| `web/src/stores/courses-store.ts` 等 | 错误消息改为错误码 + 页面侧翻译（见 1.4） |

### 1.3 复用 / 新增

- 复用 `useTranslation`、现有 `common.*`。
- 新增键命名空间（不新增组件）。
- 新增一个 `useStatusLabels()`（或纯函数 `courseStatusKey(status)`）供多页面共用，消除 `ACTION_LABELS` / `KIND_LABELS` / `STATE_LABEL` 三处重复。

### 1.4 翻译范围与边界

| 范围 | 处理 |
| --- | --- |
| 界面固定文案 | 抽取为键 |
| 动态状态 | `t(\`course.status.${status}\`)` 等枚举键 |
| 服务端错误 | store 保留错误码（`ApiError.data.error`），页面用 `t(\`practice.error.${code}\`, message)`；服务端 `message` 只作兜底 |
| 用户/AI 内容 | **不翻译**（会话标题、题目 prompt、评分反馈） |
| 技术标识 | **不翻译**（id、版本、修订号） |

### 1.5 直接影响的业务交互

无。仅文案来源改变；不触碰 store 逻辑、API 协议、学习流程。

### 1.6 定向测试

- 新增 `i18n/locales.test.ts`（键集合 + 引用校验）。
- 现有页面测试会因文案变化而失败：`PracticePage.test.tsx`（61 项）、`LearnPage*.test.tsx`、`TodayPage*.test.tsx`、`SettingsPage.archived.test.tsx`、`CourseDetailPage.test.tsx`。**做法**：测试保持中文断言（jsdom 默认 zh-CN），只改实现不改断言；仅当文案本身优化时同步更新断言。
- 不运行全量 Vitest，按页面分批。

### 1.7 回归风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 英文长文案撑破布局 | 导航短标签、按钮、卡片标题 | 每个页面英文截图检查 |
| 模板键漏抽 | 12 处动态键 | 校验用例覆盖前缀 |
| 状态值被误当文案 | 服务端枚举值（`in_progress`）不能翻译 | 只翻译显示层，不改变量 |
| 测试大面积断言变更 | 若优化文案会改测试 | 分批提交，每批只改一个页面 |

### 1.8 完成标准

1. `react/pages`、`react/courses`、`react/settings`、`react/shell` 中 CJK 行数降为 0（除 `// i18n-allow` 登记的例外）。
2. `i18n/locales.test.ts` 通过，且能捕获人为删除一个英文键。
3. 英文界面下 6 个页面无中文残留（人工检查 + 截图）。
4. 全站 `npm run build` 通过；相关页面测试通过。

---

## 2. E4.9c — 共享 UI 组件与样式收敛

### 2.1 目标

- 新增 5 个共享组件，消除 118 处 badge、19 处空态、32+32 处三态、15+ 处表单字段的复制。
- 输入控件全部走 `react/ui/`。

### 2.2 修改文件

| 文件 | 变更 |
| --- | --- |
| `react/ui/Badge.tsx`（新增） | `Badge` + `StatusBadge`（tone: accent/success/warning/danger/neutral） |
| `react/ui/EmptyState.tsx`（新增） | `icon` / `title` / `description` / `action` |
| `react/ui/AsyncSection.tsx`（新增） | `loading` / `error` / `empty` 三态，统一 `role="alert"` 与重试 |
| `react/ui/Field.tsx`（新增） | `label` / `hint` / `error` + 控件 slot |
| `react/ui/Card.tsx`（新增） | `variant: default / selectable / group / practice` |
| `react/ui/FormControls.tsx` | `Textarea` 增加 `variant="prose"`（自动增高、无拖拽手柄） |
| `react/ui/index.ts` | 导出新组件 |
| `react/shell/shell.css` | 删除 `.mla-practice-input`、`.mla-badge` 的业务重定义，保留布局类 |
| `react/pages/PracticePage.tsx` | 原生 input/select/textarea → `Input`/`Select`/`Textarea`；`mla-practice-card` → `Card variant="practice"` |
| `react/pages/LearnPage.tsx`、`TodayPage.tsx`、`ArchiveSettings.tsx`、`react/courses/*` | badge/空态/三态/卡片替换 |
| `docs/ui-guidelines.md` | 登记新组件与变体规则 |

### 2.3 复用 / 新增

- 复用：`Button`、`Input`、`Select`、`Dialog`、`Tabs`、`Tooltip`、`Separator`。
- 新增：上述 5 个组件。
- 不新建：任何页面级的 Button/Textarea/Card 副本。

### 2.4 翻译范围

无新增文案；`StatusBadge` 的文本来自 E4.9b 已建的状态键。

### 2.5 直接影响的业务交互

- 表单控件的可访问名称（`Field` 的 label 与 `aria-describedby`）会统一，键盘操作不变。
- 空态/错误的重试按钮统一为 `AsyncSection` 提供，行为不变。
- 卡片视觉统一后，练习卡与归档分组的间距会有小幅变化（需截图确认）。

### 2.6 定向测试

- `PracticePage.test.tsx`（题目/作答/评分状态）、`LearnPage*.test.tsx`（课程卡、空态）、`SettingsPage.archived.test.tsx`（分组卡）、`shell.css.test.ts`（布局契约）。
- 新增 `react/ui/Badge.test.tsx`、`AsyncSection.test.tsx`（纯渲染 + 三态）。
- 每个组件替换批次单独提交，避免一次改 20 个文件。

### 2.7 回归风险

| 风险 | 缓解 |
| --- | --- |
| 卡片间距/内边距变化导致布局跳动 | 逐页截图对比，先改单页 |
| `AsyncSection` 吞掉特定错误展示 | 保留 `error` 的 children 覆盖能力 |
| `Textarea variant="prose"` 与 composer 冲突 | composer 使用独立类，不复用该 variant |
| 测试查询依赖旧 class 名 | 优先按 role/label 查询；必要处同步更新 |

### 2.8 完成标准

1. `react/ui/index.ts` 导出 5 个新组件，且有测试。
2. 业务代码中 `mla-badge` 直接使用降为 0（全部经 `Badge`）。
3. `react/pages`、`react/courses` 中原生 `<input>`/`<select>`/`<textarea>` 为 0（保留必要的 `<button>`）。
4. `npm run build` 通过，相关页面测试通过，桌面/手机截图无回归。

---

## 3. E4.9d — 旧代码清理

### 3.1 目标

- 只删除**已证明无运行时依赖**的代码；不删除仍被引用的 Inno 模块。

### 3.2 候选与验证方式

| 候选 | 当前证据 | 删除前必须验证 |
| --- | --- | --- |
| `react/ui/checkbox.ts` | 无静态 import | 构建产物 grep + `ui/index.ts` 无导出 |
| `react/ui/dnd-backend.tsx` | 无静态 import | 同上；确认无 `react-dnd` 依赖入口 |
| `react/ui/long-press.ts` | 无静态 import | 同上 |
| `react/ui/PopoverSurface.tsx` | 仅 barrel 导出 | 构建产物无引用 |
| `react/ui/ResizeHandle.tsx` | 仅 barrel 导出 | 同上 |
| `react/MermaidMarkdownRuntime.tsx` | 无静态 import | 确认 mermaid 走 `utils/mermaid-runtime` 动态加载 |
| `api/commands.ts` | 无 import | **不删除**（可能后续接入 slash 命令），标记为保留 |
| `utils/chat-trace.ts` | 无 `react/` 引用 | 确认是否被测试或后端共享使用 |
| i18n 中 wordEditor/jobs/notebook/preview/sidebar/skills/terminal/files/globalSearch/contextUsage/workspaceStart/btw/officeEditor/presets/permission/categories | 页面未引用 | 先跑引用校验用例；无引用再删 |

### 3.3 修改文件

- 删除候选文件（逐个提交，每个附构建产物证据）。
- `react/ui/index.ts` 移除对应导出。
- `i18n/locales/*.json` 移除无引用分组。

### 3.4 翻译范围

删除无引用键；保留 `desktop.closeDialog.*`（Electron 使用）。

### 3.5 定向测试

- 每次删除后运行 `npm run build` + 引用该模块的测试文件。
- 删除 i18n 分组后运行 `i18n/locales.test.ts`。

### 3.6 回归风险

- **最高风险**：动态 import（`lazy(() => import(...))`）不会被静态扫描发现。`ArtifactRenderers`、`MermaidArtifactRenderer` 就是这种形式，**不能**因为「无静态 import」而删除。
- i18n 删除可能影响未迁移的 Inno 页面（当前仓库无此页面，但需确认 showcase/electron 不引用）。

### 3.7 完成标准

1. 每个删除项都有「构建产物无引用」的证据记录在提交信息中。
2. 构建通过，相关测试通过。
3. 不删除任何仍被 `lazy import` 或运行时动态加载的模块。

---

## 4. 跨阶段约束（不得破坏）

- 课程与对话绑定、`learning/start` 首条消息建会话。
- L2 检索范围、L1 画像与掌握状态、L3 记忆、B2 练习证据。
- 课程归档与安全删除（E4.8d）、会话恢复与历史。
- 出题、提交、评分、证据记录流程。
- 本地数据格式与后端 API 协议。
- 前端不得把聊天内容或任务完成状态转化为正式学习证据。

## 5. 验收边界

| 阶段 | 验收 |
| --- | --- |
| E4.9b | 键校验用例通过 + 6 页面英文截图无中文残留 |
| E4.9c | 组件测试 + 3 个代表页面（今日、练习、归档）桌面/手机截图 |
| E4.9d | 构建产物引用证据 + 构建/定向测试通过 |

不执行：全量 Vitest、E4.7/E4.8 业务验收重跑（按各阶段实际改动决定是否补跑）。
