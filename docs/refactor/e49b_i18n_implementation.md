# E4.9b — 中英文国际化统一实施

- 基准：`53e388a`（E4.9a 审计），执行时 `main` 已含 E4.8g
- 范围：当前有效的 My Learning Agent 学习界面；未改业务逻辑、数据格式与 API 协议
- 技术：继续使用 `react-i18next` + `web/src/i18n/{index.ts,locales/*.json}`；`inno.locale` 与即时切换保持不变

## 1. 分批提交

| 批次 | 范围 | 提交 |
| --- | --- | --- |
| B1 | 国际化基础、全局导航、设置页外壳、资源校验 | `3671775` |
| B2 | 今日学习与课程管理（12 个文件） | `81f0d48` |
| B3 | AI 学习与练习反馈（3 个文件） | `5d3cf6f` |
| B4 | 学习档案、归档与设置收尾（7 个文件） | `872cd04` |
| 收尾 | 日期与排序跟随当前语言 | `3e300e8` |

> 语言资源（`zh-CN.json` / `en.json`）是一次性落地的，随 B2 提交；B3/B4 只含组件改动。这样避免三个批次各自改写同一份资源文件。

## 2. 各批次改动

### B1 — 基础与导航

- `SHELL_PAGE_META` 不再保存中文文案，改为 `labelKey` / `shortLabelKey` / `descriptionKey`；`AppShell` 在渲染时用 `t()` 解析，语言切换立即生效，导航 ID / URL / 历史逻辑不变。
- 新增 `nav.{today,learn,practice,profile,settingsPage,course}.*`、`shell.*`（跳转链接与两个 nav 的可访问名）、`course.status.*`、`practice.result.*`、`settingsPage.*`。
- `SettingsPage` 标题、副标题、四个页签、加载/不可用提示改为翻译键。
- 新增 `i18n/locales.test.ts`（见 §3），并在 `vitest.setup.ts` 初始化 i18n，使测试与运行时使用同一份 zh-CN 资源。

### B2 — 今日学习与课程管理

- `TodayPage`、`CourseDetailPage` 与 10 个 `react/courses/*` 组件全部改走 `t()`：课程卡、课程上下文条、学习目标、知识库、概况、计划、记录、创建课程、删除确认、计划结构编辑器。
- 统一 `today.*` / `course.*` 键；`CourseLearnerPanel` 与 `CourseOverviewPanel` 原先各写一份的 `STATE_LABEL` 合并为 `course.state.*`；`TodayPage` 与 `PracticePage` 重复的 `ACTION_LABELS` / `KIND_LABELS` 由 `today.action.*` / `today.kind.*` 与 `practice.*` 各自解析，不再复制字面量。
- 课程状态、任务状态、计划状态、来源、难度、教材索引状态全部用「前缀 + 枚举值」键，渲染时解析；模块级标签表改为键表，`t()` 不在模块作用域调用。
- 保留原文：课程/计划/任务/知识点名称、用户与 AI 文本、`question.prompt`、id 与枚举值、服务端返回的消息。

### B3 — AI 学习与练习反馈

- `LearnPage`、`LearningWorkspace`、`PracticePage` 全部界面文案改走 `t()`：欢迎页与课程选择、快捷入口、会话侧栏与归档入口、学习状态与阻塞提示、题目外壳、作答提示、提交/评分/重试/记录证据、练习说明、下一题与学习建议。
- `STEP_LABEL` / `STATUS_LABEL` / `ACTION_LABEL` / `QUICK_ACTIONS` / `STARTER_PROMPTS` 改为键表；提示语模板使用 `{{title}}` 插值。
- `courseStatusLabel()` 在页面侧改为 `t(\`course.status.${status}\`)`，store 未改。
- 日期与复习标签使用 `i18n.language`；`branchErrorMessage` / `editingBlockReason` 接受 `TFunction`。
- **保持原文**：`question.prompt`、用户作答、AI 回复、评分反馈与依据、会话名/预览、课程名、知识点名、id、服务端错误消息。
- E4.8g 的一体化练习卡与提交、评分、记录证据流程完全保留。

### B4 — 档案、归档与设置

- `ProfilePage` 标题、副标题、范围选择；`LearnerProfilePanel` 仅剩的固定中文（放弃未保存摘要的确认）改为键。
- `ArchiveSettings` 全部分组、行内归档原因、操作、菜单、反馈、错误与空状态；`buildGroups` 保持纯函数，未知课程标题在渲染层解析为 `archive.unknownCourse`。
- `AboutSettings` 说明、`MagpieSettings` 手动模型占位符；`provider-presets.ts` 变为只带 `descriptionKey` / `modelHintKey` 的数据模块，`AddProviderWizard` 渲染时解析。
- 顶栏「设置」按钮的可访问名恢复为短标签（`nav.settingsPage.short`）。

### 收尾 — 日期

- 今日学习、课程组件、学习档案、归档中心、删除确认里的 `toLocaleDateString/String("zh-CN")` 改为 `currentLocale()`；归档分组按当前语言排序。

## 3. 翻译资源校验（`i18n/locales.test.ts`，7 项）

1. 学习键在 zh-CN 与 en 中同时存在；
2. 动态枚举键（`course.status.*`、`practice.result.*`）逐个校验；
3. 同一键的 `{{变量}}` 集合在两份资源中一致；
4. 复数键按语言规则处理（英文 `_one`/`_other`、中文单数形式），不要求两份 JSON 键完全相同；
5. 学习组件中的固定中文必须已迁移，`PENDING` 燃尽清单已清空——任何新增硬编码中文都会让测试失败；
6. **代码中每个字面量 `t("…")` 引用的键都必须在两份资源中存在**，缺失即失败，不会被运行时中文 fallback 掩盖；
7. 注释与 `t("key", "中文兜底")` 在扫描前剥离，避免把资源或注释误报为硬编码。

## 4. 错误信息

- 错误码（`course_paused`、`course_archived`、`course_required`、`learning_state_invalid` 等）仍按原值在 store 与 API 间传递，显示层按码映射到本地化文案。
- 无法识别的错误显示本地化的通用失败提示，并保留服务端诊断信息。
- 未改 `coursesStore` / `learningStore` / `chatStore` 的业务逻辑。

## 5. 翻译覆盖

| 指标 | 数值 |
| --- | --- |
| 新增翻译键 | 853（B1 21 + B2 444 + B3 338 + B4 65 + 缺失补齐 6；资源总量 1478 → 2369） |
| 学习界面字面量 `t()` 引用 | 1028 处 |
| 学习组件中残留固定中文 | 0 |
| 六页面英文实机核对 | 今日学习、AI 学习（欢迎/选课）、练习与反馈、学习档案、课程详情、系统设置·归档 |

## 6. 定向测试与构建

```
npx vitest run apps/learning-agent/web/src/react apps/learning-agent/web/src/i18n apps/learning-agent/web/src/stores
→ 43 files / 493 passed / 1 flaky timeout (MarkdownArtifact mermaid, 单独运行通过)
```

- `i18n/locales.test.ts`：7/7。
- `PracticePage`、`LearnPage*`、`LearningWorkspace`、`TodayPage*`、`CourseDetailPage`、`DeletionDialog`、`ProfilePage*`、`SettingsPage.archived`、`settings/*`：全部通过。
- `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json`：无错误。
- `npm run build`：通过。

## 7. 未覆盖的例外

- `provider-presets.ts` 中品牌名（DeepSeek、Kimi 等）保持原样，属品牌名不翻译。
- 服务端返回的 `message` 字段、模型生成的 `material_note` / `assumptions` / `uncertainties`、`source_title` / `heading_path` 保持原文。
- 少量 `{{count}}` 键为单数形式（英文在 count=1 时会读作 “1 messages”），未引入复数族；与仓库既有 `files.fileCount` 的处理方式一致，可作为后续优化。
- 英文界面截图未能取到：浏览器窗口被最小化，截图接口持续超时。改用 DOM 逐页核对（标题、副标题、按钮、空状态、导航、日期格式），结果见 §5。

## 8. 残余风险与 E4.9c 建议

- **残余风险**：英文长文案尚未做完整视觉回归（导航短标签、按钮、卡片标题换行）；建议 E4.9c 组件收敛时顺带核对。
- 单数形式的计数文案在英文下不自然；若产品在意，可在 E4.9c 一并引入 `_one`/`_other`。
- 资源文件目前仍混有约 712 个 Inno 遗留键（`wordEditor`、`jobs`、`notebook` 等），E4.9d 清理前需先用构建产物确认无引用。
- **E4.9c 建议**：新增 `Badge` / `EmptyState` / `AsyncSection` / `Field` / `Card` 时，把本次已在各页面重复的「状态标签 + 空态 + 三态」结构一并收进组件；`StatusBadge` 的文案直接消费 `course.status.*` 等键，避免页面再写映射。
