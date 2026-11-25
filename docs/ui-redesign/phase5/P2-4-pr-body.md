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

**本 PR 待审查，不自动合并。**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
