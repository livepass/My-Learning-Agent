# E4.9d — 旧代码清理与架构收尾验收报告

## 1. 提交范围

| 项目 | SHA |
| --- | --- |
| 执行前（E4.9c 收尾） | `7380631` |
| 批次 1：UI 工具与 react-dnd | `70384c2` |
| 批次 2：i18n 资源 | `711d8a7` |
| 执行后（本报告提交前） | `711d8a7` |

E4.9c 已于阶段 0 快进推送到远端 `main`（`691826b..7380631`，无强推、无覆盖）。

## 2. 阶段 0：E4.9c 门禁核验

| 检查项 | 结果 |
| --- | --- |
| 本地/远端差异 | 本地领先 7 个提交、落后 0 个，可快进 |
| `Badge` / `Card` / `EmptyState` / `Field` | **PASS** — 四个文件存在且被 barrel 导出 |
| `StatusBadge` | **PASS** — 由 `Badge.tsx` 导出 |
| `AsyncSection` | **未实现（设计决定）** — E4.9c 审计判定各页面三态重试语义不同，抽象会把业务逻辑塞进通用组件 |
| `tsc --noEmit` | **PASS** |
| `vitest`（react + i18n + stores） | **PASS** — 44 文件 / 504 项 |
| `npm run build` | **PASS** |
| 推送远端 | **PASS** — `691826b..7380631` |

## 3. 阶段 1：依赖审计证据表

审计方法：源码静态 import、动态 `import()`、`lazy()`、测试引用、Electron/后端/showcase 引用、构建产物特征串。构建产物路径 `apps/learning-agent/web/dist/assets/index-*.js`。

| 模块 | 证据 | 结论 | 动作 |
| --- | --- | --- | --- |
| `react/ui/checkbox.ts` | 无任何 import；导出 `checkboxCls` 0 引用；`Checkbox` 组件实际在 `FormControls.tsx` | 可删除 | **已删除** |
| `react/ui/dnd-backend.tsx` | 无 import；`InnoDndProvider` 0 引用；构建产物 `react-dnd` 特征串 0 次 | 可删除 | **已删除** |
| `react/ui/long-press.ts` | 无 import；`getLongPressHandlers` 0 引用 | 可删除 | **已删除** |
| `react/ui/PopoverSurface.tsx` | 仅 barrel 导出，无业务引用；`.inno-popover-surface` 类名由 `Menu`/`Popover`/`Select` 各自拼写，不依赖该组件 | 可删除 | **已删除**（含 barrel 导出） |
| `react/ui/ResizeHandle.tsx` | 仅 barrel 导出 + 自身测试；构建产物 `inno-ui-resize-handle` 0 次 | 可删除 | **已删除**（含测试与导出） |
| `react/MermaidMarkdownRuntime.tsx` | `utils/mermaid-runtime.ts` 通过 `import("../react/MermaidMarkdownRuntime.js")` 动态加载 | **必须保留** | 未动 |
| `utils/chat-trace.ts` | `stores/chat-store.ts` 静态 import 4 个函数；另有自身测试 | **必须保留** | 未动 |
| `api/commands.ts` | 静态 0 引用 | 按要求保留 | 未动 |

附带：`react-dnd` / `react-dnd-html5-backend` / `react-dnd-touch-backend` 三个依赖仅被已删除的 `dnd-backend.tsx` 使用，一并移除。

## 4. 阶段 2：翻译资源清理

### 4.1 审计方法

1. 对 `react/`、`stores/`、`api/`、`utils/`、`i18n/` 的全部非测试源码做**精确引号引用**扫描（`"key"` / `'key'` / `` `key` ``），避免 `learn.sidebar.*` 被误判为 `sidebar.*`；
2. 识别 `t(\`prefix.${x}\`)` 形式的动态前缀（`course.status`、`practice.result`、`profile.goals.*`、`settings.themeOptions` 等 11 个），其下所有键视为在用；
3. 扫描 `electron/`、后端 `apps/learning-agent/src/`、`apps/showcase/`；
4. 单独确认 `desktop.closeDialog.*` 由 `i18n/index.ts` 以**对象属性**方式读取（非字符串键），因此扫描不会命中——显式保留。

### 4.2 删除内容

**整组删除（两侧语言，0 引用）**：`wordEditor`、`jobs`、`notebook`、`terminal`、`sidebar`、`workspace`、`workspaceStart`、`skills`、`files`、`globalSearch`、`contextUsage`、`btw`、`officeEditor`、`presets`、`permission`、`categories`、`preview`、`question`、`welcome`、`sessions`。

**子组删除**：`settings.{smartInput, channels, mcp, permissions, feishu, webResearch, ocr, github, tavily, contentHub, l1, l2, memory, computerUse, codemode, current, providers, memorySection, saved, deleteProvider, back, editModel}`；`chat` 中除 `chat.trace.*` 外的全部子键。

**键总数**：2369 → 1331（zh-CN）/ 1333（en）。差额中的 2 个来自英文复数族（`_one`/`_other`）。

### 4.3 保留内容

`today.*`、`learn.*`、`practice.*`、`course.*`、`archive.*`、`profile.*`、`shell.*`、`settingsPage.*`、`nav.*`（学习页部分）、`common.*`（在用部分）、`markdown.*`（在用部分）、`chat.trace.*`、`settings.{magpie, models, form, wizard, thinking, presets, stats, errors, closeBehavior, themeOptions, languageOptions, markdownMath, about, title, refresh, loading, use, newProvider, saveProvider, savingProvider, confirmDelete, language, theme, followSystem, followSystemDesc}`、`desktop.closeDialog.*`。

## 5. 验证结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | **PASS** |
| 构建 | `npm run build` | **PASS**（index 1926 KB → 1845 KB） |
| 翻译校验 | `npx vitest run apps/learning-agent/web/src/i18n/locales.test.ts` | **PASS** — 8 项 |
| 前端定向 | `npx vitest run apps/learning-agent/web/src/react apps/learning-agent/web/src/i18n apps/learning-agent/web/src/stores` | **PASS** — 43 文件 / 496 项（较 E4.9c 少 8 项，为已删除的 ResizeHandle 测试） |

未执行：全量历史测试、后端业务验收（E4.7/E4.8）、Electron 壳内验证。

## 6. 实机回归

临时数据目录 + 当前构建（3109 端口），在真实浏览器逐页核对：

| 页面 | 中文 | English | 裸键泄漏 |
| --- | --- | --- | --- |
| 今日学习 | PASS | PASS | 无 |
| AI 学习（欢迎 / 选课） | PASS | PASS | 无 |
| 练习与反馈 | PASS | PASS | 无 |
| 我的学习档案 | PASS | PASS | 无 |
| 系统设置·通用 | PASS | PASS | 无 |
| 系统设置·模型连接 | PASS | PASS | 无 |
| 系统设置·归档 | PASS | PASS | 无 |

语言切换：中文 → English → 中文 均即时生效，刷新后保持。

数据完整性（清理后复查 API）：

- 课程 2 门（`Regression Course` in_progress / `Archived Regression` archived），计数与会话绑定正确；
- `/api/sessions` 返回 1 个会话且课程归属正确；
- `/api/learner/profile` 可读（goals 0 / states 0，符合空白档案预期）。

## 7. 结论

| 完成标准 | 结论 |
| --- | --- |
| 所有删除项都有充分的无运行时依赖证据 | **PASS** |
| 构建与相关定向测试通过 | **PASS** |
| 六个学习页面与必要交互无回归 | **PASS** |
| 中英文资源无新增缺失 | **PASS**（`locales.test.ts` 8 项通过） |
| 学习记忆、练习证据、课程与会话数据不受影响 | **PASS**（本轮未触碰任何数据路径，实机复查通过） |
| 提交完整验收报告、变更可追踪 | **PASS** |

**E4.9d 结论：PASS。**

## 8. 未解决风险与后续建议

1. **英文界面仍有一处服务端中文**：今日学习页的课程计划说明来自 `apps/learning-agent/src/courses/daily-plan.ts:273`（`note` 字段），属 E4.9b 范围外的服务端文案。**NOT_VERIFIED** —— 本轮未修改后端，也未纳入删除范围。
2. **`settings` 组仍有部分未引用键**（如 `settings.sections` 的部分子键、`settings.tabs` 的旧值）。它们与在用键混在同一子组，逐个删除收益低、误删风险高，留待后续按需处理。
3. **`api/commands.ts`** 静态 0 引用但按要求保留；若确认永不接入 slash 命令，可在后续单独评估。
4. **`react/MermaidMarkdownRuntime.tsx`** 只经动态 import 使用，未来若改用其他 Mermaid 方案需同步删除该文件与 `utils/mermaid-runtime.ts`。
5. 本轮未跑全量测试，后端与 Electron 的回归依赖既有 E4.7/E4.8 验收记录。
