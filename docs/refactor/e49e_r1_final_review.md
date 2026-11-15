# E4.9e-R1 — 国际化最终修复验收报告

- 修复前：`fdac6b5`（E4.9e 验收报告）
- 修复后：`1e1fbe8`（本轮代码提交）
- 范围：仅修复独立审查发现的三处问题及其直接关联遗漏

## 1. 问题原因、修改位置与验证证据

### R1-1 课程操作成功提示仍存中文

**原因**：`runWrite()` 的成功消息参数类型是 `successMessage?: string`，成功后写入 `{ tone: "success", message: successMessage }`，没有 `messageKey`。`useCourseFeedbackText()` 只认 `messageKey`，于是回退到 `message` —— 也就是那句中文。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `stores/courses-store.ts` | 新增 `SuccessFeedback { key, params? }` 与 `ok(key)` 简写；`runWrite` 第三个参数改为 `success?: SuccessFeedback`；成功时写入 `message: success.key`（旧代码兼容）+ `messageKey` + `messageParams` |
| 同上 · 23 个调用点 | 全部由中文字符串改为 `ok("course.success.*")` |
| 同上 · 直接写 feedback 处 | `deleteCourse` 的 `this.feedback = { tone: "success", message: ... }` 同步带上 `messageKey` |
| `i18n/locales/{zh-CN,en}.json` | 新增 23 个 `course.success.*` 键 |

**未改动**：`runWrite` 的 `pendingAction` 并发保护、`writeStillRelevant` 课程切换隔离、`_writeEpoch` 机制、成功判定与写入队列。

**验证证据**（真实浏览器，英文界面）：创建计划后页面显示 `Study plan created`（英文），课程名「英文测试课程」与计划名「我的学习计划」保持中文原文。

### R1-2 归档中心未适配 `CourseErrorRef`

**原因**：`coursesStore.coursesError` 已改为 `CourseErrorRef` 对象，但 `ArchiveSettings` 仍写 `{t("archive.loadFailed", { message: loadError })}` 直接插值，渲染成 `[object Object]`。此外归档中心自己的 `feedback` 存的是**已翻译字符串**，切语言不会更新；辅助函数 `errorMessage()` 还会把服务端中文 `message` 原样返回。

**修改**：

| 位置 | 改动 |
| --- | --- |
| `react/settings/ArchiveSettings.tsx` | 引入 `useCourseErrorText()`；`courseLoadError = courseErrorText(coursesState.error)`，与 `sessionsState.error` 组合时**课程错误优先** |
| 同上 · feedback 状态 | 从 `{ tone, message }` 改为 `{ tone, messageKey, params? }`，渲染时 `t(messageKey, params)` |
| 同上 · 恢复课程失败 | 优先用 `coursesStore.feedback?.messageKey`，无则回落 `archive.errors.restoreCourseRetry` |
| 同上 · 删除 `errorMessage()` | 该函数会把服务端中文 message 原样返回，已无调用点，删除 |

**未改动**：分组逻辑、只读状态、恢复约束、E4.8d 安全删除流程。

**验证证据**（真实浏览器，故意损坏 `courses/state.json` 制造真实 503）：

- 英文界面：`Could not load archived content: The course or learning record is corrupt; writing has stopped.`
- 无 `[object Object]`、无裸翻译键、未误显示空态

### R1-3 语言切换测试通过重挂载验证

**原因**：`course-error-text.test.tsx` 在切换语言前调用 `cleanup()` 再 `render()`，只能证明「新挂载会读新语言」，不能证明已挂载组件会更新。

**修改**：

| 文件 | 改动 |
| --- | --- |
| `react/courses/language-switch-live.test.tsx`（新增） | 6 项：同一已挂载组件内 中文→English→中文，用 `act()` 驱动 `i18n.changeLanguage`，断言**同一 DOM 节点**文本变化 |
| `react/courses/course-error-text.test.tsx` | 移除两处 mid-test `cleanup()`，改为 `act()` 就地切换 |
| `react/pages/SettingsPage.archived.test.tsx` | 新增 2 项：课程读取失败不出现 `[object Object]`；已显示的归档错误随语言切换更新（同样不重挂载） |

## 2. 新增翻译键与成功提示覆盖表

本轮新增 **23** 个键（`course.success.*`），中英各一份；键总数 1363 → 1386 / 1365 → 1388。

| 操作 | 键 |
| --- | --- |
| 创建课程 | `course.success.created` |
| 更新课程 | `course.success.updated` |
| 归档课程 | `course.success.archived` |
| 恢复课程 | `course.success.restored` |
| 继续课程 | `course.success.resumed` |
| 永久删除课程 | `course.success.deleted` |
| 创建计划 | `course.success.planCreated` |
| AI 生成草稿 | `course.success.planGenerated` |
| 保存草稿 | `course.success.draftSaved` |
| 确认启用计划 | `course.success.planConfirmed` |
| 归档计划 | `course.success.planArchived` |
| 删除计划 | `course.success.planDeleted` |
| 任务顺序调整 | `course.success.tasksReordered` |
| 应用调整建议 | `course.success.suggestionApplied` |
| 任务标记完成 | `course.success.taskCompleted` |
| 任务状态更新 | `course.success.taskUpdated` |
| 保存每日学习时间 | `course.success.settingsSaved` |
| 绑定学习目标 | `course.success.goalBound` |
| 解绑学习目标 | `course.success.goalUnbound` |
| 上传资料 | `course.success.sourceUploaded` |
| 重新解析资料 | `course.success.sourceRetried` |
| 关联资料 | `course.success.sourceBound` |
| 解除资料关联 | `course.success.sourceUnbound` |

## 3. 测试结果

```
npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json            PASS
npx vitest run apps/learning-agent/web/src/react \
  apps/learning-agent/web/src/i18n apps/learning-agent/web/src/stores
  → 46 files / 518 tests PASS（失败 0）
npm run build                                                        PASS
```

本轮新增测试 8 项（`language-switch-live` 6 + 归档中心 2），修改既有断言 2 处（`courses-store.test.ts` 的成功消息断言、`DeletionDialog.test.tsx` 的 409 文案断言）。

## 4. 真实浏览器验收

独立临时数据目录（`/tmp/e49er1`），当前构建，端口 3111，未触碰真实个人数据。

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | English 模式创建课程 | PASS — 课程创建成功，跳转课程详情 |
| 2 | English 模式创建并启用计划 | PASS — 提示 `Study plan created`（英文） |
| 3 | English 模式课程列表读取失败（损坏 state.json 制造真实 503） | PASS — 归档中心显示英文错误，无 `[object Object]` |
| 4 | 错误显示期间切换语言 | **NOT_VERIFIED（浏览器）** — 页面内无法调用 `setLocale`（模块未暴露到 window），改用同组件 `act()` 测试覆盖（6 项） |
| 5 | 中文课程名在英文界面保持原文 | PASS —「英文测试课程」「我的学习计划」均保持中文 |
| 6 | 英文界面无新增中文系统提示 | PASS — 逐页检查仅剩用户内容为中文 |

**截图未取得**：浏览器窗口被最小化，`preview_screenshot` 持续超时（此前多轮同样如此）。本轮以 DOM 检查替代，**视觉验收标记为未完成**，不以 DOM 检查冒充视觉验收结论。

**测试未使用真实模型**：fixture provider 指向不可达地址，全部验收为界面层与错误路径。

## 5. 核对并修正 E4.9e 的键数

E4.9e 报告写「31 个」，分类明细合计 32。以 JSON 实际差异为准：

```
git show 7e95fb7:...zh-CN.json  → 1331 keys
git show 4a7d534:...zh-CN.json  → 1363 keys
差额 = 32
```

已修正 `e49e_i18n_closeout.md` 中的统计为 **32**。

## 6. 未验证范围与剩余风险

1. **视觉验收未完成**（见 §4）：无截图，仅 DOM 检查。
2. **服务端中文文案仍在**：`daily-plan.ts` / `recommendations.ts` 的 `reason`、各 `failure(...)` 的 `message`。前端不再显示它们，但其他客户端读 API 仍会拿到中文 —— 需后端按语言返回，超出本轮约束。
3. **未登记错误码**：后端返回前端未枚举的 `code` 且无 HTTP 状态可归类时，仍回退服务端原文（可能中文）。已覆盖 21 个错误码与 404/409/503。
4. **归档中心会话恢复/删除的失败提示**统一用 `archive.errors.*` 通用文案，未按服务端错误码细分（会话接口不返回课程错误码）。
5. 未跑全量历史测试与后端验收；未做移动端逐页截图。

## 7. 结论

| 完成标准 | 结论 |
| --- | --- |
| 所有现存课程成功提示不再直接暴露固定中文 | **PASS** |
| 归档中心错误对象正确解析 | **PASS** |
| 中英文切换无需重新挂载组件 | **PASS**（6 项同组件 act() 测试） |
| 用户数据与 AI 内容保持不变 | **PASS** |
| 类型检查、构建、国际化测试与定向测试通过 | **PASS** |
| 真实浏览器验收 | **PASS**（DOM 层），**视觉截图 NOT_VERIFIED** |
| 交付完整 R1 报告 | **PASS** |

**E4.9e-R1 最终结论：PASS**（视觉截图项 NOT_VERIFIED，已在 §4/§6 标注）。
