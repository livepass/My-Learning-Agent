# E4.9i-P2-7 覆盖度审查

**审查对象：** P2-7 任务书 §2–§8 的每一条要求，是否已有实现、已有测试、缺口与新增测试。
**结论：** 18 项要求全部可追踪；新增 40 项测试，全部复用既有 fixture 与页面组件，**没有一处为了"看起来覆盖"而重复断言**。

---

## 1. 总表

| 要求 | 已有实现 | 已有测试 | 缺口 | 本轮新增 | 结果 |
| --- | --- | --- | --- | --- | --- |
| T01 课程概览状态语义 | `CourseOverviewPanel` 自有映射 | 无（既有概览测试只验证来源说明） | 三处语义错误未覆盖 | 5 项（CourseDetailPage） | 修复并验证 |
| T02 三视图状态对照 | 两个视图已用 `KnowledgeStateBadge` | `LearnerProfilePanel.knowledge-state.test.tsx` 16 项 | 概览视图；掌握度/复习日期独立性；英文课程视图 | 7 + 5 项 | 通过 |
| T03 课程范围隔离 | `coursesStore` ticket + `courseScope` 过滤 | `ProfilePage.courses.test.tsx` 3 项；`KnowledgeList/Filter/Provenance` 专项 | 相同 concept_id、计数、来源、空/失败/延迟、只读 | 12 项（C01–C12） | 通过 |
| T04 正式复习资格边界 | `reviewable()`（服务端）+ `isActionableReviewDue`（展示） | `daily-plan.test.ts` 5 项 | 来源不明、非法日期、未来日期、状态非必要条件、`due_reviews` 口径 | 8 + 8 项 | 通过 |
| T05 编辑安全回归 | P2-1–P2-6 已交付 | 摘要 17、DraftGuard 26、筛选 52、列表 46、目标 41、来源 75… | 无新增缺口，按原断言复跑 | 0（复用） | 通过 |
| T06 综合浏览器验收 | `qa_p2_6*.py` 的 fixture 与探针 | P2-6-R2 的 26 个场景 | 三视图、隔离、资格、草稿、响应式组合 | `qa_p2_7.py` 18 场景 + 26 复跑 | 通过 |
| T07 测试与构建 | 既有脚本 | — | 串行执行与数字记录 | 见验收报告 §6 | 通过 |

---

## 2. T01：课程概览的状态语义

### 2.1 原始要求 → 实现 → 测试

| 原始要求 | 修复前实现 | 缺口 | 新增测试 |
| --- | --- | --- | --- |
| unknown 不得使用成功语义 | `isWeak(unknown) === false` → `tone="success"` | 无测试读取徽章语义类 | `T01-1` 断言 `neutral` |
| 缺失状态安全降级 | `!state_label` → 文案「证据不足」，但 tone 仍是 success | 文案对了、语义错了，没有测试能发现 | `T01-2` |
| 非法状态安全降级 | `STATE_LABEL_KEY[value]` 未命中 → **返回原始字符串** | 直接把 `brand_new_state` 渲染给用户 | `T01-3` 同时断言"不泄漏" |
| 六类状态一致 | 六类文案键与共享模块相同 | 只有 tone 不一致 | `T01-4` 逐项断言 label + tone |
| 复用 `KnowledgeStateBadge` | 未复用 | 三处重复映射 | 生产代码改为共享组件 |

### 2.2 为什么必须先写测试

缺陷是"语义错误"而不是"文字错误"：`unknown` 的文案本来就是「证据不足」，只断言文字会通过。
因此 4 项测试都读取 `.mla-badge--success / --warning / --danger / --accent` 修饰类，把"颜色语义"变成可断言的事实。
修复前实测：4 项全部失败（§2.3），修复后全部通过。

### 2.3 覆盖边界

- 概览之外的 `weak` 计数（"需要关注的知识点"）也改读 `isWeakKnowledgeState`：这是同一处缺陷的另一半，
  若只改徽章，计数仍会把 unknown 当作"正常"。测试 `T01-4` 的 tone 断言与 B03 的 8 行数据共同覆盖。
- 没有删除 `Badge` 的其他用途（目标状态、复习日期、教学偏好仍是普通徽章）。

---

## 3. T02：三视图状态矩阵（S01–S15）

视图编号与任务书一致：① 全部课程 ② 指定课程 ③ 课程详情·学习概况。

### 3.1 逐格核对（只写真实存在的断言）

| 编号 | ① 全部课程 | ② 指定课程 | ③ 学习概况 | 补充证据 |
| --- | --- | --- | --- | --- |
| S01 unknown | T01（六类）、T16（tone） | T16 | T01-1、T01-4 | B04 三视图逐概念相等 |
| S02 learning | T01 | T15 | T01-4 | B04 |
| S03 fragile | T01 | **无单元用例** → B02/B04 | T01-4 | B02 断言「不稳定 / warning」 |
| S04 review_due | T01 | T15 | T01-4 | B04 |
| S05 stable | T01 | S15（Cloze → Stable） | T01-4 | B04 |
| S06 misconception | T01 | **无单元用例** → B02/B04 | T01-4 | B02 断言「存在误区 / danger」 |
| S07 缺失 | T05 | T16（无标签） | T01-2 | B05 |
| S08 非法 | T06 | **单元仅覆盖 unknown/缺失** → B05 | T01-3 | B05 断言原文不出现 |
| S09 mastery 0.05 + stable | S09（0.05） | S15（stable，mastery 0.5） | T01-4（stable，0.5） | 见 §3.2 说明 |
| S10 mastery 0.95 + unknown | S10（0.95） | T16（unknown，0.9） | T01-1（unknown，0.9） | 见 §3.2 说明 |
| S11 mastery 0.95 + review_due | S11（0.95） | T15（review_due，0.85） | T01-4（review_due，0.5） | 见 §3.2 说明 |
| S12 learning + 过期日期 | S12（徽章 + 计数 0） | 组件不读日期；B04 覆盖 learning 行 | 同左 | — |
| S13 review_due 无日期 | S13（徽章 + 计数 1） | 标签见 T15；无日期不改变任何分支 | 标签见 T01-4 | — |
| S14 review_due 未来日期 | S14（徽章 + 计数 1 + 提示语） | 组件不读日期 | 同左 | B08 的提示语断言 |
| S15 英文六类 | T12（2 类）+ B15（8 行） | S15（3 类）+ B15 | T02-5（3 类）+ B15 | B15 断言无中文泄漏 |

### 3.2 矩阵读法（为什么有些格子只有浏览器证据）

1. **视图②的单元测试只有 5 类状态。** `CourseLearnerPanel` 的既有用例 T15 覆盖 learning / review_due，
   T16 覆盖 unknown / 缺失，新增 S15 覆盖 learning / unknown / stable。**fragile、misconception、非法值
   在这三个组件测试里没有出现**，因此上一版报告把 S03 记作"既有 T15（review_due）"是错的；
   它们的真实覆盖来自浏览器 B02（课程视图 8 行逐项断言 label + tone）与 B04（三视图逐概念比对），
   B05 覆盖非法值与缺失值的降级。本轮据此更正，不补写重复的单元断言。

2. **非法值（S08）在视图②没有单元用例。** T16 的第二个概念是"缺失标签"，不是非法字符串。
   视图②的非法值由 B05 覆盖（三视图同时断言「证据不足」且 `brand_new_state` 不出现）。

3. **S09–S11 的 mastery 变体只在视图①重复取值。** 三个视图共用同一个 `KnowledgeStateBadge`，
   徽章只接收 `state_label`；在②③再写 0.05/0.95 的副本不会增加任何证据。②③已用"不同 mastery、
   同一状态"的行（stable 0.5 / unknown 0.9 / review_due 0.5–0.85）证明状态不随 mastery 变化。

4. **S12–S14 是视图①独有的计数/提示语义。** 视图②③不渲染「待复习状态」计数，也不读
   `review_due_at`（组件只把 `state_label` 传给徽章），所以"日期独立性"在②③的表现就是"完全不受影响"；
   它们的状态行由 B04/B08 覆盖。把这三条记成"三视图都断言"会夸大证据。

**复用说明：** 既有 T01–T16 的断言一条未改、一条未删；新增用例只补"尚未被断言的维度"
（tone、掌握度独立性、英文课程视图、未来日期、概览视图本身）。

---

## 4. T03：课程隔离（C01–C12）

| 编号 | 场景 | 断言位置 | 关键断言 |
| --- | --- | --- | --- |
| C01 | 打开全部课程 | `ProfilePage.courses.test.tsx` | 全局目标与概念可见，两个课程的名称不可见 |
| C02 | 全部 → A | 同上 | 只显示 A 的诊断；全局目标消失 |
| C03 | A → B | 同上 | A 的概念/诊断/目标全部消失；无「稳定」徽章 |
| C04 | B → 全部 | 同上 | 全局恢复，B 消失 |
| C05 | 相同 concept_id | 同上 | `.mla-course-knowledge-row` 恰好 1 行；证据 5，不是 3 或 8 |
| C06 | 筛选计数 | 同上 | 全部：需要关注 1 / 稳定 0；A：稳定 1 / 需要关注 0；B：待复习 1 / 稳定 0 |
| C07 | 来源标签 | 同上 | A「系统推导」、B「历史记录」+「来源不明」；切换后不残留 |
| C08 | 证据数量 | 同上 | B 显示 2，不是全局的 3 |
| C09 | 课程为空 | 同上 | 课程空态文案；不展示全局记录 |
| C10 | 读取失败 | 同上 | 只有错误文本；无「知识掌握」区；无 success 徽章 |
| C11 | 快速切换 + 延迟响应 | 同上 | A 的迟到响应被丢弃，B 不被覆盖 |
| C12 | 只读 | 同上 | 课程范围内无「编辑」按钮、无 textarea/input |

**与既有测试的关系：** 原文件 3 条课程隔离测试原样保留（C02/C04 是它们的加强版，但既有断言未被替换）。
`KnowledgeList.page.test.tsx`、`KnowledgeFilter.page.test.tsx`、`KnowledgeProvenance.lifecycle.test.tsx`、`courses-store.test.ts`
继续作为底层机制的证据，本轮未改一行。

---

## 5. T04：正式复习资格边界（V01–V08）

先读源码确定规则，再写测试（任务书禁止预设 `review_due` 是必要条件）：

```ts
// src/courses/daily-plan.ts:139-144
function reviewable(state, asOf) {
  if (evidenceCount(state) === 0) return false;
  if (state.origin !== "derived" || state.provenance_unknown === true) return false;
  const due = Date.parse(state.review_due_at);
  return Number.isFinite(due) && due <= asOf;
}
```

`state_label` 不在判定中——这既是任务书要求"由源码确定"的答案，也是 V07/V08 的依据。

| 编号 | 断言位置 | 结果 |
| --- | --- | --- |
| V01 无有效证据 | `daily-plan.test.ts` + `review-eligibility.test.ts` | 不进复习槽；`due_reviews` 不计数 |
| V02 来源不满足 | 同上 | legacy/manual/缺失 origin 均拒绝 |
| V03 provenance_unknown | 同上 | `true` 拒绝；`false`/缺失放行 |
| V04 日期缺失/非法 | 同上 | 拒绝 |
| V05 日期在未来 | 同上 | 拒绝；等于当前时刻算到期 |
| V06 满足全部条件 | 同上 | 服务端返回的条目被原样使用（concept_id、evidence_count、reason_code） |
| V07 learning + 过期 | `daily-plan.test.ts` | **可以**进入复习（规则不含 state_label）；面板计数仍算学习中 |
| V08 不伪造全局数量 | `daily-plan.test.ts` + 面板 S14 | `due_reviews` 按规则计数，不按徽章数 |

**明确未做：** 没有修改 `reviewable()`，没有让展示层参与资格判定，没有新增"复习资格"字段。

---

## 6. T05：编辑安全（复用清单）

| 功能 | 证据文件 | 本轮动作 |
| --- | --- | --- |
| 学习摘要不被刷新覆盖 | `LearnerProfilePanel.summary.test.tsx`（17） | 复跑 |
| 阅读态/编辑态分离 | `KnowledgeList.test.tsx`（39）、`KnowledgeProvenance.test.tsx`（26） | 复跑 |
| 筛选切换保护草稿 | `KnowledgeFilter.lifecycle.test.tsx`（32）、`KnowledgeFilter.page.test.tsx`（20） | 复跑 |
| 课程范围切换保护草稿 | `KnowledgeDraftGuard.page.test.tsx`（10）、`KnowledgeDraftGuard.test.tsx`（16） | 复跑 + B09 |
| 知识点消失不允许错误保存 | `KnowledgeList.page.test.tsx`（7） | 复跑 |
| 保存失败保留草稿 | 摘要测试 + GoalPriority | 复跑 |
| 来源标签用服务端返回值 | `KnowledgeProvenance.test.tsx`（26） | 复跑 |
| 目标优先级不提交未修改 | `GoalPriority.test.tsx`（41，含 R2 S01–S18） | 复跑 |
| 目标初始快照 | 同上 | 复跑 |
| 异常端点 0%/100% | 同上 | 复跑 |

**没有**新增编辑安全测试：这些行为在 P2-1–P2-6 已逐条断言，重复编写只会制造两套会漂移的期望。

---

## 7. T06：浏览器验收（B01–B18 + 26 复跑）

| 场景 | 覆盖要求 | 结果 |
| --- | --- | --- |
| B01–B03 | 三视图基础渲染、徽章、只读 | 通过 |
| B04 | 同一 concept 在三视图的 label+tone 完全一致 | 通过（8 概念 × 3 视图） |
| B05 | 缺失/非法状态在三视图均降级且不泄漏原始串 | 通过 |
| B06 | 同一 concept_id 在全部/A/B 间切换不合并 | 通过 |
| B07 | 六类筛选 + 范围独立计数 | 通过 |
| B08 | 待复习徽章 ≠ 正式复习资格；计数与提示 | 通过（5 行，计数 4） |
| B09 | 草稿保护 + 范围切换（拒绝/接受两条路径） | 通过 |
| B10 | 目标编辑期间被动更新，只提交 priority | 通过 |
| B11–B13 | 320px 三视图无裁剪/溢出 | 通过 |
| B14 | 390px 长知识点名称 | 通过 |
| B15 | 英文三视图一致、无中文泄漏 | 通过 |
| B16 | 深色主题徽章与来源说明 | 通过 |
| B17 | 空数据、读取失败、恢复 | 通过 |
| B18 | 快速切换 + 延迟响应 | 通过 |
| K-01 | 320px 折叠态目标卡片登记 | 记录（232/149/18） |
| R2 复跑 | 7 个 R2 + 19 个 R1 | 26/26 通过 |

**未做的取巧：** 没有合并场景来减少断言；B04/B05/B15 明确跨三个真实页面，各自保留独立结果。

---

## 8. 新增 vs 复用（文件级）

### 8.1 新增测试

| 文件 | 项数 | 原因 |
| --- | --- | --- |
| `CourseDetailPage.test.tsx`（扩展） | +5 | 概览视图此前没有任何状态语义断言 |
| `LearnerProfilePanel.knowledge-state.test.tsx`（扩展） | +7 | 掌握度/复习日期独立性、英文课程视图 |
| `ProfilePage.courses.test.tsx`（扩展） | +12 | 相同 concept_id、计数、来源、失败、延迟、只读 |
| `daily-plan.test.ts`（扩展） | +8 | `reviewable()` 的五个边界与"状态非必要条件" |
| `web/src/utils/review-eligibility.test.ts`（新建） | 8 | 展示层 gate 此前无任何测试 |

合计 **+40**；全量 2628 → 2668。

### 8.2 复用（未改一行）

`KnowledgeDraftGuard*`、`KnowledgeFilter*`、`KnowledgeList*`、`KnowledgeProvenance*`、
`GoalPriority.test.tsx`、`LearnerProfilePanel.summary.test.tsx`、`profile-overview.test.ts`、
`WeakKnowledgeSection.test.tsx`、`courses-store.test.ts`、`server/routes/learner.goal-priority.test.ts`。

---

## 9. 未覆盖项（明确声明）

| 项 | 原因 |
| --- | --- |
| 真实服务端下的三视图一致性 | 三视图的数据都来自同一个 `GET .../learner` 或 profile 读；服务端过滤已由既有 route 测试覆盖。本轮浏览器证据明确标注为模拟 API |
| 正式复习入口的端到端点击 | 该入口属于今日学习页，规则由 `server.review-loop.test.ts` 与 `daily-plan.test.ts` 覆盖；本轮只验证"展示状态不冒充资格" |
| 320px 折叠态目标卡片的修复 | 冻结范围禁止修改 P2-5 响应式机制；登记为 K-01 |
| 多客户端并发写冲突 | P2-6-R2 已声明不解决；本轮不重复 |

---

## 10. 结论

- 任务书 §2–§8 的每一条都能落到具体文件与用例，没有"仅有描述、没有证据"的条目。
- 新增 40 项全部指向此前**未被断言**的行为；没有重写既有期望，也没有放宽任何断言。
- 生产代码只改 `CourseOverviewPanel.tsx`（+15/−28），与冻结范围一致。
