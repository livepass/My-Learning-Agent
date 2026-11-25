# E4.9i-P2-4 验收报告：六类知识状态筛选器

- **任务**：E4.9i-P2-4
- **基准分支**：`main`
- **基准 SHA**：`c153d694c56b7ac23cb027cf322205ed09b370ba`
- **工作分支**：`feat/e49i-p2-4-knowledge-filters`
- **前置**：P2-1 / P2-2 / P2-2-R1 已合并；P2-3 / R1 经 PR #18 合并
- **结论**：**P2-4 PASS**（全量测试仅剩 1 项已核实的既有失败）

---

## 1. 基准核对

| 项 | 值 |
| --- | --- |
| `git fetch origin` 后 `origin/main` | `c153d694c56b7ac23cb027cf322205ed09b370ba` |
| PR #18 状态 | `merged: true`，`merge_commit_sha` = `c153d69…`（与 main 一致） |
| 开工工作区 | 干净（`git status --short` 无输出） |
| 新建分支 | `feat/e49i-p2-4-knowledge-filters`（自 `main` 切出） |
| 最终提交 | 见 PR 描述 |

main 未偏离任务书给出的 SHA，无需审查额外提交。

---

## 2. 现有源码审查结论

| 文件 | 实际职责 / 与本阶段相关的事实 |
| --- | --- |
| `KnowledgeList.tsx` | 纯渲染器：按给定顺序渲染、`concept_id` 作 key、`emptyMessage` 可覆盖空态。**不含**筛选与 store 访问 |
| `KnowledgeRow.tsx` | 三级状态 `collapsed / reading / editing`；头部点击先问 `guard.confirmLeave()` |
| `KnowledgeDraftGuard.tsx` | `register / verdict / isDirty / isSaving / confirmLeave`；`saving` 硬拒绝，`dirty` 确认一次 |
| `KnowledgeEditPanel.tsx` | 打开时快照作基线，`dirty` 为比较结果；卸载即注销 guard |
| `profile-overview.ts` | `deriveProfileOverview()` 同时产出四项统计与结论 |
| `knowledge-state.ts` | `normalizeKnowledgeStateLabel()` / `isWeakKnowledgeState()` 唯一判定来源 |
| `LearnerProfilePanel.tsx` | `KnowledgeSection` 是唯一接触 `learnerStore` 的知识列表容器；区块 > 5 行默认折叠 |
| `CourseLearnerPanel.tsx` | 独立只读布局，不传 `onSave`，**不是**共享组件 |
| `ProfilePage.tsx` | 持有 `KnowledgeDraftGuardProvider`，范围切换先取 verdict |

**关键确认**：课程视图并未复用 `KnowledgeList`，因此本轮为其保留现有行布局，只接入相同的筛选纯函数与展示组件（与任务书 §8 一致）。

### 2.1 筛选会导致编辑组件卸载的全部路径

| 路径 | 处理 |
| --- | --- |
| 知识行头部点击（折叠） | 既有 `guard.confirmLeave()`，未改 |
| 知识状态区块折叠 | 既有 `onBeforeCollapse={guard.confirmLeave}`，未改 |
| 课程范围切换 | 既有 `changeScope()` verdict，未改 |
| **筛选切换（本轮新增）** | 同一 `guard.confirmLeave()`，见 §5 |

---

## 3. 筛选模块

`react/profile/knowledge-filter.ts`

```ts
export const KNOWLEDGE_FILTERS = ["all","needs_attention","review_due","misconception","stable","unknown"] as const;
export type KnowledgeFilter = (typeof KNOWLEDGE_FILTERS)[number];
export type KnowledgeFilterCounts = Record<KnowledgeFilter, number>;

filterKnowledgeStates(states, filter)   // 纯函数，返回新数组
countKnowledgeFilters(states)           // 纯函数，六项计数
```

### 3.1 判定规则（与概览同源）

| 筛选值 | 规则 |
| --- | --- |
| `all` | 全部记录 |
| `needs_attention` | `isWeakKnowledgeState()` |
| `review_due` / `misconception` / `stable` / `unknown` | `normalizeKnowledgeStateLabel()` 等于该值 |

- 不使用 `mastery` / `confidence` / `review_due_at`。
- 缺失、空、未识别标签统一归入 `unknown`（证据不足）。
- 不使用误区记录数量。

### 3.2 计数与概览共享一次统计

新增 `tallyKnowledgeStates()`（`profile-overview.ts`）：一次遍历产出 `{ total, labelCounts, weakCount }`。
`deriveProfileOverview()` 改为读取它，**外部行为与原有测试不变**（`profile-overview.test.ts` 16 项全绿）；`countKnowledgeFilters()` 也读它，因此筛选计数与概览分类不可能出现两套结果。

### 3.3 顺序

`filterKnowledgeStates` 只做 `filter` / `slice`，保持服务端顺序，不排序、不按 mastery 排名。

---

## 4. 筛选器组件

`react/profile/KnowledgeStateFilters.tsx`，受控展示组件：

```ts
{ value: KnowledgeFilter; counts: KnowledgeFilterCounts; onChange: (v: KnowledgeFilter) => void }
```

- 固定顺序：全部 / 需要关注 / 待复习 / 存在误区 / 稳定 / 证据不足。
- 原生 `<button type="button">` + `aria-pressed`；`role="group"` 带无障碍名称。
- 选中项使用 `--inno-accent-soft` 背景与 accent 边框，与未选中项明显区分；焦点样式沿用全局 `button:focus-visible`。
- 数量为零仍可选。
- 下方固定一行说明：「待复习仅表示知识状态分类，不代表已达到正式复习资格。」

---

## 5. 集成与草稿保护

### 5.1 全部课程（`LearnerProfilePanel.tsx`）

```text
knowledge_states ──┬── countKnowledgeFilters() ──► KnowledgeStateFilters
                   └── filterKnowledgeStates() ──► KnowledgeList ──► KnowledgeRow
```

- 默认 `all`；`useMemo` 计算计数与可见列表。
- 切换前调用 `guard.confirmLeave()`；返回 false 则**不改变任何状态**。
- 同值点击直接 `return`：不确认、不卸载、不重渲染列表。
- 筛选只影响知识列表；概览结论与需要关注卡片仍读未过滤的 `profile`。
- 非 `all` 且无匹配时，`KnowledgeList` 显示「当前筛选下没有知识点，可选择其他状态。」，而非「暂未追踪任何概念」。

### 5.2 指定课程（`CourseLearnerPanel.tsx`）

- 使用同一 `countKnowledgeFilters` / `filterKnowledgeStates` / `KnowledgeStateFilters`。
- 数据仍是服务端返回的课程范围列表；只读，不传 `onSave`。
- 无编辑器可卸载，因此切换为普通 state 变更，不经 guard。
- `courseId` 变化时 `useEffect` 重置为 `all`；取消课程切换时组件不卸载，筛选与草稿均保留。

### 5.3 退出策略汇总

| 情形 | 行为 | 测试 |
| --- | --- | --- |
| 无草稿 | 直接切换 | G01 |
| 有草稿 | `window.confirm` 一次 | G02、G05 |
| 拒绝确认 | 筛选、编辑器、草稿全部保留 | G03 |
| 确认放弃 | 切换并卸载编辑器，不发送保存请求 | G04 |
| 保存进行中 | 拒绝切换，**不弹确认框** | G06 |
| 保存成功后 | 可正常切换 | G07 |
| 保存失败后 | 草稿仍受保护 | G08 |
| 重复点击当前筛选 | 不确认、不改变 | G10 |

### 5.4 保存导致状态改变

保存成功 → `learnerStore.patchKnowledge()` 更新 profile → 计数与匹配列表重算。
若该知识点已不符合当前筛选，它会在**保存完成后**从列表消失（编辑器此时已回到阅读态或卸载），不会在保存进行中卸载编辑组件。G07 固定了这条顺序。

---

## 6. 国际化

新增 `profile.knowledge.filters.*`（中英各 9 个键）：六类名称、无障碍名称、待复习说明、无匹配提示。
状态名称本身沿用既有 `course.state.*`（徽章文案），未重复定义。

---

## 7. 测试

### 7.1 纯函数（`knowledge-filter.test.ts`，14 项）

T01 全部 · T02 四种弱项 · T03 review_due · T04 misconception · T05 stable · T06 unknown · T07 缺失/未识别归 unknown · T08 mastery 不影响 · T09 review_due_at 不影响 · T10 空数组 · T11 原始顺序 · T12 不修改输入 · T13 计数与匹配一致 · T14 计数与概览一致（+ 键齐全、默认值、返回新数组）。

### 7.2 组件（`KnowledgeStateFilters.test.tsx`，11 项）

C01 默认全部 · C02 六项顺序 · C03 数量 · C04 唯一 `aria-pressed` · C05 点击回调 / 可聚焦原生按钮 · C06 零数量可选 · C08 中英切换 · 分组无障碍名称 · 待复习说明 · 不自行渲染空态。

### 7.3 页面集成与草稿保护（`KnowledgeFilter.page.test.tsx`，20 项）

G01–G08、G10（见 §5.3）；I01 全部课程筛选 · I02 指定课程筛选 · I03 两范围计数隔离 · I04 课程只读 · I05 切换课程后重置 · I06 取消课程切换保留筛选与草稿 · I07 概览不随筛选改变 · I08 薄弱卡不随筛选改变 · I09 刷新后数量更新 · I10 无匹配显示筛选空态而非空档案 · 刷新失败保留筛选且不伪造匹配。

### 7.4 既有测试的查询范围调整

新增筛选行会渲染「待复习」「稳定」等文字，与部分既有断言冲突。三处**只收窄查找范围，断言意图不变**：

| 文件 | 调整 |
| --- | --- |
| `LearnerProfilePanel.knowledge-state.test.tsx` | `queryByText("待复习")` → `allBadgeLabels()` 不含该文案（检查徽章而非整页文本） |
| `profile/KnowledgeList.page.test.tsx` | 课程四项 fact 的数字改为在 `.mla-fact strong` 内断言 |

### 7.5 定向结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run …/profile …/LearnerProfilePanel.summary.test.tsx …/LearnerProfilePanel.knowledge-state.test.tsx …/ProfilePage.courses.test.tsx …/i18n/locales.test.ts` | ✅ 14 文件 / **217 项** |

### 7.6 TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | ✅ 0 错误 |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | ✅ |

### 7.7 全量

`npx vitest run`（代码定稿后单次运行，`.tmp/p2-4-full-test.log`）：

```
Test Files  1 failed | 209 passed (210)
     Tests  1 failed | 2456 passed | 3 skipped (2460)
```

| 指标 | P2-3-R1 | P2-4 | 变化 |
| --- | ---: | ---: | --- |
| 通过 | 2377 | **2456** | +79 |
| 失败 | 1 | **1** | 不变 |
| 跳过 | 3 | **3** | 不变 |

唯一失败仍是 `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`；`git diff origin/main -- apps/learning-agent/src` 为 0 行。未删除、跳过或放宽任何断言。`server.learning-generate.test.ts` 本轮未复现偶发，继续单独记录，不确认根因。

---

## 8. 浏览器验收

`docs/ui-redesign/phase5/scripts/qa_p2_4.py`，隔离 Vite（127.0.0.1:5193）+ `page.route` 受控 fixture，**不读写真实学习档案**。19 个场景全部通过，页面无 JS 错误。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `p24-desktop-all.png` | 1440×900 | 默认全部（12 条） |
| `p24-desktop-needs-attention.png` | 1440×900 | 需要关注（7） |
| `p24-desktop-review-due.png` | 1440×900 | 待复习（2） |
| `p24-desktop-misconception.png` | 1440×900 | 存在误区（1） |
| `p24-desktop-stable.png` | 1440×900 | 稳定（3） |
| `p24-desktop-unknown.png` | 1440×900 | 证据不足（2） |
| `p24-desktop-no-match.png` | 1440×900 | 筛选无匹配 |
| `p24-desktop-filter-cancel.png` | 1440×900 | 取消切换，草稿保留 |
| `p24-desktop-filter-confirm.png` | 1440×900 | 确认切换 |
| `p24-desktop-filter-saving.png` | 1440×900 | 保存中尝试切换 |
| `p24-course-filter.png` | 1440×900 | 指定课程筛选 |
| `p24-course-reset.png` | 1440×900 | 切换课程后重置 |
| `p24-1024.png` | 1024×768 | 小型桌面 |
| `p24-tablet-768.png` | 768×1024 | 平板 |
| `p24-mobile-390.png` | 390×844 | 手机 |
| `p24-mobile-320.png` | 320×640 | 极窄屏 |
| `p24-desktop-dark.png` | 1440×900 | 深色 |
| `p24-desktop-en.png` | 1440×900 | 英文 |
| `p24-desktop-keyboard.png` | 1440×900 | Tab + Space 选择 |

指标：`P2-4-assets/p24-browser-metrics.json`（含 `selectedFilter`、`pressedCount`、`filterCounts`、`visibleRows`、`filterOverflow`、`rowOverflow`、`documentOverflow`、`confirmCount`、`textareas`、`pageErrors`）。

### 8.1 结论

| 检查项 | 结果 |
| --- | --- |
| 六项筛选逐项正确 | ✅ 7 / 2 / 1 / 3 / 2 / 12 与 fixture 一致 |
| 计数不随筛选改变 | ✅ 每一步 `filterCounts` 恒为 `12/7/2/1/3/2` |
| 任意时刻仅一个 `aria-pressed` | ✅ `pressedCount === 1` |
| 零数量仍可选 | ✅ 全 stable 档案下可选「待复习」，显示 0 行 |
| 无匹配提示 | ✅ 「当前筛选下没有知识点」，非空档案 |
| 取消切换 | ✅ 1 次 confirm，筛选仍为「全部」，草稿与编辑器保留 |
| 确认切换 | ✅ 1 次 confirm，切到「稳定」，编辑器卸载 |
| 保存中切换 | ✅ **0 次 confirm**，筛选不变，编辑器仍在 |
| 指定课程筛选 | ✅ 课程计数 3/2/1/0/1/0，筛选后仅 1 行；无编辑入口 |
| 切换课程重置 | ✅ `pressed = ["全部"]`，显示新课程数据 |
| 键盘 | ✅ Tab 落到「需要关注」，Space 选中并筛出 7 行 |
| 筛选行不裁切 | ✅ 全部场景 `filterOverflow = []` |
| 页面无横向滚动 | ✅ 全部场景 `documentOverflow = false` |
| 深色 / 英文 | ✅ 截图核对；英文标签无中文残留 |

---

## 9. 已知问题（不在本阶段范围）

1. **旧知识行在 390 / 320px 的固定列挤压**：`rowOverflow` 在 390、320 各记录 6 个节点（行头部按钮等），属 P2-2 已记录的既有问题，按任务书留给 P2-5。**新增筛选行本身在全部 19 个场景中溢出为 0**，页面亦无横向滚动——但这不能作为旧问题已修复的依据。
2. **`server.learning-generate.test.ts` 偶发**：本轮未复现，根因未确认。
3. **按知识点定向练习**：仍未实现（P2-3 §5.5 边界）。

---

## 10. 验收门槛核对

- [x] 六类筛选全部正确
- [x] 与概览统计口径一致（共享 `tallyKnowledgeStates`）
- [x] 只过滤数据，不改变业务状态（无写请求、无新接口）
- [x] 两种课程范围保持隔离
- [x] 指定课程保持只读
- [x] 草稿取消切换后完整保留
- [x] 保存进行中阻止切换
- [x] 原有编辑保护无退化（R1 全部用例通过）
- [x] 五档视口新增筛选器可读
- [x] 中英文与深浅主题通过
- [x] 新增及原有相关测试通过
- [x] TypeScript 与构建通过
- [x] 全量测试真实记录（2456 通过 / 1 失败 / 3 跳过）
- [x] 浏览器截图及指标已提交
- [x] 验收报告完整
- [ ] PR 已创建，未自动合并 —— 见 PR

**结论：P2-4 PASS。**
