# UI-C01 验收报告：课程视觉标识与重复信息专项修正

- **基准分支**：`main`
- **基准 SHA**：`7b5b96cfb5711297632872901c00708112b94646`
- **工作分支**：`fix/course-visual-identity-and-copy`
- **原 UI-C01 产品实现 SHA**：`f65055e`
- **UI-C01-R1 CSS 修正 SHA**：`ba535c9`
- **当前验收结论**：原 UI-C01 核心实现保留既有验收结果；R1 新增 CSS 尚未重新浏览器验证，暂不视作最终验收完成。
- **任务性质**：前端视觉一致性修复（不改业务逻辑、接口、Store 或状态枚举）
- **原 UI-C01 结论**：核心功能 PASS，历史全量测试保留 1 项已知基线失败；**R1 待验证**（见第 11 节）

---

## 1. 基线与环境

| 项 | 值 |
| --- | --- |
| 起点工作区 | 干净（`git status` 无改动） |
| Node.js | v24.x |
| 平台 | Windows 11，Git Bash |
| 浏览器 | Google Chrome（Playwright 驱动真实 Chrome，非 headless-shell） |
| 服务端 | 真实 `apps/learning-agent/dist/server.js`，`INNO_PORT=7940`，隔离 `INNO_CONFIG_DIR` / `INNO_DATA_DIR`（`.tmp/ui-c01`，已被 `.gitignore` 的 `.tmp/` 忽略） |
| provider | 本地确定性桩（`.tmp/ui-c01/stub-provider.mjs`，OpenAI Chat Completions 流式协议） |
| 测试数据 | 通过真实 HTTP API 创建（`.tmp/ui-c01/seed.py`），未触碰任何正式学习记录 |

> 桩 provider 只替换模型端点。课程、计划、任务、每日计划、会话绑定全部走真实服务端逻辑。本文所有结论都是界面与协议正确性，不是真实模型质量。

### 1.1 测试数据

| 课程 | 状态 | 计划 / 阶段 | 覆盖点 |
| --- | --- | --- | --- |
| 同义替换 | 进行中 | 词义辨析计划 / 第一阶段：词义辨析 | 中文课程、有阶段 |
| Python Basics: Functions, Closures and Decorators | 进行中 | Python Foundations（无阶段） | 英文课程、长英文名、无阶段回退 |
| 同义替换与近义词辨析：从语境、语体到感情色彩的系统训练方法 | 进行中 | 长名称计划 / 第一阶段：语境判断 | 长中文名 |
| Advanced Academic Writing and Argumentative Essay Structure | 进行中 | 无计划 | 无计划状态、长英文名 |
| 高等数学 | 已暂停 | 极限与连续计划 | 暂停状态 |
| 数据结构 | 已完成 | 线性表计划 | 完成状态 |

---

## 2. 修改文件

| 文件 | 改动 |
| --- | --- |
| `apps/learning-agent/web/src/react/courses/CourseCover.tsx` | 删除 `initialOf()` 与首字占位；`CourseCover` 统一渲染 Lucide `BookMarked`；`TaskCover` 在无阶段（或阶段等于课程名）时不再回退显示课程名 |
| `apps/learning-agent/web/src/react/courses/CourseRow.tsx` | 副标题不再重复徽章状态；无计划时不再额外渲染「未启用计划」进度文本 |
| `apps/learning-agent/web/src/react/courses/CourseCard.tsx` | 删除正文可见的阶段 + 时长副标题，改用 `.mla-today-sr` 保留同一信息给辅助技术 |
| `apps/learning-agent/web/src/react/pages/TodayHero.tsx` | 「今日主课」徽章不再拼接课程名（标题已显示）；任务态 meta 改为「课程名 · 阶段 · 时长」；暂停态 meta 不再重复「已暂停」；meta 为空时不渲染空行 |
| `apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.tsx` | 欢迎页 meta 行不再重复标题中的课程名，仅保留状态徽章与开始提示 |
| `apps/learning-agent/web/src/react/shell/shell.css` | 删除 `.mla-today-cover-initial` 与 `.mla-course-bar .mla-today-cover-initial`；删除 `.mla-today-task-sub`；小封面图标居中（`justify-content: center`）；时长胶囊 `margin-left: auto`；课程行徽章不换行、标题可收缩并允许徽章换行到第二行 |
| `apps/learning-agent/web/src/i18n/locales/zh-CN.json` / `en.json` | 删除不再被引用的 `today.coursesUi.noPlanProgress` |
| 新增 `courses/CourseCover.test.tsx` | 8 项 |
| 新增 `courses/CourseRow.test.tsx` | 9 项 |
| 新增 `courses/CourseCard.test.tsx` | 10 项 |
| 新增 `pages/TodayHero.test.tsx` | 7 项 |
| 修改 `pages/learn/LearnStartPanel.test.tsx` | 新增 1 项（未删除任何旧断言） |

未改动：课程 API、课程状态协议、`courses-store`、学习会话、任务完成规则、学习证据、掌握度计算、记忆与复习调度。

---

## 3. 问题清单与修复方式

### 3.1 任务一：课程图标

**问题**：`CourseCover` 用 `initialOf(course.title)` 取首字，中文显示「同 / 机 / 数」、英文显示「P / D」，且课程名就在旁边。

**修复**：`CourseCover` 改为渲染 `BookMarked`（`sm` 15px 线宽 1.75 / 18px；`md` 18px），保留 `coverVariant()`、`is-cover-1..3`、圆角与渐变、`aria-hidden="true"`。`initialOf()` 与 `.mla-today-cover-initial` 全部删除。

**同类问题（全局检索）**：`grep` 全前端仅 `CourseCover.tsx` 存在「按标题首字生成图标」的代码。`settings/AddProviderWizard.tsx` 的 `glyph` 是模型提供方品牌图标的后备字形，属于本任务明确排除的范围，未改动。

**发现并修复的连带缺陷**：小封面原本只有文字，`display: grid; place-items: center` 足以居中；换成 SVG 后实测图标贴左（`dx = -10px`）。原因是容器继承 `.mla-today-cover` 的 `justify-content: space-between`，`place-items` 只能在起点对齐的轨道内居中。补充 `justify-content: center` 后，实测 `sm`（24px）与 `md`（38px）在全部 14 个视口/主题/语言状态下 `dx = dy = 0`。

### 3.2 任务二：课程行重复状态

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 暂停课程 | 徽章「已暂停」+ 副标题「已暂停」 | 徽章「已暂停」；副标题为空（无阶段/计划时），有则显示真实阶段/计划 |
| 完成课程 | 徽章「已完成」+ 副标题「已完成」 | 徽章「已完成」；副标题为空或真实阶段/计划 |
| 无计划课程 | 徽章「尚未启用学习计划」+ 副标题「尚未启用学习计划」+ 进度位「未启用计划」 | 徽章「尚未启用学习计划」；副标题与进度位均不渲染 |
| 进行中课程 | 徽章无 + 副标题为阶段/计划 | 不变（真实数据） |

「未启用计划」文案随唯一引用点一起删除（zh/en 同步）。课程点击、更多菜单、归档、删除、进度条与百分比、排序、状态判断全部未改（`CourseRow.test.tsx` 覆盖）。

### 3.3 任务三：任务卡片重复信息

| 位置 | 修复前 | 修复后 |
| --- | --- | --- |
| 封面 kicker | `stage ?? course.title`（无阶段时显示课程名） | 仅真实阶段；阶段缺失或等于课程名时不渲染 |
| 封面时长胶囊 | 任务预计时长 | 不变 |
| 正文副标题 | `阶段 · 时长`（可见） | 删除可见行，改为 `.mla-today-sr`（同文本、同规则） |
| 正文课程名 / 任务名 / 进度 / 按钮 | 不变 | 不变 |

无障碍：封面保持 `aria-hidden="true"`；正文 `.mla-today-sr` 仍携带阶段与时长；卡片 `aria-label`、任务标题 `h3`、进度「任务进度」隐藏标签与按钮名称全部保留（`CourseCard.test.tsx` T14）。

### 3.4 任务四：进度信息检查

- 进度条、`0/2`、`0%`、「任务进度」四个元素对应同一 `task_progress`，实测一致（`0 / 2` 与 `0%` 同源）。
- 移动端 320px：课程行「0%」与「0 / 2」仍在行内，无横向溢出（`overflowX = 0`）；任务卡片进度文本不换行。
- 屏幕阅读器：进度条 `aria-hidden`，另有 `.mla-today-sr`「任务进度」文本，可被读屏理解。
- 未重做进度条，未把任务完成率当作掌握度（页面既有「任务进度与知识掌握是两套状态」说明未改）。

### 3.5 任务五：同类问题全局检索

| 分类 | 发现 | 处理 |
| --- | --- | --- |
| 已确认的同类视觉缺陷 | ① 课程行状态重复（徽章/副标题/进度位）② 任务卡片阶段与时长重复 ③ 「今日主课 · 课程名」徽章与下方标题重复 ④ 暂停态 hero 的 meta 重复「已暂停」⑤ 欢迎页 meta 重复标题中的课程名 | 全部在本轮最小修正 |
| 合理的信息重复（保留） | ① 任务卡片封面时长胶囊与 `.mla-today-sr` 时长：前者装饰、后者供读屏，是同一事实的两种通道 ② 课程详情页 `<h1>` 与状态徽章：标题是课程名、徽章是状态，职责不同 ③ `LearnCourseBar` 的课程名 + 状态徽章：课程栏只有一个课程，徽章提供状态 ④ `LearnContextSheet` 的课程名/状态/任务/阶段：面板本身就是「当前上下文」清单 | 保留并说明 |
| 与本任务无关 | ① `CourseContextStrip.tsx` 已无引用（`LearnCourseBar` 取代），属死代码清理 ② `LearnHistoryRail` 头部状态徽章在窄抽屉中与课程栏重复 ③ `TodayHero` 的 meta 与任务卡片都显示阶段与时长（不同层级，主课区 vs 任务列表） | 记录，不扩大范围 |

---

## 4. 真实浏览器验收

### 4.1 视口与主题

| 视口 | 深浅主题 | 中文 | 英文 |
| --- | --- | --- | --- |
| 1440 × 900 | ✓ | ✓ | ✓ |
| 1024 × 768 | ✓ | ✓ | — |
| 900 × 800 | ✓ | ✓ | — |
| 390 × 844 | ✓ | ✓ | ✓ |
| 320 × 640 | ✓ | ✓ | — |

共 14 个状态 × 3 个区域（今日学习整页 / 我的课程面板 / 任务卡片 / AI 学习课程栏 / 欢迎页头部），原始指标见 `assets/before-metrics.json` 与 `assets/after-metrics.json`。

### 4.2 关键指标（1440 × 900 中文浅色）

| 项目 | 修改前 | 修改后 |
| --- | --- | --- |
| 「同义替换」课程封面 | 文本 `同` | 无文本，`<svg class="lucide lucide-book-marked">` |
| 「Python Basics…」课程封面 | 文本 `P` | 无文本，同一 `BookMarked` |
| 暂停课程副标题 | `已暂停` | 无 |
| 完成课程副标题 | `已完成` | 无 |
| 无计划课程副标题 / 进度位 | `尚未启用学习计划` / `未启用计划` | 无 / 无 |
| 任务卡片可见副标题 | `Python Foundations · 30 分钟` | 无 |
| 任务卡片读屏文本 | `任务进度` | `Python Foundations · 30 分钟`、`任务进度` |
| hero 徽章 | `今日主课 · 同义替换` | `今日主课` |
| hero meta | `第一阶段：词义辨析 · 20 分钟` | `同义替换 · 第一阶段：词义辨析 · 20 分钟` |
| 课程栏封面 | 文本 `同` | 无文本，`BookMarked`，24×24 居中 |

### 4.3 截图

`assets/` 下共 47 张 PNG 与 2 份指标 JSON，按 `before-*` / `after-*` 配对：

| 主题 | 文件 |
| --- | --- |
| 今日学习整页 | `{before,after}-1440x900-{light,dark}-{zh,en}-today.png`、`{before,after}-{1024x768,900x800,390x844}-light-zh-today.png`、`{before,after}-320x640-dark-zh-today.png` |
| 我的课程面板 | `{before,after}-courses-{light,dark}.png`（1440）、`{before,after}-courses-{390,320}-{light,dark}.png` |
| 任务卡片 | `{before,after}-tasks-{light,dark}.png`（1440）、`{before,after}-tasks-{390,320}-{light,dark}.png` |
| AI 学习课程栏 | `{before,after}-course-bar-{light,dark}.png` |
| 欢迎页头部 | `after-welcome-{light,dark}-{zh,en}.png` |

> 修改前截图为同一隔离数据集、同一服务端、同一浏览器，仅在构建产物上回退到 `7b5b96c` 的源码后重新构建。

### 4.4 观察项

| 检查 | 结果 |
| --- | --- |
| 图标清晰、居中 | `sm` 24px / `md` 38px 下 `dx = dy = 0`，全 14 状态一致 |
| 图标与文字协调 | 与课程名基线对齐，无额外内边距 |
| 状态是否重复 | 暂停 / 完成 / 无计划各自只出现一次 |
| 任务卡片阶段、时长 | 仅封面一次；读屏文本保留 |
| 课程名是否被过度截断 | 1440/1024/900 不截断；390/320 长名以省略号结尾，徽章换到第二行，标题仍保留 7em 以上宽度 |
| 移动端横向溢出 | 全部 14 状态 `documentElement.scrollWidth - clientWidth = 0` |
| 按钮与下拉菜单点击区域 | 课程行主按钮、更多菜单、归档、删除均正常（见 4.5） |
| 深浅主题图标对比度 | 白图标位于三色渐变封面（`#4f46e5 / #0f8a80 / #a86412` 及深色主题对应值）之上，与修改前文字同色，未降低 |

### 4.5 交互回归（真实浏览器）

| 操作 | 结果 |
| --- | --- |
| 点击课程行 | URL 变为 `?page=course&course=course_186528ce&view=plan`，详情标题「同义替换」 |
| 更多菜单 | 展开 `查看课程 / 归档课程 / 删除课程` 三项 |
| AI 学习课程栏 | 显示 `BookMarked` + 「同义替换」+「进行中」+「当前任务 辨析近义词的语体差异」+「阶段：第一阶段：词义辨析」 |
| 欢迎页 | 标题「你想在「同义替换」中学习什么？」，meta「进行中选择一个开始方式，或直接在下方输入你的问题。」 |

---

## 5. 组件与页面测试

新增（全部通过）：

| 文件 | 数量 | 覆盖 |
| --- | ---: | --- |
| `courses/CourseCover.test.tsx` | 8 | T01/T02/T03/T04/T05/T14 |
| `courses/CourseRow.test.tsx` | 9 | T07/T07b/T08/T09/T10/T13/T15/T16 |
| `courses/CourseCard.test.tsx` | 10 | T11/T11b/T12/T13/T14/T15/T16 + `pickCurrentTask` |
| `pages/TodayHero.test.tsx` | 7 | T07/T07b/T09/T10/T12/T16 + 主课徽章去重 |

修改：`pages/learn/LearnStartPanel.test.tsx` 新增 1 项，未删除旧断言。

定向结果：

| 命令 | 结果 |
| --- | --- |
| `npx vitest run apps/learning-agent/web/src/react/pages/TodayPage.courses.test.tsx` | 27 / 27 |
| `npx vitest run apps/learning-agent/web/src/react/pages/learn/LearnCourseBar.test.tsx` | 16 / 16 |
| `npx vitest run apps/learning-agent/web/src/react/pages/LearnPage.course-bar.test.tsx` | 39 / 39 |
| `npx vitest run apps/learning-agent/web/src/react/courses` | 6 文件 / 46 测试全通过（含 4 个新文件） |
| `npx vitest run apps/learning-agent/web/src/react/pages apps/learning-agent/web/src/react/courses apps/learning-agent/web/src/i18n` | 32 文件 / 511 测试全通过 |

### T01–T16 对照

| 编号 | 验证内容 | 证据 |
| --- | --- | --- |
| T01 | 中文课程使用统一图标 | `CourseCover.test.tsx`「renders the same icon for a Chinese and an English course」 |
| T02 | 英文课程使用统一图标 | 同上（同一 `class` 断言） |
| T03 | 不再生成中文首字图标 | 同上 + 浏览器指标 `coverText: ''` |
| T04 | 课程配色稳定 | `CourseCover.test.tsx`「keeps the palette index stable」；浏览器前后 `is-cover-*` 全量一致 |
| T05 | `sm`、`md` 尺寸正确 | `CourseCover.test.tsx`「keeps both sizes」；浏览器 `sm` 24 / `md` 38 |
| T06 | 今日学习与 AI 学习使用同一课程标识 | 两处均渲染 `CourseCover`；指标 `coverHasSvg: true` 且 `coverText: ''` |
| T07 / T07b | 暂停状态不重复 | `CourseRow.test.tsx` T07/T07b、`TodayHero.test.tsx` T07/T07b |
| T08 | 完成状态不重复 | `CourseRow.test.tsx` T08 |
| T09 | 无计划文案不重复 | `CourseRow.test.tsx` T09、`TodayHero.test.tsx` T09 |
| T10 | 进行中课程显示真实阶段 | `CourseRow.test.tsx` T10、`TodayHero.test.tsx` T10 |
| T11 / T11b | 任务封面与正文不重复阶段和时长 | `CourseCard.test.tsx` T11/T11b |
| T12 | 阶段缺失时不伪造内容 | `CourseCard.test.tsx` T12、`CourseCover.test.tsx`「does not repeat the course title」 |
| T13 | 长中文、英文课程名正确截断 | `CourseRow.test.tsx` T13、`CourseCard.test.tsx` T13 + 浏览器 390/320 截图 |
| T14 | 图标装饰语义及任务信息可访问 | `CourseCover.test.tsx`「stays decorative」、`CourseCard.test.tsx` T14 |
| T15 | 课程跳转、菜单、归档、删除功能不变 | `CourseRow.test.tsx` T15、`CourseCard.test.tsx` T15 + 浏览器交互 |
| T16 | 原有任务进度与完成率不变 | `CourseRow.test.tsx` T16、`CourseCard.test.tsx` T16、`TodayHero.test.tsx` T16 |

---

## 6. 类型检查与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build`（后端 + 前端） | 通过 |

---

## 7. 全量测试

`npx vitest run --maxWorkers=4`：

| 轮次 | 结果 |
| --- | --- |
| 第一轮（修复完成后） | 198 文件通过 / 1 失败；2228 通过 / 1 失败 / 3 跳过 |
| 第二轮（最终代码） | 198 文件通过 / 1 失败；2228 通过 / 1 失败 / 3 跳过（519s） |

唯一失败为第 9.1 节的既有基线失败。两轮结果一致，本轮改动没有新增确定性失败。

---

## 8. 业务功能保持不变的证明

| 业务 | 证据 |
| --- | --- |
| 课程点击进入详情 | 浏览器：URL 变为 `?page=course&…&view=plan`；`CourseRow.test.tsx` T15 |
| 更多菜单 / 归档 / 删除 | 浏览器：菜单三项正常；`CourseRow.test.tsx` T15；`TodayPage.courses.test.tsx` 归档/删除用例全通过 |
| 课程状态判断 | `CourseRow` 只在展示层去重，`course.status` 的读取与徽章渲染条件未变 |
| 任务进度与完成率 | `progress.completed / progress.total`、`progress.percent` 原样渲染；T16 断言数值与条宽 |
| 课程排序 | `selectPrimaryCourse` 未改；`TodayPage.courses.test.tsx` T01–T03 通过 |
| 课程 ID / Store / API | 无 diff；`git diff --stat` 不含 `src/stores/`、`src/server/`、`src/api/` |
| 学习会话 / 证据 / 掌握度 | 无 diff |

---

## 9. 仍未处理的问题

### 9.1 既有基线失败（与本任务无关）

`apps/learning-agent/src/server.e48-workbench.test.ts` → `E4.8a — course status gates chat writes` → `allows an in_progress course to continue chatting`：`expected 2 to be 1`（`providerCalls`）。

- 该失败在本分支任何提交之前、在 `7b5b96c` 上即可复现（上一轮 P2-5 验收报告已登记为基线失败）。
- 本轮单独重跑该文件：1 失败 / 8 通过；同批另外 3 个文件单独重跑全部通过。
- **未删除、未跳过、未修改该断言。**

### 9.2 全量并发下的环境性失败

第一轮全量测试中有 4 个 `node` 套件报 `server readiness timeout`（`server.e48-workbench`、`server.learning-answer`、`server.session-archive`、`server.session-delete-audit`），均为启动等待超时而非断言失败。单独重跑这 4 个文件：3 个通过，仅剩 9.1 的既有断言失败。第二轮全量（最终代码）中 4 个套件全部正常启动，仅剩 9.1 的既有断言失败——说明首轮超时是并发启动真实服务端时的等待不足，与本轮前端改动无关。

### 9.3 记录但未处理

- `courses/CourseContextStrip.tsx` 已无任何引用，属死代码；本轮不删除，避免超出范围。
- `LearnHistoryRail` 头部状态徽章在窄抽屉中与课程栏徽章重复展示同一状态；两处属于不同容器，本轮不动。
- `TodayHero` 的 meta 与下方任务卡片都出现阶段与时长；二者分别是主课区与任务列表，信息层级不同，本轮保留。

---

## 10. 结论

**PASS**

- 「同义替换」不再显示单个「同」字图标；中文、英文课程统一使用 `BookMarked`。
- 今日学习与 AI 学习使用同一个 `CourseCover` 组件，课程颜色由课程 ID 决定且在全部 14 个状态前后一致。
- 暂停、完成、无计划状态各只出现一次。
- 任务卡片阶段与时长只在封面出现一次，读屏信息未丢失。
- 移动端 320/390 无横向溢出，徽章换行、长名省略均正常。
- 课程点击、菜单、归档、删除、任务进度数据均未改变。
- 类型检查、构建通过；定向测试 511 项全通过。
- 全量测试保留 1 项经独立复现的既有基线失败（第 9.1 节），不是本轮引入。


---

## 11. UI-C01-R1 桌面状态徽章位置修正（2026-11-24）

### 11.1 复核发现的问题

原 UI-C01 的 `shell.css` 中，`.mla-today-course-name strong` 使用 `flex: 1 1 auto; min-width: 7em;`。这使短标题（例如“高等数学”“数据结构”）在宽屏下扩张填满剩余空间，将「已暂停」「已完成」徽章推到课程行靠右位置，远离标题，破坏标签与标题的视觉关联。问题由对原 `after-courses-light.png` 的截图审阅和源码定位确认。

### 11.2 最小修复

- 工作分支不变：`fix/course-visual-identity-and-copy`。
- CSS 提交：`ba535c9`。
- 默认标题布局改成 `flex: 0 1 auto; min-width: 0;`：短标题不再自动伸展占满整行，使徽章能紧随标题。
- 在 `@media (max-width: 560px)` 下单独设置 `min-width: min(7em, 100%)`，保留窄屏标题可读最小宽度和徽章换行条件。
- 仅改 CSS；课程状态、进度、API、Store、菜单、封面、图标、无障碍文本均未改动。

### 11.3 验收证据等级及待办

**本轮直接核对：** GitHub 上的 CSS 已写入；改动位置仅涉及课程行标题的 flex/min-width 及 560px 媒体查询。原 UI-C01 前后截图与 14 组浏览器指标属于 R1 *修改前* 的证据，不得作为 R1 修复效果已经通过的证明。

**R1 仍需在真实 React 页面执行：**

1. 1440×900 浅/深主题：暂停/完成/无计划三个状态的徽章紧跟课程名称；短标题不被不必要地拉伸。
2. 390×844 与 320×640 浅/深主题：长中文、长英文课程名可以省略；徽章必要时换至第二行；标题不被挤成单字；无整页横向溢出。
3. 同时保存 R1 专项截图（尤其是短标题+状态徽章和 320px 长标题场景），并记录标题与徽章 DOM 矩形间距/是否换行、overflowX。
4. 重跑相关前端测试、TypeScript 检查和 Web 构建，保存真实结果。若有失败，应如实记录，不沿用 R1 前测试统计。

**合并建议：** 在上述浏览器与测试复核通过后可将本报告最终结论更新为 `PASS_WITH_KNOWN_BASELINE_FAILURE`（仅在历史失败仍真实存在且可归因于基线时）。当前为 **R1_NOT_VERIFIED**；不自动合并。
