## E4.9i-P2-7｜学习档案跨视图语义统一与综合回归验收

**基准：** `main@9ad642d1cd12381bbd332ff729586a55624fcf39`（PR #24 合并提交）
**分支：** `feat/e49i-p2-7-profile-final-regression`
**验收报告：** `docs/ui-redesign/phase5/P2-7-acceptance.md`
**覆盖度审查：** `docs/ui-redesign/phase5/P2-7-coverage-audit.md`
**阶段总结：** `docs/ui-redesign/phase5/E4.9i-final-acceptance.md`（合并前标记「待最终封存」）
**证据：** `P2-7-assets/browser-metrics.json`、`test-log.txt`、`known-issues.md`、`screenshots/`、`regression-r2/`

本轮是 E4.9i 的最终综合回归，不新增功能。生产代码只改一处：课程详情·学习概况复用统一知识状态展示。

### T01 课程概览的状态语义（唯一生产修复）

修复前：

```tsx
<Badge tone={isWeak(item) ? "warning" : "success"}>{stateLabel(item, t)}</Badge>
```

三处语义错误：

| 数据 | 旧表现 | 应有表现 |
| --- | --- | --- |
| `unknown` | 文案「证据不足」+ **success** 语气 | neutral |
| 缺失 `state_label` | 同上 | neutral |
| 非法值 | **渲染服务端原始字符串** | 「证据不足」 |

修复：改用 `<KnowledgeStateBadge stateLabel={item.state_label} />`，`weak` 计数改读 `isWeakKnowledgeState`，
删除 `STATE_LABEL_KEY` / `stateLabel()` / `WEAK_LABELS` / `isWeak()`（−28 行）。
未触碰目标状态、复习日期、教学偏好使用的普通 `Badge`。

### 先复现再修

在旧实现上先写测试：

```text
Test Files  1 failed (1)
     Tests  4 failed | 18 passed (22)
T01-1 expected 'success' to be 'neutral'
T01-2 expected 'success' to be 'neutral'
T01-3 expected 'brand_new_state' to be '证据不足'
T01-4 证据不足概念: expected 'success' to be 'neutral'
```

断言的是 `.mla-badge--*` 语义类，不是文字——文案本来就是对的，只断言文字发现不了这个缺陷。

### T02 三视图状态矩阵（S01–S15）

全部课程 / 指定课程 / 学习概况三处逐项一致：六类状态、缺失、非法、掌握度独立性、复习日期独立性、英文环境。
新增 7 项（`LearnerProfilePanel.knowledge-state.test.tsx`）+ 5 项（`CourseDetailPage.test.tsx`）；
既有 16 项断言一条未改。浏览器 B04 用 8 概念 × 3 真实页面逐项比对 label 与 tone。

### T03 课程隔离（C01–C12）

同一 `concept_id` 在全部课程 / 课程 A / 课程 B 各一份记录（state、mastery、origin、provenance、证据数、诊断均不同）：
切换不残留、不合并、不补全局值；空课程、读取失败、快速切换 + 延迟响应、只读均有断言。
新增 12 项，原 3 条隔离测试保留。

### T04 正式复习资格边界（V01–V08）

先读 `courses/daily-plan.ts:140` 的 `reviewable()` 再写测试。**`state_label` 不是判定条件**：

- `learning` + 过期日期 + derived + 有证据 → **可以**进入正式复习；
- `review_due` + 无证据 → **不可以**。

新增 8 项服务端规则测试 + 8 项展示层 gate 测试（`review-eligibility.test.ts` 为新建文件）。
未修改规则；客户端 gate 与服务端规则是两份实现，已登记为 K-02。

### T05 编辑安全

复用 P2-1–P2-6 的既有测试，未新增、未放宽：摘要 17、DraftGuard 26、筛选 52、列表 46、来源 75、目标 41（含 R2 S01–S18）。
全部通过。

### T06 浏览器验收

`qa_p2_7.py`：B01–B18（三视图、一致性、隔离、筛选、资格、草稿保护、目标被动更新、320/390/英文/深色、空/失败/恢复、延迟响应），
每个场景记录视口、语言、主题、范围、行数据（名称/标签/tone/边界）、页面与容器溢出、pageErrors。

18/18 通过，`pageErrors = []`，无横向溢出。
另复跑 P2-6-R2 的 26 个场景（7 个 R2 + 19 个 R1），26/26 通过，截图写入 `regression-r2/`，历史资产未覆盖。

### 测试与构建

| 验证 | 结果 |
| --- | --- |
| 定向回归（23 文件） | 469/469 |
| `tsc --noEmit`（web） | exit 0 |
| `npm run build` | exit 0（44.21s） |
| 全量测试 | **218 文件 / 2668 用例：2665 通过 / 0 失败 / 3 跳过** |
| 浏览器 | 18 + 26 = 44/44 |

新增 40 项（5 + 7 + 12 + 8 + 8），全量 2628 → 2668。
历史 `server.e48-workbench.test.ts` 偶发失败本轮未复现，单独运行 9/9，**不声称已修复**。

### 冻结范围

```text
CourseOverviewPanel.tsx    +15  -28   ← 唯一生产代码
5 个测试文件 + 1 个新测试文件
```

知识状态引擎、记忆、证据、数据库、服务端规则、掌握度/置信度/稳定性、正式复习资格、六类筛选、DraftGuard、
P2-5 响应式、P2-6-R1 语义、P2-6-R2 快照：**均无 diff**。

### 已知限制（不影响本轮核心功能）

- **K-01** 320px 折叠态目标卡片内容列 18px（既有问题，main 上同样存在，冻结范围内不修，已登记并附实测与截图）。
- **K-02** 客户端 `isActionableReviewDue` 镜像服务端 `reviewable()`，存在漂移风险（本轮用 8 项测试固定一致性，未重构）。
- **K-03** 历史偶发失败未复现，不声称根因已解决。

### 结论

**PASS_WITH_KNOWN_LIMITATIONS**（G01–G13 全部通过；限制均已登记且不影响本轮功能）

未自动合并，未直接修改 main。
