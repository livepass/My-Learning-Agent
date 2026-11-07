# E4.2 — 课程专属 L2 知识库

- 完成时间：2026-11-07
- 基线：`main` @ `e3d00bb`（E4.1a 完成）
- 范围：E4.2a 索引级课程检索、E4.2b 上传入库、E4.2c 正文分片与来源定位、E4.2d 课程内 AI 检索、E4.2e API。
- 未改动：L1 掌握度、B2 证据状态机、C1 出题规则、C2 评分、C3 幂等写入、C4 复习、L3、E3.1 模型接入、既有页面 UI。

## 0. 结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| 检索在 SQLite FTS 内部按来源过滤 | 通过 | `page_sources` 表；`searchLexical` 的 WHERE 子句；真实 `index.db` 测试 |
| 过滤发生在排序与 LIMIT 之前 | 通过 | 250 条高排名干扰页 + 1 条本课程页；`limit=1` 仍返回本课程页 |
| 图谱扩展限制课程范围 | 通过 | 图谱页面集合来自同一条 SQL 谓词；跨课程链接测试 |
| 混合来源页面不泄露 | 通过 | 任一来源越界即排除（比 E4.1a 的“任一命中”更保守） |
| `undefined` / `[]` / 非空语义 | 通过 | 未归类全局、空课程为空、非空严格限定 |
| 索引不可用与无结果分开 | 通过 | `search()` 返回 `null` → API 503 / C1 `unavailable`；空结果 → `empty` |
| PDF / DOCX / Markdown / TXT 入库 | 通过 | PDF 真实最小文件；DOCX 内置解压+XML 提取；MD/TXT 真实 HTTP |
| XLSX / PPTX | **拒绝** | 返回 400 `unsupported_format`，未验证不宣称支持 |
| 上传状态、失败原因、重试 | 通过 | manifest `status/error/indexedAt`；`POST …/retry` |
| 重复上传去重 | 通过 | 内容哈希命中；同一 `source_id`，manifest 不增行 |
| 一资料多课程 / 解除 / 重绑 | 通过 | 显式绑定；解除为 `detached`；重绑复用 `binding_id` |
| 长文档分片与章节/页码 | 通过 | 1 400 字符片段；PDF 页码；Markdown 标题路径；DOCX 不造页码 |
| C1 引用实际片段 | 通过 | 片段页是普通 wiki 页，带 `source_ids`；`retrievalCandidates` 直接采用 |
| `l2_query` 不越课程 | 通过 | 服务端会话绑定 → `sourceIds`；模型无 `course_id` 参数 |
| 旧数据兼容 | 通过 | 旧索引重建 `page_sources`；旧 manifest/旧题目/旧证据不变 |

## 1. E4.2a：索引级课程检索

### 1.1 问题

E4.1a 在 `searchL2` 里先取全局 BM25 前 30/200 条，再按 `sourceIds` 过滤。如果全局前 200 条都是其他课程的高排名页面，本课程的相关页面根本不会进入候选——过滤发生得太晚。

### 1.2 实现

`l2-index-store.ts` 新增：

```sql
CREATE TABLE page_sources (
  page_path TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (page_path, source_id)
);
CREATE INDEX idx_page_sources_source ON page_sources(source_id);
```

- `upsertPage` 在同一写入中维护 `page_sources`；`deletePage` 一并清理。
- 旧索引（只有 `pages.source_ids`）在打开时一次性回填 `page_sources`。
- `searchLexical(query, limit, { sourceIds })` 把范围写进 WHERE：

```sql
AND EXISTS (SELECT 1 FROM page_sources ps_any WHERE ps_any.page_path = p.path)
AND NOT EXISTS (
  SELECT 1 FROM page_sources ps_out
  WHERE ps_out.page_path = p.path AND ps_out.source_id NOT IN (?, ?, …)
)
```

`EXISTS` 要求页面有来源（无来源的页面不会在课程里“变成全局”）；`NOT EXISTS` 要求**全部**来源都在范围内。随后才是 `ORDER BY bm25 LIMIT ?`。

- `getPages({ sourceIds })` 用同一谓词取回图谱页面集合，图谱扩展不会沿跨课程链接走出去。
- `searchL2` 保留一层内存过滤作为防御（也兼容测试里的假 store）。
- `[]` 直接返回空；`undefined` 保持旧版全局。

### 1.3 混合来源页面

若一个 wiki 页的 `source_ids` 是 `[python, math]`，它既不能安全地算作 Python，也不能算作 Math；E4.2 选择**两边都排除**。E4.1a 的“任一来源命中即可”测试已按新契约改为排除。真正的共享资料应当是一份 `source_id` 同时绑定两门课程（显式绑定），而不是把两份不同资料合并成一个页面。

## 2. E4.2b：上传与入库

### 2.1 流程

```
POST /api/courses/:courseId/sources/upload
  → 校验收件格式与体积（≤100MB）
  → 文本提取（PDF: LiteParse；DOCX: 内置解压；MD/TXT: UTF-8）
  → 内容哈希去重
  → 保存 raw 原文 + extracted 正文
  → 按标题/页码切分片段（wiki/passages/<source_id>/pNNNN.md）
  → manifest(status=extracted) → 索引 → manifest(status=indexed)
  → 显式 CourseSourceBinding
```

- 解析、片段写入、索引任一失败：manifest 记 `status: "error"` 与稳定原因；不建立课程绑定；返回 4xx/5xx。
- 索引“成功”的判定不是“写文件成功”，而是索引所有者接受后能用该来源检索到（`search` 非 `null`）。
- 只有 `indexed` 才允许后续正常使用；`extracted`/`error` 在资料列表中原样展示。
- 绑定失败不是上传成功：返回 500 `course_binding_failed`，带 `source_id` 与 `status`，可重新关联。

### 2.2 格式

| 格式 | 解析方式 | 页码 | 状态 |
|---|---|---|---|
| PDF | LiteParse（`@llamaindex/liteparse`） | 有 | 已验证（真实最小 PDF） |
| DOCX | 内置 ZIP + `word/document.xml` 文本提取 | 无（Word 不存储分页） | 已验证（真实 DOCX 结构） |
| Markdown | UTF-8 直读 | 无 | 已验证（HTTP） |
| TXT | UTF-8 直读 | 无 | 已验证（HTTP） |
| XLSX / PPTX | — | — | **拒绝**，400 `unsupported_format` |
| 扫描 PDF / 图片 OCR | — | — | 未支持 |

DOCX 不依赖 LibreOffice：LiteParse 的 office 转换在本机缺少 LibreOffice 时会失败，因此课程入库使用独立的纯 JS 提取器。表格、样式、图片不提取；只有正文文本。

### 2.3 去重与重试

- 内容哈希相同：返回已有 `source_id`，`duplicate: true`，不新增 manifest 行；为解析临时保存的二进制副本会删除。
- `POST /api/courses/:courseId/sources/:sourceId/retry`：
  - 已 `indexed` 且有片段：幂等返回；
  - `error` 且有 extracted：从正文重建片段/索引；
  - 仅有 raw：PDF 重新解析、DOCX 重新提取、文本去掉 ingest frontmatter 后重试；
  - 都没有：404 `not_retryable`。

## 3. E4.2c：正文分片与来源定位

- `passage-builder.ts` 以 1 400 字符为目标、120 字符重叠，复用 `structural-chunker` 的标题感知切分，并开启 `sectionBoundary`：每个标题开启新片段，片段携带其真实章节路径。
- PDF 按解析器返回的页切分；片段记录 `page_start/page_end`。单页文档也保留页码（此前 `>=2` 的分支会丢掉单页页码，已修正）。
- DOCX/Markdown/TXT 不产生页码；没有标题时也不编造章节，PDF 无标题时只有页码回退。
- 片段落盘为 `wiki/passages/<source_id>/pNNNN.md`，frontmatter：

```yaml
type: passage
source_ids: [l2src_xxxxxxxx]
passage:
  source_id: l2src_xxxxxxxx
  ordinal: 3
  heading_path: "Python 编程教材 > 第三章 装饰器"
  page_start: 12
  page_end: 13
  extracted_path: extracted/python-xxxx.md
```

- 片段正文带 `## 位置` 行（章节 · 页码），C1 adopt 的 `snippet_text` 因此包含真实位置；题目侧不需要再推断。
- 旧题目/旧证据的 `knowledge` 快照结构未改；旧 wiki 页没有 `passage` 字段，读取时为 undefined。

## 4. E4.2d：课程内 AI 检索

- `l2_query` 新增服务端 `resolveCourseScope` 回调：从当前会话文件 id → `CourseStore.getSessionContext` → `sourceIds`。
- 模型参数没有 `course_id`；无法通过工具参数扩权。
- 有课程：只检索该课程 `active` 来源；空课程直接返回“尚未关联任何资料”，不调用检索。
- 未归类会话：保持旧版全局范围（明确兼容，不伪装成已隔离）。
- 课程绑定/课程文件读取失败：返回“课程资料范围暂不可用”，**不降级为全局检索**。
- 空查询：课程会话只列本课程资料概览，不返回全局 wiki 索引。
- `l2_archive` / `l2_lint` 仍是全局管理入口；课程会话归档时明确提示“未自动加入当前课程，需要显式关联”。`l2_archive` 的 DOCX 也改为内置提取，不再依赖 LibreOffice。
- C1 继续走 E4.1a 的 `allowedSourceIds`，指定其他课程资料仍为 409 `designated_out_of_scope`。

## 5. E4.2e API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/courses/:courseId/sources/upload` | `{ fileName, mimeType?, title?, dataBase64 }`；解析→索引→绑定；201 |
| GET | `/api/courses/:courseId/sources` | 默认 active；`?include_detached=true` 含历史；每条附 `source` 处理状态 |
| GET | `/api/courses/:courseId/sources/:sourceId` | 绑定 + manifest + `sections`（章节/页码定位，不含全文） |
| POST | `/api/courses/:courseId/sources/:sourceId/retry` | 幂等重试失败来源 |
| GET | `/api/courses/:courseId/search?q=&limit=` | 课程范围检索；`status: ok/empty/no_material/l2_disabled` |
| POST | `/api/courses/:courseId/sources` | 既有显式绑定（复用） |
| DELETE | `/api/courses/:courseId/sources/:sourceId` | 既有解除（改为 `detached`，复用绑定标识） |

错误码：`unsupported_format` 400、`empty_document` 400、`file_too_large` 413、`parse_failed` 422、`passage_failed` 422、`index_failed` 503、`source_not_found` 404、`course_binding_failed` 500、`l2_unavailable` 503。

## 6. 验证

### 6.1 真实隔离（两门课程）

`server.course-sources.test.ts`（真实服务进程 + 真实 SQLite + 真实文件）：

1. Python 课程上传「装饰器」资料，高数课程上传「导数」资料。
2. Python 搜「装饰器」命中，搜「导数」为空；高数搜「导数」命中，搜「装饰器」为空。
3. 资料列表显示 `active` 绑定 + `indexed` 状态 + 片段数；详情显示章节定位且无编造页码。
4. Python 资料绑定到高数后，高数可检索；从高数解除后不可检索，Python 不受影响；重绑复用绑定。
5. 重复上传同一内容：同一 `source_id`、manifest 仍为 2 行。
6. 重启后两门课程的检索与隔离仍然成立。
7. 空课程检索返回 `no_material`；XLSX 上传 400。

### 6.2 索引级饥饿测试

`memory/l2/l2-index-store.test.ts`（真实 `index.db`）：

- 250 条其他课程页面重复查询词、排名高于目标；目标页只出现一次。带 `sourceIds` 的查询仍返回目标页；`limit=1` 也返回它。
- 空范围返回空；未指定范围保持全局。
- 混合来源页在两个课程范围都不返回。
- 跨课程 `[[链接]]` 不会把页面拉进范围。
- upsert/delete 同步维护 `page_sources`。

### 6.3 入库与分片

- `course-ingest.test.ts`：Markdown/TXT/PDF/DOCX 入库、章节定位、PDF 页码、无页码不造、去重、重试、空文件/不支持格式。
- `passage-builder.test.ts`：标题路径、页码范围、无标题回退、空文档拒绝。
- `l2-query-scope.test.ts`：课程范围传入、空课程拒绝、解析失败 fail-closed、未归类全局、课程概览不泄全局索引。

### 6.4 构建与全量

```
npm run build   → 通过（tsc + vite）
npx vitest run  → 146 文件 / 1503 通过 / 3 跳过 / 0 失败
```

### 6.5 真实模型

本轮上传、检索、隔离全部使用确定性路径，**没有调用真实模型**。C1 出题使用真实片段的分支由 `question-service` 既有测试与本轮 `retrievalCandidates` 的片段页结构保证；未做“真实模型 + 真实教材”的生成质量评估。该项如实标记为未验证。

## 7. 兼容与迁移

1. **旧索引**：打开时从 `pages.source_ids` 回填 `page_sources`；旧页面仍可全局检索；未回填成功的页面在课程范围中不可见（保守）。
2. **旧 manifest**：新字段全部可选；旧记录无 `passagePages/passageCount/error`，读取为 undefined/0。旧 `status` 语义不变。
3. **旧 B2/L1**：题目、评分、证据、掌握度未改；课程上传不触碰这些文件。
4. **片段页**：新文件位于 `wiki/passages/`，旧 wiki 工具会列出它们；这是真实的索引单元，不是隐藏数据。
5. **E4.1a 行为变更**：混合来源页面由“任一命中”改为“全部命中”，原因见 §1.3；共享资料应通过同一 `source_id` 绑多课程。
6. **删除课程资料**：解除关联是 `detached`，不删除 raw/extracted/wiki/索引；原始资料仍可在全局 L2 使用。

## 8. 遗留问题

1. **FTS 词法召回是 OR 分词**：同一课程内，“函数”这类通用 bigram 会把不同章节都召回；这是召回策略，不是跨课程泄露。若要提高精度，需要短语/AND 模式或重排，E4.2 不做。
2. **片段页文件数量**：一部长教材可能产生数百个小文件；单文件上限 4 000 段。索引查询不受影响，但文件系统开销需在更大规模时评估。
3. **DOCX 只提取正文**：表格按文本顺序拼接，样式/图片/批注不提取；无页码。
4. **PDF 依赖 LiteParse**：扫描件与图片 OCR 未启用；加密 PDF 未验证。
5. **XLSX/PPTX**：未验证，明确拒绝。
6. **`l2_archive` 不产生片段**：agent 归档仍以 wiki 页为检索单元；课程上传才有正文片段。若要让所有历史资料获得段落级定位，需要在 E4.3 前把 archive 也接入 `passage-builder`。
7. **课程删除**：仍只归档，不提供彻底删除。

## 9. E4.3 接口准备

- `CourseStore` 已有 `createPlan/createTask/updateTask/listTasks` 与 `CourseSessionBinding(task_id)`；E4.3 可直接生成草案并绑定会话。
- 课程资料已可按课程检索，计划/任务生成可用 `sourceIds` 作为可用材料范围。
- 尚缺：`POST /api/courses/:courseId/learning/start`（复用或新建会话）、任务排序/进度字段、AI 草案生成入口。
