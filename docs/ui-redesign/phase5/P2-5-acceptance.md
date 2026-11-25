# E4.9i-P2-5 验收报告：移动端知识行响应式布局

- **任务**：E4.9i-P2-5
- **开发基准**：`main@46daa215adbee4f4ac73301345cebb40da85e280`（PR #21 合并提交）
- **开发分支**：`feat/e49i-p2-5-mobile-knowledge-row`
- **结论**：**P2-5 PASS_WITH_KNOWN_BASELINE_FAILURE**（仅保留已核实的 `server.e48-workbench.test.ts` 历史失败）

---

## 1. 基准核对

| 项 | 值 |
| --- | --- |
| `git fetch origin` 后 `origin/main` | `46daa215adbee4f4ac73301345cebb40da85e280` |
| PR #19 / #20 / #21 | 均已合并；#21 的合并提交即当前 main |
| 开工工作区 | 干净（`git status --short` 无输出） |
| 新建分支 | `feat/e49i-p2-5-mobile-knowledge-row`（自 `origin/main` 切出） |
| 未合并 PR 检查 | **无法执行**：`gh` 未登录（见 §9） |

任务书给出的 main SHA 与实际一致，main 无额外变化需要审查。

## 2. 开发前现状核查（实测，非推断）

改代码前先用 Playwright 测量真实布局，四档视口各取前三行：

| 视口 | 行宽 | 行 scrollWidth | 进度条宽 | 名称 |
| --- | ---: | ---: | ---: | --- |
| 1440 | 1152 | 1152 | 708 | 170px 内截断 |
| 768 | 680 | 680 | 224 | 170px 内截断 |
| **390** | **302** | **330** | **0** | 170px 内截断 |
| **320** | **232** | **330** | **0** | 170px 内截断 |

结论：手机上进度条宽度塌缩为 **0**，行内容比可用宽度多出 28–98px，横向溢出被父级容器吞掉（所以整页不滚动，问题因此长期未被发现）；名称被固定 170px 盒子截断。

固定列来源确认为 `KnowledgeRow.tsx` 的 `w-[170px]` / `w-[42px]` / `w-[110px]`。

### 2.1 指定课程视图

同样实测：`.mla-state-row` 在 `@container (max-width: 430px)` 下已经变成单列，390 / 320px 均无溢出，名称与诊断正常换行，徽章与证据数量可见。**该视图本身没有布局缺陷**，因此本轮只做与全部课程一致性的最小调整，不做重构。

### 2.2 共享 class 的影响面

`.mla-state-row` 被 8 处以上复用（学习目标、计划、会话记录、删除对话框、课程概览等）。因此**未修改任何 `.mla-state-row` 规则**，只新增知识行专用 modifier；`git diff` 中对 `.mla-state-row` 的删除行数为 **0**。

## 3. 实现

### 3.1 全部课程（`KnowledgeRow.tsx` / `KnowledgeList.tsx`）

- 移除 `w-[170px]`、`w-[42px]`、`w-[110px]` 三个固定宽度。
- 头部改为具名网格区域：`identity / mastery / badge / date / toggle`。
- 名称与领域不再 `truncate`，窄容器下改为换行（`white-space: normal` + `overflow-wrap: anywhere`）。
- 进度条设 `min-width: 60px`，百分比 `flex-shrink: 0` + `white-space: nowrap`，保证不被挤压。
- 复习日期：**无日期时不渲染该元素**，不再输出 `-` 占位（`-` 会被读成"无需复习"，而那是服务端的复习资格判断）。
- 徽章、百分比、展开图标在任何宽度下都不隐藏。

### 3.2 容器查询

`.mla-knowledge-list` 设置 `container-type: inline-size`，断点 `@container (max-width: 560px)`。
选择容器查询而非 viewport：同一列表在桌面宽面板与手机窄卡片中都会出现，只有**列表自身宽度**才应决定排列。

断点由实测确定：560px 时单行布局的进度条仍有约 180px，低于此值则挤到不可用；560px 处切换后，最窄的 320px 视口进度条仍有 187px。

### 3.3 桌面端

保持原有信息顺序与单行布局：名称 → 进度条 → 百分比 → 徽章 → 复习日期 → 展开。
1440px 实测：进度条 713px、徽章 52px、百分比 25px（`50%` 完整）、名称 170px 内省略号截断（与改造前一致）。

### 3.4 移动端

```text
┌─────────────────────────────┐
│ 知识名称              稳定  › │
│ 所属领域                     │
│ 掌握度 ━━━━━━━━━━━━  50%     │
│ 复习日期 12月1日             │
└─────────────────────────────┘
```

名称占满首行剩余宽度并可换行；徽章固定在首行右侧、与展开图标同一行；掌握度与复习日期各占一整行。

### 3.5 指定课程（`CourseLearnerPanel.tsx`）

在保留 `.mla-state-row` 基类的前提下叠加 `mla-course-knowledge-row` 等 modifier：名称允许任意位置换行、诊断完整换行、证据数量 `flex-shrink: 0` 保持可见、窄容器下证据行左对齐。视图仍为只读，未引入任何编辑入口。

## 4. 语义 class

```text
mla-knowledge-list / mla-knowledge-row
  __header __identity __name __domain __mastery __progress __bar
  __percentage __badge __date __date-label __date-value __toggle __body

mla-course-knowledge-list / mla-course-knowledge-row
  __identity __meta __evidence
```

全部使用既有 `--inno-*` 语义 token，未引入新颜色；未新增固定像素宽度（`min-width: 60px` 为进度条下限，`3ch` 已移除）。

## 5. 交互回归

未改动 `KnowledgeDraftGuard`、`KnowledgeFilter`、`KnowledgeEditPanel` 的任何业务逻辑；`KnowledgeRow` 只改渲染结构，`toggle()` / `save()` / 注册逻辑保持原样。

| 行为 | 状态 |
| --- | --- |
| 展开 / 折叠 | 通过（L01–L10、浏览器编辑态与受保护场景） |
| 阅读态 / 编辑态 | 通过 |
| 草稿确认保护 | 通过（`p25-mobile-editing.png`、`p25-mobile-protected.png`） |
| 保存中阻断 | 通过（既有用例，未修改） |
| 保存失败保留草稿 | 通过（既有用例，未修改） |
| 被动刷新保护 | 通过（浏览器 protected 场景） |
| 消失知识点保存限制 | 通过（既有用例，未修改） |
| 六类筛选 | 通过（`KnowledgeFilter.*` 全绿） |
| 受保护行提示 | 通过（`p25-mobile-protected.png`） |

## 6. 自动化测试

新增 `KnowledgeList.test.tsx` 的 `E4.9i-P2-5 — knowledge row layout structure` 组，**10 项**：

| 编号 | 断言 |
| --- | --- |
| L01 | 容器查询上下文在列表上，行在其内部 |
| L02 | 窄布局重排的每个部件都存在 |
| L03 | 头部为 identity / mastery / badge / toggle 四部件（有日期时加 date） |
| L04 | 有复习日期时渲染 date + label + value |
| L05 | 无复习日期时不渲染空占位，也不输出 `-` |
| L06 | 六种状态徽章全部存在、非空、未被 `hidden` |
| L07 | identity / name / domain 不再含 `w-[Npx]` 或 `truncate` |
| L08 | 百分比文本完整（0% / 100% / 50%），无固定宽度 |
| L09 | 进度条元素存在且取 mastery 宽度 |
| L10 | 超长名称完整渲染于 DOM，未在标记层截断 |

**变异验证**：把 `w-[170px] truncate` 加回名称后 L07 立即失败，恢复后通过——断言有效，不是恒真。

> jsdom 不做布局，因此这些用例只断言**结构**（CSS 依赖的钩子与"不得隐藏/截断"的规则）；
> 真实宽度由 §7 的浏览器测量负责。未编写只比较 CSS 字符串的用例。

## 7. 浏览器验收

`docs/ui-redesign/phase5/scripts/qa_p2_5.py`：隔离 Vite + `page.route` 受控 fixture，14 组测量全部通过，无页面错误。

### 7.1 七档视口

| 视口 | 行数 | 进度条 | 百分比 | 徽章 | 头部列数 | 页面溢出 | 名称被裁切 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1440×900 | 7 | 713 | 25 | 52 | 5 | 否 | 是（桌面省略号，符合预期） |
| 1024×768 | 7 | 385 | 25 | 52 | 5 | 否 | 是（同上） |
| 768×1024 | 7 | 241 | 25 | 52 | 5 | 否 | 是（同上） |
| 430×932 | 7 | 297 | 25 | 52 | **3** | 否 | 否 |
| 390×844 | 7 | 257 | 25 | 52 | **3** | 否 | 否 |
| 375×812 | 7 | 242 | 25 | 52 | **3** | 否 | 否 |
| 320×640 | 7 | 187 | 25 | 52 | **3** | 否 | 否 |

每个视口、每一行都断言：`badgeVisible`、`progressWidth > 0`、`percentageWidth > 0`、
百分比自身不裁切（`scrollWidth <= width`）、`toggleVisible`、名称与徽章不重叠、行不溢出、页面不横向溢出。

> 首轮把百分比阈值写成"必须 ≥ 20px"，在 `0%`（实际 18px）上失败。这不是布局缺陷，
> 是断言写错：正确的不变量是"盒子容得下自己的文字"，已改为比较 `scrollWidth`。

### 7.2 场景截图

| 截图 | 场景 | 结论 |
| --- | --- | --- |
| `p25-desktop-1440.png` | 桌面端 | 原布局与顺序保持 |
| `p25-desktop-1024.png` | 小型桌面 | 单行 |
| `p25-tablet-768.png` | 平板 | 单行 |
| `p25-mobile-430.png` / `-390` / `-375` / `-320` | 手机四档 | 纵向堆叠，无裁切 |
| `p25-mobile-long-zh.png` | 长中文名称 | 换行，`nameHeight > 20` |
| `p25-mobile-long-en.png` | 长英文名称 | 换行 |
| `p25-mobile-badges.png` | 六类徽章 | 六种全部可见（六行短名 fixture，加高视口取景） |
| `p25-course-mobile.png` | 指定课程 | 4 行单列、徽章/证据/诊断可见、无溢出 |
| `p25-mobile-editing.png` | 编辑态 | 草稿保留，无溢出 |
| `p25-mobile-protected.png` | 受保护行 | 提示可见，草稿保留 |

指标文件：`P2-5-assets/p25-browser-metrics.json`（14 条测量）。
P2-4 的历史截图与指标未被覆盖（本脚本只写 `P2-5-assets/`）。

> **截图证据自查（发现并修正）**：首轮截图时，`p25-mobile-long-zh.png`、`p25-mobile-long-en.png`、
> `p25-mobile-badges.png` 与 `p25-mobile-390.png` **字节完全相同**（MD5 一致）。测量数据本身是对的
> （7 行全覆盖、六种徽章全部记录），问题出在截图取景：这几张都在 `scroll_to_section()` 之后直接截图，
> 而该函数停在卡片顶部，因此拍到的是同一屏。已改为按行锚定取景（`show_rows()`）；六徽章场景另建
> 六行短名 fixture，并在测量后临时加高视口以便一张图容纳六行（宽度仍为 390，容器查询结果不变）。
> 现在 13 张截图 MD5 全部互不相同。此类"数据正确但截图不展示被测对象"的证据缺陷，首轮未被发现，
> 特此记录。

## 8. 测试与构建

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查 | `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | 通过（exit 0） |
| 前端构建 | `npm --workspace my-learning-agent-web run build` | 通过 |
| 全量构建 | `npm run build` | 通过 |
| 定向测试 | `vitest run react/profile/ ProfilePage.courses.test.tsx` | 208 通过（12 文件） |
| `KnowledgeList.test.tsx` | 同上 | 32 通过（22 既有 + 10 新增 L01–L10） |
| i18n 用例 | 同上 | 11 通过 |
| 全量测试 | `vitest run` | 见 §10 |
| 浏览器验收 | `qa_p2_5.py` | 14 条测量全部通过 |

## 9. 未解决问题与阻塞

1. **PR 未创建**：`gh auth status` 返回 "You are not logged into any GitHub hosts"，无法创建 PR，也无法按要求"检查是否存在其他未合并 PR"。分支已推送，PR 正文已备好（见 §11）。按任务书要求如实记录，未声称已创建。
2. `server.e48-workbench.test.ts` 的 `allows an in_progress course to continue chatting` 仍为历史失败，未删除、未跳过、未放宽。
3. `PracticePage.test.tsx` 的 `does not claim a refreshed long-term state when finalize fails` 在第 1 次全量执行中偶发失败，第 2 次通过；与本次改动无关（见 §10.2），未改动该用例。
4. 桌面端名称仍为单行省略号截断（170px 列）。这是任务书 §4.1 要求的"保留当前桌面端的信息组织"，**不是**移动端问题；完整名称可通过展开行查看。
5. 容器查询在极旧浏览器（Safari < 16、Chrome < 105）不可用。任务书 §4.3 允许"必要时再提供 `@media` 降级"；本项目基线浏览器已支持，故本轮未添加降级规则，记录备查。

## 10. 实际测试与构建结果

### 10.1 全量测试（两次完整执行）

| 执行 | 收集 | 通过 | 失败 | 跳过 | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 历史基准 | 2462 | 2458 | 1 | 3 | — |
| 第 1 次（20:05 起） | 2472 | 2467 | **2** | 3 | 735s |
| 第 2 次（20:17 起） | 2472 | 2468 | **1** | 3 | 260s |

与基准相比：**收集 +10、通过 +10**（即新增的 L01–L10），失败与跳过数不变。

### 10.2 两次执行的差异（如实记录）

第 1 次多出一个失败：

```text
apps/learning-agent/web/src/react/pages/PracticePage.test.tsx
  :: practice page long-term recommendation (C4-B)
     does not claim a refreshed long-term state when finalize fails
  AssertionError: expected "loadConceptRecommendation" to not be called at all,
                  but actually been called 1 times
```

判定为**与本次改动无关的偶发失败**，依据：

1. `PracticePage.tsx` / `PracticePage.test.tsx` 均未修改，也不 import `KnowledgeRow`、`KnowledgeList`、
   `CourseLearnerPanel` 或新增的 CSS（`grep` 无匹配）。
2. 单独执行该文件：89/89 通过。
3. 与 `react/profile/` 同批执行：304/304 通过。
4. 第 2 次完整执行（同样的代码）不再复现。

该用例断言"finalize 失败后不得重新读取建议"。`PracticePage.tsx:213` 的挂载 effect 会在
`currentSessionId` / `activeConceptId` 变化时调用 `loadConceptRecommendation`，用例在点击后用
`mockClear()` 抹掉挂载期调用再断言"零次"；若挂载 effect 因异步渲染在 `mockClear()` **之后**才落地，
计数就会变成 1。这解释了它为何只在整机高负载（第 1 次 735s vs 第 2 次 260s）时出现。

按任务书要求，**未删除、未跳过、未放宽**该用例；此处只记录观测到的事实与上述待验证推断，
不声称已在源码层面确认根因。

### 10.3 其余失败

`server.e48-workbench.test.ts :: E4.8a — course status gates chat writes allows an in_progress course to continue chatting`
为历史基准失败，两次执行均复现，未作任何处理。

### 10.4 构建

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | exit 0 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过 |

### 10.5 浏览器验收

`qa_p2_5.py` 重跑通过：**14 条测量**，13 张截图 MD5 互不相同，无页面错误。

## 11. 交付与 PR

| 项 | 值 |
| --- | --- |
| 提交信息 | `feat(profile): E4.9i-P2-5 移动端知识行响应式布局` |
| 分支 | `feat/e49i-p2-5-mobile-knowledge-row` |
| PR 标题 | `feat(profile): E4.9i-P2-5 移动端知识行布局优化` |
| PR 正文 | `docs/ui-redesign/phase5/P2-5-pr-body.md` |
| PR 状态 | **未创建**：`gh auth status` 未登录，无法执行 `gh pr create`（见 §9） |

分支已推送，正文已备好；登录后执行：

```bash
gh pr create --base main --head feat/e49i-p2-5-mobile-knowledge-row \
  --title "feat(profile): E4.9i-P2-5 移动端知识行布局优化" \
  --body-file docs/ui-redesign/phase5/P2-5-pr-body.md
```

按任务书要求，未自动合并，也未提前开始 P2-6。
