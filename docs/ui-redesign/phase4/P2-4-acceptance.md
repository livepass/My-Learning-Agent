# E4.9h-P2-4 验收报告：复习准备布局与出题交互优化

- **基准分支**：`main`
- **基准 SHA**：`330777e0f6c3acbf608c764e788ac489aff3285f`（PR #10 合并后，与任务给定一致）
- **工作分支**：`feat/e49h-p2-4-practice-review-layout`
- **原始实现提交**：`00fe7a3`；R1 补充测试提交 `7b7487d`（新增断言尚未重跑）；后续文档与 PR 提交另见 GitHub
- **结论**：**E4.9h-P2-4 核心实现符合原范围；R1 浏览器证据仍待补齐，不宣称最终验收重新 PASS**

---

## 1. 基准与最终 SHA

| 项 | 值 |
| --- | --- |
| 远端 `main` | `330777e0f6c3acbf608c764e788ac489aff3285f` |
| PR #10（P2-3 + R1） | 已合并 |
| 起点工作区 | 干净，未做任何重置 |
| 基线定向测试 | 2 文件 / 89 项通过（表单 11 + 页面 78） |

---

## 2. 修改文件清单

| 文件 | 变化 |
| --- | --- |
| `react/pages/PracticePage.tsx` | 复习准备页改单列；两个说明区块改为一个原生 `<details>` |
| `react/pages/PracticePage.test.tsx` | 原新增 11 项（T01–T10 + 退出复习）；R1 在既有 T07–T10 补充 4 处可见性与生成前就绪断言（尚未重跑） |
| `react/pages/practice/PracticeGeneratorForm.tsx` | 目标/题型/回退折叠进 `<details class="mla-generator-advanced">` |
| `react/pages/practice/PracticeGeneratorForm.test.tsx` | 新增 9 项（T11–T18 + 键盘），既有用例改为显式展开 |
| `react/shell/shell.css` | `.mla-review-prep`、`.mla-review-notes`、`.mla-generator-advanced`、窄屏 `scroll-margin` 与底部留白 |
| `i18n/locales/zh-CN.json` / `en.json` | 新增 `practice.generator.advanced` |
| `docs/ui-redesign/phase4/P2-4-assets/` | 新增：66 张真实截图 + `metrics.json` |
| `docs/ui-redesign/phase4/P2-4-acceptance.md` | 新增（本文） |

**未修改**：`learning-store.ts`、`learner-store.ts`、`sessions-store.ts`、`api/learning.ts`、后端、复习调度、`PracticeProgress.tsx`、`PracticeFeedback.tsx`。未新增依赖或 Store。

---

## 3. 复习准备页前后结构对比

**改造前**

```text
页面标题
└── .mla-split  (grid: 1fr | 224px)
    ├── 左列 .mla-card：知识点 / 到期依据 / 会话 / 题型 / 回退 / 生成 / 退出
    └── 右列 .mla-rail (224px)
        ├── 复习是怎么完成的
        └── 不会自动做的事
```

**改造后**

```text
页面标题
└── .mla-practice.mla-review-prep  (单列，860px 阅读宽度)
    ├── .mla-card：知识点 / 到期依据 / 会话 / 题型 / 回退 / 生成 / 退出
    └── details.mla-review-notes  (默认折叠)
        ├── 复习是怎么完成的
        └── 不会自动做的事
```

- `.mla-split` / `.mla-rail` 的全局样式**未删除**，其他页面照常使用。
- 说明区是表单卡片的兄弟节点，同处一列；`<summary>` 由浏览器提供键盘与触控展开。
- 折叠的只有解释性文案。知识点、到期状态、核查失败、会话、阻塞原因、生成按钮与禁用态、生成错误、退出复习全部保持可见。

---

## 4. 出题表单交互说明

```text
知识点
[输入或选择知识点]
说明 / 合成标识警告

▸ 更多出题选项        ← details，默认关闭

[生成练习题]  [取消（续题时）]
生成失败提示
```

展开后出现：关联学习目标（无目标时不渲染）、题型、允许模型回退。

| 规则 | 实现 |
| --- | --- |
| 折叠不重置字段值 | 值在页面 state，`<details>` 只管开合 |
| 再次展开显示原值 | 同上；组件不持有副本 |
| 不改变默认参数 | `goalId=""`、`kind=""`、`allowModelFallback=true` 未动 |
| 不绕过生成资格 | `canGenerate` / `conceptIsUsable` 与折叠无关 |
| 失败提示仍可见 | 错误是折叠区的兄弟节点 |
| 生成中不可重复提交 | 按钮 `disabled={!canGenerate}`（页面已含 `!isGenerating`） |
| 保持展示组件 | 无 Store、无 API；只有原生 `<details>` 的浏览器状态 |
| 键盘可达 | `<summary>` 原生可聚焦，Enter/Space 切换 |

「再练一道」仍由页面 `nextQuestionOpen` 控制，取消按钮、可信名称预填、`after_attempt_id`、退出复习模式均未改动。

---

## 5. 移动端布局检查

| 项 | 结果 |
| --- | --- |
| 复习准备单列在 320px | 无横向溢出（`overflow: false`） |
| 知识点名称过长 | `.mla-review-concept { overflow-wrap: anywhere }` |
| 下拉框宽度 | `.mla-review-prep select { max-width: 100% }` |
| 生成/退出按钮换行 | 容器 `flex-wrap: wrap` |
| 错误信息不被遮挡 | 错误在折叠区之外，无固定底栏 |
| 高级选项展开不撑破页面 | `.mla-generator-advanced-body { min-width: 0 }`，select 限宽 |
| 输入聚焦保持可见 | 窄屏 `scroll-margin-block: 88px 140px` |
| 底部留白 | `.mla-main:has(.mla-practice)` 增加 `env(safe-area-inset-bottom)`，窄屏再加 56px 底栏高度 |
| 未新增固定底栏/悬浮按钮 | 是 |
| P2-2 进度 / P2-3 反馈 | 未改动 |

新增 CSS 全部限定在 `.mla-review-prep`、`.mla-review-notes`、`.mla-generator-advanced`、`.mla-main:has(.mla-practice)` 等局部选择器，未改 `.mla-card`、`.mla-split`、`.mla-page-head` 等通用规则。

---

## 6. T01–T20 测试覆盖

| 编号 | 场景 | 覆盖位置 |
| --- | --- | --- |
| T01 | 复习准备使用单列结构 | 页面 T01（无 `.mla-split` / `.mla-rail`，存在 `.mla-review-prep`） |
| T02 | 右栏说明不再独立占栏 | 页面 T02（说明是同一列的兄弟，非 `aside`） |
| T03 | 说明默认折叠且可展开 | 页面 T03（`details.open === false` → 点击 summary 后 `true`） |
| T04 | 说明全文与原文案保留 | 页面 T04（两个标题 + 两段正文） |
| T05 | 到期信息始终可见 | 页面 T05（到期依据不在 `details` 内） |
| T06 | 不再到期时禁止生成 | 页面 T06 |
| T07 | 核查失败显示错误 | 页面 T07（`role=alert` + 按钮禁用） |
| T08 | 会话被阻塞时禁止生成 | 页面 T08 |
| T09 | 知识点人工确认仍有效 | 页面 T09（输入 + 勾选后才可生成） |
| T10 | 生成复习题带正确身份 | 页面 T10（`intent: "review"`、`concept_id`、`concept`） |
| T11 | 核心知识点输入默认可见 | 表单 T11 |
| T12 | 高级选项默认折叠 | 表单 T12 |
| T13 | 展开后显示目标/题型/回退 | 表单 T13 |
| T14 | 折叠后再展开保留值 | 表单 T14 |
| T15 | 无目标时不生成空下拉 | 表单 T15 |
| T16 | 生成中禁止重复提交 | 表单 T16 |
| T17 | 生成失败错误保持可见 | 表单 T17（错误不在 `details` 内） |
| T18 | 合成知识点仍被阻止 | 表单 T18 |
| T19 | 「再练一道」保持原有交互 | 页面续题用例（含展开后选题型，`after_attempt_id` 仍为 `a1`） |
| T20 | 「取消」关闭继续出题表单 | 表单「only shows the cancel action…」+ 页面续题用例 |

---

## 7. 原有业务回归情况

| 规则 | 状态 |
| --- | --- |
| 每次进入复习目标重新核查到期 | 未改 `useEffect([reviewConceptId])` |
| URL 不作为到期证明 | 未改；不再到期仍禁止生成（T06） |
| 核查失败不默认放行 | 未改（T07） |
| 复习身份由 `question.review === true` 决定 | 未改 `reviewQuestionActive` |
| 会话资格 `reviewSessionReadiness` | 未改（T08 + 既有用例） |
| `reviewIntentRef` / `reviewTicketRef` / `reviewGeneratingRef` / `reviewScopeProblem` / `reviewRevisionProblem` | 一字未改；既有请求隔离用例全部通过 |
| `concept_id` / 可信名称 / `intent: "review"` / `after_attempt_id` / 题型 / 回退 | 未改（T10 + 续题用例） |
| C2/C3 三步独立 | 未改；`PracticeProgress` 与 `PracticeFeedback` 未触碰 |
| P2-3 评分反馈隔离 | 页面既有 T16–T20 全部通过 |

---

## 8. TypeScript 与构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build`（server + web） | 通过 |

---

## 9. 全量测试对照

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4` | **194 文件通过 / 1 失败；2193 通过 / 1 失败 / 3 跳过** |

| 轮次 | 文件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| P2-3 合并后基线（`330777e`） | 194 | 2173 | 1 | 3 |
| P2-4 本轮 | 194 | **2193** | 1 | 3 |

> 基线 2173 取自 `main` @ `330777e` 的实际执行结果（P2-3 的 2172 加 R1 新增的 1 项英文 neutral Badge 断言）。本轮 +20 恰为新增用例：页面 +11、表单 +9。

**唯一失败**仍是基线既有 `apps/learning-agent/src/server.e48-workbench.test.ts` 的 `providerCalls` 断言（期望 1 实得 2），与本轮前端改动无关，本轮未修改该测试。不将其描述为通过。

---

## 10. 真实浏览器截图与指标

真实 React 页面 + 真实服务端（隔离数据目录 `.p24-acceptance/data` + 桩 provider），每个状态由真实 API 产生。

### 方法

- 5 视口（1440×900 / 1024×768 / 900×800 / 390×844 / 320×640）× 浅色/深色 × 6 个场景 = 60；另加英文 2 视口 × 2 场景 = 4；再加 1 张生成失败。合计 **65 条指标**。
- 另做一次独立的键盘验证（Enter/Space 切换、折叠后值保留、复习生成可用），并附 1 张截图。PNG 合计 **66 张**。
- 复习到期状态由 `seed-review.mjs` 走真实 C1→C2→C3 流程产生证据，再把 `review_due_at` 移到过去/未来；每个复习场景开始前重新落一次，避免记录证据后自动重投影把到期日推到未来。

### 场景

复习到期、复习不再到期、首次出题（折叠）、首次出题（展开）、续题「再练一道」、已评分未记录、生成失败。

### 结果

| 指标 | 结果 |
| --- | --- |
| 捕获数 | 65 条指标 / 66 张 PNG |
| 横向溢出 | **0** |
| 复习页出现 `.mla-rail` | **0** |
| 复习页多列 | **0**（全部 `reviewColumns = 1`） |
| 页面异常 | **0** |
| 控制台错误 | **1**，来自 `generate-failed` 场景：桩 provider 返回 500，应用映射为 502 —— 这是被验证的失败路径本身，不是缺陷 |

### 键盘验证（独立运行）

| 检查 | 结果 |
| --- | --- |
| 高级选项 summary 可获得焦点 | 是 |
| Enter 展开 | 是 |
| Space 收起 | 是 |
| 折叠/展开后题型值保留 | `application` |
| 复习说明 summary 可获得焦点 | 是 |
| Enter 展开复习说明 | 是（`false → true`） |
| 复习到期时「生成复习题」可用 | 原页面 T10 测试在生成前断言可用；原浏览器 `summary.keyboard.reviewGenerationEnabled=false` 与同组 `generateErrorVisible=true`，采样时机不明，**待浏览器补测** |

### 重点确认

| 检查 | 结果 |
| --- | --- |
| 复习到期且会话可用 | 单列已获浏览器证据；按钮可用状态需在到期核查完成后、实际点击前重新采样 |
| 复习不再到期 | 红色提示，按钮不可用 |
| 会话被阻塞 | 说明可见，按钮不可用（页面测试 T08） |
| 需人工确认知识点 | 输入 + 勾选后才可生成（页面测试 T09） |
| 高级选项展开/收起 | 无值丢失，无布局破损 |
| 「再练一道」 | 表单展开，取消可用 |
| 生成失败后重新操作 | 错误可见，输入保留，可再次点击 |
| 320px 完整可操作 | 是，无横向滚动 |
| 深浅主题 | 各场景两种主题 |
| 中英文 | 英文 4 条指标，无布局异常 |

截图：`P2-4-assets/`（`<宽>x<高>-<主题>-<场景>.png`），指标：`P2-4-assets/metrics.json`。

---

## 11. 已知问题与限制

1. **`server.e48-workbench` 基线失败**仍在，与前端无关，本轮未改。
2. **`generate-failed` 场景有 1 条 502 控制台错误**：这是桩 provider 主动失败后应用返回 502 的预期结果，用于验证「失败提示保持可见、可重试」，不是缺陷。
3. **jsdom 不隐藏 `<details>` 内容**：组件测试对折叠区内字段的断言在显式点击 summary 后进行，折叠行为本身由浏览器验收（截图与键盘数据）证明。
4. **`review_due_at` 会被证据重投影改写**：验收脚本在每个复习场景前重新落一次到期日；这是产品正确行为（记录证据后重新计算复习时间），不是缺陷。
5. **底部留白使用 `:has()`**：现代浏览器均支持；Electron 内置 Chromium 满足要求。

---

## 12. PASS 判定

| 条件 | 结果 |
| --- | --- |
| 复习准备页改为单列 | 是 |
| 右侧 224px 说明栏不再存在 | 是（`rails = 0`） |
| 原复习说明完整保留并可展开 | 是（T03/T04 + 键盘验证） |
| 核心输入与生成按钮保持可见 | 是 |
| 可选配置默认折叠 | 是 |
| 展开/折叠不改变表单值 | 是（T14 + 键盘验证） |
| 「再练一道」流程不变 | 是（T19/T20） |
| 复习到期核查不变 | 是 |
| 复习身份判定不变 | 是 |
| 会话资格与异步隔离不变 | 是 |
| 320px 无横向溢出 | 是 |
| 深浅主题与中英文正常 | 是 |
| P2-2、P2-3 无新增回归 | 是 |
| 定向测试、类型检查、构建通过 | 是 |
| 无新增确定性测试失败 | 原 P2-4 验收记录无新增失败；R1 只增加断言，尚未重新执行 |
| 验收证据完整 | 是 |
| 未改动冻结模块 | 是 |

**结论：E4.9h-P2-4 实现部分维持原始增量 PASS 评价；R1 浏览器异常场景与生成前按钮状态待补齐，不能将原始浏览器记录当成 R1 已通过。** 本轮不开始 P2-5。

---

## 13. P2-4-R1 补充验收记录（2026-11-23）

### 13.1 原始指标与报告矛盾

- `P2-4-assets/metrics.json` 中 `summary.keyboard.reviewGenerationEnabled=false`，同时 `summary.keyboard.generateErrorVisible=true`。
- 原始验收报告曾声称“复习到期时生成按钮可用”，截图可见正常外观；**外观、旧测试与键盘指标不足以判断采集时是否在同一操作阶段。**
- 最小验证方案：使用真实 C1/C2/C3 形成到期概念，在复习准备页面等待 `reviewCheck.loading=false`、会话 readiness 为 `ready/needs_init`、真实概念名称可用；在点击生成按钮**之前**采集 `disabled=false`，同时记录所依赖的前置状态。点击后记录生成中/失败的按钮状态，明确分开两个采样点。
- 如采集仍为 `disabled=true`，停止本轮 R1 验收，检查真实业务资格而不是删除禁用判断或强行令按钮可用。

### 13.2 缺失的真实浏览器场景（待执行）

| 场景 | 1440×900 | 320×640 | 关键断言 |
| --- | --- | --- | --- |
| 到期核查失败（如 503） | 待截图与指标 | 待截图与指标 | 错误可见、生成禁用、说明栏不遮挡错误 |
| 会话处于 blocked（未完成题目/attempt） | 待截图与指标 | 待截图与指标 | 阻塞原因可见、生成禁用、原题不被覆盖 |
| 概念无可信名称 | 待截图与指标 | 待截图与指标 | 人工确认前禁用，填入有效名称并确认后才可能启用 |
| 到期且会话就绪（生成之前） | 待复核按钮状态 | 待复核按钮状态 | `disabled=false`、前置条件可追溯 |

必须在真实 React 页面与真实 API 上重复，使用隔离数据与可控 provider；如不能启动浏览器，不生成虚假的 screenshot/metrics。待执行完成后**追加**对应证据并更新总结，原 65 条指标与 66 张截图保持原样。兼容性和回归证明不得仅用 jsdom 的 `details` 行为替代真实浏览器。

### 13.3 本轮已提交与尚未验证

- 已补强 `PracticePage.test.tsx` 的 T07–T10：核查失败时错误在折叠说明之外、blocked 原因始终可见、人工确认字段可达、到期可生成断言限定在发起生成**之前**。未修改业务规则或测试基线的预期。
- 原始 P2-4 全量 `2193 通过 / 1 失败 / 3 跳过` 和构建通过，仍是 **R1 前的历史执行记录**。本轮新增断言未重新执行，不允许把旧记录写成 R1 已通过。
- 原始浏览器 `metrics.json` 没有被修改；上述真实浏览器场景目前 **待执行**。不得凭本文件宣称新证据已产生。
- 处理完浏览器证据与测试复核之前，PR 应保持 Draft / 不合并。
