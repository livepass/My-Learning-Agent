# E4.9a — 前端架构审计（现状与问题分级）

- 审计基准：`5068b53`（`main`），已在 E4.8g 之后。核对结果：E4.8g 已合入（`457546e` + 截图提交 `5068b53`）；仓库中不存在 E4.8h 或其他后续改动。
- 审计方式：静态阅读 + 定向统计脚本（不修改运行中的组件，不执行全量测试）。
- 统计口径：`apps/learning-agent/web/src` 下非测试文件（`.test.*` 排除）。

## 1. 前端结构与依赖

```
web/src/
├── i18n/             index.ts + locales/{zh-CN,en}.json（1478/1479 键）
├── react/
│   ├── ui/           21 个文件（18 个共享组件 + barrel + 3 个未引用工具）
│   ├── shell/        AppShell / navigation / shell.css / use-location-search
│   ├── pages/        6 个页面入口
│   ├── courses/      10 个课程业务组件
│   ├── settings/     12 个文件（设置面板 + ArchiveSettings + primitives）
│   ├── markdown/     Markdown 渲染族（7 个文件）
│   └── 根组件        App / LearningWorkspace / LearnerProfilePanel / MarkdownArtifact / MarkdownRuntime / MermaidMarkdownRuntime
├── stores/           11 个 store（courses 1351 行、chat 956、learning 699、sessions 597 最大）
├── api/              10 个接口模块（courses 1067 行最大）
└── utils/            14 个工具（chat-trace 807 行、review-intent、session-visibility…）
```

### 1.1 页面依赖（页面 → 业务组件 → store）

| 页面 | 直接业务组件 | 依赖的 store |
| --- | --- | --- |
| `TodayPage` | `CourseCard`、`CreateCourseDialog`、`DeletionDialog` | courses、learner、sessions |
| `LearnPage` | `LearningWorkspace`、`CourseContextStrip`、`CreateCourseDialog` | courses、sessions、learning、learn-workbench、app |
| `PracticePage` | 无（自包含 1338 行） | learning、learner、sessions |
| `ProfilePage` | `LearnerProfilePanel` / `CourseLearnerPanel` | courses（+ 子组件 learner） |
| `CourseDetailPage` | `CoursePlanPanel`、`CourseLibraryPanel`、`CourseRecordsPanel`、`CourseOverviewPanel` | courses |
| `SettingsPage` | `GeneralSettings`、`ModelsSettings`、`ArchiveSettings`、`AboutSettings` | settings |

`App.tsx` 只做页面切换，`AppShell` 只依赖 `appStore`。依赖方向为「页面 → 业务组件 → store → api」，没有反向依赖，符合目标边界。

### 1.2 依赖关系图（主要）

```
App
└── AppShell ── appStore
    ├── TodayPage ──┬── CourseCard ────────── coursesStore
    │               ├── CreateCourseDialog ── (props only)
    │               └── DeletionDialog ────── coursesStore + sessionsStore
    ├── LearnPage ──┬── LearningWorkspace ─── app/chat/sessions/settings/learn-workbench
    │               ├── CourseContextStrip ── coursesStore
    │               └── CreateCourseDialog
    ├── PracticePage ─ learningStore + learnerStore + sessionsStore
    ├── ProfilePage ─┬── LearnerProfilePanel ── learnerStore
    │                └── CourseLearnerPanel ── coursesStore
    ├── CourseDetailPage ─ Course{Plan,Library,Records,Overview}Panel ── coursesStore
    └── SettingsPage ─ General/Models/Archive/AboutSettings ── settingsStore
```

### 1.3 模块依赖矩阵（store → api，页面 → store）

```
                    ┌──────────── api (10) ────────────┐
                    │ courses 1067 · sessions · learning │
                    │ learner · settings · chat · wiki   │
                    └───────────────┬───────────────────┘
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        │                           │                            │
  coursesStore(1351)         learningStore(699)          settingsStore
  learnerStore              sessionsStore(597)          chatStore(956)
        │                           │                    themeStore
        └───────────┬───────────────┴────────────┬───────────────┘
                    │                            │
        pages/ courses/ settings/          LearningWorkspace
        (6 + 10 + 12)                      LearnerProfilePanel
```

- 依赖方向单向：页面/组件 → store → api；`react/ui/*` 不依赖 store 与 api。
- 所有 store 都直接调用各自域的 api（`chat-store → api/chat`、`courses-store → api/courses` 等），这是既有分层：store 是「api 调用的唯一入口」，页面不直接 fetch。`learn-workbench-store` 额外依赖 `sessionsStore`/`appStore` 以完成 E4.8 的首次建会话，重构时保持不变。

## 2. 重复与冗余（按严重度）

### P0 — 影响正确性或维护成本，必须先处理

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0-1 | **学习页面整体未国际化**：`pages/*`、`courses/*`、`ArchiveSettings`、`LearningWorkspace` 全部硬编码中文 | 28 个学习 UI 文件中 20 个未引入 `useTranslation`（19 个含中文文案）；CJK 行数：PracticePage 157、LearnPage 131、CoursePlanPanel 98、TodayPage 82 | 切到 English 后这些页面仍是中文，语言开关形同虚设 |
| P0-2 | **en.json 缺 1 个键、zh.json 缺 2 个复数键**：`files.fileCount` 只在中文 | 见 `e49_i18n_inventory.md` §2 | 英文界面该处显示键名或中文回退 |
| P0-3 | **状态文案多份拷贝**：`ACTION_LABELS`/`KIND_LABELS` 在 `TodayPage` 与 `PracticePage` 完全重复；`STATE_LABEL` 在 `CourseLearnerPanel` 与 `CourseOverviewPanel` 重复 | 两处 map 内容逐字相同 | 改一处漏一处，翻译时必然漂移 |
| P0-4 | **没有 Badge / Card / EmptyState / Status 共享组件**：`mla-badge` 在 13 个文件出现 118 次（含变体类名），`mla-empty` 19 次，全部手写 JSX | `react/ui/index.ts` 无对应导出 | 视觉规则靠复制粘贴维持，E4.8c 的统一只是 CSS 层面 |

### P1 — 明确重复，但可随迁移逐步收敛

| # | 问题 | 证据 |
| --- | --- | --- |
| P1-1 | 加载/错误/空态三件套手写 32 处 `Loader2 + mla-spin`、32 处 `role="alert"`、15 处内联 danger 颜色 | 统计见上 |
| P1-2 | 业务组件里 51 个原生 `<button>`、14 个原生 `<input>`、5 个原生 `<select>`、4 个原生 `<textarea>` 未走共享控件 | LearnPage 9 个 button、PracticePage 5 input + 4 select |
| P1-3 | 197 处内联 `style={{ margin/gap }}` 承担布局间距 | `react/pages`、`react/courses` |
| P1-4 | 18 处一次性字号 `text-[1x]` 绕开字号层级 | 全 `react/` |
| P1-5 | `PracticePage` 1338 行、`LearnPage` 1079 行、`CoursePlanPanel` 932 行，单文件承担多个区块 | 行数统计 |

### P2 — 结构整洁度，可延后

| # | 问题 | 证据 |
| --- | --- | --- |
| P2-1 | 根组件位置不统一：`LearnerProfilePanel`、`LearningWorkspace`、Markdown 族都在 `react/` 根，而非 `pages/`、`courses/`、`ui/` | 目录清单 |
| P2-2 | i18n 中 712 个键属于已移除的 Inno 功能（wordEditor 122、jobs 104、notebook 73、preview 66、sidebar 57、workspaceStart 40、workspace 36、skills 31、terminal 26、files 29、globalSearch 20、contextUsage 17、btw 23、nav 14、officeEditor 10、presets 9、categories 7、desktop 7、permission 5、sessions 4、question 11、welcome 1）；`settings`（354）与 `chat`（233）中另有大部分未引用 | `e49_i18n_inventory.md` §3 |
| P2-3 | `shell.css` 已 2774 行，课程/归档/练习样式都堆在同一文件 | 行数 |
| P2-4 | `mla-practice-input` 等业务专属输入样式独立于 `.inno-ui-textarea` | E4.8g |

## 3. 旧 Inno Agent 代码依赖

判断依据：当前 `react/`、`stores/`、`api/` 的实际 import，而不是文件名里的 Inno/Legacy。

| 模块 | 状态 | 依据 |
| --- | --- | --- |
| `react/markdown/*`（7 文件） | **正在使用** | `MarkdownArtifact → MarkdownRuntime → markdown/special-renderers`，聊天消息渲染依赖 |
| `MarkdownArtifact` / `MarkdownRuntime` | **正在使用** | `LearningWorkspace` 渲染助手回复 |
| `react/ui/*`（18 个共享组件） | **正在使用** | 28 个业务文件从 `ui/index.js` 导入 |
| `react/settings/{AddProviderWizard,MagpieSettings,CurrentModelCard,ModelsSettings,ThinkingLevelField,provider-presets,model-metadata,shared}` | **正在使用** | `SettingsPage → ModelsSettings` 链路 |
| `stores/chat-store` | **正在使用** | `LearningWorkspace`、`sessions-store` |
| `api/commands.ts` | **未确认** | 全仓库无 import；仅自身定义 `GET /api/commands`。**不是**可安全移除（可能有动态调用或后续接入），需在 E4.9d 前单独确认 |
| `utils/chat-trace.ts`（807 行） | **间接依赖，未确认** | 未被 `react/` 引用，需确认是否仅测试使用 |
| `react/MermaidMarkdownRuntime.tsx` | **未确认** | 无静态 import；`MarkdownArtifact` 通过 `utils/mermaid-runtime` 懒加载 Mermaid 渲染器。**不能**据此判定可删 |
| `react/ui/dnd-backend.tsx`、`ui/long-press.ts`、`ui/checkbox.ts` | **未确认** | 三者均无静态 import；`checkbox.ts` 只在注释与测试中出现。E4.9d 前需用构建产物验证 |
| i18n 的 wordEditor/jobs/notebook/preview/sidebar/skills/terminal/files/globalSearch/contextUsage/workspaceStart/btw/officeEditor/presets/permission/categories 分组 | **未确认** | 键仍在资源文件里，但当前页面未引用；删除前需确认没有动态 `t(\`...\`)` 命中 |

**结论**：本阶段没有任何模块可以被证明「不存在当前运行时依赖」。静态无引用但**不能**直接删除的有 `ui/checkbox.ts`、`ui/dnd-backend.tsx`、`ui/long-press.ts`、`MermaidMarkdownRuntime.tsx`；它们要么需要构建产物验证，要么存在动态加载路径。E4.9d 只能处理有构建证据的项。

## 4. 本次实际检查范围

已检查：

- `react/pages/` 6 个页面、`react/courses/` 10 个组件、`react/settings/` 12 个文件、`react/shell/` 4 个文件、`react/ui/` 21 个文件（含 barrel）；
- `react/` 根 6 个组件、`react/markdown/` 7 个文件；
- `stores/` 11 个、`api/` 10 个的 import 关系；
- `i18n/index.ts` 与两份 locale 的键集合比对；
- `app.css`（8774 行）/`themes.css`（107 行）的 token 数量与 `react/ui/index.ts` 导出。

未执行：

- 全量 Vitest、浏览器全站回归、E4.7/E4.8 业务验收（按要求）；
- 构建产物的 tree-shaking 分析（用于 E4.9d 判定「可安全移除」）。

## 5. 未确认的风险

1. **动态键**：`t(\`profile.goals.typeOptions.${tp}\`)` 一类模板键共 12 处，静态扫描无法完整覆盖，翻译覆盖率统计可能偏低。
2. **`api/commands.ts` / `utils/chat-trace.ts`**：静态无引用，但可能被未来功能或动态 import 使用，不能据此删除。
3. **英文界面未做视觉回归**：现有英文键从未在完整页面中检查过长文案换行（导航短标签、按钮宽度）。
4. **`shell.css` 单文件**：样式收敛需要拆分，但拆分本身会改变层叠顺序，风险高于纯改名。
5. **`markdown/` 与 `ui/` 的耦合**：`ArtifactRenderers` 依赖 `SegmentedControl`，重构 UI 层时必须保持该导出。

## 6. 提交哈希

- 审计基准：`5068b53`（`docs(practice): 补充 E4.8g 修改前的桌面截图`）
- 审计提交：见本次提交（文档新增，无运行时代码变更）
