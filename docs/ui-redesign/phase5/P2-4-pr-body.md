## E4.9i-P2-4｜六类知识状态筛选器

**基准：** `main@c153d694c56b7ac23cb027cf322205ed09b370ba`（PR #18 合并提交）
**验收报告：** `docs/ui-redesign/phase5/P2-4-acceptance.md`
**截图与指标：** `docs/ui-redesign/phase5/P2-4-assets/`

### 目标

在「我的学习档案 → 知识状态」实现 全部 / 需要关注 / 待复习 / 存在误区 / 稳定 / 证据不足 六类筛选，全部课程与指定课程语义一致，且切换筛选不丢草稿、不改业务数据。

### 改动

| 文件 | 内容 |
| --- | --- |
| `react/profile/knowledge-filter.ts` | 纯函数 `filterKnowledgeStates()` / `countKnowledgeFilters()`，六类定义与默认值 |
| `react/profile/profile-overview.ts` | 抽出 `tallyKnowledgeStates()`，概览与筛选计数共用一次统计 |
| `react/profile/KnowledgeStateFilters.tsx` | 受控筛选行（原生 button + `aria-pressed` + 命名 group） |
| `react/LearnerProfilePanel.tsx` | 接入筛选，切换前经 `KnowledgeDraftGuard.confirmLeave()` |
| `react/courses/CourseLearnerPanel.tsx` | 复用同一纯函数与组件，保持只读，课程切换重置 |
| `i18n/locales/{zh-CN,en}.json` | `profile.knowledge.filters.*`（9 键 × 2） |
| 4 个测试文件 | 新增 45 项用例 |

### 规则边界

- 归属只由标签决定：`needs_attention` = `isWeakKnowledgeState()`，其余 = `normalizeKnowledgeStateLabel()`。
- **不**用 `mastery` / `confidence` 分类；**不**用 `review_due_at` 判定待复习；**不**把误区记录数当知识点数。
- 计数基于当前范围完整列表，选任一筛选都不改变其它计数。
- 保持服务端顺序，不排序、不排名。
- 筛选是纯视图：不请求数据、不写服务端、不重算概览结论、不影响需要关注卡片。

### 草稿保护

| 情形 | 行为 |
| --- | --- |
| 无草稿 | 直接切换 |
| 有草稿 | 确认一次（多行草稿也只确认一次） |
| 拒绝 | 筛选、编辑器、草稿全部保留 |
| 保存中 | 拒绝切换，不弹确认框 |
| 重复点击当前筛选 | 不确认、不改变 |

原有行折叠 / 区块折叠 / 课程切换保护未改动。

### 课程范围

- 全部课程：`learnerStore.profile.knowledge_states`，可编辑。
- 指定课程：服务端返回的课程列表，只读，不推断其它课程数据。
- 切换课程成功 → 筛选恢复「全部」；取消切换 → 原范围、筛选、草稿均保留。

### 测试

- 定向：14 文件 / **217 项全部通过**（新增 45 项：14 纯函数 + 11 组件 + 20 页面/草稿）。
- `tsc`、web 构建、完整构建：通过。
- 全量 `npx vitest run`：**2456 通过 / 1 失败 / 3 跳过**（P2-3-R1 为 2377 / 1 / 3，+79 通过，失败与跳过不变）。
- 唯一失败仍是 `server.e48-workbench.test.ts` 既有失败；`apps/learning-agent/src` 0 行改动。

三处既有断言收窄了查找范围（徽章、`.mla-fact`），因为筛选行会渲染同名文字；断言意图未变、未放宽。

### 浏览器验收

`docs/ui-redesign/phase5/scripts/qa_p2_4.py`，隔离 Vite + `page.route` 受控 fixture，19 个场景全部通过，无 JS 错误：

- 六类逐项切换（7/2/1/3/2/12），每步计数恒定；
- 无匹配提示、零数量可选；
- 取消切换（1 次 confirm，草稿保留）、确认切换、保存中切换（0 次 confirm）；
- 指定课程筛选与课程切换重置；
- 1440 / 1024 / 768 / 390 / 320、深色、英文、Tab+Space。

筛选行在全部场景 `filterOverflow = []`、页面无横向滚动。

### 已知问题（不在本阶段范围）

- 旧知识行在 390 / 320px 的固定列挤压仍在（P2-5 范围），`rowOverflow` 已单独记录，不能据此判定已修复。
- `server.learning-generate.test.ts` 偶发本轮未复现，根因未确认。

## E4.9i-P2-4-R1 修正（审查反馈）

审查基准 `d1af978`，在同一分支、同一 PR 内修复，未新建 PR。

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| F01 | 服务端刷新把知识点移出当前筛选时，行被卸载、草稿丢失 | Guard 通过 `useSyncExternalStore` 暴露「打开中的编辑器」集合；容器渲染 `matched ∪ protected`，每个 id 只出现一次，受保护行追加在末尾且不计入筛选计数 |
| F02 | G09 未验证真实异步保存 | 用可控 Promise 挂起 PATCH，断言编辑器保持挂载 → 返回 stable → 行移出筛选、计数更新、写请求恰好 1 次 |
| F03 | 切换后仍匹配的草稿行为未定义 | 确认切换只丢弃被隐藏的行；仍匹配的草稿保留；多草稿混合只丢不匹配项；取消保留全部 |
| F04 | 完全空档案行为未明确 | 空档案隐藏筛选器并显示档案空状态；`knowledge.length === 0` 的提前返回不再绕过打开的编辑器 |
| F05 | 测试数量差异未解释 | `P2-4-test-count-audit.md`：收集增量 49 全部来自 3 个新文件；报告原「45」少算 4 项，原「2456/2460」与日志不符（真实 2426/2430），均已更正 |

### 编辑生命周期设计

- 注册改为**每次挂载一次**，注册对象为稳定可变引用；注销时校验身份，避免旧清理误删新注册。
- 保护只针对**被动**变化；学习者确认过的主动切换会把被隐藏的行标记为 discarded，照旧关闭。
- 记录从最新档案消失时，用最后一次快照渲染并显示专用提示，不计入任何计数、不重建、不覆盖。

### 测试

- 新增 `KnowledgeFilter.lifecycle.test.tsx` **23 项**；其中 **9 项在改前代码上失败**，确认覆盖真实缺陷。
- 定向 15 文件 / **240 项**通过。
- 全量 `npx vitest run`：**2453 收集 / 2449 通过 / 1 失败 / 3 跳过**，唯一失败仍为 `server.e48-workbench.test.ts` 历史失败。
- 浏览器：脚本保留原 19 个场景（全部通过），新增 10 个 R1 场景写入 `r1-browser-metrics.json`；P2-4 原始截图未覆盖。
- 验收报告新增第 11–22 章；测试数量审计单独成文。

**R1 结论：`P2-4-R1 PASS_WITH_KNOWN_BASELINE_FAILURE`。**

## E4.9i-P2-4-R2 修正（审查反馈）

审查基准 `9d38adc`。同一分支继续修复，未新建分支、未强制推送。

### 与 PR #19 / #20 的真实关系（更正任务书假设）

任务书给出的当前 main 为 `1f49aa7`（PR #19），并说明「R1 尚未合并」。开工核对时远程实际状态不同：

| 项 | 任务书假设 | 实际核实 |
| --- | --- | --- |
| 当前 main | `1f49aa7` | **`d474343`** = `Merge pull request #20` |
| R1 是否已合并 | 尚未合并 | **已合并**：`4d6f0b8`、`9d38adc` 已是 main 祖先 |
| 本分支 HEAD | — | `9d38adc`，`git merge-base --is-ancestor HEAD origin/main` 成立 |

因此 **R1 已随 PR #20 合并**，本 PR（R2）只包含尚未合并的 R2 提交。未重开或重复合并 PR #19，历史基准未改写。

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| F06 | 已消失知识点仍允许保存 | 双重保护：`KnowledgeEditPanel` 新增 `saveDisabled`（按钮 `disabled` + `submit()` 提前返回）；`KnowledgeRow.save()` 自身再拦一次，不依赖按钮属性 |
| F07 | G09 未验证实际保存内容 | 断言 PATCH 载荷含草稿诊断；切至稳定后展开行，确认阅读态显示**保存后的诊断**、无输入控件、写请求仍为 1 次 |
| F08 | 验收报告与远程 PR 状态不同步 | 本表与验收报告新增第 23–33 章，如实记录 PR #19/#20 已合并、R2 为本轮未合并内容 |

### F06 修复前复现（先写测试，再改代码）

`KnowledgeFilter.lifecycle.test.tsx` 新增 R2 用例，在**未改动生产代码**时运行：**4 失败 / 14 通过**。
四个失败都停在 `saveButton().disabled === false`。随后用临时探针（已删除）先点击保存，实测输出：

```text
PROBE updateKnowledge calls: 1 [["c1",{"diagnosis":"消失前的草稿","next_actions":[],"mastery":0.5}]]
```

即改前确实会向已消失的 `concept_id` 发出 PATCH。修复后同一文件 **32/32 通过**。

### 保存限制

- 编辑器保持挂载；诊断、下一步动作、mastery 草稿完整保留；文本可复制。
- 保存按钮禁用，`submit()` 与 `KnowledgeRow.save()` 各拒绝一次，非法请求不会到达 store。
- 取消编辑 / 筛选切换 / 课程切换仍走既有保护，语义不变。
- **未**通过移除 `onSave` 实现只读（那会卸载草稿）。
- 文案改为明确「暂时无法保存」，中英文一致；未声称服务端已永久删除。

### 在途请求与重新出现

| 情形 | 行为 |
| --- | --- |
| 保存中记录消失 | 不取消在途请求、不发第二次请求、编辑器保持到请求结束 |
| 在途失败 | 保留草稿，按钮保持禁用，不能重试同一请求 |
| 在途成功 | 沿用既有安全结束机制，不重建记录、不把响应当作重新存在的证据 |
| 记录重新出现 | 恢复保存资格，保留原草稿，不重置基线，不自动保存 |

### 测试

- `KnowledgeFilter.lifecycle.test.tsx`：**32 项全通过**（含 R2 新增 7 项覆盖 S01–S12、S17–S18）。
- 定向、`tsc`、web 构建、完整构建：通过。
- 全量复跑：**2462 收集 / 2458 通过 / 1 失败 / 3 跳过**，唯一失败为 `server.e48-workbench.test.ts`
  既有失败。首次运行另有 `server.learning-http.test.ts` 自动标题用例在并行负载下超时，
  单独运行 12/12 通过、复跑亦通过，已如实记录两次结果（验收报告 §31.2–31.3）。
- 收集数与 R1 的 2453 相差 **+9**，全部来自本文件 23 → 32 条新增 R2 用例。
- 浏览器：原 19 + R1 10 场景全部通过，新增 6 个 R2 场景写入 `r2-browser-metrics.json`；
  P2-4 / R1 原始截图与指标已还原，未被覆盖。
- 未删除、跳过或放宽任何既有测试。

**R2 结论：`P2-4-R2 PASS_WITH_KNOWN_BASELINE_FAILURE`（见验收报告 §33）。**

**本 PR 待审查，不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
