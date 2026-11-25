# E4.9i-P2-3 验收报告：学习概览结论与薄弱知识展示

- **任务**：E4.9i-P2-3
- **基准分支**：`main`
- **基准 SHA**：`a0e063f7f8569551612f675e107e0795b5acc69f`
- **工作分支**：`feat/e49i-p2-3-profile-overview`
- **参考设计**：`docs/ui-redesign/phase5/prototype-a.html`（方案 A「概览优先」）
- **结论**：**P2-3 PASS**（全量测试仅剩 1 项历史失败，见 §7.4）

---

## 1. 基准与最终 SHA

| 项 | 值 |
| --- | --- |
| 基准 `origin/main` | `a0e063f7f8569551612f675e107e0795b5acc69f` |
| 开工前核对 | `git rev-parse origin/main` = 基准，**未变化** |
| 新建分支 | `feat/e49i-p2-3-profile-overview`（自 `origin/main` 切出） |
| 开工工作区 | 干净 |
| 最终提交 | 见 PR 描述 |

---

## 2. 实际修改文件

### 2.1 新增

| 文件 | 职责 |
| --- | --- |
| `react/profile/profile-overview.ts` | 纯计算：`deriveProfileOverview(profile)` |
| `react/profile/ProfileConclusion.tsx` | 概览结论（两层结构） |
| `react/profile/WeakKnowledgeSection.tsx` | 需要关注的知识点（只读展示） |
| `react/profile/profile-overview.test.ts` | 计算规则单测（16） |
| `react/profile/ProfileConclusion.test.tsx` | 结论分支单测（10） |
| `react/profile/WeakKnowledgeSection.test.tsx` | 弱项展示单测（18） |
| `docs/ui-redesign/phase5/scripts/qa_p2_3.py` | 可复现的 Chromium 验收脚本 |

### 2.2 修改

| 文件 | 修改内容 |
| --- | --- |
| `react/LearnerProfilePanel.tsx` | 接入结论与弱项卡；四项统计改读 `deriveProfileOverview`；刷新中/失败时暂停结论 |
| `i18n/locales/zh-CN.json` | 新增 `profile.conclusion.*`、`profile.weak.*` |
| `i18n/locales/en.json` | 同上（含 `_one`/`_other` 复数） |
| `react/LearnerProfilePanel.summary.test.tsx` | 新增概览集成回归 I01–I08 |
| `react/LearnerProfilePanel.knowledge-state.test.tsx` | 查询限定到知识区块（见 §6.1） |
| `react/profile/KnowledgeList.page.test.tsx` | 新增课程视图不含全部课程概览的回归 |

### 2.3 未修改（冻结模块）

`KnowledgeList.tsx`、`KnowledgeRow.tsx`、`KnowledgeDraftGuard.tsx`、`CourseLearnerPanel.tsx`、`PracticePage.tsx`、后端学习与记忆代码：**0 行改动**。`git diff origin/main -- apps/learning-agent/src` 为空。

---

## 3. 数据来源与计算规则

唯一来源 `learnerStore.profile`；全部结论由 `deriveProfileOverview` 一次算出，四项原有统计与结论句共用同一结果，不会出现「数字与句子不一致」。

| 计数 | 规则 |
| --- | --- |
| `activeGoals` | `goals[].status === "active"` |
| `totalConcepts` | `knowledge_states.length` |
| `reviewDueStates` | `normalizeKnowledgeStateLabel === "review_due"`（分类计数，非到期判定） |
| `openMisconceptions` | `misconceptions[].status ∈ {active, repairing}` |
| `weakCount` / `weakConcepts` | `isWeakKnowledgeState()`（learning / fragile / review_due / misconception） |
| `stableCount` | `stable` |
| `unknownCount` | `normalizeKnowledgeStateLabel === "unknown"`（缺失/空/未识别全部归此） |
| `misconceptionStateCount` | `state_label === "misconception"`，与误区记录数分开统计 |

复用而非复制：`normalizeKnowledgeStateLabel()`、`isWeakKnowledgeState()`、`KnowledgeStateBadge`、`KnowledgeState`、`LearnerProfile`。纯函数：无 `Date.now()`、无接口、无 store、不改入参（测试验证 `JSON.stringify` 前后一致）。

---

## 4. 结论文案分支

| 数据情况 | 实际输出（zh-CN） |
| --- | --- |
| 无知识点 | 还没有已记录的知识点。+ 生成说明 + 口径说明 |
| 仅 stable | 共记录 N 个知识点，M 个状态稳定。当前没有标记为需要关注的知识点。 |
| 仅弱项 | 共记录 N 个知识点，其中 M 个需要关注。 |
| 仅 unknown | … K 个证据不足。当前知识点都缺少可判断的状态，无法据此评价学习情况。 |
| 稳定+薄弱混合 | 共记录 N 个知识点，其中 M 个需要关注，S 个状态稳定。 |
| 有 review_due | 其中 R 个处于待复习状态；是否符合正式到期复习资格，以今日学习中的服务端结果为准。 |
| 有未解决误区记录 | 另有 X 条未解决的误区记录，可在「误解记录」中查看。（与「存在误区知识点」分开） |
| 状态缺失/未识别 | 归入证据不足，不猜测 |

固定口径说明：「以上为当前学习档案的分类统计，不代表练习正确率或正式到期复习资格。」

测试中显式断言**禁止出现的结论**（`ProfileConclusion.test.tsx` 的 `FORBIDDEN` 列表）：已经掌握全部知识 / 全部掌握 / 正确率达到 / 学习成绩提升 / 今天必须复习 / AI 分析认为 / 已通过到期复习资格核查。

---

## 5. 薄弱知识区块

- 标题：**需要关注的知识点**（与指定课程视图 `course.learner.weakTitle` 同义，但组件独立，未改动课程视图）。
- 每行：名称、领域（有值时）、正式状态徽章、`next_actions[0]`。
- `next_actions` 为空 → 「暂无记录的下一步动作。」；**不**用 `diagnosis` 顶替（W08 断言诊断文本不出现）。
- 顺序 = 服务端数组顺序；不按 mastery 重排（W02、`profile-overview.test.ts`）。
- 默认展示前 3 条，超出注明「另有 N 个需要关注的知识点，可在上方「知识状态」中查看。」（W03）。
- 名称空/空白 → 「知识点名称待确认」，不泄露 `concept_id`（W10）。
- 长名称换行：`[overflow-wrap:anywhere]`，无 `truncate`（W11；320px 浏览器实测全部名称 `h > 24`、`w ≤ 320`）。
- 空状态三分支：无记录 / 无弱项 / 无弱项但有 unknown（W12–W14）。
- **无任何按钮、链接、滑块、输入框**（W15；浏览器 `weakButtons === 0`）。
- 不提供按知识点定向练习：本阶段无该导航协议，不伪装普通练习、不绕过复习资格。

---

## 6. 页面集成

结构（与方案 A 一致）：概览（结论 → 四项统计 → 口径 → 摘要）→ 知识状态 → **需要关注的知识点** → 学习目标 → 误解记录 → 学习偏好。浏览器实测 `sectionTitles == ["概览","知识状态","需要关注的知识点","学习目标","误解记录","学习偏好"]`。

### 6.1 关于既有测试的查询范围

新增弱项卡会让同一知识点在「知识状态」与「需要关注的知识点」各出现一次（指定课程视图自 E4.5e 起即如此）。因此 `LearnerProfilePanel.knowledge-state.test.tsx` 的 `getByText(name)` 改为在知识区块内定位。**断言本身未删除、未放宽**，只收窄了查找范围。

### 6.2 加载与错误

`learnerStore.load()` 失败时保留旧 `profile` 并设置 `error`。据此定义 `ConclusionsState`：

| 状态 | 条件 | 结论/弱项 | 其它 |
| --- | --- | --- | --- |
| `loading` | 无 profile | 不渲染 | 显示加载中 |
| `refreshing` | 有 profile 且 `isLoading` | 暂停，提示「正在读取最新学习档案…」 | 统计与知识列表保留 |
| `failed` | `error` 非空 | 暂停，提示「本次刷新失败…」 | 错误卡补充「下方仍是此前成功读取的数据，可能已过期…」 |
| `ready` | 其余 | 正常生成 | — |

- 首次失败不填充任何本地缓存（I07）。
- 错误展示不卸载知识列表，未保存草稿不受影响（P2-2-R1 用例全绿）。
- 刷新按钮复用现有能力重试。

---

## 7. 测试结果

### 7.1 新增（全部通过）

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| `profile/profile-overview.test.ts` | T01–T12 + 目标/顺序/不变性/合计 4 条 | ✅ 16 / 16 |
| `profile/ProfileConclusion.test.tsx` | C01–C10 | ✅ 10 / 10 |
| `profile/WeakKnowledgeSection.test.tsx` | W01–W17（含 W01b） | ✅ 18 / 18 |
| `LearnerProfilePanel.summary.test.tsx`（新增段） | I01–I08（含 I06b） | ✅ 9 / 9 |

任务书 8.1 的 T01–T12 与 8.2 的薄弱项清单均已覆盖；8.3 集成回归由 I01–I08 + 既有 R1/课程隔离用例承担。

### 7.2 回归（全部通过）

| 文件 | 结果 |
| --- | --- |
| `LearnerProfilePanel.summary.test.tsx`（原有段） | ✅ 8 / 8 |
| `LearnerProfilePanel.knowledge-state.test.tsx` | ✅ 16 / 16 |
| `profile/KnowledgeList.test.tsx` | ✅ 22 / 22 |
| `profile/KnowledgeList.page.test.tsx` | ✅ 7 / 7（含新增课程视图回归） |
| `profile/KnowledgeDraftGuard.test.tsx` | ✅ 16 / 16 |
| `profile/KnowledgeDraftGuard.page.test.tsx` | ✅ 10 / 10 |
| `pages/ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `i18n/locales.test.ts` | ✅ 8 / 8 |

### 7.3 TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | ✅ 0 错误 |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build`（后端+前端） | ✅ |

### 7.4 全量测试

`npx vitest run`（代码定稿后单次运行，`.tmp/p2-3-full-test-3.log`）：

```
Test Files  1 failed | 206 passed (207)
     Tests  1 failed | 2352 passed | 3 skipped (2356)
```

- 失败 1 项：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`。
- 任务书基线：2298 通过、1 失败、3 跳过。本轮 **2352 通过（+54）**，失败与跳过数**不变**。
- 已知历史失败：`server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`。本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行，无法触及该路径；未跳过、未删除、未放宽。

另有一次并行负载下的偶发：`server.learning-generate.test.ts` › `keeps the same concept name apart in two courses…`（`expected 503 to be 201`）。单文件复跑 5/5 通过；本轮未修改其后端路径。作为独立技术债记录，根因未确认。

---

## 8. 真实浏览器验收

Playwright + Chromium 驱动**真实 React 页面**（`http://127.0.0.1:5193/?page=profile`，隔离 Vite 实例，端口 5193），全部 `/api/**` 由 `page.route` 以受控 fixture 应答：**不读取、不写入真实学习档案，无需后端**。脚本：`docs/ui-redesign/phase5/scripts/qa_p2_3.py`。页面无 JS 错误。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `p23-desktop-overview.png` | 1440×900 | 混合状态总览 |
| `p23-desktop-weak.png` | 1440×900 | 薄弱知识区块（完整可见） |
| `p23-desktop-empty.png` | 1440×900 | 无知识记录 |
| `p23-desktop-no-weak.png` | 1440×900 | 无薄弱分类（全 stable） |
| `p23-desktop-unknown.png` | 1440×900 | 仅证据不足 |
| `p23-desktop-error.png` | 1440×900 | 首次读取失败 |
| `p23-desktop-refresh-failed.png` | 1440×900 | 刷新失败，旧数据仍在、结论暂停 |
| `p23-desktop-refreshing.png` | 1440×900 | 刷新进行中，结论暂停 |
| `p23-1024.png` | 1024×768 | 中等宽度 |
| `p23-tablet-768.png` | 768×1024 | 平板 |
| `p23-mobile-390.png` | 390×844 | 手机 |
| `p23-mobile-320.png` | 320×640 | 极窄屏（整页） |
| `p23-mobile-long-name.png` | 320×640 | 长知识名称换行 |
| `p23-desktop-dark.png` | 1440×900 | 深色主题 |
| `p23-desktop-en.png` | 1440×900 | 英文界面 |
| `p23-course-regression.png` | 1440×900 | 指定课程视图 |

指标：`P2-3-assets/p23-browser-metrics.json`（16 条记录，含每张图的结论文本、四项统计、弱项行、溢出测量）。

### 8.1 验收结论

| 检查项 | 结果 |
| --- | --- |
| 结论与数据一致（6 / 4 / 1 / 1） | ✅ 四项统计 `[1,6,1,1]`，结论句同值 |
| 空状态无虚假积极评价 | ✅ 仅「还没有已记录的知识点」，无「全部掌握」 |
| 仅 unknown 不宣称良好 | ✅ 「缺少可判断的状态」 |
| 误区：知识点数 ≠ 记录数 | ✅ 「1 个知识点被标记为存在误区」+「另有 1 条未解决…」 |
| review_due 不称正式到期 | ✅ 「以今日学习中的服务端结果为准」 |
| 新卡片无横向溢出 | ✅ 16 场景 `docOverflow=false`，`newBlockOverflow=[]` |
| 状态徽章在新卡片可见 | ✅ 每行 `.mla-badge` 有文本 |
| 320px 长标题换行 | ✅ 全部名称 `h > 24`、`w ≤ 320` |
| 摘要编辑仍可操作 | ✅ 「编辑摘要」按钮在各视口存在 |
| 课程视图无全部课程计数 | ✅ 无概览结论，课程四项 fact 保留，只读 |
| 深/浅主题可读 | ✅ 截图核对 |
| 中英文渲染 | ✅ `lang=en`，无中文残留 |

---

## 9. 已知问题（未在本阶段修复）

1. **320px 下既有区块被压缩（非本阶段引入）**：`学习目标` 卡内的优先级/类型行与成功标准列表在 320px 有 `scrollWidth > clientWidth`（实测 4 个节点，`left=76 right=94`，位于既有固定列布局中）；`知识状态` 行在 320px 亦有既有固定列挤压（P2-2 已记录的旧问题，本阶段未修复）。**新增的两个区块在全部 16 个场景中 `newBlockOverflow` 均为空**，且页面无横向滚动；按任务书要求继续记录，不因整页无横向滚动而判定已修复。
2. **全量测试的并行偶发**：见 §7.4，未确认根因，不作为本阶段结论。
3. **按知识点定向练习**：本阶段未实现（任务书 5.5 明确边界），需作为独立需求。

---

## 10. 完成标准核对

- [x] 基于指定 `main` 提交（`a0e063f`）开发
- [x] 概览结论完全由现有字段生成
- [x] 四项原有统计口径不变（I01）
- [x] 薄弱状态判定复用 `isWeakKnowledgeState()`
- [x] 未将 mastery 解释为正确率（T07/T08）
- [x] 未将 `review_due` 解释为正式复习到期（T09/T10、C06）
- [x] 未混淆误区记录与误区状态知识点（T12、C07）
- [x] 未伪造下一步建议或证据来源（W08、C09）
- [x] 未新增复习调度或定向出题逻辑（W15、无按钮）
- [x] 摘要编辑及知识编辑保护无退化（R1 全绿、I06）
- [x] 课程范围隔离测试通过
- [x] 新增测试全部通过（16 + 10 + 18 + 9 = 53 项）
- [x] TypeScript 检查通过
- [x] Web 构建通过
- [x] 完整构建通过
- [x] 全量测试结果真实记录（2352 通过 / 1 失败 / 3 跳过）
- [x] 桌面与移动端浏览器验收完成
- [x] 截图、指标及问题记录完整
- [x] 已生成 P2-3 验收报告
- [ ] PR 已提交待审查，未自动合并 —— 见 PR

**结论：P2-3 PASS。**

---

# E4.9i-P2-3-R1 修正：概览完整性与异常数据安全

## 13. R1 开发基准

| 项 | 值 |
| --- | --- |
| 主分支审查基准 | `a0e063f7f8569551612f675e107e0795b5acc69f` |
| 开发分支 | `feat/e49i-p2-3-profile-overview`（沿用，不另建 PR） |
| P2-3 审查基准 | `016133bd0379df8b7de1f40e3c317d71d1ba5dfc` |
| 开工核对 | 本地与远程均为 `016133b`；`origin/main` 仍为 `a0e063f`；PR 尚未创建 |
| 审查结论 | `REVIEW_CHANGES_REQUIRED`（F01 / F02 / F03） |
| R1 代码提交 | 见 PR 描述 |

## 14. F01 — 未解决误区结论展示不完整

### 14.1 修改前问题

`ProfileConclusion.tsx` 有两处把「未解决误区记录」错绑到知识点数据上：

1. 记录提示写在 `overview.weakCount === 0 ? … : <>…</>` 的**弱项分支**里，所以只有存在弱项时才出现；
2. `totalConcepts === 0` 时组件**提前 return**，空状态分支根本不包含该提示。

结果：没有知识点但仍有未解决误区记录、或只有 stable / unknown 状态时，记录数被静默丢弃。

### 14.2 复现方式

用改前代码运行新增用例，12 项失败，其中 F01 相关 4 项：

| 用例 | 改前结果 |
| --- | --- |
| R02 无知识点 + 2 条记录 | ✗ 未渲染记录提示 |
| R03 全部 stable + 2 条记录 | ✗ 未渲染记录提示 |
| R04 仅 unknown + 1 条记录 | ✗ 未渲染记录提示 |
| 英文空知识 + 1 条记录 | ✗ 未渲染记录提示 |

（R05/R06 在改前因存在弱项而碰巧通过，但它们固定了「不合并两种计数」的规则。）

### 14.3 修改后实现

把提示提取为一个独立变量 `openMisconceptionLine`，条件只有一个：`overview.openMisconceptions > 0`。

- 空知识分支：放在空状态说明之后、口径说明之前。
- 非空分支：无论 `weakCount` 是否为 0 都渲染（`weakCount === 0` 分支里与 `noWeak`/`onlyUnknown` 并列）。
- 与 `misconceptionStateCount` 仍是两条独立语句，不合并、不相加。

`profile-overview.ts`、四项统计与知识状态分类规则**未改动**。

## 15. F02 — `next_actions` 异常数据

### 15.1 修改前问题

组件直接读 `state.next_actions.length` 与 `state.next_actions[0]`。字段来自持久化档案，可能缺失、为 `null` 或不是数组；任一情况都会在 render 中抛错，导致整块面板被错误边界接管。

### 15.2 复现方式

以受控类型转换构造异常值后运行改前代码：

| 用例 | 改前结果 |
| --- | --- |
| R09 `undefined` | ✗ 渲染抛错 |
| R10 `null` | ✗ 渲染抛错 |
| R11 `["", " "]` | ✗ 把空白当作建议渲染 |
| R12 `["", "完成练习"]` | ✗ 展示空白首项 |
| R13 非数组 | ✗ 渲染抛错 |
| R14 `null` + 有 diagnosis | ✗ 渲染抛错 |

### 15.3 修改后实现

新增 `firstRecordedAction(value: unknown)`：

- 非数组直接返回 `undefined`；
- 取**第一条非空白字符串**，返回值 `trim()` 后；
- 只读，不排序、不修改原数组、不生成建议；
- 无有效项时沿用既有文案「暂无记录的下一步动作。」；
- 仍然不使用 `diagnosis`。

正式类型定义未修改。

## 16. F03 — 机器生成知识点名称

### 16.1 修改前问题

`displayName()` 只处理空字符串，`concept_45125622e640` 或旧式 `concept 45125622e640` 会被当作知识点名称原样展示。

### 16.2 复现方式

| 用例 | 改前结果 |
| --- | --- |
| R19 `concept_45125622e640` | ✗ 原样显示机器标识 |
| R20 `concept 45125622e640` | ✗ 原样显示机器标识 |

### 16.3 修改后实现

改为复用练习页同一套规则：

```typescript
return trustedConceptLabel(state.concept_id, state.concept_name) ?? fallback;
```

`trustedConceptLabel()`（`utils/concept-label.ts`）已同时处理空白、合成标识与「名称等于 id」三种情况，与 `PracticePage` 的判定完全一致。未新建识别规则，未修改 `concept_id` 或服务端名称。

## 17. R01–R21 覆盖对照

| 编号 | 用例位置 | 结果 |
| --- | --- | --- |
| R01 无知识点、无记录 | `ProfileConclusion.test.tsx` | ✅ |
| R02 无知识点、2 条记录 | 同上 | ✅ |
| R03 全部 stable、2 条记录 | 同上 | ✅ |
| R04 全部 unknown、1 条记录 | 同上 | ✅ |
| R05 存在弱项、2 条记录 | 同上 | ✅ |
| R06 状态数 1 / 记录数 3 分别展示 | 同上 | ✅ |
| （补）resolved / stale 不计入 | 同上 | ✅ |
| （补）英文记录提示（无知识点） | 同上 | ✅ |
| R07 单条有效动作 | `WeakKnowledgeSection.test.tsx` | ✅ |
| R08 `[]` | 同上 | ✅ |
| R09 `undefined` | 同上 | ✅ |
| R10 `null` | 同上 | ✅ |
| R11 `["", " "]` | 同上 | ✅ |
| R12 `["", "完成练习"]` | 同上 | ✅ |
| R13 非数组 | 同上 | ✅ |
| R14 无动作 + diagnosis | 同上 | ✅ |
| （补）只展示第一条、保持顺序 | 同上 | ✅ |
| （补）不修改原数组 | 同上 | ✅ |
| R15 中文名称 | 同上 | ✅ |
| R16 英文名称 | 同上 | ✅ |
| R17 空名称 | 同上 | ✅ |
| R18 空白名称 | 同上 | ✅ |
| R19 合成 id | 同上 | ✅ |
| R20 旧式机器名称 | 同上 | ✅ |
| R21 合法长名称完整换行 | 同上 | ✅ |

## 18. 定向与全量测试

### 18.1 定向

| 命令 | 结果 |
| --- | --- |
| `npx vitest run …/ProfileConclusion.test.tsx …/WeakKnowledgeSection.test.tsx` | ✅ 53 / 53 |
| 任务书 §6 的 7 个文件（含 profile-overview、summary、knowledge-state、DraftGuard.page、ProfilePage.courses） | ✅ 115 / 115 |

改前对照：同一组新用例在修改前代码上 **12 项失败**（F01 4 项、F02 6 项、F03 2 项），修改后全部通过——证明用例确实覆盖缺陷，而非事后凑数。

### 18.2 TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit --project apps/learning-agent/web/tsconfig.json` | ✅ 0 错误 |
| `npm --workspace my-learning-agent-web run build` | ✅ |
| `npm run build` | ✅ |

### 18.3 全量

`npx vitest run`（代码定稿后单次运行，`.tmp/p2-3-r1-full-test.log`）：

```
Test Files  1 failed | 206 passed (207)
     Tests  1 failed | 2377 passed | 3 skipped (2381)
```

| 指标 | P2-3 | R1 | 变化 |
| --- | ---: | ---: | --- |
| 通过 | 2352 | **2377** | +25 |
| 失败 | 1 | **1** | 不变 |
| 跳过 | 3 | **3** | 不变 |

唯一失败仍是 `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`；`git diff origin/main -- apps/learning-agent/src` 仍为 0 行。未删除、跳过或放宽任何断言。`server.learning-generate.test.ts` 的偶发未在本轮复现，继续单独记录，不确认根因。

## 19. 浏览器专项复验

复用 `docs/ui-redesign/phase5/scripts/qa_p2_3.py`，新增 R1 场景；同一隔离 Vite（127.0.0.1:5193）+ `page.route` 受控 fixture，**不读写真实学习档案**。脚本保留原 P2-3 的 16 个场景（全部仍通过），另写 `r1-browser-metrics.json`，不覆盖 P2-3 原始截图。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `r1-desktop-empty-misconceptions.png` | 1440×900 | 无知识点 + 2 条未解决误区 |
| `r1-desktop-stable-misconceptions.png` | 1440×900 | 全部 stable + 2 条误区 |
| `r1-desktop-unknown-misconceptions.png` | 1440×900 | 仅证据不足 + 1 条误区 |
| `r1-desktop-missing-actions.png` | 1440×900 | `[]` / 空白 / 第二条有效 |
| `r1-desktop-diagnosis-only.png` | 1440×900 | `null` + 仅有诊断 |
| `r1-desktop-synthetic-name.png` | 1440×900 | 两种机器名称安全降级 |
| `r1-desktop-legit-name.png` | 1440×900 | 合法英文名称保留 |
| `r1-mobile-320.png` | 320×640 | 极窄屏 + 误区记录 |
| `r1-desktop-en.png` | 1440×900 | 英文空知识 + 误区记录 |
| `r1-desktop-en-actions.png` | 1440×900 | 英文异常动作提示 |

### 19.1 结论

| 检查项 | 结果 |
| --- | --- |
| 无知识点仍显示误区记录提示 | ✅ 「另有 2 条未解决的误区记录」 |
| 全部 stable 时同时显示误区提示 | ✅ |
| 仅 unknown 时同时显示误区提示 | ✅ |
| 异常 `next_actions` 不崩溃 | ✅ 10 个 R1 场景无 page error |
| 空白项不作建议、取第一条有效项 | ✅ 2 条空提示 + 1 条有效 |
| 诊断不被冒充为建议 | ✅ 诊断文本不出现在动作位 |
| 机器名称降级 | ✅ 2 行显示「知识点名称待确认」，无机器标识泄露 |
| 合法名称保留 | ✅ 「同义替换」「Synonyms」 |
| 320px 无溢出 | ✅ `docOverflow=false`，新增区块溢出为 0 |
| 英文文案 | ✅ 无中文残留 |
| 新增区块布局 | ✅ 10 场景 `newBlockOverflow = []` |

## 20. 未解决问题

1. **320px 既有区块压缩**：`学习目标` 卡片与 `知识状态` 行的固定列挤压仍在（P2-2 已记录，属 P2-5 范围）。R1 新增场景中 `newBlockOverflow` 均为空，页面无横向滚动。
2. **`server.learning-generate.test.ts` 偶发**：本轮未复现，根因未确认，继续单独记录。
3. **按知识点定向练习**：仍未实现（P2-3 §5.5 边界）。

## 21. R1 合并门槛核对

- [x] F01：未解决误区提示不再依赖知识点数量或弱项数量
- [x] F02：异常 `next_actions` 不导致组件崩溃
- [x] F03：复用 `trustedConceptLabel`，与练习页一致
- [x] 未修改知识状态及复习规则
- [x] 未新增未经记录的学习建议
- [x] 原有 P2-3 功能无退化（16 个原场景仍通过）
- [x] P2-2-R1 编辑保护无退化
- [x] 课程范围隔离无退化
- [x] 新增回归测试全部通过（25 项）
- [x] TypeScript、Web 构建、完整构建通过
- [x] 全量测试结果真实记录（2377 通过 / 1 失败 / 3 跳过）
- [x] 浏览器专项复验完成（10 个场景）
- [x] R1 验收报告已更新（本章节）
- [ ] P2-3 PR 已创建或更新 —— **分支已推送，PR 尚未创建**：本次会话的 `gh` 未登录 GitHub，无法执行 `gh pr create`。正文已备好于 `docs/ui-redesign/phase5/P2-3-pr-body.md`，登录后一条命令即可创建。
- [x] PR 未自动合并（当前无 PR 存在，也未合并任何内容）

**结论：P2-3-R1 PASS_WITH_KNOWN_BASELINE_FAILURE**（仅保留已核实的 `server.e48-workbench.test.ts` 历史失败，无新增失败）。
