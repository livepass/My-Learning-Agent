# E4.9i-P2-5-R1 验收报告：完整名称展示与响应式验收补齐

- **任务**：E4.9i-P2-5-R1
- **开发基准**：`main@46daa215adbee4f4ac73301345cebb40da85e280`（PR #21 合并提交）
- **本轮起点**：`d6695abef3ff42c9659b76ff62e6e55950067770`（P2-5 已审查 HEAD）
- **开发分支**：`feat/e49i-p2-5-mobile-knowledge-row`（沿用，不新建分支）
- **结论**：**P2-5-R1 PASS_WITH_KNOWN_BASELINE_FAILURE**

---

## 1. 基准核对

| 项 | 值 |
| --- | --- |
| `git fetch origin` 后 `origin/main` | `46daa215adbee4f4ac73301345cebb40da85e280`（与任务书一致） |
| 本轮起点 HEAD | `d6695abef3ff42c9659b76ff62e6e55950067770` |
| 远程开发分支 | `origin/feat/e49i-p2-5-mobile-knowledge-row` = `d6695ab`（与本地一致，无未推送提交） |
| 开工工作区 | 干净（`git status --short` 无输出） |
| PR 状态 | **无法查询**：`gh` 未登录（见 §8） |

未新建分支，未改动 P2-5 已完成的响应式方案（容器查询、断点、网格区域全部保持原样）。

## 2. F01：完整知识名称可查看

### 2.1 问题确认（实测，非推断）

验收报告 §9 曾写"完整名称可通过展开行查看"。**这是错的**，已核实：

- `KnowledgeReadView.tsx` 渲染徽章、掌握度、复习日期、诊断、下一步动作，**从不渲染名称**。
- `KnowledgeEditPanel.tsx` 同样不含名称。
- 桌面端 `.mla-knowledge-row__name` 是 `white-space: nowrap` + `text-overflow: ellipsis`，长名称在 170px 处截断。

因此长名称在界面上**任何位置都读不到**。1440px 实测：中文长名称 `scrollWidth 392 / clientWidth 170`，
英文 `494 / 170`，两者均被截断（见 `r1-browser-metrics.json` R05 的 `headerClippedBeforeExpand: true`）。

### 2.2 修复

在阅读态顶部新增一行带标签的完整名称（`KnowledgeReadView.tsx`）：

```text
概念: 这是一个非常非常长的中文知识点名称用来测试换行行为是否正常
```

**为什么带标签而不是裸名称**：其余字段都是「掌握度: …」「复习日期: …」的形态；裸名称会成为
头部名称文本的第二个精确匹配，既让现有测试的 `getByText` 变成多义，也让读者在行内扫视时难以区分
"标题"与"字段"。标签同时让"这是知识点的完整名称"这一含义显式化。

样式（`shell.css` 新增 `.mla-knowledge-row__full-name`）：

- `overflow-wrap: anywhere` —— 中文无空格、英文长单词都可在任意处断开。
- 无 `truncate`、无固定像素宽度、无 `overflow: hidden`。
- 沿用 `--inno-text`，未新增颜色。

**未改动**：名称数据来源（仍是 `state.concept_name`）、阅读态/编辑态切换、草稿保护逻辑。
`KnowledgeDraftGuard`、`KnowledgeEditPanel`、`KnowledgeFilter` 零改动。

### 2.3 测试

`KnowledgeList.test.tsx` 新增 `E4.9i-P2-5-R1 — the full name is readable once expanded` 组，**7 项**：

| 编号 | 断言 |
| --- | --- |
| R1-1 | 折叠行不显示带标签的完整名称 |
| R1-2 | 展开中文长名称后完整展示，且不含 `…` |
| R1-3 | 展开英文长名称后完整展示，且不含 `…` |
| R1-4 | 完整名称节点不含 `truncate` 或 `w-[Npx]` |
| R1-5 | 名称取自存储记录，不是新数据源 |
| R1-6 | 阅读完整名称不会打开编辑器（无 slider、无 textbox） |
| R1-7 | 编辑态下头部仍显示该概念自己的名称，不是 id 回退 |

**变异验证**：把新增的名称节点整段移除后，R1-2/R1-3/R1-4/R1-5/R1-6 **5 项立即失败**；恢复后全绿。
断言有效，不是恒真。

### 2.4 浏览器证据

`p25-r1-1440-long-name.png`：桌面头部显示 `这是一个非常非常长的中...`（截断），
同一行的阅读态显示 `概念: 这是一个非常非常长的中文知识点名称用来测试换行行为是否正常`（完整）。
`p25-r1-320-long-name-expanded.png`：同一行在 320px 下换行展示，`fullName.height > 20` 且无横向溢出。

## 3. F02：补齐浏览器验收场景

`open_page()` 新增 `theme` 参数（默认 `light`），写入 `localStorage['inno.theme']`——与
`theme-store.ts` 读取的是同一个键，store 在首次渲染前应用。R06 的中途切换走
`themeStore.apply()`，这是 DOM 主题属性的唯一写入方，避免截图显示 app 并未真正解析到的主题。

新增入口 `python -X utf8 docs/ui-redesign/phase5/scripts/qa_p2_5.py --r1`，写入
`p25-r1-*` 与 `r1-browser-metrics.json`；不带 `--r1` 时仍是 P2-5 原套件，只写 `p25-*`。

> **一次操作失误，已回滚**：为确认重构后 P2-5 套件仍可运行，本轮重跑了一次不带 `--r1` 的
> 套件，它按设计重写了 `p25-*` 与 `p25-browser-metrics.json`。由于 F01 在阅读态新增了一行名称，
> 其中 3 张截图（`p25-course-mobile.png`、`p25-desktop-1440.png`、`p25-mobile-editing.png`）
> 内容随之改变。已用 `git checkout --` 还原这 3 个文件，**P2-5 原始素材现与 `d6695ab` 完全一致**
> （`git status` 中 `p25-*` 无修改）。记录此事是因为任务书明确要求不得覆盖 P2-5 历史证据：
> 结论是"最终未被覆盖"，但过程中确实写过一次。

| 编号 | 场景 | 截图 | 结果 |
| --- | --- | --- | --- |
| R01 | 320px 中文深色 | `p25-r1-320-dark.png`、`p25-r1-320-dark-expanded.png` | 通过 |
| R02 | 1440px 中文深色 | `p25-r1-1440-dark.png` | 通过 |
| R03 | 320px 英文六种状态 | `p25-r1-320-en-badges.png` | 通过 |
| R04 | 320px 指定课程只读 | `p25-r1-320-course.png` | 通过 |
| R05 | 桌面长名称展开后完整 | `p25-r1-1440-long-name.png`、`p25-r1-320-long-name-expanded.png` | 通过 |
| R06 | 1440 → 320 → 1440 编辑 | `p25-r1-resize-320-editing.png`、`p25-r1-resize-1440-editing.png` | 通过 |

### 3.1 R06 的草稿连续性

| 检查 | 1440 | → 320 | → 1440 |
| --- | --- | --- | --- |
| 草稿内容 | `跨视口草稿` | 保留 | 保留，且与初始值逐字相同 |
| 编辑器存在 | 是 | 是 | 是 |
| 行展开状态 | `true` | `true` | `true` |
| 概念身份 | 长中文名称 | 同左 | 同左 |

额外断言：320px 编辑态下页面无横向溢出。

## 4. F03：完善浏览器验收断言

### 4.1 原来的问题

P2-5 用 `getBoundingClientRect().width > 0` 判断"可见"。这对被裁切祖先包住的元素同样为真：
一个 52px 宽的徽章被 `overflow: hidden` 父级切掉一半，`width` 仍然是 52。

### 4.2 新的 `check_visible()`

对每个场景、每一行、每个必须可见的部件（徽章、进度条、百分比、展开图标、日期、完整名称）：

1. **元素实际边界** —— `left / right / top / bottom / width / height`。
2. **知识行实际边界** —— 行是否宽于承载它的列表（`overflowsContainer`）。
3. **裁切祖先的可见边界** —— 向上遍历所有 `overflow-x/y != visible` 的祖先，比较元素的水平边界是否越界。
4. **文字是否被不合理裁切** —— `scrollWidth > clientWidth`。
5. **元素之间是否重叠** —— 名称/徽章、徽章/图标、名称/图标、百分比/徽章、日期/图标、进度条/百分比。
6. **页面与知识行横向溢出** —— `document.scrollWidth`、列表 `scrollWidth`、行 `scrollWidth`。

**纵向与横向的区别被显式处理**：页面纵向滚动是正常的，折叠线以下的内容属于"可滚动到达"而非"被裁切"；
只有横向越界才算裁切，因为用户无法横向滚走它。这一条写在 `VISIBILITY` 探针的注释里。

**每个场景都断言 `pageErrors` 为空**（R01–R06 全部 0 条）。

### 4.3 断言有效性（变异验证）

| 注入的缺陷 | 结果 |
| --- | --- |
| 头部 `min-width: 500px`（复现 P2-5 原始缺陷形态） | R01 失败：`knowledge list overflows horizontally 500>232` |
| 徽章绝对定位到行外 `right: -30px` | R01 失败：`knowledge list overflows horizontally 234>232` |
| 头部 `overflow: hidden`（不改变任何元素位置） | **未失败**——该变异没有真正裁切任何东西，断言正确地不报错 |

第三行说明这套断言不是"见到 overflow 就报"，而是检查元素是否真的越出了可见边界。

### 4.4 日期展示测试

新增 `knowledge-format.test.ts`，**7 项**：

- 有效 ISO 日期按当前 locale 渲染；切换语言后随之变化（英文出现 `December`）。
- 缺失日期返回调用方的占位符（`-` 或 `""`），**不**声称"无需复习"。
- 不可解析的值返回占位符，不产生 `NaN`。
- 占位符不会退化成"今天"或任何默认日期（防止占位符被读成真实排期）。
- `masteryPercent` 四舍五入而非截断（0 / 50 / 100 / 0.375→38 / 0.996→100）。

**未改动正式复习资格规则**：`formatReviewDate` 只格式化服务端已经决定要发的日期，从不判断是否到期。

## 5. 语义 class 与样式

新增一个 class：`.mla-knowledge-row__full-name`。

- 使用既有 `--inno-text`，未引入新颜色或新 token。
- 未新增固定像素宽度。
- `.mla-state-row` 规则**零改动**（`git diff` 中删除行数为 0）。

## 6. 冻结范围核对

| 冻结项 | 状态 |
| --- | --- |
| 六类状态筛选规则 | 未改动 |
| mastery 含义 | 未改动 |
| 正式知识状态 | 未改动 |
| `KnowledgeDraftGuard` | 未改动 |
| `KnowledgeEditPanel` 草稿业务逻辑 | 未改动 |
| 消失知识点保存保护 | 未改动 |
| 服务端 API | 未改动（`apps/learning-agent/src/` 零改动） |
| 数据库 | 未改动 |
| 学习记忆及复习资格 | 未改动 |
| 学习目标卡片及其他历史技术债 | 未处理 |
| P2-6 | 未开始 |

## 7. 改动清单

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `react/profile/KnowledgeReadView.tsx` | 改 | 阅读态新增带标签的完整名称 |
| `react/shell/shell.css` | 改 | 新增 `.mla-knowledge-row__full-name`（14 行） |
| `react/profile/KnowledgeList.test.tsx` | 改 | 新增 R1-1–R1-7（7 项） |
| `react/profile/knowledge-format.test.ts` | 新 | 日期与百分比 7 项 |
| `scripts/qa_p2_5.py` | 改 | `theme` 参数、`VISIBILITY` 探针、`check_visible()`、R01–R06 |
| `P2-5-assets/p25-r1-*.png` | 新 | 9 张场景截图 |
| `P2-5-assets/r1-browser-metrics.json` | 新 | R01–R06 指标 |
| `P2-5-assets/r1-test-log.txt` | 新 | 真实测试日志（含失败执行与报告口径说明） |

## 8. 未解决问题与阻塞

1. **PR 未创建/未更新**：`gh auth status` 返回 "You are not logged into any GitHub hosts"，
   `gh pr list` 与 `gh pr create` 均无法执行，因此**无法确认 P2-5 PR 是否已存在**。按任务书
   "若 GitHub CLI 未登录，如实记录，不阻碍代码及验收成果推送"，分支照常推送，未声称已创建或已更新。
2. `server.e48-workbench.test.ts` 的 `allows an in_progress course to continue chatting` 仍为历史失败，
   未删除、未跳过、未放宽。
3. 桌面端头部名称仍为单行省略号——这是 P2-5 保留的桌面紧凑布局，本轮**未改动**；
   完整名称现在可以在阅读态读到（F01）。
4. 容器查询在 Safari < 16 / Chrome < 105 不可用，本轮仍未添加 `@media` 降级（基线浏览器已支持）。

## 9. 实际测试与构建结果

### 9.1 全量测试

| 执行 | 收集 | 通过 | 失败 | 跳过 | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 历史基准（任务书） | 2462 | 2458 | 1 | 3 | — |
| P2-5 结束时 | 2472 | 2468 | 1 | 3 | 260s |
| **本轮（干净）** | **2486** | **2482** | **1** | **3** | 455s |

差异：收集 **+14**、通过 **+14**（R1-1–R1-7 共 7 项 + `knowledge-format.test.ts` 7 项），
失败与跳过数不变。唯一失败仍是 `server.e48-workbench.test.ts` 的历史基准失败。

### 9.2 一次失败的执行，及其报告口径问题

第一轮用 `--reporter=json` 跑全量，得到 `numFailedTests=0 / numPendingTests=68`。
**这个结果不可信，已查明原因**：

7 个 server 测试文件在 `beforeAll` 阶段报 `server readiness timeout`（全量并发下各自拉起
监听端口，本机超时），共 65 项未执行。vitest 的 JSON reporter 把"文件启动失败"下的用例
全部标为 `skipped`，于是 `numFailedTests` 显示 0。

**如果只看那个 JSON，会得出"0 失败"的错误结论。** 改用 default reporter 重跑后得到
§9.1 的干净数字；单独执行 `server.e48-workbench.test.ts` 也正常（8 通过 / 1 历史失败），
证明是启动超时而非代码缺陷。本轮未改动任何 server 代码（`apps/learning-agent/src/` 零改动）。

完整执行记录见 `P2-5-assets/r1-test-log.txt`。

### 9.3 定向测试与构建

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向测试 | `vitest run react/profile/ ProfilePage.courses.test.tsx react/courses/` | **278 通过**（19 文件），0 失败 |
| 其中 `KnowledgeList.test.tsx` | 同上 | 39 通过（22 既有 + 10 P2-5 + 7 R1） |
| 其中 `knowledge-format.test.ts` | 同上 | 7 通过（本轮新增） |
| 类型检查 | `tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | exit 0 |
| 完整构建 | `npm run build` | 通过（55.48s） |

### 9.4 浏览器验收

`qa_p2_5.py --r1`：**6 个场景全部通过**，每个场景 `pageErrors` 为空。
P2-5 原套件（`qa_p2_5.py`，14 条测量）在重构后仍通过。

## 10. 交付

| 项 | 值 |
| --- | --- |
| 分支 | `feat/e49i-p2-5-mobile-knowledge-row`（沿用） |
| 起点 SHA | `d6695abef3ff42c9659b76ff62e6e55950067770` |
| 本轮提交 | 见 `git log -1`（提交哈希不写入本文件：写入后再 amend 会让哈希自我指涉、无法收敛） |
| 提交信息 | `fix(profile): E4.9i-P2-5-R1 阅读态展示完整知识名称` |
| 推送 | 已推送至 `origin/feat/e49i-p2-5-mobile-knowledge-row`（本地与远程一致） |
| PR | **未创建/未更新**：`gh` 未登录（见 §8） |

新增测试 **14 项**（R1-1–R1-7、`knowledge-format` 7 项）。

未自动合并，未开始 P2-6。
