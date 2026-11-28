## E4.9i-P2-6-R2｜目标编辑初始快照与被动更新保护

**基准：** `main@59d611896f86113caf44d30e7aa9814557544a20`（PR #23 合并提交）
**分支：** `fix/e49i-p2-6-r2-goal-edit-snapshot`
**验收报告：** `docs/ui-redesign/phase5/P2-6-R2-acceptance.md`
**指标与日志：** `P2-6-assets/r2-browser-metrics.json`、`P2-6-assets/r2-test-log.txt`
**浏览器脚本：** `docs/ui-redesign/phase5/scripts/qa_p2_6_r2.py`

不回滚 R1，不重做 F01–F04，不进入 P2-7。

### 缺陷

`GoalCard.save()` 用 `goalPatchFromDraft(goal, draft, priorityTouched)`：`goal` 是实时 prop，
被动刷新会换掉它，而 `draft` 还是打开编辑器时的值。服务端改过的字段于是与旧草稿不等，
被当成"用户修改"发回服务端——既覆盖新值，又刷新该字段的 `manual.*` 归属戳。

R1 的 `priorityTouched` 只护住了 `priority`；`title` / `type` / `status` / `success_criteria` 仍按
"草稿 vs 最新记录"比较。

### 修复

- `knowledge-provenance.ts`：新增 `goalEditingBaseline(goal)`（浅拷贝对象 + 逐元素拷贝
  `success_criteria`）；`goalPatchFromDraft(baseline, draft, priorityTouched)` 的形参语义改为
  编辑初始快照，并在文档里写明"不得传入实时记录"的原因。
- `LearnerProfilePanel.tsx`：`GoalCard` 增加 `editingBaseline`。打开时建立两份独立拷贝（快照 + 草稿），
  被动刷新不覆盖它们；保存成功/取消/无修改关闭时清空；保存失败保留快照、草稿与 `priorityTouched`。
  快照缺失时阻止保存并提示，不回退到旧比较逻辑。
- i18n：新增 `profile.goals.editBaselineMissing`（zh/en）。

`learner-store.ts`、`api/learner.ts`、`server/routes/learner.ts` 零改动。

### 先复现，再修复

在未修改的 R1 实现上，新增的 18 项场景中 **11 项失败**，失败信息就是旧草稿字段被发出，例如：

```text
S01 expected { title: '学习英语', priority: 0.4 }        to equal { priority: 0.4 }
S02 expected { status: 'active', priority: 0.4 }        to equal { priority: 0.4 }
S07 expected "spy" to not be called at all, but actually been called 1 times
S14 expected { title: '学习英语', status: 'paused' }    to equal { status: 'paused' }
```

每个场景断言**完整请求体或精确键集合**，不只看最终优先级——S02 在旧实现上最终存储的 priority 也是 0.4，
只看它会完全漏掉缺陷。

### 字段语义

| 字段 | 依据 |
| --- | --- |
| `title` / `type` / `status` | 草稿 ≠ 初始快照 |
| `success_criteria` | 数组内容 ≠ 初始快照 |
| `priority` | 用户主动修改 且 为 `[0,1]` 有限数（R1 规则保留） |

同字段并发继续沿用"人工 PATCH 以提交值为准"。**R2 不是多客户端并发编辑冲突的解决方案**：
它只保证用户没改的字段不会被旧草稿覆盖。

### 测试

| 验证 | 结果 |
| --- | --- |
| 修复前反例 | 11 失败 / 30 通过（41） |
| R2 专项（3 文件） | 102 通过（GoalPriority 41 / provenance 49 / 真实路由 12） |
| 学习档案与课程专项 | 101 文件 / 1401 通过 |
| `tsc --noEmit`（web） | exit 0 |
| `npm run build` | exit 0（后端 tsc + 前端 tsc + vite，1m 6s） |
| 全量测试 | 2628 用例：2625 通过 / **0 失败** / 3 跳过（217 文件全通过） |

新增 27 项（18 + 4 + 5），R1 的既有断言一条未删、一条未放宽。
P2-5 起记录的历史基准失败（`server.e48-workbench.test.ts`）本轮未复现：全量通过，单独运行连续 3 次 9/9。
不声称已修复，只记录未观察到。一次与 Vite 并行的全量运行出现过同文件另一条断言失败，按已记录的
端口/CPU 竞争排除（见日志 §8）。

### 真实服务端路由

`learner.goal-priority.test.ts` 新增 5 项，跑真实 `handleLearnerRoutes` 与真实 learner store：

- priority-only → `manual.title/status/success_criteria` 与值全部不变；
- title-only → `manual.status/priority/success_criteria` 不变；
- status-only → `manual.title/priority` 不变；
- criteria-only → `type` 与兄弟戳不变；
- type-only → 只改 type，`manual` 整体等于种子。

未新增服务端人工维护规则。

### 浏览器验收

`qa_p2_6_r2.py`：R2-B01–B07 覆盖"服务端改状态/标题/类型+成功标准/多字段、用户只改另一个字段"、
无修改保存、刷新→取消→重开、失败→刷新→重试、320px 异常优先级端点确认。

| 场景 | PATCH |
| --- | --- |
| B01 status→paused，用户改 priority | `{"priority": 0.4}` |
| B02 title→服务端，用户改 status | `{"status": "paused"}` |
| B03 type+criteria→服务端，用户改 title | `{"title": "编辑期间改的标题"}` |
| B04 全部字段→服务端，用户未改 | 无请求 |
| B05 刷新→取消→重开→改 status | `{"status": "completed"}` |
| B06 失败→服务端改标题→重试 | 两次均 `{"status": "paused"}` |
| B07 320px 异常 3→端点 100% | `{"priority": 1}` |

每个场景记录编辑前记录、被动更新记录、用户修改字段、请求体、存储记录、`manual.*` 前后值、
`pageErrors`、元素边界与横向溢出。7 个场景 `pageErrors = []`、无横向溢出。

另复跑 R1 的 19 个场景（由 `qa_p2_6_r1.py` 自身执行），全部通过；截图写入 `r2/r1-rerun/`，
原始 `p26-*.png` 与 `r1/` 未被覆盖。

**证据边界：** 浏览器证据来自模拟 API（`page.route` 复刻打戳规则），证明客户端发什么；
真实路由行为由 Vitest 路由测试证明。两者不混为一谈。

### 一处既有现象（不属本轮，不修）

320px 折叠态目标卡片的内容列被右侧按钮组压到约 18px（卡片 232 / 右组 149）。把
`LearnerProfilePanel.tsx` 回退到 main 版本后同一探针测得相同数值，且本轮未触碰折叠态 JSX 与样式；
它属于 P2-5 响应式机制的未覆盖区域，本轮冻结范围内只记录不修。展开的编辑态在 320px 下正常。

### 改动文件

| 文件 | 内容 |
| --- | --- |
| `web/src/react/profile/knowledge-provenance.ts` | `goalEditingBaseline()`；`goalPatchFromDraft` 以快照为基准 |
| `web/src/react/LearnerProfilePanel.tsx` | `editingBaseline` 状态与四条生命周期路径 |
| `web/src/i18n/locales/{zh-CN,en}.json` | `editBaselineMissing` |
| `web/src/react/profile/GoalPriority.test.tsx` | S01–S18 |
| `web/src/react/profile/knowledge-provenance.test.ts` | 快照克隆 4 项 |
| `src/server/routes/learner.goal-priority.test.ts` | 部分更新 5 项 |

### 明确未做

- 未改知识状态引擎、证据生成/回放、记忆、掌握度/置信度/稳定性、正式复习资格。
- 未改服务端 API 规则、数据库、六类筛选规则、`KnowledgeDraftGuard`、P2-5 响应式机制。
- 未新增版本锁/ETag/冲突弹窗；未新增可信度评分；未重构目标编辑架构；未开始 P2-7。
- 未开启自动合并，未直接修改 main。
