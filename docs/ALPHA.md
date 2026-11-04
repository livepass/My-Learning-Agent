# v0.1.0-alpha

源码开发预览。单一学习产品，仅提供 learning 运行入口。

## 已具备能力（C0 / C1 / C2 / C3 / C4-A / C4-B / C4-C / D1–D4）

### C0 学习底座与全响应式前端
- **学习页面与主导航**：今日学习、AI 学习、练习与反馈、我的学习档案四个页面进入主导航（桌面侧栏与移动端底栏一致，底栏按条目数均分列宽）。系统设置不再出现在左侧导航，仍可从顶栏「设置」按钮或 `?page=settings` 进入，页面本身与配置能力未改动。
- **响应式布局**：桌面固定侧栏，≤900px 折叠为底部导航；已验证 320×640、360×800、390×844、768×1024、1024×768、1440×900、1920×1080 七个视口，无横向溢出、无内容被裁切、无底部导航遮挡。
- **学习会话与历史**：会话创建、切换、历史恢复；`?page=` 与 `?session=` 为 URL 单一真相，直接访问、刷新、后退、前进都能回到同一段会话。
- **进入即续上次对话**：地址没有 `?session=` 时，AI 学习页自动打开最近更新的会话（`historyMode: replace`，不新增浏览器历史，也不创建新会话）；已有打开中/正在打开的会话、或用户显式点过「新建」时不覆盖。刷新后直接发言不会再生成第二段内容近似的对话。服务端仍只保存显式创建的真实会话，没有新增会话存储。
- **归档与恢复**：「学习会话」分「日常会话」与「已归档」两组，每行次级菜单提供归档（普通会话）或恢复（已归档会话），永久删除也收在同一菜单里。日常列表默认 6 条，更多通过「查看全部」展开；全部归档时仍能打开归档组并恢复。归档/恢复只改 `archives.json`，不触碰聊天文件、B2 题目/作答/评分/检查点，也不改 L1 证据、掌握状态或复习时间。归档当前会话会在服务端确认成功后清掉 `?session=` 并进入空白选择态，不创建新会话、不自动打开别处，也不会被「续接最近会话」立刻抢回。后端校验会话 ID（非法 400、不存在 404）、重复归档/恢复幂等，归档与删除共用同一元数据队列，删除完成后不会留下幽灵归档项。
- **列表过滤与恢复标记**：`archives.json` 用三态表达：`true` = 已归档，`false` = 曾被归档并已显式恢复，缺省 = 从未归档。会话进入列表的条件是「有聊天消息 / 存在显式归档状态（无论 true 或 false）/ 是当前打开的本机会话」。因此零消息、非当前的真实会话归档后可见，恢复后仍然可见（刷新与服务重启后一致），而从未归档过的空白历史会话继续隐藏，不会因为一次恢复就把旧草稿全部翻出来。永久删除在同一把元数据锁内按“键是否存在”清理，`true` 与 `false` 标记都会被移除。兼容性：本次之前执行的恢复只会删除键、不会留下 `false`，那些零消息会话需要重新归档再恢复一次才会回到日常列表。
- **永久删除与 D3/D4**：入口收在次级菜单，必须显式确认。文案明确：聊天内容、题目、作答、评分与检查点不可恢复；已写入学习档案的证据与掌握状态不会自动删除或回滚；原始作答可能无法回查，不等同于彻底清除个人学习数据。删除失败保留该行并就地报错。删除**当前打开的**会话时，服务端会在同一个 Agent 队列任务内安全切换到另一个已有会话 B（未归档、有消息、真实存在），确认绑定后删除 A，并返回 B 让前端打开；没有合格 B 时返回 409 `no_replacement_session`，保留 A 并提示先新建或归档，**不会自动创建替代会话**。删除中或删除后的 A 不可被 chat/activate 重新绑定，排队中的旧请求也不会复活它。删除非当前会话不改变当前视图与运行时。
- **学习检查点**：按会话读取公开状态、显式初始化、暂停与继续，带修订号冲突检测。权威记录保存在本机，元数据中的投影可从权威记录重建。
- **学习档案与模型设置**：复用已有的学习档案面板与通用/模型/关于设置；未恢复已裁剪的 MCP、终端、Office 等能力。

### C1 知识依据与正向出题
- **知识点出题与依据绑定**：基于指定知识点生成练习题目，支持关联 L2 知识库资料或模型原生知识，清晰标识依据来源。
- **题目版本与幂等生成**：生成题目持久化至会话学习记录，携带唯一题目标识与版本号，同一生成请求幂等复用，刷新与重启精准恢复题目。
- **公开题目安全视图**：练习界面与检查点仅展示公开题目题干，参考答案、评分标准与私有依据在服务端持久化，不向前端泄露。

### C2 作答提交与可靠评分
- **作答保存与状态恢复**：支持保存用户作答，页面刷新后完整恢复服务端持久化的原始作答与已评分反馈；未提交作答按会话独立保留本地编辑状态，A/B 会话切换绝不串答案。
- **显式重新评分与重试预算**：支持针对评估失败（如超时）的显式重新评分（同一 attempt、不改答案、受预算保护）；重试上限后阻止继续消耗调用。
- **模型就绪探测与竞态补偿防护**：正式评估前探测模型就绪状态；若调用瞬间模型未就绪且未发起有效网络请求，通过验证 `evaluation_run_id` 执行原子补偿写入，不消耗重试预算，且避免作答永久卡在 `evaluating` 状态。
- **并发与暂停弹性**：评分过程中暂停检查点不会导致作答无法结算；完成与失败写入校验运行身份隔离，旧评分不覆盖新运行结果。
- **只读最小公共视图**：公开视图仅暴露用户作答、判定结果（correct/partial/incorrect/unknown）、反馈文案、得分及依据条目，私有 Rubric 权重与模型原始回复严格隔离。

### C3 学习证据记录与掌握状态更新
- **客观学习证据转化**：纯函数将权威 B2 学习作答与评分记录（`LearningAttempt`、`ValidatedLearningAssessment`、`LearningQuestion`、`LearningHintSnapshot`）确定性转换为正式 L1 `learning_evidence` 事件；不信任客户端输入，不将用户答案明文、参考答案或私有 Rubric 原文复制至 L1 metadata。
- **题目类型与提示折扣映射**：结合真实提示使用快照确定证据强度（已揭示答案或使用三级提示映射为 `exposure` 赋予零掌握权重，使用提示映射为 `guided_recall` 折扣权重，无提示继承原生题型）；评分器置信度采用确定性保守启发式（0.8），`unknown` 不伪造数值分数且不计入掌握成功。
- **L1 单一所有者写入与去重保护**：通过 `recordEventAndUpdateProfile` 统一提交至 L1 事件账本并触发画像投影；天然遵循 `learner_id + session_id + attempt_id` 强去重，重复提交幂等返回原事件，绝不产生二次掌握度增量。
- **跨存储分阶段提交与故障恢复**：严格复用 `evaluated` → `evidence_recorded` → `profile_projected` → `completed` 状态机；全链路覆盖跨 B2 与 L1 的 A-F 失败窗口，崩溃重启后自动补偿推进或幂等回放，确保检查点可靠推进至 feedback 阶段。
- **投影真实性校验**：`evidence_recorded` 阶段不再"先标记后补投影"——完成前必须通过 `inspectEvidenceProjection` 核对权威账本中确有该事件（按 `event_id`/`seq` 双路匹配）、投影规则版本一致、且画像游标已覆盖该序号；游标落后时由 L1 所有者路径就地补齐，补齐失败则明确返回 `projection_pending`/`evidence_missing` 而不推进状态。
- **检查点推进守卫**：`completed` 只能由真实推进的检查点产生；若检查点状态或题目不匹配导致 `advanceCheckpointForAttempt` 拒绝推进，写入会显式失败（`RECORD_STATE_INVALID`）而不是把作答标记为已完成。
- **并发 finalize 幂等**：同一进程内对同一 (会话, 作答) 的重复记录请求串行化，后到者观察到 `completed` 后走幂等回放并返回同一 `event_id`；跨进程则由 L1 去重键（`learner + session + attempt`）与 B2 阶段守卫保证只产生一条证据、一次掌握度增量。
- **前端显式确认与档案联动**：练习页面在评分完成后展示「记录本次学习结果」操作；记录成功后展示「本题已记录」标记、说明文案与「查看我的学习档案」入口，并自动拉取最新掌握度状态（界面不展示事件序号、画像版本等内部字段）。

### C4-A 同一会话连续出题
- **连续出题状态机**：新增纯函数 `canCommitNextQuestion(record, { afterAttemptId })`，只允许两种形态——首次出题（`conversation` 且无题目）与续题（`feedback` 且上一条作答已 `completed`、`checkpoint_advanced === true`、题目版本与检查点一致、无待处理作答）；`paused`、`completed`、评分中、证据未记录完成一律拒绝。服务层与 Store 写入锁内复用同一判断，客户端传入的 `completed=true` 无法绕过。
- **最小请求契约**：`QuestionGenerationRequest` 增加可选 `after_attempt_id`，仅用于指明本次续题承接的已完成作答；它参与请求指纹与前端 `requestIdFor`，并持久化在题目 `generation.after_attempt_id` 中用于追踪。指纹只在字段存在时纳入，升级前的历史请求重试不会因新增字段变成冲突。
- **原子续题写入**：`commitQuestion` 在 `runExclusive` + writer lock 内先做 request_id 幂等查找，再校验 revision 与状态机，最后追加题目、把 `checkpoint.question` 指向新题、`step` 置为 `awaiting_answer`、revision 只加一次；`questions` 单调增长，历史题目、作答、评分与 L1 证据均不可变，`last_completed_attempt_id` 作为历史引用保留，`exposure_sequence`、`goal_id`、`status` 不受影响；新题目复用历史 `question_id` 会被拒绝。
- **幂等与并发**：同一 `request_id` 重放返回原题且 revision 不变；同 ID 不同载荷（含不同 `after_attempt_id`）返回 409；历史出题请求重放时返回原题但携带**当前** checkpoint，客户端必须依据 `checkpoint.question` 判断当前题目；两个相同请求并发只保存一题，不同请求并发最多一个提交成功；模型调用期间暂停或删除会话时，提交会因权威状态变化被拒绝。
- **前端作答身份修复**：`currentAttempt` 不再回退到 `last_completed_attempt_id`——只有 `pending_attempt_id`（且属于当前题目）或 `feedback` 阶段当前题目的已完成作答才会被当作"当前作答"；新题在未作答前显示空白可编辑输入框，不会被上一题的答案与评分污染。
- **草稿按题目隔离**：未提交草稿键从 `sessionId` 改为 `sessionId + question_id + question_version`，A 的草稿不会出现在 B，也不会覆盖 A1 的已保存答案；会话切换同样隔离。
- **「再练一道」交互**：C3 完成后显示「本题已记录」「再练一道」「查看我的学习档案」；「再练一道」默认建议同一知识点（仅当学习档案存在可信名称），可修改知识点、题型与学习目标后再生成；生成失败时原反馈与已记录状态保持不变，可直接重试。
- **完整公共 checkpoint**：出题与 finalize 响应改为返回完整公共投影（含 `question`、`last_completed_attempt_id`、`pending_attempt_id`、知识来源类型），避免续题后前端丢失历史完成引用；刷新仍以 GET 结果为权威。
- **评分身份隔离**：评分结果只归属于产生它的 session + attempt + question/version。响应级临时评分缓存带完整身份并在读取时校验：checkpoint 指向新题、出现新的待处理作答、评分失败或切换会话后，旧评分立即不可见；渲染优先使用 `currentAttempt.assessment`（服务端持久化投影），临时缓存仅用于 reload 返回前的即时反馈，绝不以"最新写入"为由跨题复用。
- **合成概念标识不当名称**：`deriveConceptId()` 产生的 `concept_<12 hex>` 是标识而非主题。L1 投影（`projection.ts` 与 `auto-profile.ts`）不再把哈希标题化为 "concept 4512…"，而是保留标识本身；服务端拒绝把该形态作为 `concept` 提交；前端「再练一道」只有在画像存在真实名称时才预填，否则留空要求用户确认，并阻止手工输入哈希标识（含旧版 "concept 4512…" 形态）。真实名称仍复用原 `concept_id`，不新建知识点。

### C4-B 基于学习证据的个性化推荐
- **只读决策层**：新增纯函数 `recommendNextLearningActions(profile, asOf, { limit })`（`src/learning/recommendations.ts`）。内部不使用 `Date.now()`、不调用模型、不读写磁盘/L2/L3、不修改传入 profile；固定 profile + asOf + options 时结果完全一致。只从已有 `knowledge_states` 产生推荐，同一 `concept_id` 只保留一条主建议。
- **固定规则优先级**：`active` 误区 → 到期复习 → `fragile` → `learning` → `stable`（低优先级补充），`unknown` 默认不进入列表。没有加权评分公式；`mastery` / `confidence` 仅作为启发式字段保留，不参与综合打分。
- **推荐契约**：`action`（review/learn/practice/diagnose/transfer）、`suggested_kind`、机器可读 `reason_code`（`active_misconception` / `review_due` / `fragile_evidence` / `learning_needs_diagnosis` / `stable_transfer`）、可读 `reason`、`also_matches`（同概念满足的次要条件），以及最小 `evidence_basis`（`state_label`、有效 `review_due_at`、`last_result`、证据条目数、是否有活跃误区、`provenance_limited`、`exposure_only`）。不包含事件、答案、参考答案、Rubric 或画像正文。
- **到期判断**：仅当状态来源可信（`origin = derived` 且非 `provenance_unknown`）、存在至少一条可追溯证据、`review_due_at` 是有效时间且 `<= asOf` 时才算到期。仅有到期时间但无证据、来源受限、未来时间或非法时间一律不算，也不因 `state_label = review_due` 虚构到期时间。「今日学习」的到期列表使用同一口径（`isActionableReviewDue`），避免两个页面互相矛盾。
- **可信度降级**：`origin !== "derived"`（legacy/manual/缺失）或 `provenance_unknown` 的状态标记为 `provenance_limited`，不使用其启发式标签/时间产生复习、巩固、诊断或迁移建议；只有显式 `active` 误区记录仍可触发 `learn`，并附带来源受限提示。
- **名称可信**：`concept_name` 经现有合成标识检查；`concept_<hash>`、旧版 "concept 4512…" 或与 id 相同的名称一律视为不可用，返回 `name_available = false` 并由 UI 提示重新确认主题，绝不把哈希当自然语言主题送入出题模型。
- **只读 API**：`GET /api/learner/recommendations?limit=3`（全局 Top 3）与 `GET /api/learner/recommendations?concept_id=<id>`（精确单知识点）。服务端 `loadProfile()` → 服务端 `asOf` → 纯函数（先按 `concept_id` 匹配真实画像状态，再执行同一套规则）→ 公共快照（`as_of`、`generated_at`、`profile_version`、投影序号、列表、`status`/`empty_reason`、`limit`、`concept_id` 回显）。不做"把全局 limit 提到 20 再截取"的假修复，也不接受客户端提交 mastery/state_label。不写证据、不改 B2、不调模型；`limit` 1–20、`concept_id` 标识格式非法均返回 400；L1 损坏或不可读返回明确 503，不返回伪造默认建议。
- **精确读取与缓存失效**：练习页按当前 checkpoint 题目的 `concept_id` 单独读取建议，因此全局排序第 4 的知识点也能拿到自己的建议；响应必须回显同一 `concept_id`，否则视为失败。推荐读取失败会清空上一次成功快照并让错误状态优先展示，较旧请求即使晚到也不能恢复已被新请求判定失效的结果；成功恢复后重新显示新建议。切换题目/会话时立即清空上一概念的卡片，并用请求票号丢弃迟到响应。
- **前端展示**：今日学习新增「下一步学习建议」卡片（最多 3 条，展示名称、动作、理由、证据条数与建议题型；空状态与读取失败文案区分）；无真实名称时显示「知识点名称待确认」且不展示哈希。练习页在 C3 记录成功后展示当前 checkpoint 知识点对应的建议，与 C2 评分分区展示；finalize 失败或建议重读失败时不显示"已刷新"的旧建议。推荐卡只提供「前往 AI 学习 / 前往练习页」导航，不生成题目、不调用模型。
- **启发式边界**：推荐基于 L1 的启发式 `state_label`、`review_due_at` 和证据条目，不是校准后的掌握概率；`stable` 建议明确写明"不代表永久掌握"，`unknown`/无证据状态不给高置信推荐。

### C4-C 可执行的复习闭环（最小可用）
- **复习入口**：今日学习的「到期复习」行与 `action = review` 的建议卡都提供「开始复习」，只携带 `concept_id`；不传 mastery、confidence、复习状态或评分。点击只做导航，不创建会话、不生成题目。
- **资格复核**：进入练习页复习准备后重新请求 `GET /api/learner/recommendations?concept_id=<id>`，只有主推荐为 `review_due` 或 `also_matches` 含 `review_due` 才允许生成；点击「生成复习题」前再查一次。链接失效时明确提示"不再显示为到期复习"，不把它包装成已完成或仍有效的复习任务。若主建议是活跃误区，页面先解释该依据，同时允许用户选择去 AI 学习或仍按到期复习准备。
- **URL 与恢复**：`?page=practice&intent=review&review_concept_id=<id>&session=<id>&review_question_id=<id>`。参数经过标识格式校验；URL 只表达意图，不是权威状态，也不是复习身份的依据。刷新、Back/Forward 会恢复目标知识点与会话。打开页面不会创建会话、不会初始化 B2、不会生成题目。
- **请求上下文固定（并发）**：点击「生成复习题」时快照会话、`concept_id`、检查点 revision 和请求票号；异步 L1 核查、`init`、模型返回之后都重新比对。切换会话、切换知识点、退出复习模式（含「改为普通练习」）、检查点被他人推进都会取消该次请求，既不向新会话出题，也不改写当前页面或重新激活已退出的复习模式。出题调用显式带上确认时的 session，store 在该会话已不是当前会话时直接拒绝；模型返回时若会话已切换，结果只留在服务端，不写入页面状态。
- **复习身份持久化**：生成请求携带 `intent: "review"`，服务端把它写入题目 `generation.review`（与 `request_id` 同一处 metadata，无新存储），并只在公共题目投影中返回布尔标记。该标记只是来源说明，不是学习证据、不参与 C2/C3 去重、也不代表知识已掌握。`intent` 仅在出现时参与 C1 请求指纹，旧请求指纹保持兼容。页面以服务端保存的题目记录为准显示「复习」与「本次复习作答已记录。」；URL 只能收窄（同知识点、同题目），不能把普通题目标成复习题。HTTP 响应丢失后刷新，GET 从 B2 恢复题目及其复习来源；重试用同一 `request_id` 由服务端回放原题，不产生第二道。
- **会话守卫**：复用现有 B2 检查点，不新建状态机。只有 `active + conversation`（无题、无待处理作答）或 `active + feedback`（上一题已完成 C3、满足 `canCommitNextQuestion`）允许生成；`awaiting_answer`、评分中、证据写入中、`paused`、`completed`、记录不可用或状态不一致都会阻止插题，并提示先完成原学习或选择其他会话。用户可显式选择已有会话或点击「新建复习会话」；创建失败保留待复习知识点。会话没有 B2 记录时，只有点击生成才会显式初始化，进入页面不会创建。
- **复习出题**：复用 `POST /api/sessions/:id/learning/questions/generate`，默认 `kind = free_recall`，用户可显式改为应用题/迁移题；知识来源策略沿用 C1 的 `allow_model_fallback` 与指定资料校验。请求携带原 `concept_id` 与可信/确认过的名称；没有可信名称时必须填写真实名称并勾选确认，名称永远不会反向生成 concept id，避免把复习证据记到另一个知识点。`feedback` 会话携带 `after_attempt_id` 承接已完成作答；同一 `request_id` 重放只返回原题，不同请求在待答期间返回 409，失败不改变学习记录。
- **完成与 L1 更新**：复习题生成后完全复用 C2（保存/评分）与 C3（finalize/证据/检查点）。只有目标题目对应的 attempt 在 C3 成功推进到 `completed` 后，页面才显示「本次复习作答已记录。」；仅打开页面、生成题目或提交答案都不算完成。下次复习时间、掌握度与状态标签仍由 L1 状态引擎产生，前端不写入复习日期，也不因一次答对宣称 `stable`。
- **复习后刷新**：完成 finalize 后重新读取学习档案与精确知识点建议，展示 C2 评分、本次证据已记录、L1 最新状态与下一步建议；返回今日学习会重新读取到期列表。读取失败时显示错误，不复制旧建议冒充成功。
- **未新增**：没有全局题库、复习任务数据库、FSRS/遗忘曲线、后台自动出题、通知或第二套证据/评分系统。

## D3/D4 会话删除（已实施）

- 审计与实施记录：`docs/analysis/session_delete_runtime_audit.md`（审计基线 `1fae980`，实施基线 `7a7a771`）。
- **D3 安全接管**：删除运行时当前会话 A 时，服务端在 `data/sessions` 中选择「存在、可解析、未归档、至少一条消息、未被删除」的最近会话 B（`session-replacement.ts`），在同一个 Agent 队列任务内重新校验 B、切换到 B、确认运行时确实绑定 B，然后才删除 A 的聊天文件（`replaceActiveSessionAndRemove`）。返回 `newActiveId = B` 与 `replacedWith = "existing"`；B 的聊天文件、B2 和检查点逐字节不变。若 B 在排队期间失效，A 保留并返回 409 `replacement_unavailable`；若运行时在任务执行前已被其他请求切走，只删除 A，不回抢新绑定。
- **D4 无合格替代**：A 是当前会话但没有合格 B 时，返回 409 `no_replacement_session`（`requiresExplicitChoice: true`）。A 的聊天文件、B2、L1 均不变；不调用 `createNewSession()`，不创建不可见替代会话。前端提示「这是当前唯一的会话，已保留。请先新建一个会话，或归档后再删除」，不会自动重试第二次 DELETE。
- **删除生命周期**：`session-lifecycle.ts` 以进程内 lease + tombstone 管理删除状态。删除开始即阻止新请求接受 A（`/api/chat`、`/api/chat/stream`、`activate` 返回 409 `session_deleting` 或 404）；`switchSessionFile`、`runPromptInSession`、`runPromptStreamingInSession`、`branchSessionBeforeUserMessage`、`applyWorkspaceCwd`、`appendAssistantNotificationInSession` 都在共享 Agent 队列槽内重新检查文件存在与墓碑，队列等待期间被删除的目标不会再被绑定或重建。删除成功后 tombstone 保持到进程结束，旧请求无法复活 A。
- **显式会话不再回退**：`POST /api/chat` 显式指定 `sessionId` 时，不存在返回 404、正在删除返回 409；不再回退到 `runPromptSerialized()` 把消息写进当前运行时 B。只有真正未指定 `sessionId` 的请求才使用运行时当前会话。
- **清理顺序**：Agent 队列内只做切换与删除聊天文件；B2/`meta.json` 清理在队列外按原有每文件锁与元数据所有者执行，保持 Agent → B2 的锁顺序。删除仍只清理 B2 与 sidecar，L1 证据与掌握状态不变。
- **非活动删除**：同样受 lease/tombstone 保护，但不切换运行时、`newActiveId` 为 `null`；排队中的 A 任务在真正执行前失败。
- **测试**：`src/server.session-delete-audit.test.ts` 8 项（真实 HTTP + 真实文件/B2/L1）、`src/server/routes/session-delete-races.test.ts` 8 项（可控 Promise barrier：删除中的 activate/chat、B 失效、队列超时、切换抛错）、`src/session-delete-runtime.test.ts` 7 项（队列内重新校验、切换+删除同一槽、B 缺失/不合格、运行时被切走、绑定校验失败）、`src/server/session-replacement.test.ts` 3 项（可见性/归档/空白/阻塞筛选）。
- **兼容性**：旧的 `server.session-delete-audit.test.ts` 中“删除活动会话必须新建 C”的断言已替换为 D3/D4 新语义；C1/C2/C3/L1/C4/D1/D2 均未修改。

## 尚未实现（C4-C 之后）

- **题库沉淀与全局复习调度**：题目归档到全局题库、跨会话复习队列、定时推送/后台自动生成复习任务、个性化复习排序模型。
- **自动执行建议**：推荐仍只提供导航；不会自动把建议绑定到题目、知识来源或复习流程。

## 本轮验证记录（真实执行）

```powershell
npm run build        # 通过
npx vitest run       # 127 文件 / 1289 通过 / 3 跳过 / 0 失败
```

全量测试覆盖后端路由、状态机、数据存储、跨进程锁、L2/L3 检索，以及前端页面与 Store，包含以下核心回归场景：
- **作答恢复**：提交作答 → 评分完成 → 页面刷新，原始答案文本与评分反馈（包含得分与判定）完整恢复。
- **会话隔离**：A/B 会话切换不会串答案，未提交草稿按会话隔离，切换会话不显示其他会话的作答。
- **就绪竞态**：模型预检查通过但实际调用返回 `not_ready` 时，原子补偿回滚，重试次数保持不变，后续模型就绪可继续评分。
- **幂等与恢复**：重复提交/评分幂等回放、并发评分冲突防卫、评分中暂停与服务重启恢复全流程通过。
- **证据转换与提示降级**：纯转换逻辑准确覆盖无提示原生映射、提示使用降级（`guided_recall`）、答案揭示保守处理（`exposure`）与 `unknown` 分数剔除。
- **投影校验**（`profile-store.test.ts` `inspectEvidenceProjection`）：完整投射、游标缺口 16/15 经所有者恢复补齐、账本缺失、身份不匹配、按 `event_id` 命中五种情形。
- **跨存储故障窗口**（`evidence-recovery.test.ts`，真实 B2 + 真实 L1，仅伪造模型调用）：
  - A：L1 未写 → 写入一条事件、投射、推进；
  - A2：账本已写入但画像游标未覆盖（追加成功、投影失败）→ 重跑去重分支补齐游标，不产生第二条事件；
  - B/C：L1 已有事件但 B2 仍 `evaluated` → 去重回放，`event_id` 不变；
  - D：B2 `evidence_recorded` 且游标落后 → 校验+补齐后才标记投影；
  - E：B2 `profile_projected` 但检查点未推进 → 仅补完成；
  - F：已完成作答回放不再写 L1；进程重启（新建 store 实例）后回放仍只有一条证据。
- **并发与删除竞态**：同一 (会话, 作答) 两个并发 finalize 均返回成功、恰好一条证据、游标等于该事件序号、检查点推进到 `feedback`；finalize 与删除会话并发时被删记录不会被复活。
- **检查点边界**：检查点无法推进时 `completeAttempt` 抛 `RECORD_STATE_INVALID`，作答保持 `profile_projected` 而不会被误标 `completed`。
- **连续出题状态机**（`contracts.test.ts` 12 项、`record-store.test.ts` 8 项、`question-service.test.ts` 7 项）：首次 / 续题允许；缺 `after_attempt_id`、指向其他作答、上一条未完成、`checkpoint_advanced=false`、题目版本不一致、存在待处理作答、`paused`、`completed` 全部拒绝且零写入；续题后 `questions=2`、A1 作答/评分/事件逐字段不变、revision 只加一次、`last_completed_attempt_id` 保留。
- **请求契约与幂等**（`question-request.test.ts` 11 项 + 服务层）：`after_attempt_id` 严格格式校验；参与指纹且能区分不同承接作答；无该字段时指纹与升级前完全一致；同 ID 重放不新增题目、同 ID 不同 `after_attempt_id` 返回 409、历史请求重放返回原题 + 当前 checkpoint；同请求并发只保存一题、不同请求并发只成功一个。
- **两轮完整 HTTP 流程**（`server.learning-continuation.test.ts`，真实服务进程 + 真实 B2/L1 + 本地确定性 Provider）：A 出题→作答→评分→记录→feedback，再续题 B→作答→评分→记录；重启后当前题目仍为 B、A1/B1 原始答案均可读取；重放 A/B 出题与 A1/B1 finalize 均不改变 revision、不新增证据（L1 恰好两条）；GET 不触发模型调用；公共响应不含参考答案、Rubric 权重。
- **前端连续出题**（`PracticePage.test.tsx` 8 项、`learning-store.test.ts` 5 项）：记录完成显示「再练一道」；续题预填同一知识点并提交 `after_attempt_id`；B 未作答时答案框为空可编辑且不显示 A 的评分/已记录状态；提交 B1 使用 B 的题目身份；刷新显示 B1 而非 A1；A/B 会话切换草稿不串；历史请求迟到返回不激活旧题；生成失败保留原反馈可重试；无可信知识点名称时要求用户重新选择。
- **评分身份隔离**（`learning-store.test.ts` 5 项、`PracticePage.test.tsx` 6 项）：通过真实 `evaluateAnswer()` 路径写入临时评分（不在测试前清空 `assessment`），覆盖 A 评分并 finalize → 生成 B 未作答、B 已提交未评分、B 评分失败、B 成功评分、同一会话 reload、A/B 会话切换六种情形；断言旧评分不可见、B 仅显示自己的得分/反馈、当前题目恢复自己的评分。
- **概念标识与名称边界**（`concept-id.test.ts` 4 项、`projection-concept-name.test.ts` 3 项、`question-request.test.ts` 4 项、`PracticePage.test.tsx` 4 项）：派生 id 不被投影伪造为标题；服务端拒绝把 `concept_4512…` / `concept 4512…` 当作知识点名称，但允许真实名称复用派生 id；前端对 id 形态与旧版标题形态均不预填，真实名称可预填并复用原 `concept_id`，手工输入标识时禁用生成并提示原因。
- **推荐规则**（`recommendations.test.ts` 30 项）：活跃误区 → learn；到期需可信来源 + 有效证据（含边界时刻）→ review/free_recall；仅到期时间无证据不产生任务；未来、非法、legacy/manual 时间不做到期；精确概念读取可命中全局第 4 条、未知概念返回真实空结果、空 concept_id 不回退全局；fragile → practice/application；learning → diagnose/free_recall（仅有接触记录时在理由与依据中标注）；stable → transfer；unknown/无证据/legacy/缺失 origin 不产生高置信推荐；同概念多条件只留一条并列出 `also_matches`；同优先级按到期时间或 `last_evidence_at` 再按 `concept_id` 稳定排序；默认 3 条、可调上限；非法 `asOf` 返回空；输入 profile 不被修改；合成名称缺失。
- **推荐只读 API**（`server.recommendations.test.ts`，真实服务 + 真实 B2/L1 + 本地确定性 Provider）：无证据时返回 `status=empty`/`no_knowledge_evidence`；完成 A 后返回 `fragile_evidence` → practice/application，且 `evidence_basis` 与画像一致；完成 4 个不同知识点后全局仍只返回 3 条，被排除的第 4 条可通过 `concept_id` 精确读取；不存在概念返回空、非法 concept_id 返回 400；GET（全局/精确）均不调用模型、不增加 L1 证据、不改 B2 revision；第二轮后建议依据的证据条目更新；重启后同一画像与时间得到完全相同的建议；`limit` 服务端生效、非法值 400；响应不含答案/Rubric/参考答案；损坏 L1 返回 503 且无伪造列表。实际两轮示例：`concept_81d3d3132018`（名称不可用）→ `practice` / `application` / `fragile_evidence`，理由「最近的证据显示这个知识点还不稳定」，依据含 `state_label=fragile`、`last_result=correct`、证据条目 4、无活跃误区、来源可信。
- **推荐前端**（`TodayPage.test.tsx` 8 项、`PracticePage.test.tsx` 7 项、`learner-store.test.ts` 11 项）：今日学习展示名称/动作/理由/证据条数/建议题型，空状态文案与错误状态正确，点击前不导航、点击后只导航；首次成功后再次读取 503 时旧建议立即消失、只显示错误，成功恢复后显示新建议，空列表显示"暂无可靠推荐"；到期列表只展示 derived+有证据的状态；哈希名称显示为「知识点名称待确认」。练习页仅在 C3 成功后展示当前知识点建议，与 C2 评分分区；全局 Top 3 不含当前知识点时仍能显示精确读取结果；读取失败时不显示旧建议；finalize 失败不刷新；迟到/跨概念响应不串台。
- **C4-C 复习准备与导航**（`review-intent.test.ts` 9 项、`navigation.test.ts` 5 项新增、`PracticePage.test.tsx` 15 项、`TodayPage.test.tsx` 1 项）：URL 仅接受合法 `intent=review`、concept/session/question 标识，刷新与 Back/Forward 恢复目标会话；今日到期行与 review 建议卡只导航；复习准备重新核对 L1 到期资格，失效时提示并允许改为普通练习；活跃误区优先时给出解释与 AI 学习入口；无可信名称必须确认；会话 conversation/feedback 允许、awaiting/paused 阻止；无会话需显式选择或创建，创建失败保留知识点；打开页面不初始化 B2、不生成题目；迟到响应不覆盖新知识点；题型可显式调整，客户端 mastery/state_label 不进入请求。
- **会话归档/恢复与永久删除**（`server.session-archive.test.ts` 3 项，真实服务 + 真实 B2/L1 + 真实会话文件；`LearnPage.test.tsx` 9 项；`sessions-store.test.ts` 4 项）：
  - 归档/恢复：非法 ID 返回 400、不存在返回 404、重复调用幂等且只写 `archives.json`；零消息的非当前会话归档后出现在已归档组，恢复后重新回到日常列表，刷新与服务重启后仍可见，再次归档/恢复仍正确；从未归档的空白会话保持隐藏。
  - 数据完整性：真实走完 C1 出题 → C2 提交/评分 → C3 finalize 后，归档与恢复前后会话文件、B2 记录、L1 画像与事件账本逐字节一致；重启后题目、作答与证据仍可读。
  - 永久删除：删除后会话文件与 B2 记录消失、学习接口 404、L1 事件数不变、画像文件不变；`archives.json` 中 `true` 与 `false` 标记都会按“键存在”清掉，删除后再归档返回 404 且不产生幽灵条目。
  - 前端：归档/恢复/删除入口收在每行的次级菜单（Radix 菜单，键盘可用、44px 触控），归档失败保留原行并报错，取消删除不调用接口，超过 6 条可「查看全部」，全部归档时仍能展开归档组。
  - 当前会话：归档成功后清空 `?session=` 并进入空白选择态，`pendingNewSession` 阻止「续接最近会话」立刻抢回；归档请求进行中切换会话时，迟到结果不会关闭新会话；归档失败保留当前会话与页面状态。
- **会话删除 D3/D4**（`server.session-delete-audit.test.ts` 8 项，真实服务 + 真实 B2/L1；`server/routes/session-delete-races.test.ts` 8 项，可控 Promise barrier；`session-delete-runtime.test.ts` 7 项，真实 `pi-runner` + 假 runtime；`server/session-replacement.test.ts` 3 项；`sessions-store.test.ts` 3 项、`LearnPage.test.tsx` 2 项）：
  - D3：删除活动 A 时选择最近的有消息会话 B，同一 Agent 队列槽内复核 B → 切换并确认绑定 → 删除 A；返回 `newActiveId = B`、`replacedWith = "existing"`；B 字节不变、无新会话；A 的 B2 被清理、L1 画像/事件不变。
  - D4：只有 A 或仅有隐藏空白会话时返回 409 `no_replacement_session`，不创建任何替代会话，A 的聊天/B2/L1 全部保留；前端给出“先新建或归档”的可操作提示，不自动重试。
  - 删除生命周期：删除中 activate/chat/stream 返回 409 `session_deleting`；tombstone 清除后旧请求仍无法 activate 或重建 A；B 在队列中失效返回 409 `replacement_unavailable`；队列超时/切换抛错均保留 A 并回滚 lease。
  - 显式会话不回退：向已删除 A 发非流式/流式消息返回 404，当前运行时 B 的聊天文件逐字节不变；只有未指定 `sessionId` 的请求才使用运行时当前会话。
  - 重启：删除完成后重启，A 仍 404 且文件不复活，B 可 activate 并继续对话。
- **C4-C 复习身份与异步恢复**（`PracticePage.test.tsx` 6 项、`learning-store.test.ts` 2 项、`question-request.test.ts` 4 项）：
  - 会话竞态：L1 核查未返回时切到会话 B → 不向 B 出题、不带 review 参数跳转；核查期间点「改为普通练习」→ 迟到结果不重新进入复习模式、不发起模型调用。
  - 生成竞态：模型调用期间切换会话 → 迟到的已提交结果不写入页面、不导航、当前会话状态不被污染；store 对已不是当前会话的捕获 session 直接拒绝。
  - 身份恢复：URL 只有入口意图、没有题目 id 时，刷新后从 B2 的题目记录恢复「复习」标记与答题框；仅修改 URL 指向一道普通题时仍显示该题的普通反馈（「本题已记录」），不出现复习标记或「本次复习作答已记录」。
  - 重试身份：首次生成失败后再次点击复用同一 `request_id` 且始终带 `intent: "review"`；`intent` 仅在出现时参与指纹，旧请求指纹保持不变，复习与同内容普通练习的指纹不同。
- **C4-C 端到端复习闭环**（`server.review-loop.test.ts`，真实服务 + 真实 B2/L1 + 本地确定性 Provider）：真实 C2/C3 生成并记录原始概念 → 测试夹具把该状态 `review_due_at` 改到过去以模拟到期 → 精确推荐确认 review → feedback 会话生成 free_recall 复习题（请求带 `intent: "review"`，响应与 GET 均返回 `review: true`，普通题不带该标记）→ 待答期间第二次出题 409 → 同 request_id 重放返回原题不新增且仍带复习标记 → 评分后 finalize 前证据数不变 → finalize 后恰好 +1 且证据关联原 `concept_id`/本次 attempt、该 attempt 只有一条证据 → L1 证据条目增加、未变成 stable、推荐按新画像重算 → finalize 重放不新增证据/模型调用 → 重启后题目仍带复习标记、答案、建议一致。
- **端到端联动**：作答评分 → 显式记录 → B2 检查点推进至 feedback → L1 档案掌握度与事件日志更新并在前端即时体现。

### 明确未执行
- **未做真实进程强杀故障注入**：上述 A-F 窗口以"在同一存储上构造中间状态 + 注入会在指定点抛错的 L1 写入"复现，未在本轮用 `SIGKILL`/断电方式验证；磁盘耐久性依赖已有的 `writeJsonDurable` 与追加式账本的既有测试。
- **跨存储无事务**：B2 与 L1 独立提交，不存在分布式事务；一致性由幂等重放保证（同一 `attempt` 的 L1 去重键 + B2 阶段守卫）。因此崩溃后短期内两存储可能不一致，直到下一次 finalize 请求触发自愈。
- **未做真实浏览器端到端复验**：C3/C4-A/C4-B/C4-C 前端交互（记录按钮/再练一道/建议卡/复习准备）沿用组件测试与真实 HTTP 流程测试，本轮未重新执行 Chrome CDP 真机验收；移动端布局沿用 C0 已验证结论，新复习准备页复用现有 `mla-split`/`mla-card` 响应式规则，未做真机移动端走查。
- **复习到期的测试夹具**：`server.review-loop.test.ts` 通过把测试画像的 `review_due_at` 写到过去来获得"可信到期"状态，不是等待自然到期；生产环境的到期时间仍由 L1 状态引擎计算。
- **"响应丢失"未在真实浏览器断网复验**：本轮用真实 HTTP 服务验证"服务端已保存复习题 → 前端只靠 GET 恢复身份"，并用组件测试模拟迟到/丢失响应；未在 Chrome 中实际断网、中断请求或强制刷新，也未做真机移动端走查。
- **复习来源标记的作用域**：`generation.review` 只说明这道题由用户显式发起的到期复习生成，不是学习证据、不参与 C2/C3 去重、不改掌握度，也不能证明知识点已经复习完成或掌握。
- **归档/恢复未做真实浏览器截图**：本轮以组件测试（含菜单键盘路径）与真实 HTTP 集成测试验证，未在 Chrome 中实际点击归档并截图；移动端 44px 触控目标由样式保证，未做真机走查。
- **活动对话归档的 409 未做并发自动化**：服务端复用 `streamRegistry` 拒绝正在流式输出的会话，前端把它翻译为「请先停止后再归档」；本轮没有构造长流式回合来断言该分支。
- **D3/D4 未做真实浏览器并发复验**：删除中 activate/chat、B 失效、队列超时等竞态由可控 Promise barrier 的路由/运行器测试覆盖，未开两个 Chrome 标签页实际点击删除与切换并截图；未做真机移动端走查。
- **D4 不提供“无会话运行时”**：当前 SDK `@earendil-works/pi-coding-agent@1.1.0` 没有受支持的解绑能力（`newSession` 必建、`switchSession` 必绑定、`dispose` 终止），因此没有实现 `_runtime = null` 或隐形替代会话；没有合格 B 时明确返回 409，由用户新建或归档。若未来要求真正无会话，需要单独立项改造初始化与所有 `getSession()` 调用点。
- **Agent 初始化期间删除**：删除路由本身不要求 Agent 就绪；初始化中的 `initSession` 只会创建新会话，不会绑定被删除的 A。该窗口仅由代码路径确认，未构造真实慢初始化注入。
- **B2 finalize 与删除的并发注入**：删除的 B2 清理走 `LearningRecordStore.remove` 的每文件队列，未在本轮注入“finalize 正在写 B2 时删除同一会话”的真实并发；锁顺序（Agent → B2）与现有 store 队列未改。
- **未做 SIGKILL/断电**：未在“切换 B 后、删除 A 前”强制杀进程；重启场景验证的是删除完成后的持久状态（A 404、B 可继续）。
- 未使用真实大模型评分，评分链路仍以本地合成模型服务验证。
- **C4-A 不做自动推进**：连续出题必须由用户显式点击并确认知识点/题型，不存在后台自动生成或自动流转。
- **C4-C 只做显式复习**：复习入口只导航到准备页，二次核对资格后才由用户点击生成；没有后台自动创建复习任务、自动出题、通知或跨会话调度。
- **旧画像 origin 缺失的处理**：本轮不做历史数据迁移；`origin` 缺失的状态按来源受限处理，不出现在自动到期推荐与到期列表中，直到 L1 正常重投影将其标记为 `derived`。

## 已知限制

- Electron 安装包与 Docker 镜像未在本轮验证范围。
- 评分功能验证使用本地合成模型服务，不代表真实生产大模型的实际理解能力。
