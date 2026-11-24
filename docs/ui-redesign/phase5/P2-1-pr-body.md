## 概要

E4.9i-P2-1：全部课程视图与指定课程视图改用同一份知识状态来源，并停用前端按 `mastery` 阈值伪造状态的做法。

- 基准：`main` @ `7d90d0bb2cd863d730cfb38fc523065959d33a74`
- 工作分支：`feat/e49i-p2-1-knowledge-state-semantics`
- 参考设计：`docs/ui-redesign/phase5/`（P1 方案 A + 状态筛选器）

**未修改**后端 `state-engine.ts`、复习调度、证据账本、`learner-store.ts`、会话与知识点归属、数据库、P1 HTML 原型、今日学习与 AI 学习页。

## 修复的问题

真实数据 `mastery: 0.05, state_label: "learning"`：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 全部课程视图 | 「待复习」（`masteryStateFor(0.05)` → `needsReview`） | **「学习中」** |
| 指定课程视图 | 「学习中」 | 「学习中」 |

同一个知识点在两个视图给出不同结论。另外概览的「待复习」按 `review_due_at <= now` 计数，与同一屏的徽标互相否定。

`mastery: 0.85, state_label: "review_due"`：修复前「已掌握」（0.85 ≥ 0.8），修复后「待复习」。

## 改动

| 文件 | 改动 |
| --- | --- |
| `react/knowledge-state.ts`（新增） | 六状态 → 翻译键 / 徽章 tone / 薄弱判定的唯一来源 |
| `types/learner.ts` | 补 `KnowledgeStateLabel`、`state_label?`、`course_id?`（服务端早已返回） |
| `LearnerProfilePanel.tsx` | 删 `MasteryState` / `masteryStateFor()` / 两套旧映射；徽标改读 `state_label`；进度条仍按 `mastery` 画宽度但改为单一强调色；概览统计改口径 |
| `courses/CourseLearnerPanel.tsx` | 改用共享模块；徽章色按状态本身，`unknown` 不再被画成 success |
| `i18n/locales/{zh-CN,en}.json` | 删 `profile.knowledge.masteryState.*`、`profile.summary.dueReviews`；增 `reviewDueStates`、`reviewDueStatesHintTitle` |

## 状态语义

| `state_label` | 中文 | 英文 | tone |
| --- | --- | --- | --- |
| `unknown` | 证据不足 | Insufficient evidence | neutral |
| `learning` | 学习中 | Learning | accent |
| `fragile` | 不稳定 | Fragile | warning |
| `review_due` | 待复习 | Review due | warning |
| `stable` | 稳定 | Stable | success |
| `misconception` | 存在误区 | Misconception | danger |

缺失、空串、未知字符串一律降级为「证据不足」，不读 `mastery` / `review_due_at` / 证据数，也不把原始字符串漏到界面。「需要关注」的四个标签集合未变。

## 概览统计

- 判据：`review_due_at <= now` → `state_label === "review_due"`
- 文案：待复习概念 → **待复习状态**（英文 Review-due states）
- 网格下方一行：「仅统计知识状态，不代表已通过到期复习资格核查」/ "Counts knowledge states only; not a passed due-review check"

前端未重新实现任何复习资格规则；课程视图的正式到期统计仍来自服务端 `courseDaily.knowledge.due_reviews`。

## 验证

| 项 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | ✅ |
| `npm run build` | ✅ |
| 新增 `LearnerProfilePanel.knowledge-state.test.tsx`（T01–T16） | ✅ 16 / 16 |
| `LearnerProfilePanel.summary.test.tsx` | ✅ 8 / 8 |
| `ProfilePage.courses.test.tsx` | ✅ 3 / 3 |
| `i18n/locales.test.ts` | ✅ 8 / 8 |
| `react/courses/`（6 文件） | ✅ 46 / 46 |
| 全量 `npx vitest run --maxWorkers=4` | 见下方 |

原有断言一条未删。

全量结果（单次、无并发）：

```
Test Files  2 failed | 198 passed (200)
     Tests  2 failed | 2243 passed | 3 skipped (2248)
```

| 失败用例 | 单独复跑 | 判断 |
| --- | --- | --- |
| `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting` | 仍失败 | 合并前 `main` 上已知的历史失败（mock provider 调用计数漂移）；本轮 `git diff origin/main -- apps/learning-agent/src` 为 0 行 |
| `react/MarkdownArtifact.test.tsx` › Cherry-style diagram languages | **25 / 25 通过** | 全量并发下的渲染时序抖动 |

## 真实页面验收

Playwright 驱动真实 React 页面（`?page=profile`），用 CDP `Fetch.fulfillRequest` 注入受控 profile 响应，覆盖本机档案里没有的六状态、旧数据与缺失字段。页面无 JS 错误。

| 截图（`docs/ui-redesign/phase5/P2-1-assets/`） | 视口 | 场景 |
| --- | --- | --- |
| `p21-desktop-six-states.png` | 1440×900 | 六状态同屏 |
| `p21-desktop-dark.png` | 1440×900 | 深色 |
| `p21-desktop-en.png` | 1440×900 | 英文 |
| `p21-desktop-legacy.png` | 1440×900 | 缺标签 / 未知值 / legacy 来源 |
| `p21-1024.png` | 1024×768 | 中等桌面 |
| `p21-mobile-390.png` | 390×844 | 手机 |
| `p21-mobile-320.png` | 320×640 | 小屏手机 |
| `p21-desktop-empty.png` | 1440×900 | 无知识点 |
| `p21-desktop-course.png` | 1440×900 | 指定课程 |
| `p21-mobile-320-course.png` | 320×640 | 指定课程 · 小屏 |

关键验收点：mastery 95% 且无状态 → 「证据不足」；mastery 85% + `review_due` → 「待复习」；四块概览指标在 320/390/1024/1440 下高度均为 86px；各视口无横向溢出。

## 已知遗留（不阻断本轮）

320 / 390px 知识行徽章仍被裁切（行宽 232px、徽章右边界 343–355px），进度条宽度为 0。这是 P1 分析记录的既有固定列布局问题（`w-[170px]` + `w-[42px]` + `w-[74px]`），与本次语义改动无关；任务书要求留给 **P2-4**。

完整报告：`docs/ui-redesign/phase5/P2-1-acceptance.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
