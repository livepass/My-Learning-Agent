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

> **更正（E4.9i-P2-4-R1）**：新增用例实际为 **49** 项（18 纯函数 + 11 组件 + 20 页面/草稿），
> 原「45 项」少算了 `knowledge-filter.test.ts` 的 4 个用例。详见 `P2-4-test-count-audit.md`。

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
     Tests  1 failed | 2426 passed | 3 skipped (2430)
```

> **更正（E4.9i-P2-4-R1）**：本节最初写作「2456 passed / 2460 total」，与同一份日志的实际输出不符。
> 日志真实值为 **2426 / 1 / 3 / 2430**。差异来源见 `P2-4-test-count-audit.md`；下文表格已按真实值修正。

| 指标 | P2-3-R1 | P2-4 | 变化 |
| --- | ---: | ---: | --- |
| 收集总数 | 2381 | **2430** | **+49** |
| 通过 | 2377 | **2426** | +49 |
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
- [x] 全量测试真实记录（2430 收集 / 2426 通过 / 1 失败 / 3 跳过；见 §7.7 更正）
- [x] 浏览器截图及指标已提交
- [x] 验收报告完整
- [ ] PR 已创建，未自动合并 —— 见 PR

**结论：P2-4 PASS。**

---

# E4.9i-P2-4-R1 修正：被动筛选与编辑生命周期保护

## 11. R1 开发基准

| 项 | 值 |
| --- | --- |
| main 基准 | `c153d694c56b7ac23cb027cf322205ed09b370ba` |
| 开发分支 | `feat/e49i-p2-4-knowledge-filters`（沿用，未新建 PR） |
| P2-4 审查基准 | `d1af9781899da6c4f9ee71679d3b290eb6c2e1b2` |
| 开工核对 | 本地与远程均为 `d1af978`；`origin/main` 仍为 `c153d69`；工作区干净；PR 尚未创建 |
| 审查状态 | `REVIEW_CHANGES_REQUIRED`（F01–F05） |
| R1 代码提交 | 见 PR 描述 |

## 12. 修复前复现（先写测试，再改代码）

`react/profile/KnowledgeFilter.lifecycle.test.tsx` 的第一条用例先于任何生产代码改动写成：

```
初始：c1 = learning，筛选「需要关注」，进入编辑并修改诊断
刷新：服务端返回 c1 = stable（不再匹配）
```

**改前实测**：`Unable to find an element with the display value: 刷新前的草稿`
——`KnowledgeRow` 随筛选结果一起被卸载，草稿丢失。F01 由此确认为真实缺陷，而非静态推断。

> 首次尝试把「切换筛选」放在进入编辑之后，测试意外通过：切换本身触发了 `confirmLeave()`，
> jsdom 的 `window.confirm` 返回 falsy，切换被拒绝，编辑器因此没有被卸载。把顺序改为
> 「先切筛选、后进编辑」后，才复现了真正的被动路径。

## 13. F01 — 被动筛选更新保护

### 13.1 设计

`KnowledgeDraftGuard` 新增两个只读接口，仍使用同一张注册表、同一写入路径：

```ts
subscribe(listener) => unsubscribe   // 仅当「打开中的编辑器集合」变化时通知
getSnapshot() => string              // 排序后以 \u0000 连接的 concept_id 串
```

配合新 hook：

```ts
useOpenKnowledgeEditors(): Set<string>   // useSyncExternalStore 读取上述快照
```

容器据此把「打开中的编辑器」并入可见列表：

```text
matchedStates       = filterKnowledgeStates(knowledge, filter)      // 正式结果
protectedEditorStates = 打开编辑中、且不在 matchedStates 中的记录     // 仅渲染保护
visibleStates       = matchedStates ∪ protectedEditorStates         // 每个 concept_id 只出现一次
```

约束落实：

| 要求 | 实现 |
| --- | --- |
| 每个 `concept_id` 只渲染一次 | `matchedIds` Set 去重；受保护行只补充不重复 |
| 保持相同 React key | 行仍以 `concept_id` 为 key，未换父容器，编辑器不重挂载 |
| 正式结果保持服务端顺序 | `matchedStates` 原样；受保护行**追加在末尾** |
| 受保护行不计入筛选数量 | `countKnowledgeFilters(knowledge)` 始终基于完整列表，与保护无关 |
| 不新增服务端字段 / 不改状态 | 纯前端渲染决策 |
| 不伪造分类 | 受保护行显示服务端最后一次给出的真实状态 |

### 13.2 注册时机（避免闪烁卸载）

`KnowledgeEditPanel` 原先在 `[dirty, saving]` 变化时重新注册，每次都会先执行上一次的清理函数，
导致 concept 短暂从注册表消失。若容器在那一帧读取快照，就会把行卸载。

现改为**每次挂载只注册一次**，注册对象为稳定的可变引用，effect 内只同步字段：

```ts
const statusRef = useRef({ conceptId, dirty, saving });
statusRef.current.dirty = dirty;
statusRef.current.saving = saving;
useEffect(() => guard.register(statusRef.current), [guard, state.concept_id]);
```

注销回调也加了身份校验，旧清理不会误删新注册：

```ts
if (editors.current.get(status.conceptId) !== status) return;
```

### 13.3 主动切换 vs 被动更新

保护只针对**被动**变化。主动切换时学习者已被询问并确认，因此：

```ts
const hidden = 打开编辑中的 id 中，不在「新筛选结果」里的那些
setDiscarded(prev ∪ hidden)   // 这些行允许卸载
setFilter(next)
```

`discarded` 中的 id 会在其编辑器真正卸载后自动清除，之后再次编辑仍受保护。

### 13.4 记录已从档案中消失

若最新档案不再包含该 `concept_id`，行没有数据可渲染。容器用 `lastKnown`（ref 缓存）保留最后一次
看到的记录，只为**受保护行**提供渲染数据；该行显示专用提示，且不计入任何匹配数量。

## 14. F02 — G09 真实异步保存

`R11/G09` 用可控 Promise 走完整流程：`需要关注` → 编辑 → 保存（挂起）→ 断言编辑器仍挂载 →
返回 `stable` → 断言行移出筛选、`稳定` 计数 +1、编辑器关闭、写请求恰好 1 次 → 切到 `稳定` 验证内容。

`R14` 固定「保存进行中切换被拒绝且不弹确认」；`R16` 固定单次写入。未使用固定延迟，未提前卸载。

## 15. F03 — 主动切换的草稿策略

| 场景 | 行为 | 测试 |
| --- | --- | --- |
| 切换后仍匹配 | 保留编辑器与草稿，不发送保存 | R17 |
| 切换后不匹配 | 确认一次后移除该行与其草稿 | R18（G04）、R19 |
| 多草稿部分匹配 | 保留匹配项草稿，仅丢弃被隐藏项 | R19 |
| 多草稿取消 | 两份草稿全部保留 | R20 |
| 重复选择当前筛选 | 不确认、不重置 | R21（G10） |
| 取消课程切换 | 保留非 all 筛选与草稿 | R22 |

确认文案：筛选切换使用专用 `profile.knowledge.filters.switchConfirm`
（「切换筛选可能隐藏正在编辑的知识点，隐藏项的未保存内容将丢失。是否继续？」），
折叠与课程切换仍用原 `discardConfirm`，语义未变。

## 16. F04 — 完全空档案

| 数据情况 | 行为 | 测试 |
| --- | --- | --- |
| 当前范围无知识点 | 隐藏筛选器，显示档案空状态 | R23、R24、R1 浏览器 `r1-empty-profile` |
| 有知识点但某筛选为 0 | 保留筛选器，可选中 | R25 |
| 当前筛选无匹配 | 显示筛选空结果 | P2-4 I10 |
| 数据变为空但有受保护草稿 | 保留该编辑区直到安全结束 | R10 |
| 加载失败且无缓存 | 显示错误，不伪造筛选数据 | P2-4 I10 的刷新失败用例 |

`knowledge.length === 0` 的提前返回已加上 `&& protectedRows.length === 0`，不会绕过编辑保护。

## 17. F05 — 测试数量审计

完整审计见 `docs/ui-redesign/phase5/P2-4-test-count-audit.md`。结论：

- 静态收集：`c153d69` 2378 → `d1af978` 2427，**+49**；新增全部来自 3 个新文件，无删除、无重复、无改名。
- 报告原写「45 项」少算了 `knowledge-filter.test.ts` 的 4 个用例（应为 18，不是 14）。
- 报告原写「2456 通过 / 2460 总数」与同一份日志不符，日志真实值为 **2426 / 2430**；已在 §7.7 更正。
- 未解释的「34 项差异」不存在：49 是唯一增量；通过数曾出现 +74 是因为 25 个 Mermaid 相关用例在并行下
  由 skip 变为 passed（环境时序），与 P2-4 代码无关。

## 18. R01–R30 覆盖对照

| 编号 | 用例 | 结果 |
| --- | --- | --- |
| R01 | learning 草稿刷新后变 stable | ✅ |
| R02 | review_due 草稿刷新后变 unknown | ✅ |
| R03 | 刷新后仍匹配 | ✅ |
| R04 | 刷新失败 | ✅ |
| R05 | 保存期间刷新并改变状态 | ✅ 浏览器 `r1-save-in-flight` |
| R06 | 受保护行不计入匹配数 | ✅ |
| R07 | 编辑结束后不再匹配则移除 | ✅ |
| R08 | 多受保护行无重复无丢失 | ✅ |
| R09 | 知识点从最新档案消失 | ✅ |
| R10 | 完整列表变为空 | ✅ |
| R11/G09 | 异步保存返回不同状态 | ✅ |
| R12 | 保存成功仍匹配 | ✅ |
| R13 | 保存失败且状态已变 | ✅ |
| R14 | 保存期间主动切换 | ✅ |
| R15 | 保存后计数更新 | ✅（R11 内断言） |
| R16 | 写请求次数 | ✅ |
| R17 | 确认切换后仍匹配 | ✅ |
| R18 | 确认切换后不匹配 | ✅（G04） |
| R19 | 多草稿部分匹配 | ✅ |
| R20 | 多草稿取消 | ✅ |
| R21 | 重复选择当前筛选 | ✅（G10） |
| R22 | 取消课程切换 | ✅ |
| R23 | 全部课程空档案 | ✅ |
| R24 | 指定课程空档案 | ✅（含 R24b 非空对照） |
| R25 | 零数量筛选可选 | ✅ |
| R26 | Guard 注册注销 | ✅（R07/R08/R27 + 既有 guard 用例） |
| R27 | 语言切换后保护仍生效 | ✅ |
| R28–R30 | 原有 P2-2-R1 / P2-3-R1 / P2-4 用例 | ✅ 全部通过 |

## 19. 测试与构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | ✅ 0 错误 |
| 定向（profile + 三份面板测试 + i18n） | ✅ 15 文件 / **240 项** |
| 新增 `KnowledgeFilter.lifecycle.test.tsx` | ✅ 23 项 |
| 改前对照 | 22 项新用例中 **9 项失败**（F01 7、F02 1、F03/R27 1） |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | ✅ |
| `npx vitest run`（`.tmp/p2-4-r1-full.json`） | 211 文件 / **2453 收集** / **2449 通过 / 1 失败 / 3 跳过** |

唯一失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（历史失败）。
`apps/learning-agent/src` 相对 `c153d69` 为 0 行改动。本轮未出现 Mermaid 时序失败。

相对 P2-4 的 2430：+23，与新增用例数一致；通过 2426 → 2449（+23）。

## 20. 浏览器专项复验

脚本 `docs/ui-redesign/phase5/scripts/qa_p2_4.py` 保留原 19 个场景（全部仍通过），
新增 10 个 R1 场景，写入独立的 `r1-browser-metrics.json`，未覆盖 P2-4 截图与指标。
受控 fixture，不读写真实档案。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `r1-refresh-state-changed.png` | 1440×900 | 刷新改变状态后草稿仍在 |
| `r1-protected-editor.png` | 1440×900 | 受保护行提示 |
| `r1-save-in-flight.png` | 1440×900 | 保存中且已被移出筛选 |
| `r1-save-state-changed.png` | 1440×900 | 保存成功后移出筛选 |
| `r1-save-failed.png` | 1440×900 | 保存失败保留草稿 |
| `r1-retained-draft.png` | 1440×900 | 主动切换后仍匹配 |
| `r1-multiple-drafts.png` | 1440×900 | 多草稿部分匹配 |
| `r1-empty-profile.png` | 1440×900 | 完全空档案 |
| `r1-mobile-320.png` | 320×640 | 极窄屏受保护行 |
| `r1-desktop-en.png` | 1440×900 | 英文保护提示 |

指标（`r1-browser-metrics.json`）实测：

| 场景 | 选中筛选 | 可见行 | 受保护行 | 重复 id | 筛选行溢出 | 页面横向溢出 | confirm |
| --- | --- | ---: | ---: | --- | --- | --- | ---: |
| refresh-state-changed | 需要关注 | 7 | 1 | 无 | 0 | 否 | 0 |
| protected-editor | 需要关注 | 7 | 1 | 无 | 0 | 否 | 0 |
| save-in-flight | 需要关注 | 7 | 1 | 无 | 0 | 否 | 0 |
| save-state-changed | 需要关注 | 0 | 0 | 无 | 0 | 否 | 0 |
| save-failed | 需要关注 | 1 | 0 | 无 | 0 | 否 | 0 |
| retained-draft | 需要关注 | 1 | 0 | 无 | 0 | 否 | 1 |
| multiple-drafts | 稳定 | 1 | 0 | 无 | 0 | 否 | 1 |
| empty-profile | —（无筛选器） | 0 | 0 | 无 | 0 | 否 | 0 |
| mobile-320 | 需要关注 | 7 | 1 | 无 | 0 | 否 | 0 |
| english | Needs attention | 7 | 1 | 无 | 0 | 否 | 0 |

全部场景无 JS 页面错误，无重复 `concept_id`，筛选行无裁切。

## 21. 未解决问题与范围限制

1. **320 / 390px 旧知识行固定列挤压**：仍在，属 P2-5 范围。本轮未改 `KnowledgeRow` 的列布局；
   新增筛选器与保护提示均无溢出，但这不代表旧问题已修复。
2. **Mermaid 运行时预热的时序不稳定**：审计时在 worktree 中观察到 25 个用例在 skip/passed 之间摆动；
   本轮全量运行未出现。根因未确认，单独记录。
3. **`server.e48-workbench.test.ts` 历史失败**：仍存在，未删除、跳过或放宽。
4. **P2-4 报告中 2456/2460 的来源**：`UNRESOLVED`，已在 §7.7 与审计文档中更正为真实值。

## 22. R1 合并门槛

- [x] 被动筛选更新不丢失草稿
- [x] 保存期间编辑器保持挂载
- [x] G09 真实异步场景通过
- [x] 保存成功后安全移除不匹配知识点
- [x] 保存失败后保留编辑内容
- [x] 受保护行不污染正式筛选计数
- [x] 不存在重复知识行
- [x] 全部课程与指定课程隔离
- [x] 主动筛选确认语义正确
- [x] 完全空档案行为明确
- [x] 测试数量差异已核查并如实说明
- [x] 原有编辑保护无退化
- [x] 新增回归测试通过
- [x] TypeScript 与构建通过
- [x] 浏览器专项复验完成
- [x] R1 验收报告完整
- [ ] PR 已创建或更新 —— 分支已推送，PR 未创建（`gh` 未登录）
- [x] PR 未自动合并（当前无 PR，未合并任何内容）

**结论：P2-4-R1 PASS_WITH_KNOWN_BASELINE_FAILURE**（仅保留已核实的 `server.e48-workbench.test.ts` 历史失败）。

---

# E4.9i-P2-4-R2 修正：消失知识点的保存限制

## 23. R2 开发基准与远程状态核对

任务书给出的基准与远程实际状态不一致，以**实际核实结果**为准：

| 项 | 任务书 | 实际 |
| --- | --- | --- |
| 当前 main | `1f49aa76283f9d30e0f907ffe0cbb31d8d03ac0b`（PR #19） | `d474343824f4af56a3042c8360361ef6b8cfa56b`（`Merge pull request #20`） |
| R1 是否已合并 | 尚未合并 | **已合并**：`4d6f0b8`、`9d38adc` 均为 main 祖先 |
| 开发分支 | `feat/e49i-p2-4-knowledge-filters` | 一致，HEAD `9d38adc` |
| 工作区 | 干净 | 干净（开工时 `git status --short` 无输出） |

`git merge-base --is-ancestor 9d38adc origin/main` 返回真，说明 R1 已随 PR #20 进入 main。
因此本轮**只提交尚未合并的 R2 内容**，未重开 PR #19，未改写历史基准，未强制推送。

`origin/main` 在 R1 之后没有其它新增提交，无冲突需要处理。

## 24. F06 — 消失知识点不得保存

### 24.1 修复前复现

先写测试，再改生产代码。`KnowledgeFilter.lifecycle.test.tsx` 新增 R2 用例后在**未改动生产代码**时运行：

```text
Tests  4 failed | 14 passed | 14 skipped (32)
```

四个失败全部停在 `expect(saveButton().disabled).toBe(true)`，实际为 `false`：

| 用例 | 失败断言 |
| --- | --- |
| S01–S04 | 保存按钮未禁用 |
| S07–S08 | 重新出现前按钮未禁用 |
| S10 | 在途失败后按钮未禁用 |
| S12 | 空列表时按钮未禁用 |

仅凭 `disabled` 不足以证明「会发出请求」，因此另用一次性探针（先点击再断言，事后删除，未进入提交）实测改前行为：

```text
PROBE updateKnowledge calls: 1 [["c1",{"diagnosis":"消失前的草稿","next_actions":[],"mastery":0.5}]]
```

即改前确实向已从档案消失的 `concept_id` 发送了 PATCH。F06 为真实缺陷，不是静态推断。

### 24.2 修复：双重保护

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 第一层 | `KnowledgeEditPanel` 新增 `saveDisabled` | 按钮 `disabled={saving || saveDisabled}` |
| 第二层 | `KnowledgeEditPanel.submit()` | `if (saving || saveDisabled) return;` |
| 第三层 | `KnowledgeRow.save()` | `if (missingFromProfile) return;` |

`KnowledgeRow` 以 `missingFromProfile` 传入 `saveDisabled`。三层都保留 `onSave`，因此编辑器不会因
「只读」而卸载；`onSave` 仍是决定是否渲染编辑组件的那一个条件。

### 24.3 编辑器保留

| 功能 | 行为 |
| --- | --- |
| 编辑器挂载 | 保持 |
| 诊断 / 下一步 / mastery 草稿 | 完整保留 |
| 文本复制 | 正常 |
| 保存按钮 | 禁用 |
| 新保存请求 | 三层拦截，0 次 |
| 取消 / 筛选切换 / 课程切换 | 沿用既有保护 |

### 24.4 提示文案

复用 `profile.knowledge.missingDraft`，最小范围改为明确「无法保存」：

- zh-CN：「该知识点已不在最新档案中，暂时无法保存。你可以复制当前编辑内容。」
- en："The concept is no longer in the latest profile. Saving is unavailable. You can copy your current draft."

未声称服务端已永久删除该知识点。

## 25. 在途请求与重新出现

| 情形 | 实现与验证 |
| --- | --- |
| 保存中记录消失 | `save()` 已在途，`missingFromProfile` 只影响**新**请求；编辑器保持到请求结束（S09） |
| 在途失败 | 草稿保留、`alert` 显示、按钮保持禁用，不能重试（S10） |
| 在途成功 | 沿用既有「仅当仍处于 editing 才回到 reading」的结束机制；不重建记录（S11） |
| 记录重新出现 | `missingFromProfile` 变回 false，按钮恢复可用、草稿不重置、不自动保存（S07–S08） |

未引入请求取消或服务端并发控制协议。

## 26. F07 — G09 补齐保存内容验证

原 G09 只断言切到「稳定」后能看到知识点名称，无法发现「保存的诊断没有回到列表」这类问题。本轮补充：

1. PATCH 载荷包含草稿诊断（`expect.objectContaining({ diagnosis: "保存后的诊断" })`）。
2. 切至「稳定」后展开该行，断言处于阅读态。
3. 断言显示的是**保存后的诊断**文本。
4. 断言不存在编辑输入控件（`queryByRole("slider")` 为 null）。
5. 断言写请求总数仍为 1。

**变异验证**：临时把 store 的合并改成 `{ ...updated, diagnosis: k.diagnosis }`（即保存的诊断不写回列表），
新增断言立刻失败（`Unable to find an element with the text: 保存后的诊断`），恢复后通过。
说明新断言确实覆盖了原用例漏掉的回归，且未降低原断言强度。

## 27. F08 — 文档与 PR 状态

- 本报告与 `P2-4-pr-body.md` 均已追加 R2 章节。
- 明确记录：**P2-4 已随 PR #19 合并**（`1f49aa7`）；**R1 已随 PR #20 合并**（`d474343`）；
  **R2 为当前未合并内容**。
- 历史开发基准（`c153d69`）与历史审查基准（`d1af978`、`9d38adc`）保留未改。
- 未尝试重开或重复合并 PR #19。

## 28. S01–S22 覆盖对照

| 编号 | 场景 | 覆盖位置 |
| --- | --- | --- |
| S01 | 知识点消失，原草稿保留 | `S01–S04` |
| S02 | 消失记录保存按钮禁用 | `S01–S04`、`S12` |
| S03 | 尝试保存消失记录不发 PATCH | `S01–S04`、`S12` |
| S04 | 提示明确无法保存 | `S01–S04` |
| S05 | 取消但拒绝放弃 | `S05` |
| S06 | 确认放弃后安全关闭 | `S06` |
| S07 | 重新出现恢复保存资格 | `S07–S08` |
| S08 | 重新出现草稿不丢失 | `S07–S08` |
| S09 | 保存期间消失不提前卸载 | `S09–S11` |
| S10 | 在途失败保留草稿、禁止再次保存 | `S10` |
| S11 | 在途成功安全结束、不重建 | `S09–S11` |
| S12 | 完整列表变空仍保留草稿且禁止保存 | `S12` |
| S13 | G09 保存返回新状态退出筛选 | `R11/G09` |
| S14 | 切至稳定并展开显示保存后诊断 | `R11/G09` |
| S15 | 保存请求次数恰好一次 | `R11/G09`、`S17`、`S18` |
| S16 | 保存完成后为阅读态 | `R11/G09`、`R12` |
| S17 | 正常存在知识点保存不受影响 | `S17` |
| S18 | 状态变化但记录仍存在仍可保存 | `S18` |
| S19 | R1 生命周期测试全通过 | 同文件 32/32 |
| S20 | P2-2-R1 编辑保护 | 回归套件 |
| S21 | P2-3-R1 概览测试 | 回归套件 |
| S22 | P2-4 原筛选测试 | 回归套件 |

按任务书 §6 说明，编号是覆盖矩阵，不要求一一对应独立测试函数；未为凑数重复相同断言。

## 29. 浏览器专项复验（R2）

`qa_p2_4.py` 保留原 19 个 P2-4 场景与 10 个 R1 场景，新增 6 个 R2 场景，写入独立的
`r2-browser-metrics.json`。全部受控 fixture，不读写真实档案。

| 截图 | 场景 | 关键断言 |
| --- | --- | --- |
| `r2-missing-draft.png` | 消失知识点草稿保留 | `draftPreserved`、`missingFromProfile`、受保护行 1 |
| `r2-missing-save-disabled.png` | 保存控件禁用 | `saveDisabled=true`，程序化点击后 `saveRequestCount=0` |
| `r2-missing-save-in-flight.png` | 保存过程中记录消失 | 编辑器未卸载、在途请求 1 次、按钮禁用 |
| `r2-restored-concept.png` | 恢复后可保存 | 恢复前禁用 → 恢复后可用并成功写入 1 次 |
| `r2-mobile-320.png` | 320px 消失记录提示 | 无横向溢出、`filterOverflow=[]`、按钮禁用 |
| `r2-desktop-en.png` | 英文保存限制提示 | 含 "Saving is unavailable"、无中文泄漏 |

全部场景：`duplicateConceptIds=[]`，无页面错误。

> 首次运行覆盖了 P2-4 / R1 的截图与指标文件；已用 `git checkout --` 全部还原，
> 现有 R2 提交只新增 `r2-*` 文件。

## 30. 实际测试与构建结果

全部为本轮真实执行输出，未预先填写预测值。

| 命令 | 结果 |
| --- | --- |
| `KnowledgeFilter.lifecycle.test.tsx`（改前） | 32 收集：**4 失败 / 14 通过 / 14 跳过** |
| `KnowledgeFilter.lifecycle.test.tsx`（改后） | **32 通过** |
| 定向回归（`react/profile/` + 两个 `LearnerProfilePanel.*.test.tsx`） | 13 文件 / **238 通过** |
| P2-4 / P2-3 原筛选与概览测试 | 5 文件 / **102 通过** |
| `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json` | 退出码 0 |
| `npm --workspace my-learning-agent-web run build` | 成功（约 1m27s） |
| `npm run build` | 成功（约 1m36s） |

## 31. 最终测试与构建记录

### 31.1 收集数量核对

`npx vitest list --json`：**2459** 条（全部 `mode = run`，无 `skip` / `todo` 声明）。
全量运行的 `numTotalTests` 为 **2462**，差额 3 条为运行期跳过（`mermaid` 等条件跳过），与历史一致。

与 R1 的 2453 相比 **+9**，全部来自 `KnowledgeFilter.lifecycle.test.tsx` 的 23 → 32 条新增 R2 用例，
没有新增其它文件、没有删除用例。数字自洽，无需额外解释。

### 31.2 全量运行

| 项 | 值 |
| --- | --- |
| 收集 | 2462（211 个文件） |
| 通过 | 2457 |
| 失败 | 2 |
| 跳过 | 3 |

失败项：

1. `server.e48-workbench.test.ts` → `E4.8a — course status gates chat writes > allows an in_progress course to continue chatting`
   —— 已核实的历史失败，P2-3-R1 / P2-4 / P2-4-R1 三次全量均存在。
2. `server.learning-http.test.ts` → `learning checkpoint HTTP API > persists the first auto-generated title for a brand-new session`
   —— **本轮新出现的失败**。该用例为「聊天后由后台任务异步生成标题」，自带 75s 轮询窗口；
   单独运行该文件 **12/12 通过**，仅在全量并行负载下超时。本轮改动全部位于 `apps/learning-agent/web/`
   （前端），`apps/learning-agent/src/` 零改动，无法影响该后端行为。归为并行负载下的时序不稳定，已如实记录，未修改、未跳过、未放宽。

> 该结论以**两次全量运行**为依据，见 §31.3。

### 31.3 第二次全量运行（复跑）

同一工作区、同一命令再跑一次：

| 项 | 第一次 | 第二次 |
| --- | --- | --- |
| 收集 | 2462（211 文件） | 2462（211 文件） |
| 通过 | 2457 | **2458** |
| 失败 | 2 | **1** |
| 跳过 | 3 | 3 |

第二次的失败**只剩** `server.e48-workbench.test.ts` 的历史失败。`server.learning-http.test.ts` 的
自动标题用例本次通过，证实 §31.2 第 2 项确为并行负载下的时序不稳定，而非本轮引入的回归：

- 该用例自带 75s 轮询窗口，等待后台 fire-and-forget 任务落盘；
- 单独运行该文件 12/12 通过；
- 两次全量之间仅「是否超时」不同，代码与用例完全未变；
- 本轮 `apps/learning-agent/src/` 零改动。

因此最终以第二次运行作为结论依据：**仅保留 1 项已核实历史失败**。

### 31.4 结论

**`P2-4-R2 PASS_WITH_KNOWN_BASELINE_FAILURE`** —— 唯一失败为 `server.e48-workbench.test.ts`
的既有失败（P2-3-R1 / P2-4 / P2-4-R1 三次全量均存在），未删除、未跳过、未放宽。

## 32. 未解决问题

1. `server.e48-workbench.test.ts` 的 `allows an in_progress course to continue chatting` 仍失败，历史技术债，未删除或跳过。
2. Mermaid 运行时预热导致的 skip/passed 摆动：本轮全量未出现，根因仍未确认。
3. 320 / 390px 旧知识行固定列挤压仍在，属 P2-5 范围。
4. 保存资格以「最新一次档案读取」为准：若服务端在 PATCH 在途期间删除记录且请求成功，本轮按既有安全机制结束编辑，不重建记录；未引入并发控制协议（任务书 §3.7 明确不在范围）。

## 33. R2 合并门槛

- [x] 消失知识点的编辑器保持挂载
- [x] 未保存草稿完整保留
- [x] 消失知识点无法发送新保存请求（按钮 + 提交 + 行入口三层）
- [x] 在途请求正常结束
- [x] 保存失败后草稿仍受保护
- [x] 知识点重新出现后恢复保存资格
- [x] G09 验证实际保存内容
- [x] 原有正常保存行为无退化
- [x] 原有筛选逻辑无退化
- [x] 原有草稿保护无退化
- [x] 课程数据隔离无退化
- [x] 新增及相关回归测试通过
- [x] TypeScript 检查通过
- [x] Web 构建通过
- [x] 完整构建通过
- [x] 全量测试结果真实记录（两次运行均记录，见 §31.2–31.3）
- [x] 浏览器专项复验完成
- [x] 验收报告及 PR 状态正确
- [ ] R1/R2 新修复 PR 已创建 —— **阻塞**：`gh auth status` 返回 "You are not logged into any GitHub hosts"，分支已推送，PR 正文已备好（任务书 §12 允许记录阻塞，未声称 PR 已创建）
- [x] 未自动合并
