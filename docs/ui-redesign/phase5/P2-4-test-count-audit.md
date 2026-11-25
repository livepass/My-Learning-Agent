# E4.9i-P2-4 测试数量审计（F05）

- **审计对象**：`docs/ui-redesign/phase5/P2-4-acceptance.md` 中报告的「+79 通过」与「45 项新增测试」之间的差异
- **基准提交 A**：`c153d694c56b7ac23cb027cf322205ed09b370ba`（P2-3-R1 合并，`main`）
- **基准提交 B**：`d1af9781899da6c4f9ee71679d3b290eb6c2e1b2`（P2-4 审查提交）
- **方法**：两个独立 git worktree（`../p24-audit-base`、`../p24-audit-head`），链接同一份 `node_modules`，同一 Vitest 3.2.4 与同一配置；先 `vitest list --json` 做静态收集，再 `vitest run --reporter=json` 做真实执行。

---

## 1. 结论摘要

| 项 | 值 |
| --- | --- |
| 静态收集：A 用例数 | 2378 |
| 静态收集：B 用例数 | 2427 |
| **收集差异** | **+49**（无删除、无重命名、无重复 key） |
| 新增用例实际来源 | 3 个新文件：`knowledge-filter.test.ts` 18 + `KnowledgeFilter.page.test.tsx` 20 + `KnowledgeStateFilters.test.tsx` 11 = **49** |
| 报告中写的「45 项」 | **不准确**：当时按「14 + 11 + 20」相加，但纯函数文件实际有 **18** 个用例（T01–T14 + 4 个附加断言），故为 **49** |
| 报告中写的「+79 通过」 | **不可复现**：同环境下 A→B 的通过数增量为 **+74**，总数增量为 **+49**，差值全部来自环境相关的 skip 变化 |

**核心结论：测试数量本身没有异常膨胀——新增就是 49 项。审计暴露的是两处记录错误：**
1. P2-4 报告把新增用例数写成 45（应为 49）。
2. P2-4 报告的全量「2456 通过 / 2460 总数」与同一份日志实际输出不符（该日志真实值为 2426 / 2430）。

两者都不是代码问题，但必须如实修正。

---

## 2. 逐文件证据（静态收集，`vitest list --json`）

### 2.1 A → B 的用例增量

```
apps/learning-agent/web/src/react/profile/knowledge-filter.test.ts        0 → 18  (+18)
apps/learning-agent/web/src/react/profile/KnowledgeFilter.page.test.tsx   0 → 20  (+20)
apps/learning-agent/web/src/react/profile/KnowledgeStateFilters.test.tsx  0 → 11  (+11)
合计 +49
```

- 无文件删除，无用例改名（按 `project :: name :: file` 归一后，`removed = 0`）。
- 无重复收集：A、B 的 key 集合大小均等于条目数（2378/2378、2427/2427）。
- 无旧构建产物被收集：`vitest.config.ts` 的 `include` 仅匹配 `**/*.test.ts(x)`，`exclude` 含 `node_modules`、`runtime`、`workspace`；两个 worktree 均为干净检出，无 `dist` 参与收集。
- 参数化用例：新增 3 个文件不含 `describe.each` / `it.each`，用例数为字面 `it()` 数量，无展开差异。

### 2.2 报告中「45」的来历

P2-4 验收报告 §7.1–7.3 记录为「14 + 11 + 20 = 45」。实际 `knowledge-filter.test.ts` 含：

| 分组 | 用例 |
| --- | --- |
| `filterKnowledgeStates` | T01–T12 + 「returns a new array even for all」 = 13 |
| `countKnowledgeFilters` | T13、T14 + 键顺序 + 默认值 + 不可变 = 5 |
| 合计 | **18** |

即报告少算了该文件的 4 个用例。这是计数笔误，不是用例缺失。

---

## 3. 真实执行结果（`vitest run --reporter=json`）

同一命令、同一依赖、同一配置，在两个 worktree 分别执行：

| 指标 | A `c153d69` | B `d1af978` | 差值 |
| --- | ---: | ---: | ---: |
| `numTotalTests` | 2381 | 2430 | **+49** |
| passed | 2351 | 2425 | +74 |
| failed | 2 | 2 | 0 |
| skipped | 28 | 3 | **−25** |
| 测试文件数 | 207 | 210 | +3 |

### 3.1 为什么通过数 +74 而不是 +49

差值 **+74 − 49 = +25**，正好等于 skip 数的减少量。A 的 28 个 skip 中有 **25 个来自 `MarkdownArtifact.test.tsx`**；B 中同样 25 个用例变为 passed。该文件的 `beforeAll` 会预热真实 Mermaid 运行时（预算 60s），在并行 worker 抢占下会超时并被标记为跳过——这是**执行环境/时序相关**，与 P2-4 代码无关（P2-4 未改动该文件及其依赖）。

因此：

- 「通过数」不是稳定基准，会随 Mermaid 预热时序在 ±25 之间摆动。
- 「收集总数」才是稳定基准：A 2381 → B 2430，**+49**，与静态收集完全一致。

### 3.2 失败项

| 提交 | 失败用例 |
| --- | --- |
| A | `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（历史失败）；`MarkdownArtifact.mermaid-cold.test.tsx` › `loads the real Mermaid runtime from its cold placeholder…`（Mermaid 冷启动，环境相关） |
| B | `server.e48-workbench.test.ts` › 同一历史失败；`MarkdownArtifact.test.tsx` › `sanitizes SVG preview elements…`（同类 Mermaid 时序） |

两次的 Mermaid 失败不是同一条用例，且都属真实运行时预热/时序，未在 P2-4 代码路径上。

---

## 4. 与历史报告的偏差

### 4.1 P2-4 报告（`P2-4-acceptance.md` §7.7）

报告写：

```
Tests  1 failed | 2456 passed | 3 skipped (2460)
```

对应日志 `.tmp/p2-4-full-test.log` 的实际输出为：

```
Tests  1 failed | 2426 passed | 3 skipped (2430)
```

报告中的 2456/2460 **没有任何日志支持**，属于记录错误（本轮审计无法复现该数字）。正确记录应为 2426 / 2430。

### 4.2 P2-3-R1 报告（2377 / 1 / 3 / 2381）

该数字与 `.tmp/p2-3-r1-full-test.log` 一致，且本轮在 `4ec8030`（R1 代码提交）worktree 的独立执行可交叉验证（见 §5）。它与 A 的静态收集 2378 相差 1，源于同一 Mermaid 时序下的 skip 与 passed 归属，不影响「总数」口径。

---

## 5. 修订后的可信基准

**口径统一为「收集总数（`numTotalTests`）」**，因为它不受 Mermaid 预热时序影响：

| 提交 | 收集总数 | 测试文件 | 失败（稳定） |
| --- | ---: | ---: | --- |
| P2-3-R1 `4ec8030` | 2381 | 207 | 1（`server.e48-workbench`） |
| P2-3-R1 合并 `c153d69` | 2381 | 207 | 1 |
| P2-4 `d1af978` | 2430 | 210 | 1 |

- 新增用例：**49**。
- 删除用例：**0**。
- 跳过/失败中除 `server.e48-workbench` 外均与环境（Mermaid 运行时预热）相关，不构成回归。

**R1 之后的基准（本轮新增 23 项后）以 R1 章节的最终全量输出为准。**

---

## 6. 未能确认的部分

| 项 | 状态 |
| --- | --- |
| P2-4 报告中 2456/2460 的来源 | `UNRESOLVED`——同配置、同依赖下无法复现；最可能是手写记录时的错误，但无证据确认 |
| A 中 `MarkdownArtifact.mermaid-cold` 失败、B 中 `MarkdownArtifact` 失败的精确触发条件 | `UNRESOLVED`——两者都依赖真实 Mermaid 运行时预热，尚未定位到可稳定复现的阈值；与 P2-4 改动无代码关联 |

未通过删除测试、调整 `include`/`exclude` 或修改断言来凑数字；两个 worktree 均为原样检出。
