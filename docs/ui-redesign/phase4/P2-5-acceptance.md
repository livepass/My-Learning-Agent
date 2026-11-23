# E4.9h-P2-5 最终集成验收报告

- **基准分支**：`main`
- **基准 SHA**：`1c90d94c7644fa00e9e44dacc50975a4cd703bd1`（PR #11 合并后，与任务给定一致）
- **工作分支**：`test/e49h-p2-5-integration-qa`
- **本轮性质**：测试、集成验证、验收收尾。**未修改任何产品代码**。
- **P2-5-R1 工作提交**：`ec707be`（起点）→ 本轮收尾提交见 PR #12
- **当前 R1 结论**：**PASS_WITH_KNOWN_BASELINE_FAILURE**。320/390px 底栏已在真实浏览器复测通过，全量测试日志已归档，证据一致性已核对；仍保留 1 项经独立复现的历史基线失败。

---

## 1. 环境与基线

| 项 | 值 |
| --- | --- |
| Node.js | v24.14.0 |
| npm | 11.9.0 |
| 平台 | Windows 11，Git Bash |
| 起点工作区 | 干净，未做任何重置 |
| 数据目录 | 隔离：`.p25-acceptance/data`（`.gitignore` 未跟踪的临时目录，验收后删除） |
| 服务端 | `apps/learning-agent/dist/server.js`，`INNO_PORT=7940`，`INNO_CONFIG_FILE` 指向隔离配置 |
| provider | 本地确定性桩（`p25-stub-provider.mjs`），OpenAI Chat Completions 流式协议 |

> 桩 provider 返回固定题目与固定评分。**本文所有评分结论都是界面与协议正确性，不是真实模型质量。**

### 1.1 原始测试基线（本轮真实执行）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run PracticePage.test.tsx` | **89 / 89 通过** |
| `npx vitest run pages/practice` | **186 / 186 通过**（6 文件） |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过 |
| `npx vitest run --maxWorkers=4` | **194 文件通过 / 1 失败；2193 通过 / 1 失败 / 3 跳过** |

原始完整测试输出在 P2-5 提交时**未归档**（`.gitignore` 忽略 `*.log`）。P2-5-R1 已补跑并归档为 `P2-5-assets/full-test.txt` 与 `full-test-run1-flaky.txt`，详见第 14.4、14.5 节。

### 1.2 基线失败

唯一失败：`apps/learning-agent/src/server.e48-workbench.test.ts` → `E4.8a — course status gates chat writes` → `allows an in_progress course to continue chatting`，断言 `providerCalls` 期望 1 实得 2。

**独立复现**：在本分支（尚无任何提交）单独执行该文件，同样失败。分支相对 `origin/main` 没有任何代码改动，因此该失败与本轮无关，不是新回归。本轮**没有**删除、跳过或修改该断言。

---

## 2. 阶段 B：P2-4-R1 与 P2-3 遗留问题闭环

### 2.1 P2-4-R1：复习「生成复习题」按钮状态

原始 `P2-4-assets/metrics.json` 记录 `summary.keyboard.reviewGenerationEnabled=false`，与报告里「复习到期时按钮可用」矛盾。本轮在真实页面**分三个采样点**重新测量（`P2-5-assets/metrics-phase-b.json`）：

| 采样点 | 1440×900 | 320×640 | 说明 |
| --- | --- | --- | --- |
| 点击前（到期核查与会话读取已完成） | `disabled=false` | `disabled=false` | 到期行可见、会话就绪 |
| 点击后（请求进行中） | 复习准备页已卸载 | 复习准备页已卸载 | 生成成功后页面跳转到题目页，**不存在该按钮** |
| 结果之后 | 同上 | 同上 | — |

**结论**：只要真正等到核查与会话读取完成，点击前按钮就是可用的。旧指标的 `false` 是采样时机（页面已卸载或尚未就绪）与选择器口径造成的，**不是产品缺陷**，也不需要放宽 `reviewCanGenerate`。

**失败变体**（复现旧指标那种「有错误 + 按钮存在」的组合，`B1b`）：

| 阶段 | 1440×900 | 320×640 |
| --- | --- | --- |
| 失败前 | `disabled=false`，无错误 | `disabled=false`，无错误 |
| 生成失败后 | `disabled=false`，`role=alert` 可见，复习准备页仍在 | 同左 |

即：生成失败后按钮重新可用，错误提示可见，可以重试。相应 JSON 证据在 `metrics-phase-b.json`；**当前提交目录没有** `B1-before-click` 或 `B1b-generate-failed` 专项 PNG，不应将这些文件描述为已归档。

### 2.2 P2-3：英文 `unknown` 徽章计数

原始指标把英文 unknown 的 `resultBadgeCount` 记为 0。本轮改为**枚举反馈块内所有 `.mla-badge` 元素**（不再只匹配 `success/warning/danger` 修饰类）：

| 视口 | 概览文本 | 徽章数 | 徽章文本 | neutral | 分数 | 显示为 Incorrect |
| --- | --- | ---: | --- | --- | --- | --- |
| 1440×900 | `Scoring feedbackUnable to judge` | **1** | `Unable to judge` | 是（`class="mla-badge"`，无 tone 修饰类） | 无 | 否 |
| 320×640 | 同左 | **1** | 同左 | 是 | 无 | 否 |

**结论**：徽章数量正确，旧计数的 0 是**验收脚本选择器遗漏 neutral**，不是产品 UI 问题。本轮只修正测试口径，**未修改产品代码**。原始指标在 `metrics-phase-b.json`；当前提交目录中**没有** `B2-unknown-en` 专项 PNG，不能将它计入已归档的 58 张截图。

---

## 3. 阶段 C：普通练习闭环（E01–E12）

全部通过真实 React 页面与真实学习 API（桩只提供模型回复）。身份校验读取服务端 `GET /api/sessions/:id/learning` 与 `/api/learner/profile`，不以页面文案为准。数据：`metrics-phase-c.json`。

| 编号 | 检查项 | 实测 | 结论 |
| --- | --- | --- | --- |
| E01 | 打开练习页 | `exists=false` | 未自动创建记录 ✅ |
| E02 | 显式初始化 | `exists=true`，`revision=1` | ✅ |
| E03 | 首次生成题目 | `question_id=q_4588…`，`inState=true`，`step=awaiting_answer` | 身份正确 ✅ |
| E04 | 题目与作答同卡 | `cards=1`，题干与输入框都在卡内 | ✅ |
| E05 | 保存作答 | `attempt.stage=answer_saved`，答案与 `question_id` 均匹配 | 服务端持久化 ✅ |
| E06 | 评分前 | `hasFeedback=false`，`hasScore=false` | 不提前显示 ✅ |
| E07 | AI 评分 | 服务端 `result=partial`、`score=0.75`；界面「部分答对」「得分 75 / 100」 | 展示服务端结果 ✅ |
| E08 | 评分完成 | 进度「答案已保存 → 评分完成 → 待记录」，记录按钮存在 | 第三步仍未完成 ✅ |
| E09 | 记录学习证据 | 点击后 `attempt.stage=completed`，`checkpoint.step=feedback` | 独立动作 ✅ |
| E10 | 记录成功 | `stage=completed`，`last_completed_attempt_id` 与本次 attempt 一致 | ✅ |
| E11 | 学习档案 | 知识点 `concept_81d3…` 在该次指标采样中有 **16 条证据** | 可读取 ✅ |
| E12 | 下一步建议 | 建议区块存在，文案含建议 | 来自长期状态 ✅ |

**关键约束**：E07 时 `stage=evaluated`，界面仍显示「待记录」；只有 E09 之后才 `completed`。评分成功**没有**被当作证据已记录。

### 3.1 数据一致性

| 身份 | 实测关联 |
| --- | --- |
| `session_id` | 全程同一会话 |
| `question_id` / `question_version` | attempt 与 checkpoint 一致 |
| `attempt_id` | `pending_attempt_id` → `last_completed_attempt_id` 同一值 |
| `concept_id` | 档案证据落在 `concept_81d3d3132018` |
| `checkpoint.revision` | 每次操作递增，无回退 |

---

## 4. 阶段 C：再练一道

| 检查 | 实测 |
| --- | --- |
| 知识点自动填充 | `Python 闭包`（可信名称） |
| 展开高级选项并改题型 | 选择 `application` |
| 收起再展开 | 值仍为 `application` |
| 生成下一题 | HTTP 200，`question_id=q_c3fa…`，与上一题不同 |
| `after_attempt_id` | `last_completed_attempt_id` 仍为上一题 attempt |
| 新题无 attempt | `pending_attempt_id` 为空 |
| 答案不继承 | 输入框为空 |
| 评分不继承 | 无反馈块 |
| 题型生效 | 新题 `kind=application` |

> 首次运行时桩 provider 固定返回 `free_recall`，页面请求 `application`，服务端以 422 拒绝，页面正确显示「模型输出未通过校验：题目类型必须是 application…」。这是**桩的限制**，不是产品缺陷；修正桩让它回显请求的题型后通过。截图：`C-continuation-expanded`、`C-continuation-new-question`。

---

## 5. 阶段 C：复习闭环（R01–R10）

到期状态由真实 C1→C2→C3 证据链产生，再在**隔离数据**中把 `review_due_at` 移到过去。未触碰真实用户档案。

| 编号 | 检查项 | 实测 |
| --- | --- | --- |
| R01 | 入口携带复习知识点身份 | URL 含 `review_concept_id=concept_81d3…` |
| R02 | 每次进入重新核查 | 页面显示「复习时间：11月22日；可追溯证据 16 条」，按钮 `disabled=false` |
| R03 | 过期链接不绕过核查 | 核查失败/不再到期时按钮禁用（见阶段 E） |
| R04 | 生成请求使用 `intent: "review"` | 页面生成路径固定带 `intent: "review"` |
| R05 | 复习题身份来自服务端 | 服务端 `question.review === true` |
| R06 | URL 无法伪装普通题 | 本轮 JSON 只记录了 `urlReviewQuestionId=null`，**不足以独立证明防伪造**；已有 `PracticePage.test.tsx` 测试 `does not treat an ordinary question as a review when only the URL says so` 明确覆盖该行为（组件/页面测试证据） |
| R07 | 复习题可正常作答 | 提交后 `stage=evaluated` |
| R08 | 评分后仍需单独记录 | 进度「评分完成 → 待记录」，记录按钮存在 |
| R09 | 证据归属正确 | `stage=completed`，`concept_id=concept_81d3…` |
| R10 | 重新读取长期状态 | 证据 18 条，`state_label=fragile`，建议 `fragile_evidence` |

> R10 记录的是**服务端实际计算结果**，未预设掌握度上涨或复习日期延长。

---

## 6. 阶段 D：状态隔离与异常恢复

| 编号 | 场景 | 实测 |
| --- | --- | --- |
| S01 | A 输入后切 B | B 知识点输入为空，不显示 A 草稿 |
| S02 | A 已评分后切 B | B 无反馈块 |
| S03 | A 已记录后切 B | B 进度为 `null`（未继承） |
| S04 | 切回 A | A 的学习记录仍存在 |
| S05 | 生成中切换会话 | 由既有 `learningStore` ticket 与 `reviewScopeProblem` 保护；本轮页面用例全部通过 |
| S06 | 复习中切换知识点 | 由 `reviewTicketRef` 保护；既有用例全部通过 |

### 刷新恢复（真实页面刷新）

| 阶段 | 刷新后进度 | 反馈 | 答案 |
| --- | --- | --- | --- |
| 已生成未作答 | 待提交 / 待评分 / 待记录 | 无 | 空 |
| 已提交未评分 | 答案已保存 / 待评分 / 待记录 | 无 | 保留 |
| 已评分未记录 | 答案已保存 / 评分完成 / 待记录 | 有 | 保留 |
| 已完成记录 | 答案已保存 / 评分完成 / 证据已记录 | 有 | 保留 |

### 失败与重试

| 场景 | 实测 |
| --- | --- |
| 评分失败 | `stage=evaluation_failed`，`retryable=true`，进度「评分失败」 |
| 评分重试成功 | 点击「重新评分」后 `stage=evaluated`，进度「评分完成」 |
| 生成失败 | 错误 `role=alert` 可见，按钮恢复可用 |
| 到期核查失败 | 503 → 「学习档案暂时不可用，无法核对复习资格。」，按钮禁用 |

**未在浏览器安全注入**：评分重试次数耗尽（需连续 3 次失败）与证据记录失败。二者由组件测试确定性覆盖（`PracticeProgress` T09/T11、`PracticeAnswerPanel` T07/T11），本报告不把它们写成浏览器实测。

---

## 7. 阶段 B/E：R1 遗留浏览器场景

| 场景 | 1440×900 | 320×640 | 关键断言 |
| --- | --- | --- | --- |
| 到期核查失败（真实 503） | ✅ 截图 | ✅ 截图 | 错误可见、**不在折叠区内**、按钮禁用、退出可用 |
| 会话被阻塞（未完成 attempt） | ✅ 截图 | ✅ 截图 | 阻塞原因可见、按钮禁用、原题与 pending attempt **未被覆盖** |
| 概念无可信名称 | ✅ 截图 | ✅ 截图 | 不展示合成 ID、人工输入 + 确认控件存在、确认前按钮禁用 |

会话阻塞后的身份复核：`questionUnchanged=true`、`pendingAttemptPreserved=true`。

---

## 8. 阶段 E：响应式与可访问性

### 8.1 视口矩阵

5 视口 × 浅色/深色 × 5 个页面状态（首次出题、高级选项展开、已评分未记录、复习准备、unknown），另加英文 1440 与 320：

| 指标 | 结果 |
| --- | --- |
| 捕获 | **62 条**（另加阶段 B/C 截图，PNG 共 58 张） |
| 横向溢出 | **0** |
| 折叠区内出现错误提示 | **0** |
| 深浅主题 | 全覆盖 |
| 英文 | 1440 与 320 均正常 |

### 8.2 可访问性（真实浏览器）

| 检查 | 结果 |
| --- | --- |
| 「知识点」标签与输入框关联（`for` = `id`） | ✅ |
| 高级选项 summary 可获得焦点 | ✅ |
| 焦点可见（outline 非 none） | ✅ |
| Enter 展开 | ✅ |
| Space 收起 | ✅ |
| 折叠/展开后题型值保留 | `transfer` |
| 错误提示 `role="alert"` | ✅ |
| 320px 底部导航不遮挡最后操作 | ✅ 见第 14 节：真实浏览器 M01–M04 复测，320×640 与 390×844 均无重叠、按钮可点击 |

---

## 9. 定向与全量测试

| 命令 | 结果 |
| --- | --- |
| `npx vitest run PracticePage.test.tsx` | 89 / 89 |
| `npx vitest run pages/practice` | 186 / 186 |
| `npx tsc --noEmit` | 0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过 |
| `npx vitest run --maxWorkers=4` | 194 文件 / **2193 通过** / **1 失败** / 3 跳过 |

与 `main` 新基线（`1c90d94`）对照：**完全一致**，本轮没有新增或删除测试，因此通过数相同。唯一失败即第 1.2 节所述 `server.e48-workbench`，已独立复现。

---

## 10. 证据来源标注

| 证据 | 来源 |
| --- | --- |
| E01–E12、R01–R10、S01–S04、刷新恢复、失败重试 | **真实浏览器 + 真实学习 API**（桩仅提供模型回复） |
| R1 三个遗留场景、P2-4 按钮三阶段、P2-3 英文 unknown | **真实浏览器 + 真实 API** |
| 视口矩阵、键盘与标签 | **真实浏览器** |
| 评分重试耗尽、证据记录失败、空 criteria | **组件测试**（未在浏览器注入） |
| 定向/全量测试 | **单元与集成测试**（Vitest） |

---

## 11. 已知问题与限制

1. **`server.e48-workbench` 基线失败**：已独立复现，与 E4.9h 无关，本轮未修改。
2. **桩 provider 的评分是固定的**：本文结论仅关于界面与协议，不代表真实模型质量。
3. **两项故障未在浏览器注入**：评分重试耗尽、证据记录失败（需要连续多次失败或服务端写入故障），由组件测试覆盖。
4. **旧 P2-4 指标的矛盾已解释**：采样时机 + 选择器口径，非产品缺陷；旧 `metrics.json` 保持原样未改写。
5. **P2-3 英文 unknown 旧计数为 0**：选择器遗漏 neutral 徽章，非 UI 问题；本轮修正口径，未改产品代码。

---

## 12. 最终 PASS 判定

| 条件 | 结果 |
| --- | --- |
| 正常练习闭环成功 | ✅ |
| 复习闭环成功 | ✅ |
| 学习证据正确持久化 | ✅ |
| 学习档案可读取对应证据 | ✅ |
| 评分成功不提前声明证据完成 | ✅ |
| 新旧题目评分不互相污染 | ✅ |
| 会话切换与刷新恢复正确 | ✅ |
| 复习身份不能由 URL 伪造 | **既有页面测试通过**；本轮浏览器 R06 未执行带伪造 `review_question_id` 的负向操作 |
| 到期核查失败不放行 | ✅ |
| P2-4 生成按钮状态重新验证 | ✅（三阶段采样） |
| P2-3 英文 unknown 徽章数正确 | ✅（恰好 1 个 neutral） |
| 三步进度与评分反馈无回归 | ✅ |
| 五种视口无阻断性布局问题 | 62 条记录均无横向溢出；**320px 底栏操作可见性仍待按真实 DOM 复测** |
| 中英文、深浅主题 | ✅ |
| 无新增确定性业务测试失败 | ✅（与基线一致） |
| TypeScript 与构建通过 | ✅ |
| 验收证据完整且与实际一致 | **待补齐**：移动端 `clear=false` 矛盾、专项截图/测试日志引用 |

**当前审查结论：核心业务链路通过，最终验收证据仍有待关闭项，暂不批准最终 PASS_WITH_KNOWN_BASELINE_FAILURE。** 既有全量测试记录 2193 通过 / 1 项已知基线失败 / 3 跳过（本轮 R1 没有重新执行），不能称全量全绿。完成底栏实测、证据核对后才可恢复最终判定。

E4.9h 阶段的功能开发到此停止，等待最终审查。

---

## 13. P2-5-R1 证据一致性修正（2026-11-23）

- **修正证据数量**：`metrics-phase-c.json` 的同一验收运行中，E11 为 16 条、R02 为 16 条、R10 为 18 条。修正本报告旧的 4→6 描述；不声称同一条 attempt 固定增加 2 条学习证据的原因，增量解释以数据模型为准。
- **截图关联**：`metrics-phase-e.json` 共 62 条记录，其中 **58 条 UI 截图记录**的 `file` 已准确关联到现有 58 个 PNG；另外 **4 条 DOM/业务断言记录**（`R1-session-blocked-identity` 两条、`R1-no-trusted-name-controls` 两条）没有单独 PNG，保留空 `file`，且相应异常页面已有其他截图。没有生成或补写任何不存在的图片。
- **B 阶段证据**：`metrics-phase-b.json` 的按钮前后、英文 unknown 徽章指标存在，提交目录没有 `B1-before-click`、`B1b-generate-failed`、`B2-unknown-en` 单独图片。因此本轮不能将它们列为已经提供的专项截图；可追加原始截图或在 PR 中明确仅有 DOM 指标。
- **测试日志**：P2-5 提交时未归档；P2-5-R1 已补跑并归档 `full-test.txt`（2193 / 1 / 3）与 `full-test-run1-flaky.txt`（2 失败），见第 14.4、14.5 节。历史基线失败不可忽略或重命名为 PASS。
- **移动底栏关键门槛**：原始 `summary.keyboard.lastActionClear` 为 `{buttonBottom:570, navTop:0, clear:false}`，现有截图可说明页面概况，但不能据此判定最后操作在真实 320px 视口未被遮挡。需在真实浏览器复测：确保 `.mla-bottomnav` 可见，在操作元素滚动到视口内后记录 `getBoundingClientRect()`、`getComputedStyle()`、视口尺寸及导航实际矩形，判断是否重叠。仅在新实测支持时更改结论。`metrics-phase-e.json` **保留旧原始值**。
- **R06 证据来源**：本轮 URL 只显示 `review_question_id=null`；实际防伪造行为由已有 `PracticePage.test.tsx` 中的 `does not treat an ordinary question as a review when only the URL says so` 单测覆盖。若要升级到浏览器实测结论，需额外执行 URL 伪造负向场景。
- **本轮代码范围**：仅调整证据关联与验收文档，不触碰 UI、API、Store、记忆、复习调度或既有测试断言；本轮**没有**重新运行构建或完整浏览器测试。

**R1 合并门槛：重新采集 320px 底栏遮挡结果，补齐测试日志的可追溯来源，并确认报告的其余证据引用。未完成前保持 PR 为 Draft，不自动合并。**

---

## 14. P2-5-R1 收尾：移动端底栏复测与测试日志（2026-11-23）

### 14.1 旧指标 `clear=false` 的真实原因

原始 `metrics-phase-e.json` 记录 `{ buttonBottom: 570, navTop: 0, clear: false }`。

原因有两处，都不是产品遮挡：

1. **选择器错误**：旧脚本用 `document.querySelector("nav")` 找底栏，命中的是页面**顶部**导航，其 `getBoundingClientRect().top` 天然为 `0`，于是 `navTop=0`、`clear=false`。
2. **采样方式错误**：旧脚本把操作按钮 `scrollIntoView` 后直接与上述错误矩形比较，没有滚动页面真正的滚动容器 `.mla-main`，也没有验证点击命中。

本轮改为直接测量 `.mla-bottomnav`，并按项目实际的滚动模型（`.mla-main` 是滚动容器，不是 `window`）定位操作按钮。

### 14.2 复测方法

真实 React 页面 + 真实服务端（隔离数据目录 + 确定性桩 provider），Playwright 驱动 Chrome：

- 视口：**320×640**（必测）与 **390×844**（补充）。
- 四个状态：M01 首次出题、M02 复习准备、M03 已评分待记录、M04 证据已记录。
- 每个状态先等待业务就绪，再把操作按钮滚动到 `.mla-main` 可见区域底部。
- 采集：视口尺寸、`main.scrollTop/scrollHeight/clientHeight`、底栏 `display/visibility/position/rect`、操作按钮 `rect/disabled`、两者矩形重叠、`elementFromPoint()` 命中对象、横向溢出。
- 交互：对按钮执行真实 `focus()` 与 `click({ trial: true })`，确认可聚焦、可点击。

### 14.3 结果（`metrics-mobile-nav-r1.json`）

| 视口 | 状态 | 操作按钮 | 底栏 top | 按钮 bottom | 可见 | 重叠 | 命中按钮 | 可点击 | 横向溢出 |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| 320×640 | M01 首次出题 | 生成练习题 | 570 | 425 | ✅ | 否 | ✅ | ✅ | 否 |
| 320×640 | M02 复习准备 | 改为普通练习 | 570 | 425 | ✅ | 否 | ✅ | ✅ | 否 |
| 320×640 | M03 已评分 | 记录本次学习结果 | 570 | 425 | ✅ | 否 | ✅ | ✅ | 否 |
| 320×640 | M04 已记录 | 查看我的学习档案 | 570 | 425 | ✅ | 否 | ✅ | ✅ | 否 |
| 390×844 | M01 首次出题 | 生成练习题 | 774 | 629 | ✅ | 否 | ✅ | ✅ | 否 |
| 390×844 | M02 复习准备 | 改为普通练习 | 774 | 629 | ✅ | 否 | ✅ | ✅ | 否 |
| 390×844 | M03 已评分 | 记录本次学习结果 | 774 | 629 | ✅ | 否 | ✅ | ✅ | 否 |
| 390×844 | M04 已记录 | 查看我的学习档案 | 774 | 629 | ✅ | 否 | ✅ | ✅ | 否 |

- 底栏 `display: block`、`position: static`：它是正常文档流里的 flex 行，不覆盖内容。
- 8 个场景 `blocking` 列表为空：无重叠、无不可见、无不可点击、无横向溢出。
- 截图（8 张，均为本轮真实运行）：`P2-5-assets/{320x640,390x844}-light-M0{1..4}-*.png`。

**结论：不存在真实遮挡。旧 `clear=false` 是选择器与采样方式错误，不是产品缺陷。本轮未修改任何产品代码。**

### 14.4 全量测试（可追溯日志）

| 项 | 值 |
| --- | --- |
| Node.js | v24.14.0 |
| npm | 11.9.0 |
| Git SHA | `ec707be`（运行前） |
| 命令 | `npx vitest run --maxWorkers=4` |
| 退出码 | 0 |
| 日志 | `P2-5-assets/full-test.txt` |

**正式结果（第 2 次运行）**：194 文件通过 / 1 失败；**2193 通过 / 1 失败 / 3 跳过**。

失败：`apps/learning-agent/src/server.e48-workbench.test.ts` → `E4.8a — course status gates chat writes` → `allows an in_progress course to continue chatting`，断言 `providerCalls` 期望 1 实得 2。与历史记录完全一致；本分支相对 `main` 没有任何代码差异，已独立复现。

### 14.5 一次并发偶发失败（如实记录）

第 1 次全量运行出现 **2** 个失败：除上述基线失败外，还有 `PracticePage.test.tsx` → `practice page long-term recommendation (C4-B)` → `does not claim a refreshed long-term state when finalize fails`（`loadConceptRecommendation` 被调用 1 次）。

核查：

- 该用例**单独运行通过**（`-t` 过滤，1 passed）。
- 本分支与 `main` 无任何代码差异，因此不是本轮引入。
- 第 2 次同条件运行未复现，恢复为 2193 / 1。

判定为**并发下的偶发失败**，不是确定性失败。两次日志均已归档：`full-test-run1-flaky.txt`（2 失败）与 `full-test.txt`（1 失败）。不把它写成稳定失败，也不隐藏。

### 14.6 证据一致性核查

| 项 | 状态 |
| --- | --- |
| E11 / R02 / R10 证据数 | 16 / 16 / 18，与 `metrics-phase-c.json` 一致，未恢复旧的 4→6 口径 |
| E 阶段 62 条指标 | 58 条已关联真实 PNG，4 条纯 DOM/身份记录保留 `file=""`，未虚构截图 |
| P2-3 英文 unknown | 原始 B 阶段指标支持：恰好 1 个 neutral 徽章；本轮未重复验证 |
| P2-4 生成按钮 | 原始 B 阶段指标支持：点击前 `disabled=false`；本轮未重复验证 |
| R06 URL 防伪造 | 由 `PracticePage.test.tsx` 负向用例覆盖，**不**写成浏览器实测 |
| 截图真实性 | 本轮新增 8 张底栏截图，全部来自本轮真实运行 |

### 14.7 R1 遗留项关闭情况

| 遗留项 | 状态 |
| --- | --- |
| 320px 底栏遮挡复测 | ✅ 关闭（320 与 390 均无遮挡） |
| 旧 `clear=false` 解释 | ✅ 关闭（选择器 + 采样方式错误） |
| 全量测试日志可追溯 | ✅ 关闭（两次日志已归档） |
| 历史基线失败确认 | ✅ 关闭（同名断言，已独立复现） |
| 证据一致性 | ✅ 关闭（第 14.6 节） |

### 14.8 最终结论

**PASS_WITH_KNOWN_BASELINE_FAILURE。**

- 移动端底栏无实际遮挡，操作按钮在 320px 与 390px 均完整可见、可点击。
- 旧指标矛盾有可复核的解释，且未改动产品代码。
- 本轮无新增确定性测试失败（第 1 次并发偶发已如实记录并复验）。
- 历史 `server.e48-workbench` 失败已独立确认，与本阶段无关。
- 测试日志与截图均可追溯。

**满足解除 Draft 的条件；不自动合并，等待最终审核。** E4.9h 阶段功能开发到此停止。
