# E4.9i-P2-6 验收报告：学习档案来源与证据可信度展示

- **任务**：E4.9i-P2-6
- **开发基准**：`main@7d7a04accd6f9a64f475c575405fe6db0c4484ca`（PR #22 合并提交）
- **开发分支**：`feat/e49i-p2-6-profile-provenance`（从 `origin/main` 新建）
- **结论**：**P2-6 PASS_WITH_KNOWN_BASELINE_FAILURE**
  （唯一失败为 P2-5 起已记录、与本任务无关的 `server.e48-workbench.test.ts` 历史基准失败）

---

## 1. 基准核对

| 项 | 值 |
| --- | --- |
| `git fetch origin` 后 `origin/main` | `7d7a04accd6f9a64f475c575405fe6db0c4484ca`（与任务书一致） |
| 开发分支 | `feat/e49i-p2-6-profile-provenance`，基于上述 `origin/main` 新建 |
| P2-5 / P2-5-R1 | 已在 PR #22 合入 main；本轮**未改动**任何 P2-5 资产或响应式机制 |
| 开工工作区 | 存在上一任务遗留的 P2-5-R1 提交内容（已在 main 中），无未跟踪的无关改动 |
| PR 状态 | **无法创建**：`gh` 未登录（见 §9.2） |

**未改动**：知识状态引擎、证据生成与回放、记忆、掌握度/置信度/稳定性计算、六种筛选规则、
概览统计、正式复习资格、服务端 API、数据库、草稿保护业务规则、P2-5 响应式机制。

---

## 2. 真实字段来源（读，不推断）

| 展示项 | 唯一来源 | 说明 |
| --- | --- | --- |
| 记录来源 | `KnowledgeState.origin` / `CourseKnowledgeState.origin` | 服务端写入，取值 `derived` / `manual` / `legacy` |
| 来源不明 | `KnowledgeState.provenance_unknown` | 独立布尔字段，与 `origin` 无派生关系 |
| 证据标识数量 | `evidence_ids.length` | 原样计数，不去重 |
| 目标优先级 | `LearningGoal.priority` | 文档约定 0–1 权重 |

服务端写入路径已核实（`apps/learning-agent/src/memory/learner/profile-updater.ts`）：

- `updateProfile()` 第 114 行：任何显式写入都会落 `origin: "manual" as const`，并在 `evidence_ids`
  为空时置 `provenance_unknown: true`。
- `patchProfile()` 第 159 行：新建状态同样带 `origin: "manual"`。
- 前端**没有**任何写 `origin` 的代码（`grep` 全仓 `origin:` 写入点均不在 `web/src`）。

因此「保存后标记为人工维护」是**服务端规则**，本轮只展示，不复制、不预置、不推断。

## 3. 展示规则 vs 业务规则（明确区分）

本任务只增加**展示**，不改变任何**判定**：

| 展示层做了什么 | 业务层未做什么 |
| --- | --- |
| 把 `origin` 三个已知值映射成中文/英文标签 | 不改变 `origin` 的产生条件 |
| 未知 `origin` 显示「来源未标明」，不落回「系统推导」 | 不新增 `origin` 取值 |
| `provenance_unknown` 独立展示为「来源不明」徽标 | 不改变服务端置 `true` 的条件 |
| 证据数量按 `evidence_ids.length` 显示 | 不去重、不合并镜像、不改变数组内容 |
| 优先级超出 0–1 显示原始值 | 不校验、不迁移、不改调度 |

---

## 4. 改动文件与理由

### 4.1 新增

| 文件 | 理由 |
| --- | --- |
| `web/src/react/profile/knowledge-provenance.ts` | 纯函数：`describeProvenance`、`describeEvidenceCount`、`evidenceSummary`、`formatGoalPriority`、`priorityForSlider`、`goalPriorityText`、`goalPriorityLine`。展示语义集中在一处，两个视图不会各说各话 |
| `web/src/react/profile/KnowledgeProvenance.tsx` | 共享展示组件（来源行 + 来源不明徽标 + 证据行 + 可选两段说明） |
| `web/src/react/profile/knowledge-provenance.test.ts` | 28 项：来源语义、证据计数语义、优先级边界 |
| `web/src/react/profile/KnowledgeProvenance.test.tsx` | 20 项：渲染、双字段并存、不可读计数、双语、文案不重复 |
| `web/src/react/profile/KnowledgeProvenance.lifecycle.test.tsx` | 11 项：编辑生命周期 C01–C08、课程作用域 E01–E03 |
| `web/src/react/profile/GoalPriority.test.tsx` | 9 项：异常优先级的显示、编辑、保存、取消 |
| `docs/ui-redesign/phase5/scripts/qa_p2_6.py` | B01–B10 浏览器验收 |
| `docs/ui-redesign/phase5/P2-6-assets/` | 指标 JSON、测试日志、10 张截图 |

### 4.2 修改

| 文件 | 改动 |
| --- | --- |
| `web/src/react/profile/KnowledgeReadView.tsx` | 在状态/掌握度/日期之后插入 `KnowledgeProvenance`（`withNotes`） |
| `web/src/react/courses/CourseLearnerPanel.tsx` | 用 `KnowledgeProvenance` 替换原来的 `course.learner.evidenceCount` 文本；读取课程自己的 `origin` / `provenance_unknown` / `evidence_ids` |
| `web/src/react/courses/CourseOverviewPanel.tsx` | T04 影响面：同一 `CourseKnowledgeState.evidence_ids`，原「证据 N 条」改为共享 `evidenceSummary()` |
| `web/src/react/LearnerProfilePanel.tsx` | T06：优先级改用 `goalPriorityLine()`；滑块值经 `priorityForSlider()`；异常时显示原始值与提示 |
| `web/src/react/shell/shell.css` | 新增 `.mla-provenance*`；删除已无引用的 `.mla-course-knowledge-row__evidence` 规则 |
| `web/src/i18n/locales/{zh-CN,en}.json` | `profile.knowledge.provenance.*`、`profile.goals.priority*`；英文补 `evidenceCount_one` |
| `web/src/react/profile/KnowledgeList.page.test.tsx` | 断言随 T04 统一措辞更新为「证据标识 N 个」 |

### 4.3 影响面记录（T04）

全仓 `evidence_ids.length` 的展示点只有两处，且**同一定义**（都是 `CourseKnowledgeState.evidence_ids`）：
`CourseLearnerPanel` 与 `CourseOverviewPanel`。两处均已改为共享实现。
`practice.*` / `today.basis.*` 等使用 `evidence_basis.evidence_count`，**定义不同**（是服务端的计数而非数组长度），
按任务书要求**未触碰**。

---

## 5. 实现要点

### 5.1 来源（T01）

```ts
describeProvenance({ origin, provenance_unknown })
// derived → 系统推导 / manual → 人工维护 / legacy → 历史记录
// 缺失、null、空串、未知值 → 来源未标明（永不落回系统推导）
// provenance_unknown === true 才是「来源不明」；缺失或 false ≠ 已核实
```

- `origin` 与 `provenanceUnknown` **相互独立**，可同时显示。`manual + true` 是真实组合，
  组件会同时显示「人工维护」和「来源不明」，不做「纠正」。
- 未知来源保留原始值到 `data-provenance-origin`，供报告与排查使用。

### 5.2 证据数量（T04）

- `Array.isArray` 才计数；缺失、`null`、字符串、数字一律「证据标识数量不可用」，**绝不显示 0**。
- 不去重：`["legacy_1","event_1","legacy_1"]` 显示 3 个。
- 文案固定为「证据标识 N 个」/「N evidence identifiers」（英文补 `_one`）。
- 阅读态额外说明：数量 ≠ 独立学习或练习次数；旧版镜像可能重复计入；暂不提供证据明细。

### 5.3 编辑态一致性（T03）

编辑面板的提示 `profile.knowledge.manualNotice`（「保存修改后，此知识记录将标记为人工维护。」）
**在 main 上已存在**，本轮未新增该行为，只补测试证明其在生命周期每一步都成立：

| 场景 | 结果 |
| --- | --- |
| 打开编辑器 | 来源不变（`derived`） |
| 改草稿 | 来源不变，且未发请求 |
| 保存成功 | 来源变为 `manual`，**取自服务端响应** |
| 保存失败 | 保留草稿 + 保留原来源 `derived` |
| 取消 | 不发请求，来源不变 |
| 被动刷新 | 显示服务端最新来源（含 `legacy` + `来源不明`） |
| 知识点已消失 | 保存按钮禁用，点击无效，草稿保留 |

前端**未**预置 `origin: "manual"`；保存请求体仅 `diagnosis` / `mastery` / `next_actions`
（浏览器实测 `saveRequestFields` 断言了这一点）。

### 5.4 课程视图（T05）

`CourseLearnerPanel` 复用同一组件，字段全部取自 `GET /api/courses/:id/learner` 的
`CourseKnowledgeState`，**绝不**用全局档案回填。浏览器 B10 用一份故意冲突的数据验证：
全局说「人工维护 / 9 个」，课程说「系统推导 / 1 个」，页面显示后者。

### 5.5 目标优先级（T06）

```ts
formatGoalPriority(value)
// 有限且 ∈ [0,1] → percent
// 有限但越界   → anomaly（显示原始值）
// NaN/Infinity/缺失/非数字 → unavailable
```

- `priority = 3` 显示「优先级异常 · 原始值 3」，不显示 300%，也不静默钳到 100%。
- 滑块**只移动手柄**：`priorityForSlider(3)` 返回 1，`draft.priority` 仍是 3。
  因此只改标题保存时，写回的是 3（浏览器 B09 实测 `titleOnlySavePriority: 3`）。
- 用户真正拖动滑块才用新值覆盖（`onChange` → `Number(value)/100`）。
- 异常时编辑器显示提示「该目标的优先级超出正常范围（0–1）。未修改优先级时，保存不会改变这个原始值。」

**关于异常值编辑的最小保护**：仅两处，且都不影响正常值——
(1) 滑块手柄取最近端点，(2) 显示一条提示。正常值（0/0.5/1）行为与改动前完全一致，
测试 `a normal goal edits exactly as before` 覆盖。

### 5.6 置信度（T07）

本轮**未**新增任何置信度展示。界面不出现置信度百分比、高/中/低分级、「正确概率」，
不把掌握度当作练习正确率，不做证据质量评分。来源标签不参与复习资格判定。

---

## 6. 浏览器验收（B01–B10）

脚本：`docs/ui-redesign/phase5/scripts/qa_p2_6.py`
指标：`P2-6-assets/p26-browser-metrics.json`

隔离 Vite（`127.0.0.1:5193`）+ Playwright Chromium + `page.route` 固定数据，
**无后端、无真实数据、无写入**。

| 场景 | 视口 | 主题/语言 | 截图 | 断言要点 |
| --- | --- | --- | --- | --- |
| B01 | 1440×900 | light/zh | `p26-b01-1440-provenance.png` | 六种来源各就各位；未知来源不落「系统推导」；镜像计数 3；不可读计数为「不可用」；未发 PATCH |
| B02 | 390×844 | light/zh | `p26-b02-390-provenance.png` | 堆叠布局保持 3 列，来源与计数不变 |
| B03 | 320×640 | light/zh | `p26-b03-320-unknown.png` | 来源不明徽标 + 提示完整可见，无横向裁剪 |
| B04 | 320×640 | light/en | `p26-b04-320-en.png` | 五种英文文案逐一核对；中文零泄漏 |
| B05 | 390×844 | **dark**/zh | `p26-b05-dark.png` | 对比度实测 **6.59:1**（≥ 4.5 AA） |
| B06 | 1440×900 | light/zh | `p26-b06-manual-save.png` | 保存前 `derived` → 保存后 `manual`；请求体仅 3 个可编辑字段 |
| B07 | 390×844 | light/zh | `p26-b07-save-failed.png` | 500 失败后草稿保留、来源仍为 `derived` |
| B08 | 1440×900 | light/zh | `p26-b08-legacy-mirror.png` | 镜像 3 个；两段说明齐全；未渲染任何证据 ID |
| B09 | 1440×900 | light/zh | `p26-b09-priority.png` | 异常行「原始值 3」；滑块停 100 但草稿仍 3；仅改标题保存写回 3；取消不发请求 |
| B10 | 320×640 | light/zh | `p26-b10-320-course.png` | 课程读自己的数据、只读、单列、无裁剪 |

全部 10 个场景：`pageErrors` 为空，页面级横向溢出为 0。

**测量方法**（沿用 P2-5-R1 的真实边界思路，不用 `width > 0`）：

- 元素真实 `getBoundingClientRect()`
- 逐个祖先检查 `overflow-x/y`，判断是否被裁到可见框外
- 元素自身 `scrollWidth > clientWidth` 判断文字溢出
- 行宽 vs 列表宽、文档宽 vs 视口宽
- 纵向只报告不判定：内容可滚动即可达，不是裁剪

---

## 7. 测试

详见 `P2-6-assets/p26-test-log.txt`（真实日志）。

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | 0 错误 |
| 定向回归 | profile + courses + LearnerProfilePanel + i18n | 24 文件 / **354 通过** |
| Web 构建 | `npm --workspace my-learning-agent-web run build` | ✓ 1m 24s |
| 全量构建 | `npm run build` | ✓ 1m 27s |
| 全量测试 | `node node_modules/vitest/vitest.mjs run --reporter=default` | 216 文件 / 2554 用例：**2550 通过 / 1 失败 / 3 跳过** |

### 7.1 与历史基准对比

| | 总数 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- | --- |
| P2-5-R1 基准 | 2486 | 2482 | 1 | 3 |
| 本轮 | **2554** | **2550** | **1** | **3** |

新增 **68** 项：`knowledge-provenance.test.ts` 28、`KnowledgeProvenance.test.tsx` 20、
`KnowledgeProvenance.lifecycle.test.tsx` 11、`GoalPriority.test.tsx` 9。

### 7.2 唯一失败（历史基准）

```text
FAIL apps/learning-agent/src/server.e48-workbench.test.ts
  > E4.8a — course status gates chat writes
  > allows an in_progress course to continue chatting
  AssertionError: expected 2 to be 1
  ❯ apps/learning-agent/src/server.e48-workbench.test.ts:253:25
    expect(providerCalls).toBe(calls + 1);
```

- 已在 `P2-5-acceptance.md` §9 与 `P2-5-R1-acceptance.md` 记录为历史失败。
- 单独重跑该文件：1 失败 / 8 通过，同一用例、同一断言。
- 该测试启动真实服务并统计 provider 调用次数，**不涉及本轮改动的任何文件**。
- **未删除、未跳过、未放宽断言。**

### 7.3 未用 JSON reporter 的原因

`--reporter=json` 会把在 `beforeAll` 失败的文件内所有用例标记为 **skipped**，
`numFailedTests` 可能读成 0，而实际有整个文件从未执行（P2-5-R1 已遇到）。
本轮用 default reporter，并核对 `Test Files` 与 `Tests` 两行。

---

## 8. 变异测试（证明断言有效）

对纯函数层注入 6 个缺陷，确认每个都被捕获：

| 变异 | 结果 |
| --- | --- |
| 越界优先级钳到 100% | 5 项失败 ✅ |
| 不可读证据计数当作 0 | 2 项失败 ✅ |
| 未知来源落回「系统推导」 | 5 项失败 ✅ |
| `provenance_unknown` 用真值判断 | 初版 0 失败 → 补用例后 1 项失败 ✅ |
| `NaN` 用范围判断而非 `isFinite` | 3 项失败 ✅ |
| 证据行加回字段名前缀 | 3 项失败 ✅ |

第 4 项暴露了初版测试的盲区（只测了 `undefined/null/false/true`），
已补「真值但非 `true`」用例（`1` / `"true"` / `"false"` / `{}` / `[]`）。

---

## 9. 已知缺陷与未验证项

### 9.1 本轮修复的两个真实文案缺陷

浏览器截图暴露、jsdom 无法发现：

1. **证据行重复字段名**：`证据标识 证据标识 3 个`。
   原因：`KnowledgeProvenance` 同时渲染了「证据标识」标签与完整短语。
   修复：删除标签 span（短语本身已是完整文案），并删除随之无用的 `evidenceLabel` 键。
2. **优先级重复字段名**：`优先级 优先级异常 · 原始值 3`。
   原因：折叠行与编辑器在异常短语前又加了一次字段名。
   修复：新增 `goalPriorityLine()`——百分比才加前缀，异常/不可用短语自足。

两处均补了会失败的回归测试，并用变异验证（§8 第 6 行）。

### 9.2 PR 创建阻塞（如实记录）

```text
$ gh auth status
You are not logged into any GitHub hosts. To log in, run: gh auth login

$ gh pr create --repo livepass/My-Learning-Agent --base main \
    --head feat/e49i-p2-6-profile-provenance \
    --title "E4.9i-P2-6｜学习档案来源与证据可信度展示" \
    --body-file docs/ui-redesign/phase5/P2-6-pr-body.md
To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
```

**代码与验收成果已推送**：`origin/feat/e49i-p2-6-profile-provenance` = `1364ebd`。
PR 需要在 `gh auth login` 之后创建，或直接访问 GitHub 给出的链接：

```text
https://github.com/livepass/My-Learning-Agent/pull/new/feat/e49i-p2-6-profile-provenance
```

PR 描述已备好：`docs/ui-redesign/phase5/P2-6-pr-body.md`。
**未开启自动合并。**

### 9.3 未验证项

- **真实后端数据**：浏览器验收全部使用固定数据，未连真实服务端。
  `origin` / `provenance_unknown` 的服务端写入规则来自源码阅读与既有测试，非本轮实测。
- **旧版数据兼容**：`evidence_ids` 缺失的真实历史档案未采样；该情况仅在固定数据中模拟。
- **PR 状态**：`gh` 未登录时无法创建/查询 PR（见 §9.2）。
- **全量测试中的历史失败**：`server.e48-workbench` 的根因未在本轮排查（超出范围）。

---

## 10. 交付物清单

```text
docs/ui-redesign/phase5/
├── P2-6-acceptance.md                     本报告
├── P2-6-pr-body.md                        PR 描述
├── scripts/qa_p2_6.py                     B01–B10 浏览器验收
└── P2-6-assets/
    ├── p26-browser-metrics.json           10 个场景的实测数据
    ├── p26-test-log.txt                   真实测试/构建日志
    └── p26-b01..b10-*.png                 10 张截图
```

P2-5 / P2-5-R1 资产**未被覆盖**：`git status --short docs/ui-redesign/phase5/P2-5-assets/` 无输出。

---

## 11. 结论

**PASS_WITH_KNOWN_BASELINE_FAILURE**

- T01–T09 全部实现并有测试覆盖。
- 全量测试 2550/2554 通过，唯一失败是已记录的历史基准失败，与本任务无关。
- 类型检查、Web 构建、全量构建均通过。
- 10 个浏览器场景全部通过，含暗色对比度实测、双语文案核对、编辑生命周期、异常优先级。
- 过程中发现并修复了两个 jsdom 无法暴露的真实文案缺陷，并补了有牙齿的回归测试。
