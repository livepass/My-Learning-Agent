# E4.9i-P2-7 验收报告：学习档案跨视图语义统一与综合回归

| 项 | 值 |
| --- | --- |
| 任务 | E4.9i-P2-7（E4.9i 学习档案改造的最终综合回归） |
| 分支 | `feat/e49i-p2-7-profile-final-regression` |
| 开发基准 | `main@9ad642d1cd12381bbd332ff729586a55624fcf39`（PR #24 合并提交） |
| 唯一生产代码改动 | `CourseOverviewPanel.tsx`（+15 / −28） |
| 结论 | **PASS_WITH_KNOWN_LIMITATIONS**（见 §11） |

本轮不新增功能，只做三件事：修一处被审计确认的状态语义缺陷、把三个视图与课程范围的行为固化成测试、跑完整回归并封存证据。

---

## 1. 开工前核对

| 核对项 | 结果 |
| --- | --- |
| 最新 main | `9ad642d`（`Merge pull request #24 from livepass/fix/e49i-p2-6-r2-goal-edit-snapshot`） |
| 远程分支 | `git ls-remote --heads origin` 无 `feat/e49i-p2-7-*`；本地无同名分支 |
| 工作区 | 开工时干净，位于已合并的 R2 分支提交 |
| 等价实现 | 全仓搜索 `KnowledgeStateBadge`：仅 `KnowledgeRow`、`CourseLearnerPanel`、`WeakKnowledgeSection` 使用；`CourseOverviewPanel` 仍保留自有映射（T01 的缺陷本体） |
| 等价测试 | `LearnerProfilePanel.knowledge-state.test.tsx` 已覆盖视图①②；`CourseDetailPage.test.tsx` 只有来源说明测试，**没有**状态语义断言 |
| P2-7-Audit | 任务书提供的 A01–A04 与源码一致：A01 即 §2 的概览徽章缺陷（本轮修复），A02–A04 属于既有能力，本轮只补回归证据 |

---

## 2. T01：课程概览的状态语义（最高优先级）

### 2.1 缺陷

```tsx
// 修复前 CourseOverviewPanel.tsx:348
<Badge tone={isWeak(item) ? "warning" : "success"}>
  {stateLabel(item, t)}
</Badge>
```

三处错误，都是"没有报错、但说了不该说的话"：

1. `unknown` 不在 `WEAK_LABELS` 里 → `success`：把"证据不足"画成了"稳定"。
2. 缺失 `state_label` → 同样 `success`。
3. 非法值 → `STATE_LABEL_KEY[value]` 未命中时 `return state.state_label`，**把服务端原始字符串直接渲染给用户**。

### 2.2 修复前反例（真实运行）

先加测试、后改代码。在未修改的实现上运行 `CourseDetailPage.test.tsx`：

```text
Test Files  1 failed (1)
     Tests  4 failed | 18 passed (22)
```

| 用例 | 旧实现的实际值 | 期望 |
| --- | --- | --- |
| T01-1 unknown | `tone = "success"` | `neutral` |
| T01-2 缺失标签 | `tone = "success"` | `neutral` |
| T01-3 非法标签 | 徽章文本 `"brand_new_state"` | `"证据不足"`，且原文不得出现 |
| T01-4 六类状态 | `证据不足概念: tone "success"` | `neutral` |

原始输出见 `P2-7-assets/test-log.txt` §1。

三个测试都读 `.mla-badge--*` 语义类，而不是颜色或文字——因为文案本来就是对的，只有 tone 错了；
只断言文字会让这处缺陷完全隐形。

### 2.3 修复

```tsx
// CourseOverviewPanel.tsx
import { isWeakKnowledgeState } from "../knowledge-state.js";
import { KnowledgeStateBadge } from "../profile/KnowledgeStateBadge.js";

const weak = useMemo(
  () => knowledge.filter((item) => isWeakKnowledgeState(item.state_label)),
  [knowledge],
);
...
<KnowledgeStateBadge stateLabel={item.state_label} />
```

删除 `STATE_LABEL_KEY`、`stateLabel()`、`WEAK_LABELS`、`isWeak()` 四处局部实现（共 28 行），
没有删除其他业务逻辑：`weak` 计数保留，只是改读共享判定；
目标状态、复习日期、教学偏好仍用普通 `Badge`（它们不是知识状态）。

---

## 3. T02：三个视图的状态语义对照

| 编号 | 数据 | 视图①全部课程 | 视图②指定课程 | 视图③学习概况 | 结果 |
| --- | --- | --- | --- | --- | --- |
| S01 | unknown | 证据不足 / neutral | 证据不足 / neutral | 证据不足 / neutral | 通过 |
| S02 | learning | 学习中 / accent | 学习中 / accent | 学习中 / accent | 通过 |
| S03 | fragile | 不稳定 / warning | 不稳定 / warning | 不稳定 / warning | 通过 |
| S04 | review_due | 待复习 / warning | 待复习 / warning | 待复习 / warning | 通过 |
| S05 | stable | 稳定 / success | 稳定 / success | 稳定 / success | 通过 |
| S06 | misconception | 存在误区 / danger | 存在误区 / danger | 存在误区 / danger | 通过 |
| S07 | 缺失 | 证据不足 / neutral | 证据不足 / neutral | 证据不足 / neutral | 通过 |
| S08 | 非法 | 证据不足 / neutral，无泄漏 | 同左 | 同左 | 通过 |
| S09 | mastery 0.05 + stable | 稳定 | 稳定（S11/S15 覆盖 mastery 极端值） | 稳定 | 通过 |
| S10 | mastery 0.95 + unknown | 证据不足 / neutral | 同左 | 同左 | 通过 |
| S11 | mastery 0.95 + review_due | 待复习 / warning | 同左 | 同左 | 通过 |
| S12 | learning + 过期日期 | 学习中；待复习计数 0 | 同左 | 同左 | 通过 |
| S13 | review_due 无日期 | 待复习；计数 1 | 同左 | 同左 | 通过 |
| S14 | review_due 未来日期 | 待复习；计数 1；不宣称已到期 | 同左 | 同左 | 通过 |
| S15 | 英文六类 | Learning / … | Learning / … | Learning / … | 通过 |

**断言维度**（任务书 §3.3 的六条全部落到断言）：

- 视觉语义：每个状态断言 `mla-badge--{neutral|accent|warning|success|danger}`，不是只看文字。
- 归一化结果：既有 `knowledge-state` 用例与新增 tone 断言共同覆盖。
- 非法值不泄漏：`document.body.textContent` 不得包含 `brand_new_state`。
- 证据不足不得呈现为成功：S01/S07/S08 的 tone 断言。
- 掌握度独立：S09/S10/S11（0.05 配 stable、0.95 配 unknown/review_due）。
- 复习日期独立：S12/S13/S14。

**三视图一致性**还由浏览器 B04 逐概念比对：8 个概念 × 3 个真实页面，label 与 tone 完全一致。

### 3.1 新增/复用的分工

| 视图 | 既有测试 | 新增 |
| --- | --- | --- |
| ① | `LearnerProfilePanel.knowledge-state.test.tsx` T01–T16 | S09–S14（7 项中的 6 项） |
| ② | 同文件 T15/T16 | S15（英文） |
| ③ | 无 | T01-1…T01-4、T02-5（5 项） |

既有断言一条未改。详见 `P2-7-coverage-audit.md` §3。

---

## 4. T03：课程范围隔离（C01–C12）

测试数据：同一 `concept_01` 在三个范围各有一份记录：

| 字段 | 全部课程 | 课程 A | 课程 B |
| --- | --- | --- | --- |
| state_label | learning | stable | review_due |
| mastery | 0.5 | 0.9 | 0.3 |
| origin | manual | derived | legacy |
| provenance_unknown | false | false | true |
| 证据标识 | 3 | 5 | 2 |
| diagnosis | 全局诊断 | A课程诊断 | B课程诊断 |
| 目标 | 全局目标 | A 课程目标 | B 课程目标 |

| 编号 | 结果 | 关键证据 |
| --- | --- | --- |
| C01 | 通过 | 全局记录可见，A/B 名称不可见 |
| C02 | 通过 | 只显示 A；全局目标消失 |
| C03 | 通过 | A 的概念/诊断/目标全部消失；无 `稳定` 徽章 |
| C04 | 通过 | 返回全部课程后全局恢复 |
| C05 | 通过 | 课程 A 的知识行恰好 1 条；证据 5（不是 3，也不是 8） |
| C06 | 通过 | 全部：需要关注 1 / 稳定 0；A：稳定 1 / 需要关注 0；B：待复习 1 / 稳定 0 |
| C07 | 通过 | A「系统推导」；B「历史记录」+「来源不明」；切换不残留 |
| C08 | 通过 | B 显示 2，不是全局的 3 |
| C09 | 通过 | 空课程显示自己的空态，不补全局数据 |
| C10 | 通过 | 500 时只有错误文本；没有「知识掌握」区、没有 success 徽章 |
| C11 | 通过 | A 的迟到响应被丢弃，B 不被覆盖 |
| C12 | 通过 | 课程范围无「编辑」按钮、无输入控件 |

原有 3 条课程隔离测试保留并通过；本轮新增 12 条只补组合场景，不重写机制。

---

## 5. T04：正式复习资格边界（V01–V08）

### 5.1 先读源码，再定预期

```ts
// src/courses/daily-plan.ts:139-144（未修改）
function reviewable(state: KnowledgeState, asOf: number): boolean {
  if (evidenceCount(state) === 0) return false;
  if (state.origin !== "derived" || state.provenance_unknown === true) return false;
  const due = typeof state.review_due_at === "string" ? Date.parse(state.review_due_at) : Number.NaN;
  return Number.isFinite(due) && due <= asOf;
}
```

**关键结论：`state_label` 不是判定条件。** 因此"待复习"徽章既不是充分条件也不是必要条件：

- `learning` + 过期日期 + derived + 有证据 → **可以**进入正式复习；
- `review_due` + 无证据 → **不可以**。

这正是任务书"不预设 review_due 是必要条件"的答案，本轮只验证、不修改规则。

| 编号 | 条件 | 结果 |
| --- | --- | --- |
| V01 | review_due 无有效证据 | 不进入；`due_reviews` 不计数；空串/空白串同样不算 |
| V02 | 来源为 legacy/manual/缺失 | 不进入 |
| V03 | provenance_unknown = true | 不进入；false/缺失时正常放行 |
| V04 | 日期缺失 / 空串 / 非法 | 不进入 |
| V05 | 日期在未来 | 不进入；等于当前时刻算到期 |
| V06 | 满足全部条件 | 服务端返回的条目被原样使用（含 evidence_count、reason_code） |
| V07 | learning + 过期日期 | **进入**正式复习；但档案页的「待复习状态」计数仍为 0（两套口径） |
| V08 | 全部课程视图 | 计数来自 `state_label`，页面明示"不代表已通过到期复习资格核查"，不伪造全局到期数 |

实现侧证据：`daily-plan.test.ts`（真实 `buildDailyPlans`）+ `review-eligibility.test.ts`（展示层 gate）。

---

## 6. T05：编辑安全回归

全部复用既有测试，未新增、未修改、未放宽：

| 功能 | 文件（用例数） | 结果 |
| --- | --- | --- |
| 学习摘要不被刷新覆盖 | `LearnerProfilePanel.summary.test.tsx`（17） | 通过 |
| 阅读态/编辑态分离 | `KnowledgeList.test.tsx`（39）、`KnowledgeProvenance.test.tsx`（26） | 通过 |
| 筛选切换保护草稿 | `KnowledgeFilter.lifecycle.test.tsx`（32）、`KnowledgeFilter.page.test.tsx`（20） | 通过 |
| 课程范围切换保护草稿 | `KnowledgeDraftGuard.page.test.tsx`（10）、`KnowledgeDraftGuard.test.tsx`（16） | 通过 |
| 知识点消失不错误保存 | `KnowledgeList.page.test.tsx`（7） | 通过 |
| 保存失败保留草稿 | 摘要测试 + `GoalPriority.test.tsx` | 通过 |
| 来源标签用服务端值 | `KnowledgeProvenance.test.tsx`（26） | 通过 |
| 目标优先级不提交未修改 | `GoalPriority.test.tsx`（41，含 R2 S01–S18） | 通过 |
| 目标初始快照 | 同上 | 通过 |
| 异常端点 0%/100% | 同上 | 通过 |

R2 的 S01–S18 全部保留并通过。

---

## 7. T06：综合浏览器验收

脚本：`qa_p2_7.py`（新增，复用 `qa_p2_6.py` / `qa_p2_6_r1.py` / `qa_p2_6_r2.py` 的 fixture 与探针）。

### 7.1 B01–B18

| 场景 | 视口 | 结果 |
| --- | --- | --- |
| B01 全部课程 | 1440×900 | 8 行 label+tone 全部一致 |
| B02 指定课程 | 1440×900 | 同上；无编辑器挂载 |
| B03 课程详情·学习概况 | 1440×900 | 同上（这是 T01 修复的直接证据） |
| B04 三视图一致 | 1440×900 | 8 概念 × 3 视图逐项相等 |
| B05 缺失/非法状态 | 1440×900 | 三视图均「证据不足」/neutral，原始串未出现 |
| B06 相同 concept_id 切换 | 1440×900 | 全部→A→B→全部，四步无残留、无合并 |
| B07 六类筛选与计数 | 1440×900 | 稳定筛选只留 1 行；证据不足筛选 3 行；课程视图筛选独立 |
| B08 待复习 vs 正式资格 | 1440×900 | 5 行按状态展示；计数 4；提示语存在；无"符合复习资格"字样 |
| B09 草稿保护 + 范围切换 | 1440×900 | 拒绝时草稿保留、范围不变；确认后切换、编辑器卸载 |
| B10 目标编辑被动更新 | 1440×900 | 请求体 `{"priority": 0.4}`；status 保持 paused |
| B11 320 全部课程 | 320×640 | 无裁剪、无横向溢出 |
| B12 320 指定课程 | 320×640 | 同上 |
| B13 320 学习概况 | 320×640 | 同上 |
| B14 390 长名称 | 390×844 | 名称换行，行高 > 20px，无溢出 |
| B15 英文三视图 | 1440×900 | Learning / Insufficient evidence / Stable 等；无中文泄漏 |
| B16 深色主题 | 1440×900 | `data-theme=dark`；徽章与来源说明可读 |
| B17 空数据/失败/恢复 | 1440×900 | 空态文案正确；失败无 success 徽章；恢复后显示课程记录 |
| B18 快速切换与延迟响应 | 1440×900 | 迟到的 A 响应未覆盖 B |

18 个场景 `pageErrors = []`；每个场景都记录了视口、语言、主题、范围、行数据（名称/标签/tone/边界）、
页面与容器横向溢出、必要时的请求体。指标见 `P2-7-assets/browser-metrics.json`。

### 7.2 历史回归（R2 的 26 个场景）

| 组 | 数量 | 结果 |
| --- | --- | --- |
| R2-B01–B07 | 7 | 全部通过 |
| R1-R01–R08 + B01–B10 复跑 | 19 | 全部通过 |

截图写入 `P2-7-assets/regression-r2/`；P2-6、P2-6-R1、P2-6-R2 的原始证据目录未被写入
（`git status` 中无修改）。

### 7.3 已知缺陷复核（K-01）

320px 折叠态目标卡片：卡片 232px、右侧按钮组 149px、内容列 18px。与 R2 记录一致；
把 `LearnerProfilePanel.tsx` 回退到 `main` 版本后同一探针测得相同数值，确认是既有问题。
本轮只登记（`known-issues.md` K-01），未修改任何响应式代码。

### 7.4 证据边界

浏览器证据来自 `page.route` 模拟 API，证明的是"收到这份数据后如何呈现、发出什么请求"。
服务端行为由 `src/courses/daily-plan.test.ts` 与 `src/server/routes/learner.goal-priority.test.ts`
（真实 handler）单独证明。两者在报告与指标文件的 `evidenceKind` 中分开标注，不互相替代。

---

## 8. T07：测试与构建

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| T01 修复前反例 | `npx vitest run .../CourseDetailPage.test.tsx` | 4 失败 / 18 通过 |
| T01 修复后 | 同上 | 23/23 通过 |
| 三视图语义 | `LearnerProfilePanel.knowledge-state.test.tsx` | 23/23 |
| 课程隔离 | `ProfilePage.courses.test.tsx` | 15/15 |
| 复习资格 | `daily-plan.test.ts` + `review-eligibility.test.ts` | 13/13 + 8/8 |
| 编辑安全 | 见 §6 | 全通过 |
| 定向回归（23 文件） | 见 `test-log.txt` §2 | **469/469** |
| TypeScript（web） | `npx tsc --noEmit -p ...` | exit 0 |
| 完整构建 | `npm run build` | exit 0（后端 tsc + 前端 tsc + vite，44.21s） |
| 全量测试 | `npx vitest run` | **218 文件 / 2668 用例：2665 通过 / 0 失败 / 3 跳过** |
| P2-7 浏览器 | `python -X utf8 .../qa_p2_7.py` | 18/18 |
| 历史浏览器 | 同上（内置） | 26/26 |

### 8.1 与历史基准对比

| 指标 | P2-6-R2 | P2-7 |
| --- | --- | --- |
| 测试文件 | 217 | 218（+1 新建） |
| 总用例 | 2628 | 2668（+40） |
| 通过 | 2625 | 2665 |
| 失败 | 0 | 0 |
| 跳过 | 3 | 3 |
| 定向回归 | 1401/1401（101 文件） | 469/469（23 文件，本轮相关域） |
| 浏览器 | 26/26 | 18 + 26 = 44/44 |
| TypeScript | PASS | PASS |
| 完整构建 | PASS | PASS |

新增 40 项构成：概览 5 + 三视图 7 + 隔离 12 + 资格 8 + 展示层 gate 8。

**历史 `server.e48-workbench.test.ts` 偶发失败**：本轮全量干净运行未复现，单独运行 9/9。
不声称根因已解决（见 `known-issues.md` K-03）。

浏览器与全量测试串行执行，未并行。

---

## 9. 冻结范围核查

`git diff --numstat`（相对 `main@9ad642d`）：

```text
CourseOverviewPanel.tsx                       +15  -28   ← 唯一生产代码
CourseDetailPage.test.tsx                    +119   -2
LearnerProfilePanel.knowledge-state.test.tsx +115   -2
ProfilePage.courses.test.tsx                 +290   -1
daily-plan.test.ts                            +90   -0
web/src/utils/review-eligibility.test.ts      新文件（测试）
```

| 冻结项 | 结论 |
| --- | --- |
| 知识状态引擎 | 无 diff（只读取 `knowledge-state.ts`） |
| 学习记忆 / 证据生成与重放 | 无 diff |
| 数据库与数据结构 | 无 diff |
| 服务端 API 业务规则 | 无 diff（`src/server/**` 非测试文件未改） |
| 掌握度 / 置信度 / 稳定性 | 无 diff |
| 正式复习资格 | 无 diff（`daily-plan.ts` 未改） |
| 六类筛选规则 | 无 diff |
| `KnowledgeDraftGuard` | 无 diff |
| P2-5 响应式布局 | 无 diff |
| P2-6-R1 可信度语义 | 无 diff |
| P2-6-R2 编辑快照 | 无 diff |

唯一的生产改动就是任务书 §9 预先授权的那一处：课程概览复用统一状态展示，并删除因复用而失效的局部映射。

---

## 10. 门禁结果

| 门禁 | 条件 | 结果 | 依据 |
| --- | --- | --- | --- |
| G01 原始规划 | 所有 P2-7 要求有可追踪证据 | **PASS** | `P2-7-coverage-audit.md` |
| G02 缺陷复现 | 概览原有语义缺陷可复现 | **PASS** | 4 项失败，断言 tone 与原始串（§2.2） |
| G03 跨视图语义 | 三视图标签与语义一致 | **PASS** | T02 表 + B04 逐概念比对 |
| G04 课程隔离 | 相同知识点不跨课程污染 | **PASS** | C01–C12 + B06/B18 |
| G05 正式复习边界 | 不以展示状态替代正式资格 | **PASS** | V01–V08 + B08 |
| G06 编辑安全 | R1、R2 及历史草稿保护通过 | **PASS** | §6，GoalPriority 41/41 |
| G07 响应式回归 | 无新增裁剪及横向溢出 | **PASS** | B11–B14/B16，`overflowsHorizontally=false` |
| G08 浏览器 | 综合场景及历史回归通过 | **PASS** | 18 + 26 |
| G09 构建 | 类型检查与完整构建通过 | **PASS** | tsc exit 0；build exit 0 |
| G10 全量测试 | 无新增稳定失败 | **PASS** | 2668 / 2665 通过 / 0 失败 / 3 跳过 |
| G11 冻结范围 | 无越权修改 | **PASS** | §9 的 6 个文件 |
| G12 证据完整 | 日志、截图、指标、报告完整 | **PASS** | §12 |
| G13 已知缺陷 | 如实登记，不隐藏不夸大 | **PASS** | K-01、K-02、K-03 |

---

## 11. 结论

**PASS_WITH_KNOWN_LIMITATIONS**

理由：

- 13 项门禁全部通过；唯一生产改动在授权范围内。
- 三个视图现在共用一套状态语义；概览此前把「证据不足」画成成功的缺陷已修复，并有修复前后的失败/通过记录。
- 课程隔离、正式复习边界、编辑安全都有独立证据，且没有修改任何被冻结的规则。
- 仍存在的限制均已登记且不影响本轮核心功能：
  - **K-01** 320px 折叠态目标卡片内容列 18px（既有，非本轮引入，冻结范围内不修）；
  - **K-02** 客户端复习 gate 与服务端 `reviewable()` 是两份实现（本轮用 8 项测试固定一致性，未重构）；
  - **K-03** 历史偶发失败未复现，不声称已解决。
- 因此不给纯 `PASS`：已知缺陷确实存在，只是不在本轮授权内。

---

## 12. 交付物

```text
docs/ui-redesign/phase5/
├── P2-7-coverage-audit.md          要求 → 实现 → 测试 → 缺口 → 新增 → 结果
├── P2-7-acceptance.md              本报告
├── P2-7-pr-body.md                 PR 描述
├── E4.9i-final-acceptance.md       阶段总结（合并前标记"待最终封存"）
├── P2-7-assets/
│   ├── browser-metrics.json        18 个 P2-7 场景 + 26 个复跑 + K-01 实测
│   ├── test-log.txt                修复前/后、定向、构建、全量的真实输出
│   ├── known-issues.md             K-01 / K-02 / K-03 / L-01 / L-02
│   ├── known-issue-320-goal-card.png
│   ├── screenshots/                24 张 P2-7 截图
│   └── regression-r2/              26 个 R2/R1 复跑截图（30 张）
└── scripts/
    └── qa_p2_7.py                  B01–B18 + 26 复跑 + K-01 实测
```

---

## 13. 提交、推送与 PR

| 项 | 值 |
| --- | --- |
| 分支 | `feat/e49i-p2-7-profile-final-regression` |
| 功能提交 | `da36028`（`fix(profile): E4.9i-P2-7 课程概览复用统一状态语义并完成综合回归`） |
| 推送 | 已推送至 origin；`git ls-remote --heads origin` 可读到该分支 |
| 开发基准 | `main@9ad642d1cd12381bbd332ff729586a55624fcf39` |

**PR 状态（如实说明）：** 本环境的 GitHub CLI 未登录（`gh auth status` 为未登录，且无 `GH_TOKEN`），
`gh pr create` 直接返回"请先登录"，因此**未能通过命令行创建 PR**。分支已推送，PR 描述已写入
`P2-7-pr-body.md`，可用以下 compare 页面创建：

```text
https://github.com/livepass/My-Learning-Agent/compare/main...feat/e49i-p2-7-profile-final-regression
```

创建时把 `P2-7-pr-body.md` 作为描述即可。未开启自动合并，未直接修改 main。
本文件后续的文档修订会产生新提交，最终 HEAD 以 `git log -1` 为准。
