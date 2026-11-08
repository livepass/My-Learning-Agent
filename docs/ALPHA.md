# v0.1.0-alpha

源码开发预览。单一学习产品，仅提供 learning 运行入口。

## 已具备能力（C0 / C1 / C2 / C3 / C4-A / C4-B / C4-C / D1–D4 / E1 / E1.1 / E1.2 / E4.1 / E4.1a / E4.2 / E4.3 / E4.4 / E4.4-R1）

### C0 学习底座与全响应式前端
- **学习页面与主导航**：今日学习、AI 学习、练习与反馈、我的学习档案四个页面进入主导航（桌面侧栏与移动端底栏一致，底栏按条目数均分列宽）。系统设置不再出现在左侧导航，仍可从顶栏「设置」按钮或 `?page=settings` 进入，页面本身与配置能力未改动。
- **响应式布局**：桌面固定侧栏，≤900px 折叠为底部导航；已验证 320×640、360×800、390×844、768×1024、1024×768、1440×900、1920×1080 七个视口，无横向溢出、无内容被裁切、无底部导航遮挡。
- **学习会话与历史**：会话创建、切换、历史恢复；`?page=` 与 `?session=` 为 URL 单一真相，直接访问、刷新、后退、前进都能回到同一段会话。
- **进入即续上次对话**：地址没有 `?session=` 时，AI 学习页自动打开最近更新的会话（`historyMode: replace`，不新增浏览器历史，也不创建新会话）；已有打开中/正在打开的会话、或用户显式点过「新建」时不覆盖。刷新后直接发言不会再生成第二段内容近似的对话。服务端仍只保存显式创建的真实会话，没有新增会话存储。
- **归档与恢复**：「学习会话」分「日常会话」与「已归档」两组，每行次级菜单提供归档（普通会话）或恢复（已归档会话），永久删除也收在同一菜单里。日常列表默认 6 条，更多通过「查看全部」展开；全部归档时仍能打开归档组并恢复。归档/恢复只改 `archives.json`，不触碰聊天文件、B2 题目/作答/评分/检查点，也不改 L1 证据、掌握状态或复习时间。归档当前会话会在服务端确认成功后清掉 `?session=` 并进入空白选择态，不创建新会话、不自动打开别处，也不会被「续接最近会话」立刻抢回。后端校验会话 ID（非法 400、不存在 404）、重复归档/恢复幂等，归档与删除共用同一元数据队列，删除完成后不会留下幽灵归档项。
- **列表过滤与恢复标记**：`archives.json` 用三态表达：`true` = 已归档，`false` = 曾被归档并已显式恢复，缺省 = 从未归档。会话进入列表的条件是「有聊天消息 / 存在显式归档状态（无论 true 或 false）/ 是当前打开的本机会话」。因此零消息、非当前的真实会话归档后可见，恢复后仍然可见（刷新与服务重启后一致），而从未归档过的空白历史会话继续隐藏，不会因为一次恢复就把旧草稿全部翻出来。永久删除在同一把元数据锁内按“键是否存在”清理，`true` 与 `false` 标记都会被移除。兼容性：本次之前执行的恢复只会删除键、不会留下 `false`，那些零消息会话需要重新归档再恢复一次才会回到日常列表。
- **永久删除与 D3/D4**：入口收在次级菜单，必须显式确认。文案明确：聊天内容、题目、作答、评分与检查点不可恢复；已写入学习档案的证据与掌握状态不会自动删除或回滚；原始作答可能无法回查，不等同于彻底清除个人学习数据。删除失败保留该行并就地报错。删除**当前打开的**会话时，服务端会在同一个 Agent 队列任务内安全切换到另一个已有会话 B（未归档、有消息、真实存在），确认绑定后删除 A，并返回 B 让前端打开；没有合格 B 时返回 409 `no_replacement_session`，保留 A 并提示先新建或归档，**不会自动创建替代会话**。删除中或删除后的 A 不可被 chat/activate 重新绑定，排队中的旧请求也不会复活它。删除非当前会话同样经过 Agent 队列：若排队期间运行时已切到 A，会按队列时的真实绑定转入接管逻辑；无合格 B 则 409 保留 A。手动生成标题若在模型返回前会话已被删除，写入边界会拒绝迟到的 `meta.json` 条目。
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

- 审计与实施记录：`docs/analysis/session_delete_runtime_audit.md`（审计基线 `1fae980`，D3/D4 实施基线 `7a7a771`，最终并发补丁基线 `34d5b80`）。
- **D3 安全接管**：删除运行时当前会话 A 时，服务端在 `data/sessions` 中选择「存在、可解析、未归档、至少一条消息、未被删除」的最近会话 B（`session-replacement.ts`），在同一个 Agent 队列任务内重新校验 B、切换到 B、确认运行时确实绑定 B，然后才删除 A 的聊天文件（`deleteSessionFileInQueue`）。返回 `newActiveId = B` 与 `replacedWith = "existing"`；B 的聊天文件、B2 和检查点逐字节不变。若 B 在排队期间失效，A 保留并返回 409 `replacement_unavailable`；若运行时在任务执行前已被其他请求切走，只删除 A，不回抢新绑定。
- **D4 无合格替代**：A 是当前会话但没有合格 B 时，返回 409 `no_replacement_session`（`requiresExplicitChoice: true`）。A 的聊天文件、B2、L1 均不变；不调用 `createNewSession()`，不创建不可见替代会话。前端提示「这是当前唯一的会话，已保留。请先新建一个会话，或归档后再删除」，不会自动重试第二次 DELETE。
- **删除生命周期**：`session-lifecycle.ts` 以进程内 lease + tombstone 管理删除状态。删除开始即阻止新请求接受 A（`/api/chat`、`/api/chat/stream`、`activate` 返回 409 `session_deleting` 或 404）；`switchSessionFile`、`runPromptInSession`、`runPromptStreamingInSession`、`branchSessionBeforeUserMessage`、`applyWorkspaceCwd`、`appendAssistantNotificationInSession` 都在共享 Agent 队列槽内重新检查文件存在与墓碑，队列等待期间被删除的目标不会再被绑定或重建。删除成功后 tombstone 保持到进程结束，旧请求无法复活 A。
- **显式会话不再回退**：`POST /api/chat` 显式指定 `sessionId` 时，不存在返回 404、正在删除返回 409；不再回退到 `runPromptSerialized()` 把消息写进当前运行时 B。只有真正未指定 `sessionId` 的请求才使用运行时当前会话。
- **清理顺序**：Agent 队列内只做切换与删除聊天文件；B2/`meta.json` 清理在队列外按原有每文件锁与元数据所有者执行，保持 Agent → B2 的锁顺序。删除仍只清理 B2 与 sidecar，L1 证据与掌握状态不变。
- **非活动删除**：同样受 lease/tombstone 保护，并统一进入 Agent 队列；以**执行时**的运行时绑定为准——运行时不在 A 时只删除文件、`newActiveId` 为 `null`；排队期间 `activate(A)` 已把运行时切到 A 时转入接管，无合格 B 则 409 保留 A。排队中的 A 聊天任务在真正执行前失败，不会重建文件。
- **迟到标题**：`generate-topic` 在 `meta.json` 的写入边界内检查会话仍存在且未处于删除状态；模型返回前会话已被删除时返回 404，不创建孤立元数据条目。自动标题与人工标题路径不变。
- **测试**：`src/server.session-delete-audit.test.ts` 9 项（真实 HTTP + 真实文件/B2/L1，含迟到标题）、`src/server/routes/session-delete-races.test.ts` 9 项（删除中的 activate/chat、非活动删除走队列、B 失效、队列超时、切换抛错）、`src/session-delete-runtime.test.ts` 12 项（队列时运行时身份、activate 暂停后删除、A→B 切换中删除 B、B 归档/删除中回滚、排队聊天不复活）、`src/server/session-replacement.test.ts` 3 项（可见性/归档/空白/阻塞筛选）、`src/shared/session-meta-store.test.ts` 27 项（含迟到标题拒绝）。
- **兼容性**：旧的 `server.session-delete-audit.test.ts` 中“删除活动会话必须新建 C”的断言已替换为 D3/D4 新语义；C1/C2/C3/L1/C4/D1/D2 均未修改。

## E1 AI 学习对话体验

- **消息展示**：用户消息右对齐为圆角气泡；AI 回复左对齐、去掉角色标签与多余边框，正文按 780px 阅读列、1.72 行高和自然段落渲染。流式回复直接在对话末尾生长，滚动默认贴底；用户主动上滚后不再抢回滚动位置。
- **消息操作**：用户消息悬停或键盘聚焦显示「复制」「编辑」，AI 回复显示「复制」。触屏/移动端操作始终可见。复制使用原始文本（`message.content`），成功显示「已复制」，失败显示「复制失败，请手动选择文本」，不触发发送、分支或会话切换。
- **输入框**：圆角多行输入框，内容增加时自动增高，超过 200px 后内部滚动；底部左侧为全局默认模型选择器，右侧为发送按钮，生成中替换为停止按钮（复用 `chatStore.cancel()`）。发送、编辑发送均复用 `chatStore.send()`；普通草稿仍由 `appStore.chatDraft` 持有，页面切换不丢失。
- **键盘行为**：移除 Ctrl/Cmd+Enter 自定义发送；回车保持原生换行，只通过发送按钮提交。没有新增快捷键提示、文件上传、Markdown 工具栏或其他增强入口。
- **重新编辑**：仅对真实持久化、带 `entryId`、无图片/附件、来源为 web 的用户纯文本消息开放。编辑框出现在原消息位置，预填原文；使用独立 `editDraft`，不读写 `appStore.chatDraft`。退出编辑只清理编辑态。
- **分支与重发**：发送修改前调用 `POST /api/sessions/:id/branch-before-message`，再调用 `chatStore.branchBefore(entryId)` 从当前视图移除被编辑消息及之后的所有回答，最后走现有 `chatStore.send()`。旧 JSONL 不被原地改写，旧回答属于被放弃分支，不会显示为新消息的回答。
- **并发与数据保护**：编辑前检查会话身份、活动流、本地消息是否仍存在，并读取 `GET /api/sessions/:id/learning` 做提前提示；**服务端在分支执行的队列槽内以 B2 为准再判一次**（见 E1.1），客户端检查只是提示。不调用任何 B2/L1 写接口，不回滚或修改学习档案。编辑期间切换会话会关闭编辑态，不会向新会话建分支或发送。分支成功但重发失败时保留编辑草稿与错误，可在新分支上重试发送。
- **模型选择**：复用 `settingsStore`、`settings.configuredModels` 与 `POST /api/settings/model`（`switchBackendModel`）。只展示已配置模型及提供商；当前值来自 `settings.defaultProvider/defaultModel`。切换期间禁止重复选择与发送，失败保留原模型并显示错误；生成中禁止切换。未配置模型时提供「连接模型」入口，直接打开系统设置的「模型连接」tab。第一版只切换全局默认模型，没有逐消息模型能力。
- **文案同步**：移除「出题与评分尚未开放」「练习评分与资料导入尚未开放」等过期说明；学习页与侧栏改为描述已接入的出题、评分与学习证据。
- **测试**：`LearningWorkspace.e1.test.tsx` 16 项（复制成功/失败、编辑资格与退出、分支顺序、分支失败、服务端学习记录拒绝、分支成功但发送失败保留草稿、分支被并发改变、证据保护、流式禁用编辑与流式渲染、会话切换取消编辑、Ctrl/Cmd+Enter 不发送、切换模型时禁用、模型切换成功/失败、空模型入口）；`chat-store.test.ts` 20 项（含分支标记透传与 `stale_branch` 终止码）；`settings-store.test.ts` 2 项（确认后才更新、失败保留旧值）；`server.session-branch.test.ts` 9 项（真实服务分支、过期消息、B2 证据/待评分拒绝、真实作答落盘后拒绝、客户端检查后证据落盘、有效/过期分支标记、流式拒绝）；`shell.css.test.ts`（布局契约，现 10 项，含触屏操作、滚动归属、E1.2 宽度对齐与窄屏表格）。
- **仍未支持的编辑边界**：图片/附件消息、渠道（非 web）消息、临时/未持久化消息不能编辑；已有 B2 正式证据或进行中学习任务的会话不能编辑历史；不提供消息级模型、重新生成、复制修改内容、还原旧分支、Markdown 编辑工具栏或文件上传。

### E1.1 历史消息编辑安全性补丁

- **服务端权威判定**：`POST /api/sessions/:id/branch-before-message` 不再依赖前端 `GET /learning` 的结论。新增纯函数 `evaluateBranchEditSafety(record)`（`src/learning/branch-edit-guard.ts`），按 B2 记录判定：已有作答/证据 → `409 learning_evidence_locked`；有已保存或评分中的作答、待处理 attempt → `409 learning_attempt_pending`；已发布题目、提示曝光、`step !== conversation` → `409 learning_task_pending`。拒绝时返回中文 `message`，不删除、不回滚、不重新投影 L1 证据。
- **校验与分支原子化**：新增 `LearningRecordStore.withRecordLock(sessionId, fn)`，在同一记录的文件队列与写入锁内读取权威记录并把决定交给回调。分支任务通过 `beforeBranch` 在**同一 Agent 队列槽**内先取锁判定、再修改会话树，因此 B2 初始化、评分提交、C3 finalize 无法在校验与分支之间落盘；锁顺序仍是 Agent 队列 → B2 写入锁，不在持有 B2 锁时等待 Agent 队列。判定回调抛错时分支不执行，会话文件保持原样。
- **分支提交校验**：`branchSessionBeforeUserMessage` 返回 `branchMarkerId`；编辑重发把它随 `/api/chat` 或 `/api/chat/stream` 的 `branchMarkerId` 传回。服务端在真正执行 prompt 的队列槽内比对当前分支叶子是否仍是该标记：不一致返回 `409 stale_branch`（流式为终止事件 `aborted` + `code: "stale_branch"`），不追加任何消息。标记缺失时行为不变（普通发送）。
- **前端反馈**：编辑失败区分服务端学习记录拒绝、分支被并发改变、普通发送失败；三种情况都保留编辑草稿与原始视图，不自动重试、不重新分支。`chatStore.lastTerminalCode` 只保存本次发送的终止码。
- **测试**：`branch-edit-guard.test.ts` 8 项（策略矩阵）；`record-store.test.ts` 新增 2 项（同一记录的文件队列/写入锁串行化、拒绝回调不写盘）；`session-branch-runtime.test.ts` 6 项（`beforeBranch` 在队列槽内、拒绝时树不变、标记匹配/过期/普通发送）；`server.session-branch.test.ts` 新增 7 项真实 HTTP 场景（正式证据、待评分、真实作答经学习 API 落盘、客户端检查后证据落盘、有效标记、过期标记、流式过期标记），并断言聊天消息、B2、L1 逐字节不变。
- **仍未支持**：不提供分支还原、消息级模型、重新生成或 Markdown 编辑工具；带图片/附件的用户消息、非 web 渠道消息仍不可编辑。

### E1.2 AI 学习页面宽度与响应式布局

- **约束来源**：消息列真正受 `.mla-chat-scroll > * { max-width: 780px }` 限制；`.mla-learn` 本身没有宽度上限。1920 视口下聊天卡片 1444px、消息列只有 780px，而输入框铺满 1394px，形成“两侧空、输入框过宽”的错位。
- **桌面布局**：`.mla-learn` 增加 `width: 100%; max-width: 1440px; margin-inline: auto`。由此聊天卡片固定为 1148px（1100px 内容列 + 24px 卡片内边距 ×2），右侧信息栏仍为 224px、间距 20px；`.mla-chat-scroll > *` 的列为 `max-width: 1100px`。输入框沿用 24px 内边距，在卡片封顶时自然落在同一 1100px 列上，不需要额外覆盖规则。
- **收缩与移动端**：低于 1440px 时卡片随可用宽度收缩（1440 → 914px 列、1366 → 840px 列）；≤900px 保持原有单列布局、16px 页面/输入框边距、消息列 `max-width: 100%`；五个目标视口均无页面级横向溢出。
- **窄屏表格**：手机端 5 列表格原本被压成逐字换行。新增 `@container (max-width: 640px)` 下 `.mla-message-assistant .inno-markdown-table { min-width: 560px }`，由既有 `.inno-markdown-table-scroll` 在表格内部横向滚动；选择器只作用于学习消息，其他页面表格尺寸不变。
- **CDP 实测（Chrome headless，精确 CSS 视口，单位 px）**：

| 视口 | 修改前 消息列 / 输入框 | 修改后 消息列 / 输入框 | 修改后卡片 |
|---|---|---|---|
| 1920 × 1080 | 780 / 1394 | 1098 / 1098 | 1148 |
| 1440 × 900 | 780 / 914 | 914 / 914 | 964 |
| 1366 × 768 | 780 / 840 | 840 / 840 | 890 |
| 768 × 1024 | 678 / 678 | 678 / 678 | 712 |
| 390 × 844 | 300 / 300 | 300 / 300 | 334 |

  1920 下 1098 而非 1100 是卡片左右各 1px 边框所致；输入框与消息列完全相等，说明对齐成立。全部视口 `scrollWidth === clientWidth`，无横向溢出。
- **测试**：`shell.css.test.ts` 新增 2 项——学习页 1440/1100 宽度与输入框同列契约、窄屏表格最小宽度规则（且限定 `.mla-message-assistant`）。

## E4.1 / E4.1a 多课程记忆关联

- **课程实体**：`Course` 与 `CourseGoalBinding`、`StudyPlan`、`LearningTask`、`CourseSessionBinding`、`CourseSourceBinding` 统一由 `courses/course-store.ts` 写入 `data/courses/state.json`；课程不是学习目标，归属只来自显式绑定，绝不按标题或聊天内容推断。
- **课程视图**：`GET /api/courses/:courseId/learner` 返回该课程绑定的目标、`course_id` 匹配的知识点状态，以及跨课程共享的教学偏好；未归类数量单列。旧知识点保持未归类，不做批量迁移。
- **同名知识点**：课程内出题把 `course_id` 纳入知识点哈希（`deriveConceptId(label, { courseId })`），Python 的「函数」与高数的「函数」得到不同 `concept_id`，不会合并掌握度；无课程上下文时哈希与历史完全一致。客户端复用其他课程的 `concept_id` 返回 409 `concept_course_mismatch`。
- **L2 范围**：`CourseSourceBinding` 增加 `status(active/detached)`、`updated_at`、`detached_at`；解除是状态变更，重新绑定复用原记录。检索按 `sourceIds` 先限定候选页面再做词法与一跳图谱扩展，空范围表示「本课程没有资料」而不是退回全局；显式指定范围外资料返回 409 `designated_out_of_scope`。
- **L3 范围**：召回支持 `allowedSessionIds`，在评分前过滤；空集合不回退全局。`l3_recall` 不增加 `course_id` 参数，课程范围只能由服务端回调提供（E4.4 接入会话绑定）。
- **B2 溯源**：题目私有 `generation.course_id` 在出题时冻结，C3 写证据时复制为 `LearningEvidence.course_id`；旧题目/旧证据保持未归类。`GET /api/courses/bindings/session/:sessionId` 额外返回 `task`、`source_ids`、`goal_ids`，可从 B2 `session_id` 反查课程。
- **统一上下文**：`resolveCourseContext` 只读持久化绑定；客户端课程意图仅用于校验（不匹配 409）；课程文件损坏返回 503，不退化为未归类。
- **测试**：`courses/course-context.test.ts` 12 项、`courses/course-store.test.ts` 23 项、`learning/question-request.test.ts` 27 项、`learning/question-service.test.ts` 38 项、`learning/knowledge-lookup.test.ts` 17 项、`learning/evidence-adapter.test.ts` 10 项、`memory/learner/auto-profile.test.ts` 15 项、`memory/l2/l2-search.test.ts` 6 项、`memory/l3/recall.test.ts` 4 项、`server.courses.test.ts` 2 项（真实进程）、`server.learning-generate.test.ts` 5 项（真实进程，两课程同名知识点）。报告：`docs/analysis/e4_1a_memory_contracts.md`。
- **仍未实现**：课程级 L3 自动召回接线、课程页面与任务驱动会话（L2 索引级来源过滤已在 E4.2 完成）。

## E4.2 课程专属 L2 知识库

- **索引级课程检索**：新增 `page_sources(page_path, source_id)`；`searchLexical` 把来源范围写进 SQL WHERE，在 bm25 排序与 `LIMIT` 之前过滤，全局高排名页面不再挤掉本课程资料。`getPages` 用同一谓词限定图谱扩展；混合来源页面（部分来源越界）整体排除。`undefined` 保持旧版全局、`[]` 表示空课程、非空严格限定。
- **上传入库**：`POST /api/courses/:courseId/sources/upload` 支持 PDF、DOCX、Markdown、TXT。PDF 经 LiteParse 提取并按页分片；DOCX 使用内置 ZIP/XML 文本提取，不依赖 LibreOffice；XLSX/PPTX 明确拒绝（未验证不宣称支持）。状态严格按 raw → extracted → 索引成功 → `indexed` 推进，解析/索引失败记 `error` 并可重试；索引成功后才建立课程绑定。重复内容按哈希去重，不新增 manifest 行。
- **正文分片与定位**：长文档按 1 400 字符切分（120 重叠），每个片段是 `wiki/passages/<source_id>/pNNNN.md`，带 `source_ids` 与 `passage{ordinal, heading_path, page_start, page_end, extracted_path}`。PDF 保存真实页码，DOCX/Markdown/TXT 不编造页码；片段正文含「位置」行，C1 adopt 的 `snippet_text` 因此带真实章节/页码。旧题目与旧证据结构不变。
- **课程内 AI 检索**：`l2_query` 通过服务端会话绑定解析课程来源，模型没有 `course_id` 参数；空课程直接返回「尚未关联资料」，绑定/索引读取失败时 fail-closed，不降级为全局；未归类会话保持旧版全局范围。`l2_archive`/`l2_lint` 仍是全局管理入口，课程会话归档时明确提示需要显式关联。
- **API**：资料上传、列表（含 `include_detached` 与处理状态）、详情（章节/页码定位）、失败重试、课程范围检索 `GET /api/courses/:courseId/search`，复用既有绑定/解除接口。
- **测试**：`l2-index-store.test.ts` 5 项（真实 SQLite，250 条干扰页仍命中本课程）、`course-ingest.test.ts` 8 项（Markdown/TXT/PDF/DOCX、页码、去重、重试、失败）、`passage-builder.test.ts` 3 项、`l2-query-scope.test.ts` 5 项、`server.course-sources.test.ts` 1 项真实服务端到端（两课程隔离、共享资料、解除、重绑、重启）。全量 146 文件 / 1503 通过 / 3 跳过。
- **遗留**：FTS 仍为 OR 分词（同课程内通用词会多召回）；片段页数量随教材规模增长；DOCX 只提取正文、无页码；扫描 PDF/OCR 与 XLSX/PPTX 未支持；`l2_archive` 尚未接入正文分片。

## E4.3 AI 学习计划与每日任务推荐

- **计划数据模型**：`StudyPlan` 增加 `revision`、`target_date`、`daily_minutes`、`generation`、`adjustments`；新增 `PlanStage`；`LearningTask` 增加 `stage_id`、`order`、`estimated_minutes`、`difficulty`、`source_refs`、`rationale`、`completed_at`；`CourseStudySettings` 按课程保存每日学习时间。旧 `state.json` 无这些字段时按空/默认加载，旧任务按 `created_at` 补 `order`，不重写、不追认。
- **原子与并发**：计划+阶段+任务在单文件 `mutate` 内一次写入；失败不留半套数据。阶段可单独替换标题/顺序（`PUT /plans/:id/stages`），不会删除任务。草稿整体替换、确认、排序、调整都要求 `expected_revision`，冲突 409 并返回当前版本。任务增删改也会递增所属计划 revision。
- **AI 草稿**：`POST /api/courses/:courseId/plans/generate` 只读该课程 active 来源；最多 12 份来源 / 240 个候选片段，送模型最多 24 段、每段 500 字符。目录与定位全部来自真实 `passage` frontmatter；模型只能通过 `unit_id` 引用，未知引用、未知字段、无引用、自造页码一律 422。提示把教材标为数据而非指令，字段闭集校验。只有全部通过才写入 `draft`；模型错误/超时/空输出/非法输出不产生计划、阶段或任务。
- **教材缺失**：默认 409 `no_course_material`；显式 `basis: "model_knowledge"` 可生成，但 `generation.basis`、`material_note`、`units=[]` 明确标注“未使用课程教材”，不伪装成教材规划。
- **草稿确认**：`draft` 只能通过 `POST /plans/:id/confirm` 转 `active`；`agent_suggested` 草稿的 `PATCH status=active` 被 409 拒绝。已有 active 计划时必须显式 `replace_active`，旧计划归档而非删除。生成新草稿不覆盖任何现有计划。
- **重复与失败**：同 `request_id`、相同指纹（课程/目标/预算/日期/基础/依据/片段/L1 版本）均返回原计划；`force` 只绕过指纹去重。用户改过草稿后重复生成不会覆盖修改。
- **每日推荐**：`GET /api/courses/daily` 默认只取进行中课程（显式 `course_id` 可查看其他状态），逐课程独立预算；到期复习只认 `derived` + `evidence_ids` 非空 + `review_due_at` 已过的 L1 状态；任务按 `in_progress`/`order`，首个任务可标 `over_budget`，后续必须放得下。返回 `task_progress` 与 `knowledge` 两组字段，明确不创建任务、不自动完成、不改掌握度；已有「复习：」任务时不重复推荐。
- **调整建议**：`GET /plans/:id/suggestions` 仅使用有证据的 L1 状态、活跃误区和 L2 显式前置边，输出 5 类建议（前置复习、补练习、重排、暂缓、调难度），含 `suggestion_id`、原因码和证据快照。`apply` 会按当前 revision 重算，过期建议 409；应用后写入 `PlanAdjustmentRecord`。
- **测试**：新增 `plan-generator.test.ts` 10 项、`daily-plan.test.ts` 5 项、`plan-adjustments.test.ts` 7 项、`course-store.plan.test.ts` 12 项、`server.course-plans.test.ts` 11 项（真实进程 + 真实 L2 + 模拟模型）、`server.course-daily.test.ts` 5 项（真实进程 + 真实 B2/L1 证据）。覆盖 Python/高数双课程隔离、草稿不转正、用户修改不被覆盖、重复请求、失败不落盘、缺教材、伪造引用、预算、真实到期复习、重启、旧数据、模型断连。
- **真实模型联调**：`example / qwen3.8-flash`，临时 home + 真实 server，真实生成 Python 与高数各 3 阶段 / 9 任务，引用各自教材的 8 个真实章节，`isolation_ok = true`；两份均停在 `draft`。同一请求前两次瞬时 502、第三次成功，说明生成仍有模型侧波动。
- **范围**：无课程 UI（E4.5）；无任务驱动会话与课程级 L3 召回（E4.4）。报告：`docs/analysis/e4_3_study_plans.md`。

### E4.3-R1 数据完整性修复

- **生成幂等**：模型调用前按 `request_id` / 意图指纹查询已有计划；同请求优先重放（材料更新也不影响），同 ID 不同意图 409；同完整指纹并发合并为一次模型调用；持久化复检命中时 `write:false`，不写文件、不递增 revision。
- **草稿 ID**：`replacePlanDraft` / `replacePlanStages` 校验 stage_id、task_id 全局唯一，重复返回 400 且不写入部分结果。
- **跨计划移动**：要求原计划 `expected_revision`，旧计划 reindex 关闭空洞，新计划追加末尾，两边 revision 各 +1，阶段置空。
- **绑定任务**：`deleteTask` 与 `replacePlanDraft` 拒绝删除/遗漏被 `CourseSessionBinding` 引用的任务（409），会话与 B2 记录保留。
- **课程归属**：计划 `goal_id` 必须已绑定该课程；手动任务 `source_ids` 必须是该课程 active 且 indexed 的来源；手动 `source_refs` 一律拒绝，草稿只允许原样回传。
- **次要**：前置知识建议限定课程 active 来源；`defer_task`/`reorder_task`/同难度调整无效果时 409；生成指纹加入课程 `updated_at`、目标标题与材料 `contentHash/updatedAt`。
- **测试**：`course-store.integrity.test.ts` 10 项、`prerequisite-store.test.ts` 2 项、`server.course-plans-r1.test.ts` 10 项；E4.3 相关 11 文件 / 107 通过。报告：`docs/analysis/e4_3_r1_integrity_fix.md`。

## E4.4 任务驱动 AI 会话与课程级 L3 记忆

- **开始/继续学习**：`POST /api/courses/:courseId/learning/start`（`task_id?`、`request_id?`）。有任务时先查 `CourseSessionBinding(task_id)`，存在且文件在则切回原会话；否则复用 `createNewSession` / `switchSessionFile`，成功后写绑定，再返回“已就绪”。任务只会 `pending → in_progress`，已完成任务 409。
- **先记账再建会话**：`state.json` 新增 `learning_starts`（`creating → created → ready`）。绑定失败时撤销刚创建的空会话（Agent 队列 + 会话生命周期 + 原会话接管）并删除记录；无法撤销时返回 503 与 `session_id`、`rolled_back:false`，不虚报已开始。并发按 `courseId+taskId` 单飞，重复请求按 `request_id` 幂等。
- **B2 初始化**：按原契约 `create()`，已存在原样返回；`goal_id` 只取“任务计划目标且已绑定本课程”，否则 `null`；恢复会话不重建、不覆盖题目/作答/评分。C1 出题、评分与证据链路未改动。
- **课程级 L3**：`resolveRecallScope` 改为异步，由持久绑定解析课程会话集合；未归类保留旧版全局并标注 `legacy_global`；课程只有当前会话时是空集合而非全局；课程存储损坏 → `unavailable` 并拒绝召回。`l3_recall` 无 `course_id` 参数。`recallWithStatus` 区分 `ok` / `empty_index` / `unavailable`。
- **教学上下文**：`before_agent_start` 注入课程/任务/L1 薄弱点与到期复习/课程教材原文片段/本课程历史对话/共享教学偏好；标注“教材原文 / 聊天记忆 / 正式学习证据”，最多 6 状态、3 段教材×360 字、3 段历史×240 字、总长 4200 字；未归类会话不注入课程段。
- **计划重放边界**：`request_id` 重放判定提前到读取教材之前。生成成功后即使全部来源被解绑或 L2 不可用，旧请求仍 200 返回原计划、0 次模型调用、不新增计划；新请求 409 `no_course_material`。
- **测试**：`learning-start.test.ts` 14、`recall-scope.test.ts` 5、`course-learning-context.test.ts` 6、`server.course-learning.test.ts` 9、`server.course-plans-r1.test.ts` +1。报告：`docs/analysis/e4_4_learning_sessions.md`。

### E4.4-R1 上下文与会话归属完整性

- **课程级 L1**：`before_agent_start` 每轮只解析一次会话归属。已绑定课程 → 注入按课程裁剪的 L1 包（目标按绑定、知识状态按 `course_id`、误区按本课程概念），教学偏好仍共享；未归类旧会话 → 保留旧版全量包；会话身份缺失或绑定不可读 → **不注入全量包**（不再把另一门课的进度注入课程会话）。
- **任务会话唯一**：`bindSession` 在写入事务内校验一个任务只有一个会话；第二个会话（含“认领任务”）返回 409 `course_session_conflict` 且不写入；同一会话重复绑定仍幂等；并发只有一个成功，失败方在 `learning-start` 中收敛到胜者会话。
- **历史重复**：`listDuplicateTaskBindings` + `GET /courses/:id/sessions` 的 `duplicate_task_bindings` 明确报告；继续学习取最早会话并在 `warnings` 说明；不删除任何会话或 B2 记录。
- **检索身份**：`resolveRecallScope` 对缺失/非法会话 ID 返回 `unavailable`（不再当作未归类全局）；`l2_query` 同样停止检索并说明不会回退全局；空课程范围仍为空集合；课程 ID 仍只来自绑定。
- **测试**：`learning-extension.test.ts` 5（真实扩展 + 真实存储/画像）、`course-store.binding.test.ts` 8、`learning-start.test.ts` +2、`server.course-learning.test.ts` +3、L2/L3 范围测试更新。报告：`docs/analysis/e4_4_r1_context_ownership.md`。

## 尚未实现（C4-C 之后）

- **题库沉淀与全局复习调度**：题目归档到全局题库、跨会话复习队列、定时推送/后台自动生成复习任务、个性化复习排序模型。
- **自动执行建议**：推荐仍只提供导航；不会自动把建议绑定到题目、知识来源或复习流程。

## 本轮验证记录（真实执行）

```powershell
npm run build        # 通过
npx vitest run       # 160 文件 / 1629 通过 / 3 跳过 / 0 失败（--maxWorkers=4）
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
- **会话删除 D3/D4**（`server.session-delete-audit.test.ts` 9 项，真实服务 + 真实 B2/L1；`server/routes/session-delete-races.test.ts` 9 项，可控 Promise barrier；`session-delete-runtime.test.ts` 12 项，真实 `pi-runner` + 假 runtime；`server/session-replacement.test.ts` 3 项；`session-meta-store.test.ts` 迟到标题 1 项；`sessions-store.test.ts` 3 项、`LearnPage.test.tsx` 2 项）：
  - D3：删除活动 A 时选择最近的有消息会话 B，同一 Agent 队列槽内复核 B → 切换并确认绑定 → 删除 A；返回 `newActiveId = B`、`replacedWith = "existing"`；B 字节不变、无新会话；A 的 B2 被清理、L1 画像/事件不变。
  - D4：只有 A 或仅有隐藏空白会话时返回 409 `no_replacement_session`，不创建任何替代会话，A 的聊天/B2/L1 全部保留；前端给出“先新建或归档”的可操作提示，不自动重试。
  - 删除生命周期：所有聊天文件删除（含非活动会话）都进入 Agent 队列，执行时以真实运行时绑定判断是否接管；删除中 activate/chat/stream 返回 409 `session_deleting`；tombstone 清除后旧请求仍无法 activate 或重建 A；`activate(A)` 暂停期间 DELETE A、A→B 切换中 DELETE B、B 在切换中归档/删除均有 barrier 测试，运行时最终绑定的文件始终存在；队列超时/切换抛错均保留 A 并回滚 lease。
  - 迟到标题：手动生成标题的模型请求暂停时删除会话，放行后 `generate-topic` 返回 404，`meta.json` 不产生该 id 的条目，聊天文件与 B 均不变。
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
