# E4.9a — 中英文翻译覆盖清单

- 基准：`5068b53`
- 资源文件：`web/src/i18n/locales/zh-CN.json`（1478 键）、`en.json`（1479 键）
- 初始化：`web/src/i18n/index.ts`，`fallbackLng: "zh-CN"`，语言存于 `localStorage["inno.locale"]`，切换入口在「系统设置 → 通用与外观」

## 1. 当前覆盖概况

| 指标 | 数值 |
| --- | --- |
| zh-CN 键总数 | 1478 |
| en 键总数 | 1479 |
| 业务代码中**字面量** `t("…")` 引用的键 | 253 |
| 业务代码中**模板** `t(\`…${}\`)` 引用的键 | 12 处（profile 的 8 处、settings 的 4 处） |
| 学习 UI 中**未引入 `useTranslation`** 的文件 | 20 / 28（其中 19 个含中文文案） |

已国际化的部分集中在 **设置页**（General/Models/Magpie/About/ThinkingLevel）与 **学习档案面板**（`LearnerProfilePanel`，72 处 `t()`）、Markdown 渲染族。核心学习页面（今日学习、AI 学习、练习与反馈、课程详情、课程组件、统一归档、AppShell 导航）全部是硬编码中文。

## 2. 键集合差异（P0-2）

| 键 | zh-CN | en | 说明 |
| --- | --- | --- | --- |
| `files.fileCount` | `{{count}} 个文件` | **缺失** | 英文界面会回退中文 |
| `files.fileCount_one` / `_other` | 缺失 | `{{count}} file` / `files` | 英文复数键在中文资源中不存在（正常） |

另发现 6 个**代码引用但资源缺失**的键（均带默认值，运行时不会显示键名，但属于隐患）：

```
common.clearSearch            settings.form.apiType
markdown.artifact             settings.wizard.noMatchingModels
                              settings.wizard.searchFetchedModels
                              settings.wizard.selectFetchedModel
```

## 3. 键分组使用情况

| 分组 | 键数 | 与学习系统相关 | 说明 |
| --- | ---: | --- | --- |
| `settings` | 354 | 部分 | 含已移除的 Inno 设置项（channels/feishu/github/codemode/computerUse…） |
| `chat` | 233 | 部分 | 含 slash palette、审批、上下文用量等 Inno 聊天能力 |
| `markdown` | 74 | **是** | Markdown 工具栏、artifact 渲染 |
| `profile` | 66 | **是** | 学习档案（唯一大量国际化的学习模块） |
| `common` | 39 | **是** | 通用按钮（save/cancel/done/delete…） |
| `wordEditor` | 122 | 否 | 已移除的文档编辑 |
| `jobs` | 104 | 否 | 已移除的任务中心 |
| `notebook` | 73 | 否 | 已移除 |
| `preview` | 66 | 否 | 已移除的文件预览 |
| `sidebar` | 57 | 否 | 已移除的工作区侧栏 |
| `workspaceStart` / `workspace` | 76 | 否 | 已移除 |
| `skills` / `terminal` / `files` / `globalSearch` / `contextUsage` / `btw` / `officeEditor` / `presets` / `permission` / `categories` / `desktop` / `nav` / `question` / `sessions` / `welcome` | 289 | 否（`desktop` 例外） | 均为 Inno 遗留 |

> 712 个键（48%）属于已移除功能，另有 `settings`（354）与 `chat`（233）中大部分未被学习页面引用，是 E4.9b 需要决策的范围：保留（低成本）还是清理（减少误用）。

## 4. 各页面翻译覆盖表

统计口径：页面文件（含其直接业务组件）中的中文界面文字；「已翻译」指已走 `t()`。

### 4.1 全局导航与外壳

| 文字 | 来源 | 现状 |
| --- | --- | --- |
| 今日学习 / AI 学习 / 练习与反馈 / 我的学习档案 / 系统设置 / 课程详情 | `shell/navigation.ts` `SHELL_PAGE_META` | **硬编码**（6 条 label + 6 条 description + 短标签） |
| 今日 / 学习 / 练习 / 档案 / 设置 / 课程 | 同上 `shortLabel` | **硬编码** |
| 设置（顶栏按钮）、跳到主要内容、My Learning Agent | `AppShell.tsx` | **硬编码** |

建议键：`nav.today.label`、`nav.today.short`、`nav.today.description` …（6 页 × 3 字段），保留 `nav.*` 现有分组名但新增学习页命名空间 `nav.learning.*`，避免与 Inno 遗留的 `nav.chat/files/jobs` 冲突。

### 4.2 今日学习（`TodayPage.tsx`，82 行含中文）

| 类别 | 数量 | 示例 |
| --- | ---: | --- |
| 已翻译 | 0 | — |
| 固定中文 | 76 | 「我的课程」「每门课程有独立的目标、教材、计划与学习记录」「今日跨课程任务」「下一步学习建议」「暂时没有个性化建议」「正在读取学习档案…」 |
| 动态状态标签 | 3 组 | `ACTION_LABELS`（5 项）、`KIND_LABELS`（3 项）、`RESULT_LABELS`（4 项） |
| 错误/空态 | 9 | 「课程列表读取失败」「今天还没有课程安排」「目前没有足够可靠的学习记录…」 |

### 4.3 AI 学习（`LearnPage.tsx` + `LearningWorkspace.tsx`，131 + 51 行含中文）

| 类别 | 数量 | 示例 |
| --- | ---: | --- |
| 已翻译 | 0（`LearningWorkspace` 未引入 `useTranslation`，文案全部硬编码） | — |
| 固定中文 | 125 + 49 | 「你想学习什么？」「先选择一门课程，再开始本次 AI 学习。」「在「{课程名}」中开始第一段学习」「继续之前的对话」「查看归档」「本次学习」「暂停学习」 |
| 动态状态标签 | 3 组 | `STEP_LABEL`、`STATUS_LABEL`、`ACTION_LABEL` |
| 错误/提示 | 21 | 「课程已暂停」「课程已完成」「课程列表读取失败」「请先恢复所属课程」 |
| 保留原文 | — | 会话标题、预览、助手回复（来自用户/AI，不翻译） |

### 4.4 练习与反馈（`PracticePage.tsx`，157 行含中文）

| 类别 | 数量 | 示例 |
| --- | ---: | --- |
| 已翻译 | 0 | — |
| 固定中文 | 144 | 「当前题目」「题目信息」「你的回答」「提交作答」「先独立作答，提交后再看评分」「评分反馈」「练习说明」 |
| 动态状态标签 | 4 组 | `ACTION_LABELS`、`KIND_LABELS`、结果标签（答对/部分答对/答错/无法判定）、评分阶段文案 |
| 错误/空态 | 13 | 「还没有待作答的题目」「评分失败：…」「评分重试次数已用尽。」 |
| 保留原文 | — | `question.prompt`、用户作答、评分反馈正文（服务端生成） |

### 4.5 我的学习档案（`ProfilePage.tsx` + `LearnerProfilePanel.tsx`）

| 类别 | 数量 | 示例 |
| --- | ---: | --- |
| 已翻译 | 72 处 `t()` | `profile.sections.summary`、`profile.goals.addNew`、`profile.summary.*` |
| 固定中文 | 6（`ProfilePage` 标题与副标题） | 「我的学习档案」「学习目标、知识掌握、薄弱点与教学偏好都来自同一份本机档案。」 |
| 动态状态标签 | 3 组 | `profile.goals.typeOptions.*`、`profile.goals.statusOptions.*`、`profile.knowledge.masteryState.*`（均为 i18n 键） |
| 错误 | 部分 | `profile.goals.addFailed` 已翻译；`profile.summary.saveFailed` 已新增 |

### 4.6 课程管理（`react/courses/*`，266 个中文字符串）

| 类别 | 数量 | 示例 |
| --- | ---: | --- |
| 已翻译 | 0 | — |
| 固定中文 | ~230 | 「课程详情」「学习计划」「课程知识库」「学习记录」「学习概况」「归档课程」「删除课程」「计划草稿已保存」 |
| 动态状态标签 | 5 组 | `STATE_LABEL`（2 份重复）、`BASIS_LABEL`、`ORIGIN_LABEL`、课程/任务/计划状态（来自 `courses-store.ts` 的 `courseStatusLabel` 等） |
| 错误/空态 | ~30 | 「还没有关联学习目标」「课程列表读取失败」「只有已归档的课程可以永久删除。」 |

### 4.7 统一归档（`ArchiveSettings.tsx`，39 个中文字符串）

| 类别 | 数量 |
| --- | ---: |
| 已翻译 | 0 |
| 固定中文 | 36（「归档」「已归档」「随课程归档」「手动归档 · 课程已归档」「查看历史」「恢复课程」「删除课程」「暂无归档内容」「未归类归档会话」） |
| 动态 | 3（组标题来自课程名、会话名，保留原文） |

### 4.8 系统设置（`SettingsPage.tsx` + `react/settings/*`）

| 类别 | 数量 |
| --- | ---: |
| 已翻译 | 大部分（General/Models/Magpie/About/ThinkingLevel 共 123 个 `settings.*` 键） |
| 固定中文 | `SettingsPage` 9 个（页标题、副标题、4 个 tab 名、错误提示） |
| 动态 | `settings.themeOptions.*` 等 |

### 4.9 通用弹窗 / 错误 / 空状态

| 类别 | 现状 |
| --- | --- |
| 通用按钮 | `common.*` 39 键，已翻译，但学习页面多数手写「取消」「保存」「删除」 |
| 空状态 | 19 处 `mla-empty`，文案全部硬编码 |
| 错误提示 | 32 处 `role="alert"`，文案全部硬编码；`courses-store` 内 50 行含中文错误消息 |
| 确认框 | `window.confirm` 文案硬编码（会话删除、摘要放弃、课程删除） |

## 5. 需要保留原文的内容（不翻译）

- 用户输入：会话标题、会话预览、用户作答、草稿。
- AI 输出：助手回复、题目 `prompt`、评分反馈 `feedback`、评分依据 `explanation`。
- 服务端标识：`question_id`、`question_version`、`course_id`、`session_id`、`concept_id`、错误码。
- 用户自建的课程名、目标标题、知识点名称。

## 6. 命名规范（E4.9b 实施）

```
<domain>.<area>.<element>[.<variant>]
```

| 规则 | 说明 |
| --- | --- |
| 域 | `nav` / `today` / `learn` / `practice` / `profile` / `course` / `archive` / `settings` / `common` |
| 学习页专用命名空间 | 新增 `today.*`、`learn.*`、`practice.*`、`course.*`、`archive.*`；`profile.*` 沿用现有 |
| 枚举值 | 用语义值作键，不用序号：`practice.result.correct`、`course.status.in_progress` |
| 动态拼接 | 只允许「前缀 + 已枚举值」：`t(\`course.status.${status}\`)`；禁止拼接自由文本 |
| 错误 | 界面文案与错误码分离：`practice.error.<code>`，服务端 `message` 仅作兜底展示 |
| 复数 | 使用 i18next `_one`/`_other`；中文只保留单数键（或同时提供，二者取其一并在校验中说明） |
| 占位 | 变量统一 `{{name}}`，不用位置参数 |

## 7. 缺失翻译检测策略

1. **键集合校验（CI 可跑）**：`zh-CN.json` 与 `en.json` 递归展开后比较键集合；`_one`/`_other` 按语言规则豁免。当前脚本已能报出 `files.fileCount` 这一类差异。
2. **代码引用校验**：扫描 `t("…")` 字面量与 `t(\`prefix.${…}\`)` 模板，前者必须存在于两份资源；后者校验前缀下至少存在一个键。当前已发现 6 个「引用但缺失」的键。
3. **硬编码中文校验**：对 `react/pages`、`react/courses`、`react/settings`、`react/shell`、`react/*.tsx` 扫描 CJK 字符，允许清单（`// i18n-allow` 注释）逐条登记保留原文的场景（如 `zh-CN` 展示、日志）。
4. **视觉回归**：E4.9b 完成后在英文界面检查导航短标签、按钮、长标题换行。

建议把 1、2 做成 `vitest` 用例（`i18n/locales.test.ts`），随现有测试体系运行，不引入新工具链。
