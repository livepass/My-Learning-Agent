# E4.9i-P2-1 验收报告：统一知识状态展示语义

- **任务**：E4.9i-P2-1 — 统一全部课程与指定课程的知识状态展示语义
- **基准分支**：`main`
- **基准 SHA**：`7d90d0bb2cd863d730cfb38fc523065959d33a74`
- **工作分支**：`feat/e49i-p2-1-knowledge-state-semantics`
- **参考设计**：`docs/ui-redesign/phase5/`（P1 分析与原型，方案 A + 状态筛选器）
- **结论**：**P2-1 PASS**

---

## 1. 修改文件清单

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `apps/learning-agent/web/src/types/learner.ts` | 类型 | 新增 `KnowledgeStateLabel`；`KnowledgeState` 补 `state_label?` / `course_id?` |
| `apps/learning-agent/web/src/react/knowledge-state.ts` | **新增** | 六状态 → 翻译键 / 徽章色 / 薄弱判定的唯一映射 |
| `apps/learning-agent/web/src/react/LearnerProfilePanel.tsx` | 组件 | 删除 `MasteryState` / `masteryStateFor()` / 两套映射；知识行改读 `state_label`；概览统计改口径并加说明 |
| `apps/learning-agent/web/src/react/courses/CourseLearnerPanel.tsx` | 组件 | 改用共享模块；徽章色按状态而非「薄弱/非薄弱」二值 |
| `apps/learning-agent/web/src/i18n/locales/zh-CN.json` | i18n | 删 `profile.knowledge.masteryState.*`、`profile.summary.dueReviews`；增 `reviewDueStates` / `reviewDueStatesHintTitle` |
| `apps/learning-agent/web/src/i18n/locales/en.json` | i18n | 同上，英文同步 |
| `apps/learning-agent/web/src/react/LearnerProfilePanel.knowledge-state.test.tsx` | **新增测试** | T01–T16 |
| `docs/ui-redesign/phase5/P2-1-acceptance.md` | 文档 | 本报告 |
| `docs/ui-redesign/phase5/P2-1-assets/` | 证据 | 10 张真实页面截图 |

未触碰：后端 `state-engine.ts`、复习调度、证据账本、`learner-store.ts`、会话归属、知识点课程归属、数据库、P1 HTML 原型、今日学习与 AI 学习页面。

---

## 2. 六种状态对应表

单一来源：`react/knowledge-state.ts`。两处视图都从这里取文案与色。

| `state_label` | 中文 | 英文 | 徽章 tone | 归入「需要关注」 |
| --- | --- | --- | --- | --- |
| `unknown` | 证据不足 | Insufficient evidence | neutral | 否 |
| `learning` | 学习中 | Learning | accent | 是 |
| `fragile` | 不稳定 | Fragile | warning | 是 |
| `review_due` | 待复习 | Review due | warning | 是 |
| `stable` | 稳定 | Stable | success | 否 |
| `misconception` | 存在误区 | Misconception | danger | 是 |

「需要关注」集合与原 `WEAK` 完全一致（四个标签），业务分类用途未变。

---

## 3. 修复前后的状态对比

真实数据 `mastery: 0.05, state_label: "learning"`：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 全部课程视图 | 「待复习」（`masteryStateFor(0.05)` → `needsReview`） | **「学习中」** |
| 指定课程视图 | 「学习中」 | 「学习中」 |
| 概览「待复习」计数 | 按 `review_due_at <= now` 计，与本行徽标互相否定 | 按 `state_label === "review_due"` 计，与徽标同源 |

`mastery: 0.85, state_label: "review_due"`：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 全部课程视图 | 「已掌握」（0.85 ≥ 0.8） | **「待复习」** |

`mastery: 0.20, state_label: "stable"`：修复前「待复习」，修复后「稳定」。

进度条：宽度仍取 `mastery`；颜色改为单一强调色（`--inno-accent`），不再按阈值染成绿/黄/红。

---

## 4. 缺失或异常状态的处理

| 数据 | 显示 | 截图 |
| --- | --- | --- |
| `state_label` 缺失 | 证据不足（neutral） | `p21-desktop-legacy.png`：mastery 95% 仍显示「证据不足」 |
| `state_label: ""` | 证据不足 | T06 |
| 未知字符串 `brand_new_state` | 证据不足，原文不外泄 | `p21-desktop-legacy.png`：mastery 88% 仍显示「证据不足」 |
| `origin: "legacy"`、无状态 | 证据不足 | `p21-desktop-legacy.png` 第三行 |
| `review_due_at` 缺失 | 复习日期列显示 `-`，**不解释为「无需复习」** | `p21-desktop-six-states.png` 首行 |

关键断言（H10）：mastery 很高但状态缺失时，绝不显示为「稳定」或「已掌握」。

---

## 5. 概览统计语义

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 判据 | `review_due_at && Date.parse(review_due_at) <= Date.now()` | `state_label === "review_due"` |
| 文案（中） | 待复习概念 | **待复习状态** |
| 文案（英） | Due for review | **Review-due states** |
| 说明 | 无 | 指标网格下方一行：「仅统计知识状态，不代表已通过到期复习资格核查」/ "Counts knowledge states only; not a passed due-review check" |

前端未重新实现任何复习资格规则。课程视图的正式到期复习统计仍来自服务端 `courseDaily.knowledge.due_reviews`，未被覆盖。

说明文字的排版经过三轮实测修正：

1. 放进指标块内 → 320px 下该块从 86px 涨到 151px，与相邻块高度差过大；
2. 改为块内单行 + `title` → 四块高度一致，但原生 `title` 违反 `design.md`「轻量悬停提示统一使用共享 `Tooltip`」，且共享 `Tooltip` 需要 `TooltipProvider`（测试环境没有），同时规范也规定 Tooltip 不承载长篇说明；
3. 最终放在指标网格下方一行脚注 → 四块高度在 320/390/1024/1440 均为 86px，说明完整可见，不依赖悬停。

---

## 6. 数据与业务规则冻结证明

| 规则 | 状态 | 证据 |
| --- | --- | --- |
| 后端 `state-engine.ts` 未改 | ✅ | `git diff origin/main...HEAD -- apps/learning-agent/src` 为空 |
| 复习调度 / 证据账本未改 | ✅ | 同上 |
| `learner-store.ts` 未改 | ✅ | 同上 |
| 编辑接口参数不变 | ✅ | T14 断言 `updateKnowledge("c1", { diagnosis, next_actions, mastery })` 完全一致 |
| 课程范围仍由服务端过滤 | ✅ | `ProfilePage.courses.test.tsx` 3 项通过；未改 `courses-store.ts` |
| 前端不推断缺失状态 | ✅ | `normalizeKnowledgeStateLabel()` 只做白名单匹配，不读 `mastery` / `review_due_at` / `evidence_ids` |
| 「需要关注」分类不变 | ✅ | `isWeakKnowledgeState()` 使用与原 `WEAK` 相同的四个标签 |

---

## 7. 定向测试结果

新增 `apps/learning-agent/web/src/react/LearnerProfilePanel.knowledge-state.test.tsx`：**16 / 16 通过**。

| 编号 | 覆盖 | 结果 |
| --- | --- | --- |
| T01 | 六种状态正确翻译 | ✅ |
| T02 | mastery 0.05 + learning → 学习中 | ✅ |
| T03 | mastery 0.85 + review_due → 待复习 | ✅ |
| T04 | mastery 0.20 + stable → 稳定 | ✅ |
| T05 | 状态缺失 → 证据不足 | ✅ |
| T06 | 未知/空字符串安全降级，不外泄原文 | ✅ |
| T07 | mastery 百分比与进度条保留 | ✅ |
| T08 | 旧三档标签不再渲染 | ✅ |
| T09 | 概览按 `state_label` 计数 | ✅ |
| T10 | 过去日期 + learning 不计入状态数 | ✅ |
| T11 | review_due 无日期仍计入 | ✅ |
| T12 | 中英文切换使用正确文案 | ✅ |
| T13 | 展开与编辑可用 | ✅ |
| T14 | 保存参数不变 | ✅ |
| T15 | 课程视图文案与全部课程一致 | ✅ |
| T16 | unknown 不被画成 success | ✅ |

回归：

| 文件 | 结果 |
| --- | --- |
| `LearnerProfilePanel.summary.test.tsx` | ✅ 8 / 8 |
| `ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `i18n/locales.test.ts` | ✅ 8 / 8 |
| `react/courses/`（6 个文件） | ✅ 46 / 46 |

原有断言一条未删。

---

## 8. TypeScript 与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | ✅ 退出码 0 |
| `npm --workspace my-learning-agent-web run build` | ✅ 退出码 0（tsc + vite build） |
| `npm run build` | ✅ 退出码 0（后端 tsc + 前端 vite build） |

首次 `tsc` 曾报 `TS2783: 'concept_id' is specified more than once`（测试夹具里重复展开），已修正为单一来源后通过。

---

## 9. 全量测试

`npx vitest run --maxWorkers=4`（单次、无并发）：

```
Test Files  2 failed | 198 passed (200)
     Tests  2 failed | 2243 passed | 3 skipped (2248)
```

| 失败用例 | 单独复跑 | 判断 |
| --- | --- | --- |
| `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（`expected 2 to be 1`） | 仍失败 | **既有历史失败**（合并前 `main` 上已知）。断言的是 mock provider 调用次数，属本机端口/进程复用导致的计数漂移。本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行，无法触及该路径。 |
| `react/MarkdownArtifact.test.tsx` › `routes the additional Cherry-style diagram languages to special views` | **25 / 25 通过** | 全量并发下的渲染时序抖动 |

两条失败均未通过删除、跳过或放宽断言处理。基线对照的构建与定向测试见 §7–§8。

---

## 10. 真实页面验收

用 Playwright 驱动真实 React 页面（`http://localhost:5173/?page=profile`），通过 CDP `Fetch.fulfillRequest` 注入受控 `GET /api/learner/profile` 响应，覆盖本机真实档案里没有的六状态、旧数据与缺失字段场景。页面无 JS 错误（`page errors: none`）。

| 截图 | 视口 | 场景 |
| --- | --- | --- |
| `p21-desktop-six-states.png` | 1440×900 | 六种状态同屏（浅色） |
| `p21-desktop-dark.png` | 1440×900 | 深色主题 |
| `p21-desktop-en.png` | 1440×900 | 英文界面 |
| `p21-desktop-legacy.png` | 1440×900 | 旧数据：缺标签 / 未知值 / legacy 来源 |
| `p21-1024.png` | 1024×768 | 中等桌面 |
| `p21-mobile-390.png` | 390×844 | 手机 |
| `p21-mobile-320.png` | 320×640 | 小屏手机 |
| `p21-desktop-empty.png` | 1440×900 | 无知识点 |
| `p21-desktop-course.png` | 1440×900 | 指定课程视图 |
| `p21-mobile-320-course.png` | 320×640 | 指定课程 · 小屏 |

### 验收结论

| 检查项 | 结果 |
| --- | --- |
| 知识状态来自 `state_label` | ✅ 六状态截图逐一核对 |
| 概览显示「待复习状态」 | ✅ 中英文均确认 |
| 状态分类与掌握度百分比不互相覆盖 | ✅ 95% 显示「证据不足」，85% 显示「待复习」 |
| 旧数据缺失状态显示证据不足 | ✅ `p21-desktop-legacy.png` |
| 课程视图使用同一文案 | ✅ `p21-desktop-course.png`：学习中 / 待复习 / 存在误区 / 证据不足 |
| 课程切换后状态不串用 | ✅ 未改 `courses-store.ts`；`ProfilePage.courses.test.tsx` 3 项通过 |
| 320px 无横向溢出 | ✅ 各视口 `scrollWidth === clientWidth` |
| 320px 概览提示块不撑高 | ✅ 四块高度均为 86px（320/390/1024/1440） |

---

## 11. 已知遗留（不阻断本轮）

1. **320 / 390px 知识行徽章仍被裁切。** 这是 P1 分析里记录的既有固定列布局问题（`w-[170px]` + `w-[42px]` + `w-[74px]`），与本次语义改动无关。实测 320px 下行宽 232px、徽章右边界 343–355px（修复前旧三档徽章为 365px，现已更窄），进度条宽度 0。任务书要求留给 **P2-4**，本轮只记录不修。
2. 进度条在窄屏宽度为 0，属同一固定列问题。
3. `profile.knowledge.concept` / `domain` / `due` 三个 i18n 键当前无引用，属既有冗余，本轮未清理（超出范围）。

---

## 12. 完成标准核对

- [x] 全部课程和指定课程统一读取 `state_label`
- [x] 原 mastery 三档状态判断已停用并删除
- [x] 六种正式状态正确显示
- [x] 缺失或未知状态安全降级
- [x] mastery 仍作为数值独立显示
- [x] 概览统计不冒充正式到期复习
- [x] 没有新增前端复习资格算法
- [x] 历史知识数据兼容
- [x] 原有知识状态编辑功能正常
- [x] 跨课程数据隔离不变
- [x] 中英文文案一致
- [x] TypeScript 和构建通过
- [x] 无新增确定性测试失败
- [x] 浏览器验收证据完整

**结论：P2-1 PASS。**
