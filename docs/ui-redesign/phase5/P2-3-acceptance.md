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
