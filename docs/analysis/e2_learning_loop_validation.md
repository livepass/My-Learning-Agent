# E2 真实学习闭环验证报告

- 验证时间：2026-11-05
- 基线：`aa727ec style(learn): E1.2 扩宽聊天阅读列并对齐输入框`
- 主题：Python 装饰器
- 本轮不修改产品代码、不重构、不修改 B2/L1 数据契约

## 1. 验证方法与三层证据

验证分三层，互不替代：

| 层次 | 含义 | 本轮是否执行 |
|---|---|---|
| A. 源码已实现 | 阅读路由、服务、存储代码，确认入口存在 | 是 |
| B. 自动化测试已通过 | 仓库内测试套件（真实进程 + 真实文件 + 确定性模型） | 是，全量 132 文件 / 1347 通过 |
| C. 真实浏览器与真实模型 | 真实 Chrome 驱动 UI；真实 `bailian/qwen3.8-flash` 调用 | 是，但**分两条路径**（见下） |

边界说明，避免混淆：

- **真实浏览器路径**使用确定性本地 Provider（固定对话、固定题目、固定评分）。它验证 UI 接线与持久化，**不是真实 AI 输出**。
- **真实模型路径**使用本机已配置的 `bailian/qwen3.8-flash`，通过真实 HTTP 完成“讲解 → 出题 → 评分 → 证据”，**未经过浏览器 UI**。
- 没有把确定性 Provider 的输出称为真实 AI 调用；也没有把 HTTP 验证称为浏览器验证。

## 2. 逐环节结果

| 环节 | 实现（源码） | 自动化测试 | 本轮实测 | 结论 |
|---|---|---|---|---|
| 创建学习目标 | `src/server/routes/learner.ts:147-170`；`LearnerProfilePanel.tsx` | `TodayPage`/`PracticePage` 测试 | HTTP 创建 + 浏览器“+ 新增目标 → 保存”，刷新后仍在 | 通过 |
| AI 教学对话 | `src/server/routes/chat.ts`；`agent/pi-runner.ts` | `server.smoke`、E1 对话测试 | 浏览器发送并渲染回复；真实模型回复 782 字（38.3s） | 通过 |
| 生成练习题 | `src/learning/question-service.ts`；`POST /learning/questions/generate` | `server.learning-generate.test.ts` 4 项 | 浏览器“再练一道 → 生成下一题”；真实模型生成 1 道 schema 合法题 | 通过（真实模型首调失败一次，重试成功） |
| 提交作答 | `src/learning/answer-service.ts`；`POST /learning/attempts` | `server.learning-answer.test.ts` 6 项 | 浏览器填写并提交；B2 `answer_saved` | 通过 |
| 评分与反馈 | `answer-service.ts` evaluate；真实模型评分 | 同上 | 浏览器显示评分反馈；真实模型给出 `partial 0.5` 与逐条 rubric 反馈 | 通过 |
| 正式证据 | C3 `finalizeAttempt` + `evidence-adapter` | `server.learning-http.test.ts` 12 项、`server.review-loop.test.ts` | 浏览器点“记录本次学习结果”；L1 `events.jsonl` 追加 1 条证据 | 通过 |
| B2 关联 | `record-store.ts` `LearningSessionRecord` | `record-store.test.ts` 56 项 | 题目、作答、评分、attempt、checkpoint 同一 `session_id` 与 `concept_id` | 通过 |
| L1 掌握状态 | `memory/learner/auto-profile.ts` | `evidence-recovery.test.ts` 等 | `knowledge_states` 由 `derived` 生成，`mastery/label/evidence_ids` 随证据变化 | 通过（名称有缺陷，见 F1） |
| 今日建议 | `learning/recommendations.ts`；`TodayPage.tsx` | `TodayPage.test.tsx` 9 项 | 卡片显示“到期复习/建议题型/开始复习”；理由来自真实证据 | 通过 |
| 智能复习 | `intent=review` + C1/C2/C3；`PracticePage.tsx` | `server.review-loop.test.ts` 1 项 | HTTP 复习题 `generation.review=true`，完成后同一 concept 新增 1 条证据 | 通过 |
| 刷新/重启 | 无内存态，均读文件 | 重启恢复测试 | 浏览器刷新、服务重启后目标/建议/对话/已完成作答均恢复 | 通过 |
| 归档/删除 | `sessions.ts` archive/delete | `server.session-archive` 3 项、delete 9 项 | 归档与删除后 L1 `profile.json`/`events.jsonl` 逐字节不变 | 通过 |

## 3. 实际执行结果

### 3.1 HTTP 闭环（确定性模型，19/19）

真实服务进程 + 真实临时 home + 确定性 Provider；完整跑完 2 次证据（首次学习 + 复习）。

| # | 检查 | 结果 |
|---|---|---|
| 1 | 目标创建并持久化 | 通过 |
| 2 | B2 初始化并绑定 `goal_id` | 通过 |
| 3 | 教学回复产生 | 通过（1 次模型调用） |
| 4 | 教学不写 L1 | 通过（profile/events 逐字节不变） |
| 5 | 题目入 B2，`concept_id`/`goal_id` 一致 | 通过 |
| 6 | 作答只保存一次（重复提交 `created:false`） | 通过 |
| 7 | 评分只调用一次模型，重复评分 `replayed:true` | 通过 |
| 8 | finalize 完成 attempt 与 checkpoint | 通过 |
| 9 | 1 条证据事件，含 event/evidence 双 ID | 通过 |
| 10 | L1 掌握状态由证据更新 | 通过（`fragile`，mastery 0.276） |
| 11 | 重复 finalize 不新增事件 | 通过（events 字节不变） |
| 12 | 建议读取真实状态 | 通过（`fragile_evidence`） |
| 13 | 到期条件可识别 | 通过（`review_due`） |
| 14 | 复习题服务端标记 `review:true` | 通过 |
| 15 | 复习复用 C2/C3 且归属同一 concept | 通过（events +1） |
| 16 | 过期 revision 被 409 拒绝且不写 | 通过 |
| 17 | 归档不改变 L1 | 通过（逐字节） |
| 18 | 重启后 B2/L1 逐字节一致 | 通过 |
| 19 | 重启后学习状态与建议可恢复 | 通过 |

关键文件值（fixture，HTTP 阶段结束时；浏览器阶段又完成一题，最终为 3 次作答 / 3 条证据 / mastery≈0.58）：

- `checkpoint`: `step=feedback`，`last_completed_attempt_id=e2_attempt_review`
- `attempts`: `e2_attempt_1=completed`、`e2_attempt_review=completed`
- `events.jsonl`: HTTP 阶段 2 条（`seq=1/2`）；浏览器阶段完成第三题后为 3 条
- `profile.knowledge_states[]`: `origin=derived`，`state_label=fragile`，`evidence_ids` 同时包含 `evt_*` 与 `evd_*`

### 3.2 真实浏览器（确定性模型，19/19 + 重启 5/5）

Chrome headless + CDP，1440×900，真实点击/输入/导航：

| 检查 | 结果 |
|---|---|
| “我的学习档案”新增目标，保存后可见 | 通过 |
| AI 学习页输入并发送，流式回复渲染 | 通过 |
| 侧栏进入练习，恢复待答题/继续练习 | 通过 |
| 出题并渲染题目、答案输入、提交 | 通过 |
| 评分反馈出现，点击“记录本次学习结果” | 通过 |
| 今日学习显示目标、建议、到期复习 | 通过 |
| 点击“开始复习”进入 `intent=review` 准备流程 | 通过 |
| 刷新后已完成作答仍显示“本题已记录” | 通过 |
| 服务重启后：目标/建议/到期复习/对话/已完成练习 | 5/5 通过 |

### 3.3 真实模型（`bailian/qwen3.8-flash`）

真实服务 + 真实 Provider 配置（只读引用，未复制或打印密钥），临时数据目录：

| 检查 | 结果 |
|---|---|
| 真实对话 | 通过，38.3s，782 字，内容为装饰器讲解 |
| 真实出题（第 1 次） | **502 `model_error/empty_output`** |
| 真实出题（重试） | 通过，生成 `q_a78a…`，`kind=application`，含 rubric/hints/reference_answer |
| 真实评分 | 通过，`partial 0.5`，逐条 criterion 反馈，指出“缺少完整可运行实现” |
| 真实 finalize | 通过，`attempt=completed`，`profile_version=3` |
| 真实 L1 证据 | 1 条事件，`evidence.evidence_id=evd_83d20119`，`model.provider_id=bailian`，`model.model_id=qwen3.8-flash` |
| 真实 L1 状态 | `learning`，`mastery≈0.157`，1 条证据 |

真实模型第一次出题返回 502，说明 provider 偶发空输出/错误被服务端正确拒绝；同一请求重试成功。这是**真实的可靠性边界**，不是测试替身。

### 3.4 回归

```bash
npm run build     # exit 0（tsc + vite）
npx vitest run    # 132 文件 / 1347 通过 / 3 跳过 / 0 失败
```

E1.2 布局、E1/E1.1 对话与编辑保护、D1–D4 会话管理、C1–C4-C 学习闭环均未回归。

## 4. 重点检查结论

| 检查项 | 结论 | 依据 |
|---|---|---|
| 会话与知识点身份一致 | **部分通过** | `session_id`、`concept_id`、`question_id`、`attempt_id` 全链路一致；但 L1 的知识点**名称**被写成 `concept_<hash>`，见 F1 |
| AI 教学是否错误提高掌握度 | 否 | 教学后 profile/events 逐字节不变；真实模型路径 finalize 前也只有 0 条证据 |
| 评分是否可追溯 | 是 | 事件含 `evidence_id`、`event_id`、`attempt_id`、`question_id`、`rubric_version`、模型身份；B2 保存同一 attempt |
| 同一作答是否重复写入 | 否 | 重复 answer `created:false`；重复 evaluate `replayed:true` 且模型调用不增加；重复 finalize 不新增事件 |
| 复习是否复用正式证据流程 | 是 | 复习题 `generation.review=true`，走 C2/C3，新增 1 条同 concept 证据 |
| 归档/删除是否改变 L1 | 否 | 归档与删除前后 profile/events 逐字节相同；删除后 B2 移除、会话 404 |
| 重启后 B2/L1 是否一致 | 是 | 两文件逐字节一致；浏览器 5/5 恢复 |
| 异常请求/网络失败 | 部分验证 | 过期 revision 409 且不写；重复请求幂等；真实网络中断未注入（见 F3） |

## 5. 发现的问题

### F1（中）：知识点名称未持久化，到期复习列表显示原始 hash

- 现象：学习档案里 `concept_name` 为 `concept_bb4b6e6ce381`；今日学习“下一步学习建议”卡片正确显示“知识点名称待确认”，但“到期复习”列表直接渲染 `concept_bb4b6e6ce381`（截图 `e2-evidence/e2-today.png`）。
- 原因：C1 用 `deriveConceptId(label)` 生成稳定 id，C3 证据只带 `concept_id`；`titleFromConceptId` 对合成 id 不做猜测，L1 因此没有人类可读名称。`recommendations` 用 `name_available:false` 规避，`TodayPage` 的到期列表没有做同样的回退。
- 影响：证据与身份正确，复习仍可执行；但用户会看到机器标识，且复习前必须重新确认知识点名称。
- 最小修复建议（本轮未实施，且不需要改 B2/L1 契约）：在 `TodayPage` 到期复习行复用“名称可用性”判定，不可用时显示“知识点名称待确认”，与建议卡一致；若未来要持久化名称，需要单独的契约变更，不在 E2 范围。

### F2（低）：真实模型首次出题 502

- 现象：第一次真实出题返回 502，重试成功。
- 判定：服务端正确拒绝无效模型输出，未写入半成品；UI 提供重新生成。不是缺陷，属于 provider 稳定性边界。建议保留现有错误提示与重试入口，不改代码。

### F3（覆盖缺口，低）：真实网络中断未注入

- 已覆盖：过期 revision、重复提交/评分/finalize、删除/归档、重启。
- 未执行：在 finalize 或评分请求中途切断网络/进程，再验证恢复。C3 的恢复逻辑有自动化测试，但本轮没有真实网络故障注入。报告不把自动化测试等同于该场景已验证。

### F4（信息）：真实模型延迟

- 对话 38.3s；出题在重试后完成；评分返回 `partial`。真实模型延迟明显高于确定性 Provider，但 UI 的流式/加载态正常，未出现超时或卡死。

## 6. 是否需要最小修复

- **F1：建议修**（UI-only，小改动，不触碰 B2/L1 契约），否则“今日学习”的到期复习会持续暴露机器 id。
- F2：无需修复，保留重试。
- F3：无需产品修复；补一条网络故障注入测试即可，属于测试增强。

## 7. 最终结论

**CONDITIONAL PASS**

- 闭环的**功能与数据**通过：目标 → 教学 → 出题 → 作答 → 评分 → 证据 → 掌握 → 建议 → 复习 → 刷新/重启，HTTP 19/19、浏览器 19/19 + 重启 5/5、真实模型完整跑通（出题重试一次）。
- 条件：F1 的知识点名称展示问题需要在进入下一阶段前做最小 UI 修复（到期复习行回退为“知识点名称待确认”），或明确接受该已知限制。它不影响证据正确性，但影响复习入口的可读性与“今日学习展示正确建议”的验收表述。
- F2/F3 不阻断验收；F3 作为测试覆盖缺口记录。

## 8. 复现材料

仓库外临时文件（未提交）：

- `D:/wo/code/tmp-e2-loop.mjs`（HTTP 闭环 19 项）
- `D:/wo/code/tmp-e2-browser.mjs`（浏览器 19 项）
- `D:/wo/code/tmp-e2-restart.mjs`（重启后浏览器 5 项）
- `D:/wo/code/tmp-e2-real.mjs`（真实模型）
- `D:/wo/code/e2-evidence/`（fixture/real 的 profile、events、B2、今日页截图）

真实模型验证使用了本机 `~/.inno-agent/config/config.json` 中已配置的 `bailian/qwen3.8-flash`，数据写入临时目录，未修改用户的学习数据。
