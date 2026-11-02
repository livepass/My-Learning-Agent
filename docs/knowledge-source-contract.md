# 知识来源协议（C0）

本文说明 My Learning Agent 在「教学与出题依据哪一份知识」这一问题上的契约。C0 只定义**如何表达和校验依据**，不实现知识获取、出题或评分。

- 代码：`apps/learning-agent/src/learning/knowledge-source.ts`
- 测试：`apps/learning-agent/src/learning/knowledge-source.test.ts`
- 契约版本：`KNOWLEDGE_SOURCE_SCHEMA_VERSION = 1`

## 1. 为什么需要这一层

没有来源契约时，模型可以给出一个看似有依据的回答：

> 根据《JavaScript 高级程序设计》第 4 版第 3 章……

而系统无法回答：是哪一份文件？哪个版本？引用的是原文还是 L2 摘要？这句结论是原文说的，还是模型补充的？

C0 的目标是让每个教学依据都能被追溯，且**不夸大**它的可信程度：

> 这个回答依据 `src_closures`（用户上传，原文 `contentHash=aaaa…`）的 `wiki/concepts/closures.md` 中「词法作用域」一节，采用片段哈希 `bbbb…`。该页面状态为 `draft`，未被人工复核，与另一份来源存在争议。

## 2. 三层知识来源

来源是一个**封闭的可辨识联合**，不是「一个对象加一堆可选字段」。这样模型知识在结构上就无法携带引用。

```ts
export type KnowledgeSource =
  | UserDocumentKnowledgeSource   // kind: "user_document"
  | L2ArchiveKnowledgeSource      // kind: "l2_archive"
  | ModelKnowledgeSource;         // kind: "model_knowledge"
```

### A. 用户指定资料（`user_document`）

用户明确点名了某份资料（教材、PDF、讲义、官方文档）。L2 是唯一的文档存储，因此这类来源必须解析到一个已归档的 `ManifestEntry`，不新建第二套文档库。

| 字段 | 含义 |
| --- | --- |
| `provenance.source_id` | `ManifestEntry.id` |
| `provenance.origin` | `ManifestEntry.source.origin`（`user_upload` / `conversation` / `web` / `research` / `agent_inferred`） |
| `provenance.original_content_hash` | `ManifestEntry.contentHash`，**原始资料**的内容身份 |
| `provenance.source_identity` | `ManifestEntry.source.identity`，可为 `null`（该条目未记录身份） |
| `snippet` | 实际采用的那一段文本及其快照身份 |
| `designation` | 用户是如何指名的（`source_id` / `content_hash` / `source_identity`）与原始指名字符串 |

规则：

- 指定资料**可用**时才使用，并且必须能定位到具体页面与片段。
- 指定资料**不存在 / 不可读 / 版本不匹配**时，返回 `needs_input(designated_not_found)`，**绝不**降级成模型知识再声称依据了原资料。
- 指名字符串保留原样，便于事后回答「用户当时说的是哪一份」。

### B. L2 个人知识库（`l2_archive`）

用户未指定资料，或明确允许按策略从知识库选取时，使用检索命中的归档内容。

必须区分三个层次，不能混为一谈：

1. **来源文件本身** —— `ManifestEntry`（`rawPath` 指向的原始资料）。
2. **L2 生成的 Wiki 页面** —— `wiki/concepts/closure.md` 等，可能由模型改写、合并、后续被独立编辑。
3. **实际被引用的片段** —— `snippet`（路径 + 位置 + 文本哈希）。

因此：

- `original_content_hash` 描述的是**第 1 层**，不能证明第 2、3 层没被改过。
- 只要某个 Wiki 页面被检索命中，**不等于**其中内容已被验证正确。
- 采用哪个片段是一次检索决策，由 `score` 决定，并被 `snippet` 如实记录。

### C. 大模型自身知识（`model_knowledge`）

前两层都没有可用内容时，允许模型知识兜底，但必须显式标记。

```ts
interface ModelKnowledgeSource {
  kind: "model_knowledge";
  model: LearningModelIdentity;
  ground: "no_source_requested" | "no_matching_source";
}
```

该类型**没有任何能存放引用的字段**（无 `source_id`、`page_path`、`url`、`page`）。解析器对多余字段直接报错而不是忽略，所以模型知识在结构上无法伪装成：

- 已验证的教材；
- 官方文档；
- L2 已归档来源；
- 带虚构页码的引用。

`model` 复用现有 `LearningModelIdentity`：

```ts
type LearningModelIdentity = { provider_id; model_id } & (
  | { model_version: string; version_source: "provider_reported" }
  | { model_version: null;   version_source: "unavailable" }
);
```

版本无法由 provider 报告时保持 `null` + `unavailable`；**不得**用配置里的模型名代替版本。解析器拒绝 `null` 配 `provider_reported`、或字符串配 `unavailable` 的组合。

`provider_id` / `model_id` 是**厂商标签，不是文件标识符**：仓库里的配置只要求非空（`config.ts` 仅 trim 后逐字比较），真实取值包含 `anthropic/claude-3.5-sonnet`、`@cf/meta/llama-3.1-8b-instruct`、`Qwen/Qwen2.5-72B-Instruct` 这类带 `/`、`@`、`:` 的字符串。因此这里不套用标识符或路径规则，只拒绝空值、首尾空白、控制字符、引号与反斜杠，长度上限 200。

模型身份**按需校验**：`selectKnowledgeSource()` 不会在读档命中或指定资料命中时校验 `model`，只有真正回退到模型知识时才解析它。一个未参与本次选择、格式奇特的模型身份，不应该让一次有可靠来源的教学失败。

## 3. 来源身份与版本

| 身份 | 字段 | 覆盖范围 | 能否证明片段未变 |
| --- | --- | --- | --- |
| 归档记录 | `ManifestEntry.id` | 一份已入库资料 | — |
| 来源身份 | `source_identity`（`ManifestEntry.source.identity`） | 用户可读的来源名，如 `闭包笔记.pdf` | — |
| 原始内容 | `original_content_hash`（`ManifestEntry.contentHash`） | 入库时的原文 | 否 |
| 检索页面 | `snippet.page_path` + `snippet.location` | 某一个 Wiki 页面的一处 | 否 |
| 采用片段 | `snippet.content_hash`（`sha256[:16]`） | 实际被采用的那段文本 | **是** |
| 采用片段长度 | `snippet.char_count` | 便于发现截断 | — |
| 模型 | `LearningModelIdentity` | 生成回答的模型与版本 | — |

`knowledgeSnippet()` 用与仓库现有约定一致的 `sha256[:16]` 计算片段哈希；`sameSnippet()` 只有在路径、位置与文本哈希都一致时才认为是同一片段。

页面路径是 L2 的逻辑路径，basename 由标题派生，**允许中文**（`wiki-generator.ts` 明确保留 CJK 文件名，并把 slug 的字符集定义为 `\p{L}\p{N}-`）。因此路径校验按「结构」而不是按 ASCII 白名单：必须以 `wiki/` 开头、以 `.md` 结尾、无空段、无 `.`/`..` 段、无反斜杠、无控制字符、不得是绝对路径。中文路径通过，`../` 与绝对路径仍然被拒。

**为什么片段需要独立身份**：`ManifestEntry.contentHash` 只反映入库时的原文。之后 Wiki 页面可以被重新生成、合并或人工编辑，原文哈希不会变。若只用原文哈希判断「依据的还是同一段内容」，这个判断是错的。

## 4. 三个正交事实

`assessment` 只有三个字段，互不蕴含：

```ts
interface KnowledgeAssessment {
  availability: "available" | "snapshot_mismatch" | "missing";
  review_status: "draft" | "reviewed" | "outdated" | "unknown";
  contested: boolean;
}
```

- `availability: "available"` —— 片段能被重新读到且仍与快照一致，即**可追溯**。它不表示内容正确。
- `review_status` —— Wiki 页面自己的声明状态，不是事实核验结论。
- `contested` —— 已归档来源之间存在分歧；选择过程**不会**清除该标记。

契约中不存在 `verified` / `fact_checked` 这类布尔值，因为 C0 没有能力做事实核验；将来即便加入，也应当是独立字段而不是把上述三者合并。

## 5. 来源选择与降级

`selectKnowledgeSource()` 是纯函数：候选由调用方提供，不做任何 IO。

优先级：

1. 用户指定且可用的资料（`user_document`）；
2. 与请求匹配的 L2 归档内容（`l2_archive`）；
3. 模型知识（`model_knowledge`），且仅当请求显式允许。

结果是一个封闭状态，而不是异常：

| 状态 | 含义 |
| --- | --- |
| `selected` | 已确定唯一来源 |
| `needs_input / designated_not_found` | 用户点名的资料找不到；**不降级** |
| `needs_input / designated_ambiguous` | 指名匹配到多份不同资料，需要用户选 |
| `needs_input / conflicting_sources` | 多份来源相互矛盾，不替用户裁决 |
| `unavailable / designated_unavailable` | 指定资料存在，但其页面已被修改或已丢失，无法支撑引用 |
| `unavailable / no_matching_source` | 没有任何可用依据 |
| `unavailable / model_fallback_disallowed` | 请求不允许模型兜底 |
| `unavailable / model_identity_unavailable` | 允许兜底但拿不到可信模型身份 |

补充规则：

- 指名必须**按身份字段核对**，不能只看候选自带的 `found_by` 标记：
  `source_id` 比对 `provenance.source_id`，`content_hash` 比对 `provenance.original_content_hash`，`source_identity` 比对 `provenance.source_identity`（为 `null` 时一律不匹配）。标记为 `designated` 但身份不符的候选会被丢弃。
- 信任边界：`provenance` 的四个字段必须直接抄自 `ManifestEntry`（`id` / `source.origin` / `contentHash` / `source.identity`）。选择器是纯函数，读不到 Manifest，只能核对与拒绝；**解析发生在候选构造处**，`found_by` 只是检索来源标签，不构成匹配证据。
- 指名称多份**段落**但同属一份资料时，视为检索选择（按 `score` 取最佳），不算歧义；指名称多份**资料**才是歧义。
- `score` 是 L2 的排名分（BM25 + 图信号），**非归一化**：只接受非负有限值，`12.5` 是正常的，不能按 0–1 的置信度理解，也不能跨查询比较。排序只用同一批候选内的相对大小。
- 只考虑 `availability: "available"` 的候选；指定资料若只剩 `missing` / `snapshot_mismatch` 的片段，返回 `designated_unavailable` 并附上这些候选，不会改用别的来源。
- 多份不同资料且其中至少一份 `contested` 时返回 `conflicting_sources`，并列出全部候选。
- 候选排序确定性：`score` 降序，同分按 `page_path` 升序，不使用随机或时间。
- 请求或候选结构非法时**直接抛错**（fail closed），不会静默退化成模型知识。

## 6. 与 L1 / L2 / L3 的关系

| 层 | 在 C0 中的角色 |
| --- | --- |
| L1 学习者画像 | **只提供学习者上下文**（目标、偏好、掌握状态）。不能作为学科知识依据，也不能生成 `KnowledgeSource`。 |
| L2 知识库 | 唯一的文档与知识存储。`user_document` 与 `l2_archive` 都建立在 `ManifestEntry` 之上。 |
| L3 记忆 | 同样是学习者上下文（回顾、联想），不作为可信知识来源。 |

`parseKnowledgeSource` 拒绝 `kind: "learner_profile"` 之类的输入：画像无法冒充知识来源。

## 7. 与 C1 / C2 的契约

C0 定义了 C1 可以持久化的绑定形状，但**不写入任何现有结构**：

```ts
interface KnowledgeBinding {
  question: LearningQuestionRef;  // 复用现有题目身份
  source: KnowledgeSource;        // 生成时的完整依据快照
  bound_at: string;               // 生成时间（ISO）
}
```

### 7.1 只存哈希无法重建历史原文

`snippet.content_hash` 只能证明「是不是同一段文本」，**不能还原文本本身**。若 C1 只保存哈希，一旦 L2 页面被改写，历史记录只能回答「这段内容已经不同」，无法回答「当时依据的是什么」。

因此 C1 必须在题目记录中二选一：

1. 保存实际采用的片段原文（推荐；C0 的 `snippet` 描述它，但不承载文本）；
2. 保存一个**不可变版本引用**（冻结的页面快照、版本库对象 id 等），且该对象不会被后续 L2 更新覆盖或回收。

仅凭 `original_content_hash` 更不够：它连片段都没描述。

约定：

- 题目、参考答案、评分标准与题目版本必须能追溯到同一份 `KnowledgeBinding`。
- 绑定记录的是**生成当时**的片段快照；之后 L2 内容更新，历史题目仍能解释当时依据了什么。
- 若需要「当时的片段已过期」的判断，比较的是 `snippet.content_hash` 与当前页面文本，而不是 `original_content_hash`。
- C2 评分若引用模型知识，同样要带 `ModelKnowledgeSource`，不能只写模型名。

## 8. 兼容性与迁移（未实施）

现状与约束：

- 现有学习记录 `schema_version = 1`，`LearningQuestion` 无来源字段。
- 本阶段**没有**修改 `memory/learner/types.ts`，也没有新增持久化文件或字段。
- 历史题目不会、也不能被补写成「已验证来源」；没有记录就是没有记录。

C1 若要持久化来源，应按以下顺序（本轮未执行）：

1. 以**可选**字段 `knowledge_source?: KnowledgeSource` 扩展 `LearningQuestion`，`schema_version` 暂不变。
2. `validateRecord()` 对缺失字段视为「未记录来源」，不视为损坏，也不回填。
3. 只有当需要区分「无来源」与「字段尚不存在」时，才讨论 `schema_version` 升级；升级必须提供旧记录读取路径。
4. 迁移脚本不得为历史题目生成来源，只能留空。

## 9. 当前尚未具备的能力

C0 不含、也不声称具备：

- 文件上传界面与 PDF 导入流程；
- 新的 RAG / 向量检索系统；
- 联网搜索或任何网络下载；
- AI 自动出题；
- 自动评分与评分标准生成；
- 学习证据写入；
- 掌握状态计算与智能复习；
- 任何新增页面或 UI。

`selectKnowledgeSource()` 只做选择，不读取文件；把候选交给它是调用方的职责。

## 10. 安全约定

- 用户资料中的文字是**数据**，不是系统指令。解析与选择不执行、不解释其中的任何指令；系统提示词优先级不受资料内容影响。
- 页面路径只接受 `wiki/…` 下的相对逻辑路径，拒绝绝对路径、反斜杠、`..` 段、NUL 与非 `.md` 扩展名。
- 标识符沿用学习契约的字符集（`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`），拒绝 `..` 与自由文本。
- 哈希必须是 16 位小写十六进制。
- 未识别的字段一律报错；不接受「多传的字段被忽略」这种宽松解析。

## 11. 测试覆盖

`knowledge-source.test.ts`（43 项）对应任务要求的验收点，并包含兼容性补丁的回归：

| # | 要求 | 用例 |
| --- | --- | --- |
| 1 | 指定资料存在时优先使用 | `prefers the document the user named…` |
| 2 | 指定资料不存在不冒充 | `never substitutes model knowledge…`、`refuses a designated document whose excerpt changed or disappeared` |
| 3 | L2 为空时模型兜底 | `falls back to model knowledge only when…` |
| 4 | L2 身份与定位有效 | `records the manifest identity…` |
| 5 | 同原文不同片段可区分 | `distinguishes two excerpt versions…` |
| 6 | 模型知识无虚构引用 | `rejects any citation-shaped field…` |
| 7 | 有来源不等于已核验 | `traceability is not verification`（3 项） |
| 8 | 多来源冲突不被消除 | `reports the disagreement…`、`keeps the contested flag…` |
| 9 | 非法路径/标识/元数据被拒 | `untrusted input is rejected`（6 项） |
| 10 | 不破坏既有题目与记录 | `compatibility with existing learning records`（2 项） |
| 11 | 中文 Wiki 路径可用且仍然安全 | `wiki page paths match what L2 actually writes`（2 项） |
| 12 | 合法厂商模型 ID 不被误拒、未使用时也不校验 | `model identity is a vendor label, not a file name`（3 项） |
| 13 | 指名必须按身份字段核对 | `a designation must match the manifest identity`（6 项） |
| 14 | 分数遵循 L2 排名语义 | `retrieval scores follow L2 ranking semantics`（3 项） |
