# E4.9i-P2-6-R2 验收报告：目标编辑初始快照与被动更新保护

| 项 | 值 |
| --- | --- |
| 任务 | E4.9i-P2-6-R2（独立终审发现的目标编辑被动更新缺陷） |
| 分支 | `fix/e49i-p2-6-r2-goal-edit-snapshot` |
| 开发基准 | `main@59d611896f86113caf44d30e7aa9814557544a20`（PR #23 合并提交） |
| 范围 | T01 编辑初始快照、T02 PATCH 字段语义、T03 回归测试、T04 浏览器验收 |
| 结论 | **PASS**（见 §10–§11） |

本轮不回滚 P2-6-R1，不重做 F01–F04，不进入 P2-7。R1 的 `priorityTouched` 与异常优先级端点按钮全部保留。

---

## 1. 开工前核对

| 核对项 | 结果 |
| --- | --- |
| 最新 main | `59d6118`（`Merge pull request #23 from livepass/feat/e49i-p2-6-profile-provenance`） |
| 远程等价分支 | `git ls-remote --heads origin` 无 `fix/e49i-p2-6-r2-*`；`git branch -a` 无同名分支 |
| 工作区 | 开工时干净，位于 `feat/e49i-p2-6-profile-provenance`，与该分支远程一致 |
| 等价实现排查 | 全仓搜索 `editingBaseline` / `goalPatchFromDraft`：仅命中 `LearnerProfilePanel.tsx`、`knowledge-provenance.ts` 及其测试；`editingBaseline` 在 main 上不存在（R1 只用 `goal` 作比较基准） |
| PR 列表 | 本环境 `gh` 未登录（`gh auth status` 报未登录），无法枚举 GitHub PR 列表；PR 状态通过 `origin/main` 的合并历史与远程分支引用核对。这是环境限制，不是"已确认无相关 PR"的强证据，如实记录 |

分支从 `origin/main` 新建，未携带上一分支的未合并改动。

---

## 2. T01 问题复现（G1）

### 2.1 缺陷机理

R1 的保存逻辑：

```ts
const patch = goalPatchFromDraft(goal, draft, priorityTouched);
```

`goal` 是实时 prop：任何一次 `learnerStore.load()`（刷新、其他端写入后的重读）都会把它替换成新对象；
`draft` 仍是编辑开始时的值。于是**服务端改过的字段**与**旧草稿**不相等，
被判定为"用户修改"，随请求一起发出。

R1 的 `priorityTouched` 只挡住了 `priority` 一个字段（因为优先级还有一个"手柄位置无法表达异常值"的额外问题），
`title` / `type` / `status` / `success_criteria` 仍然按"草稿 vs 最新记录"比较。
任务书 §2.1 给出的例子正是这条路径：服务端把 `status` 改成 `paused`，用户只动优先级，
请求体却带上 `status: "active"`，既覆盖服务端新值，又刷新 `manual.status`。

### 2.2 修复前反例（真实运行）

先写测试、后改代码。在**未修改的 R1 实现**上运行 `GoalPriority.test.tsx`：

```text
Test Files  1 failed (1)
     Tests  11 failed | 30 passed (41)
```

11 项失败全部是"旧草稿字段被发出"，断言的是**完整请求体**而不是单个值：

| 编号 | 服务端被动更新 | 用户修改 | R1 实际请求体（失败证据） | 期望 |
| --- | --- | --- | --- | --- |
| S01 | title | priority | `{ title: '学习英语', priority: 0.4 }` | `{ priority: 0.4 }` |
| S02 | status | priority | `{ status: 'active', priority: 0.4 }` | `{ priority: 0.4 }` |
| S03 | type | title | `{ title: '改过的标题', type: 'skill' }` | `{ title: '改过的标题' }` |
| S04 | success_criteria | title | `{ title: '改过的标题', success_criteria: [...] }` | `{ title: '改过的标题' }` |
| S06 | title+type+status+criteria | priority | `{ title, type, status, success_criteria, priority }` | `{ priority: 0.4 }` |
| S07 | 全部可编辑字段 | 无 | 发出了 1 次请求 | 不发请求 |
| S08 | title | status | `{ title: '学习英语', status: 'paused' }` | `{ status: 'paused' }` |
| S09 | status | title | `{ title: '改过的标题', status: 'active' }` | `{ title: '改过的标题' }` |
| S10 | success_criteria | priority | `{ success_criteria: ['旧标准'], priority: 0.4 }` | `{ priority: 0.4 }` |
| S14 | title（保存失败后） | status | 重试发送 `{ title, status }` | `{ status: 'paused' }` |
| S16 | status | priority（端点 100%） | `{ status: 'active', priority: 1 }` | `{ priority: 1 }` |

原始输出见 `P2-6-assets/r2-test-log.txt` §1。

S05、S11、S12、S13、S15、S17、S18 在 R1 上即通过（R1 已具备的行为：未触碰的 priority 不发、取消不发请求、
端点值合法），保留为回归护栏，不计入"复现"。

### 2.3 未使用的复现捷径

没有通过放宽断言、只验证"最终优先级正确"来制造通过。S02 在 R1 上最终存储的 priority 也是 0.4，
若只断言它，缺陷完全不可见——所以每个场景都断言请求体的键集合或整体相等。

---

## 3. T01 最小代码修改

改动 7 个文件，生产代码只有 3 个（`+598 / −19`，其中测试 519 行）：

| 文件 | 增/删 | 内容 |
| --- | --- | --- |
| `web/src/react/profile/knowledge-provenance.ts` | +35 / −8 | 新增 `goalEditingBaseline()`；`goalPatchFromDraft` 形参改名 `goal` → `baseline`，语义文档改为"与编辑初始快照比较" |
| `web/src/react/LearnerProfilePanel.tsx` | +40 / −7 | `GoalCard` 新增 `editingBaseline` 状态；打开/取消/保存/失败四条路径的快照生命周期 |
| `web/src/i18n/locales/{zh-CN,en}.json` | +2 / −1 各 | 新增 `profile.goals.editBaselineMissing`（快照异常缺失时的提示） |
| `web/src/react/profile/GoalPriority.test.tsx` | +349 / −0 | S01–S18（18 项） |
| `web/src/react/profile/knowledge-provenance.test.ts` | +54 / −2 | 快照克隆 4 项 |
| `src/server/routes/learner.goal-priority.test.ts` | +116 / −0 | 真实路由 partial PATCH 5 项 |

### 3.1 快照对象

```ts
export function goalEditingBaseline<G extends GoalEditableFields>(goal: G): G {
	return { ...goal, success_criteria: [...goal.success_criteria] };
}
```

浅拷贝对象 + 逐元素拷贝 `success_criteria`。元素是字符串，浅拷贝即完整；
共享数组会让草稿编辑反向污染快照，并经由快照污染 store 里仍在使用的记录。

### 3.2 GoalCard 的三个对象

| 对象 | 来源 | 何时变化 |
| --- | --- | --- |
| `goal` | 组件 prop（store 当前记录） | 每次被动刷新 |
| `editingBaseline` | 打开编辑器时的深一层拷贝 | 仅打开时建立；被动刷新不覆盖；保存成功/取消/无修改关闭时清空 |
| `draft` | 打开时的另一份拷贝 | 用户输入 |

`startEditing()` 建立快照与草稿两份独立拷贝；`useEffect` 在 `!editing` 时用新拷贝重置草稿，
避免空闲态草稿与 store 记录共享 `success_criteria` 引用。

### 3.3 保存

```ts
const patch = goalPatchFromDraft(editingBaseline, draft, priorityTouched);
```

`goal` 不再参与字段比较。快照缺失时直接报错并阻止发送，**不回退**到"用最新记录比较"——
回退等于恢复本轮要修的错误逻辑。

### 3.4 未做的改动（明确）

- 没有改 `goalPatchFromDraft` 的判定规则本身（只在字段比较与异常值护栏上保留 R1 行为）。
- 没有新增版本号、ETag、锁、冲突弹窗或服务端并发控制。
- `learner-store.ts`、`api/learner.ts`、`server/routes/learner.ts` 零 diff（仅核查）。

---

## 4. T02 字段修改语义

| 字段 | 提交依据 | 实现位置 |
| --- | --- | --- |
| `title` | `draft.title !== baseline.title` | `goalPatchFromDraft` |
| `type` | `draft.type !== baseline.type` | 同上 |
| `status` | `draft.status !== baseline.status` | 同上 |
| `success_criteria` | 数组逐项比较 | `sameStringArray` |
| `priority` | `priorityTouched` 且为 `[0,1]` 有限数 | 同上（R1 规则保留） |

同字段并发：用户主动修改过的字段，仍以用户提交值为准（S18 断言 `{ title: '用户最后输入的标题' }`）。
本轮**不解决**多客户端并发编辑冲突，只解决"用户没改的字段被旧草稿覆盖"。

---

## 5. 快照生命周期验证

对照任务书 §3.3 逐条：

| 场景 | 要求 | 验证 |
| --- | --- | --- |
| 打开编辑器 | 建立独立快照与草稿 | `knowledge-provenance.test.ts`：两份快照互不影响；`GoalPriority` S15 断言原数组不被键入修改 |
| 服务端被动刷新 | 不覆盖快照、不覆盖草稿 | S01–S10、S14：刷新后草稿仍在，请求体不含未修改字段；B01–B07 浏览器侧同样验证 |
| 保存成功 | 用服务端返回记录结束编辑 | `patchGoal` 用响应替换 store 记录；关闭后 `useEffect` 以新记录重建草稿（B02 保存后卡片显示服务端标题） |
| 保存失败 | 保留快照、草稿、编辑标记 | S14：失败后再次保存只发 `{status}`；B06：两次尝试均为 `{status:'paused'}` |
| 取消编辑 | 不发请求，清理状态 | S12：无请求且卡片回到服务端记录；B05：取消后草稿丢弃 |
| 重新打开 | 基于最新服务端记录建快照 | S13：重开后标题输入框为服务端新标题，保存只发 `{status}`；B05 同 |
| 无有效修改 | 不发 PATCH | S07（被动更新后直接保存）、S11（改回原值）：0 次请求；B04 同 |
| 快照异常缺失 | 安全阻止保存 | `save()` 首行判空 → 报 `editBaselineMissing` 并 return，不退回旧比较逻辑 |

---

## 6. PATCH 字段与人工维护标记

### 6.1 浏览器侧（模拟 API）

`qa_p2_6_r2.py` 的 mock 按 `server/routes/learner.ts` 的规则打戳：**只有请求体出现的字段**才推进
`manual.<field>.edit`。7 个场景的实测请求体：

| 场景 | 服务端被动更新 | 用户修改 | 实际 PATCH | 未提交字段的结果 |
| --- | --- | --- | --- | --- |
| R2-B01 | status→paused | priority 40% | `{"priority": 0.4}` | status 仍 paused，`manual.status` 为服务端新戳 |
| R2-B02 | title→服务端标题 | status→已暂停 | `{"status": "paused"}` | 标题保留服务端值，`manual.title` 未被刷新 |
| R2-B03 | type→exam、criteria→两条 | title | `{"title": "编辑期间改的标题"}` | type 与成功标准保留服务端值 |
| R2-B04 | 全部字段 | 无 | 无请求 | 记录逐字段等于服务端记录 |
| R2-B05 | title→服务端标题 | status→已完成 | `{"status": "completed"}` | 重开后基线为服务端记录 |
| R2-B06 | 失败后 title→服务端标题 | status→已暂停（重试） | 两次均 `{"status": "paused"}` | 标题未被旧草稿覆盖 |
| R2-B07 | status→paused（320px） | 异常 3 → 端点 100% | `{"priority": 1}` | status 仍 paused |

### 6.2 服务端侧（真实路由）

`learner.goal-priority.test.ts` 新增 5 项，全部跑真实 `handleLearnerRoutes` + 真实 learner store（临时目录）：

- priority-only PATCH：`manual.title/status/success_criteria` 与种子值逐字段相等，`title/status/type/success_criteria` 值不变；
- title-only PATCH：`manual.status/priority/success_criteria` 不变；
- status-only PATCH：`manual.title/priority` 不变；
- criteria-only PATCH：`type` 与其兄弟戳不变；
- type-only PATCH：只改 `type`，`manual` 整体等于种子。

未新增任何服务端人工维护规则，`server/routes/learner.ts` 零 diff。

### 6.3 证据边界

浏览器证据来自**模拟 API**（`page.route` 复刻打戳规则），证明的是"客户端发什么"；
真实路由的打戳与部分更新行为由上面的 Vitest 文件证明。两者在报告与脚本 docstring 中分开陈述，
不互相替代。

---

## 7. 测试与构建

全部在本机串行执行，浏览器与全量测试未并行。

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 修复前反例 | `npx vitest run .../GoalPriority.test.tsx` | 11 失败 / 30 通过（41） |
| R2 专项 | 3 个测试文件 | **102 通过**（41 + 49 + 12） |
| 学习档案与课程专项 | `react` / `i18n` / `stores` / `api` / `server/routes` / `memory.learner` | **101 文件 / 1401 通过** |
| TypeScript（web） | `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | exit 0 |
| 完整构建 | `npm run build` | exit 0（后端 tsc + 前端 tsc + vite，1m 6s） |
| 全量测试 | `npx vitest run` | **2628 用例：2625 通过 / 0 失败 / 3 跳过**（217 文件全通过） |

### 7.1 与历史基准对比

| 指标 | P2-6-R1 | P2-6-R2 |
| --- | --- | --- |
| 总测试数 | 2601 | 2628（+27：18 + 4 + 5） |
| 通过 | 2597 | 2625 |
| 失败 | 1（历史基准） | 0 |
| 跳过 | 3 | 3 |
| 定向回归 | 933/933（59 文件） | 1401/1401（101 文件） |
| 浏览器 | 19/19 | 7 R2 + 19 R1 复跑，全部通过 |

历史基准失败（`server.e48-workbench.test.ts > allows an in_progress course to continue chatting`）
本轮**未复现**：全量干净运行中通过，单独运行该文件连续 3 次均为 9/9。
本报告不声称它已修复，只记录"本轮未观察到"。

有一次全量运行在 Vite 仍监听 5193 时启动，报 1 项失败，且是同一文件中的**另一条断言**
（`unclassified Web history is read-only`，`expected 4 to be 3`）。两次运行之间无代码改动，
按已记录的端口/CPU 竞争处理，不采用该次数字（见 `r2-test-log.txt` §8）。

---

## 8. 浏览器验收（T04）

脚本：`docs/ui-redesign/phase5/scripts/qa_p2_6_r2.py`（新增，`import qa_p2_6_r1` 复用 fixture 与探针）。

### 8.1 R2-B01–B07

每个场景记录：编辑前记录、服务端被动更新记录、用户实际修改字段、PATCH 请求体、服务端返回/存储记录、
`manual.*` 前后值、`pageErrors`、元素边界与横向溢出（`editorBounds`：输入框、滑块、文本域、端点按钮、
编辑卡片的 `width/left/right/scrollWidth/clientWidth/clippedBy`）。

| 场景 | 视口 | 结果 |
| --- | --- | --- |
| R2-B01 服务端改状态，用户只改优先级 | 1440×900 | 通过，`{priority:0.4}`，status 保持 paused |
| R2-B02 服务端改标题，用户只改状态 | 1440×900 | 通过，`{status:'paused'}` |
| R2-B03 服务端改类型与成功标准，用户只改标题 | 1440×900 | 通过，`{title}` |
| R2-B04 服务端改多字段，用户未修改直接保存 | 1440×900 | 通过，无请求，记录不变 |
| R2-B05 被动刷新 → 取消 → 重新打开 | 1440×900 | 通过，重开基线为服务端记录 |
| R2-B06 保存失败 → 被动刷新 → 重试 | 1440×900 | 通过，两次均 `{status}` |
| R2-B07 320px 异常优先级端点确认并保存 | 320×640 | 通过，`{priority:1}`，页面无横向溢出 |

全部 7 个场景 `pageErrors = []`。

### 8.2 R1 全量复跑

19 个 R1 场景由 `qa_p2_6_r1.py` 自身执行（R01–R08 + B01–B10 复跑），输出重定向到
`P2-6-assets/r2/r1-rerun/`，全部通过、`pageErrors = []`、无横向溢出。
原始 `P2-6-assets/p26-*.png` 与 `P2-6-assets/r1/` 未被写入（`git status` 中无修改）。

### 8.3 320px 的一处既有现象（不属于本轮，也不修改）

R2-B07 的 320px 截图里，**折叠态**目标卡片的内容列被右侧「状态 + 编辑 + 删除」按钮组压到约 18px，
标题逐字换行。实测：卡片 232px、右侧按钮组 149px、左列 18px。

这不是本轮引入的：暂时把 `LearnerProfilePanel.tsx` 回退到 `origin/main` 版本后，同一探针测得
完全相同的数值（卡片 232 / 右组 149 / 左列 18），且本轮 diff 未触碰折叠态 JSX 与任何样式。
它属于 P2-5 响应式机制的未覆盖区域，而本轮冻结范围明确禁止修改该机制，因此**只记录、不修**。
页面级横向溢出为 false，编辑态（展开）在 320px 下可正常使用（见 `r2-b07a-320-endpoint-confirm.png`）。

---

## 9. 冻结范围 diff 核查（G9）

`git diff --numstat`（相对 `main@59d6118`）只涉及 7 个文件，全部在允许范围内：

```text
web/src/react/LearnerProfilePanel.tsx              +40  -7
web/src/react/profile/knowledge-provenance.ts      +35  -8
web/src/i18n/locales/zh-CN.json                     +2  -1
web/src/i18n/locales/en.json                        +2  -1
web/src/react/profile/GoalPriority.test.tsx       +349  -0
web/src/react/profile/knowledge-provenance.test.ts  +54  -2
src/server/routes/learner.goal-priority.test.ts    +116  -0
```

| 冻结项 | 结论 |
| --- | --- |
| 知识状态引擎 / 学习证据生成与重放 / 学习记忆 | 无 diff |
| 服务端 API 业务规则 / 数据库 | `server/routes/learner.ts`、`memory/learner/*` 无 diff |
| 掌握度、置信度、稳定性计算 / 正式复习资格 | 无 diff |
| 六类知识筛选规则 / `KnowledgeDraftGuard` | 无 diff |
| P2-5 响应式布局机制 | 无 diff（320px 现象见 §8.3，未修改） |
| P2-6-R1 的 F02/F03/F04 | 无回退、无改写；R1 断言全保留 |
| 新可信度评分 / 目标编辑架构重构 / P2-7 | 未做 |

唯一"新增"的共享代码是 `goalEditingBaseline()`（3 行实现 + 文档注释），放在既有的 `knowledge-provenance.ts`，
没有新建并行模块。

---

## 10. 门禁结果

| 门禁 | 条件 | 结果 | 依据 |
| --- | --- | --- | --- |
| G1 问题复现 | 旧实现复现未修改字段覆盖 | **PASS** | 11 项失败，断言完整请求体（§2.2） |
| G2 快照安全 | 快照与草稿独立 | **PASS** | 4 项克隆单测 + S15 + 代码审阅 |
| G3 请求安全 | 未修改字段不进入 PATCH | **PASS** | S01–S10、B01–B07 精确请求体 |
| G4 生命周期 | 取消/失败/重试/重开正确 | **PASS** | S11–S14、S16–S18、B04–B06 |
| G5 回归保护 | R1 断言全部保留并通过 | **PASS** | 测试文件仅新增；R1 的 23 + 45 + 7 项全通过 |
| G6 构建 | 类型检查与全部构建通过 | **PASS** | tsc exit 0；`npm run build` exit 0 |
| G7 全量测试 | 无新增稳定失败 | **PASS** | 2628 / 2625 通过 / 0 失败 / 3 跳过 |
| G8 浏览器 | R1、R2 场景通过，无新增溢出与 pageErrors | **PASS** | 7 + 19 场景，pageErrors 全空；既有 320px 现象见 §8.3 |
| G9 冻结范围 | 无越权修改 | **PASS** | §9 的 7 文件清单 |

---

## 11. 剩余限制与实际 HEAD

### 11.1 剩余限制（明确不解决）

1. **不是并发冲突解决方案**。两个客户端同时编辑同一字段时，后提交者覆盖先提交者，没有提示、没有版本校验。
   R2 只保证"用户没改的字段不会被旧草稿带走"。
2. **被动刷新不合并进草稿**。若服务端把用户正在编辑的同一字段改了，草稿保持用户输入，保存后以用户值为准（S18）。
3. **快照只在打开时建立**。编辑器长时间打开期间服务端多次变更，仍以打开时的记录判断"改了什么"——这是本轮的
   设计选择：它保证用户的编辑意图不被丢弃，代价是不能自动 rebase 到新记录。
4. **320px 折叠态目标卡片内容列过窄**（§8.3）。既有问题，冻结范围内不修。
5. **PR 列表未能通过 API 核对**（§1）。`gh` 未登录，仅有远程引用与合并历史证据。
6. **Playwright 需要手工准备**：本机原先没有 Python Playwright，本轮安装 `playwright==1.65.2` 与
   Chromium 159 后才执行脚本；脚本本身未写入任何环境假设。

### 11.2 实际 HEAD

本报告与代码位于 `fix/e49i-p2-6-r2-goal-edit-snapshot`。该分支的提交哈希无法写进由同一提交携带的文件
（自我指涉），实际值以 `git log -1 --format=%H` 与 PR 描述为准。
开发基准固定为 `main@59d611896f86113caf44d30e7aa9814557544a20`。

### 11.3 交付物

```text
docs/ui-redesign/phase5/
├── P2-6-R2-acceptance.md                 本报告
├── P2-6-R2-pr-body.md                    PR 描述
├── P2-6-assets/
│   ├── r2-browser-metrics.json           7 个 R2 场景 + 19 个 R1 复跑实测
│   ├── r2-test-log.txt                   修复前/后、构建、全量、浏览器日志
│   └── r2/
│       ├── r2-b01 … r2-b07*.png          8 张截图（B07 含确认前后两帧）
│       └── r1-rerun/                     R1 19 场景复跑截图
└── scripts/
    └── qa_p2_6_r2.py                     R2-B01–B07 + R1 复跑
```

---

## 12. 结论

**PASS**

- G1–G9 全部通过。
- 未修改任何冻结模块；服务端业务规则零 diff。
- R1 的 F01–F04 与全部断言保留，19 个 R1 浏览器场景复跑通过。
- 全量 2628 用例 0 失败；历史基准失败本轮未复现（如实记录，不声称已修复）。
- 剩余限制见 §11.1，其中 320px 折叠态卡片宽度为既有问题，不在本轮范围。
