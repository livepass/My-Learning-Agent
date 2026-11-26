# E4.9i-P2-6-R1｜数据可信度语义与目标编辑安全修正

**状态：代码修正已提交；验收阻塞（NOT VERIFIED）。不等同于 PASS。**

- 基准 main：`7d7a04accd6f9a64f475c575405fe6db0c4484ca`
- 起始分支 HEAD：`6ea2eeae62e86947d30cd146744cd4e83bdaf2bc`
- 分支：`feat/e49i-p2-6-profile-provenance`
- 最新实际 HEAD：见此分支 `git log -1` 或 GitHub PR。由于本报告自身也产生提交，避免使用自指 SHA。
- 原 P2-6 B01–B10 资产与原 `qa_p2_6.py`、原验收文档不作覆盖；R1 资产使用 `r1-` 前缀和 `r1-b-replay` 目录。

## 1. F01｜优先级 PATCH 的所有权问题

已在 `LearnerProfilePanel.tsx` 的 **GoalCard（现有编辑器）** 增加 `priorityEdited` 状态。仅滑块真实变化或点击异常值显式端点按钮才设置该状态；未主动修改时 PATCH 中不包含 `priority` 属性，而不是发送原始 3 / -0.2 / 0.5 等值。

- 打开、取消及再次打开会重置草稿与编辑标记；保存失败保留草稿和标记。
- 用户主动选择 0 或 1 的按钮解决滑块因端点钳位不触发 change 的问题；滑块可选择中间值（例如 0.4）。仅 `Number.isFinite` 且处于 [0, 1] 的用户设置值允许提交。
- `learner-store.ts` 已将 PATCH 响应完整替换成本地目标；`api/learner.ts` 已将参数直接 JSON 序列化。两者已核对，无需修改。
- **服务端规则未改**：`server/routes/learner.ts` 对字段存在性执行 `if (body.priority !== undefined) manual.priority = nextManualStamp(current)`。省略该字段可避免人工标记被无谓刷新，也避免覆盖编辑期间更新的服务端优先级。
- 原 GoalPriority 断言“只改标题仍发送原始 3”已更正为 `not.toHaveProperty("priority")`。补充值 3、-0.2、0.5、缺失、null、NaN，主动设置 0/0.4/1，状态编辑、失败重试、取消重开以及被动更新测试。
- `server.smoke.test.ts` 增加**真实 HTTP 路由测试代码**：创建目标后记录 `manual.priority`，仅提交 title，再查询比对标记不变，随后提交 `priority:0.4` 并检查编辑序号递增。**此测试尚未执行**，不能将“测试已编写”表述为“行为已被运行证明”。

## 2. F02｜指定课程证据说明

`CourseLearnerPanel.tsx` 和 `CourseOverviewPanel.tsx` 在各自知识记录区域增加 **一次** 现有 i18n `profile.knowledge.provenance.evidenceNote`，不逐行重复、不要求切换全部课程。另显示一次 `originNote`，明确来源标签不构成证据质量或可信度认证。仅展示本课程作用域数据，保留只读及原筛选规则。新增组件测试检查说明只出现一次。**320px 的真实布局尚无运行证据**。

## 3. F03｜来源不明的字段语义

依据 `apps/learning-agent/src/memory/learner/types.ts` 的注释：`provenance_unknown` 为“旧历史值因来源未知而原样保留”的标志。它不是实际追溯操作的结果，也不是对所有关联证据的否定，更不能证明知识评估正确。

- 中文：**此记录包含来源无法确认的历史信息，不能据此判断证据质量或知识判断的准确性。**
- English: **This record contains historical information whose provenance cannot be confirmed. This flag does not establish evidence quality or the accuracy of the knowledge assessment.**
- 仍独立展示 `origin` 和 `provenance_unknown`，未添加评分或质量认证。更新渲染用例和文案测试。

## 4. F04｜证据数组计数

`describeEvidenceCount()` 在完整数组的每个元素均为字符串时才按 **原始长度** 计数。空数组为 0，重复与 legacy 镜像不去重，不更改数组。非数组及含任一非字符串元素的数组均为“数量不可用”。

新增 `[null]`、`[123]`、`[{}]`、`["evt_1", null]`、`["evt_1", 123]` 等测试。

**空字符串与纯空白字符串依据**：当前 `learner-tools.ts` 采用 `Type.Array(Type.String())`，未对元素设 `minLength` 或 trim 限制，故展示层把 `""`、`"  "` 视为字符串并按长度计数。这不是认定它们为有效证据；正式复习资格的非空校验属于冻结范围，保持不变。

## 5. 浏览器验收与与原 B09 纠错

新增独立 `docs/ui-redesign/phase5/scripts/qa_p2_6_r1.py`，在原脚本不变的情况下重放 B01、B02、B04–B08、B10，另运行修正 B03、B09 和 R01–R08。B03 原测试预期“服务端未能追溯”不符合新语义；B09 原预期“只改标题仍提交 priority=3”是本轮已确认的缺陷，因此 **R1 必须断言 PATCH 缺少该字段**。

脚本使用 Playwright Chromium + `page.route` 模拟 API，记录 pageErrors、视口与元素边界、横向溢出、PATCH 请求及模拟返回值。其 `manual.priority` 记录只是模拟数据快照，**不能代替**新增真实 HTTP 路由测试。真实测试通过后才可以合并两条独立证据链。

`r1-browser-metrics.json` 当前为 **未执行标记**，不包含虚构的观测和截图。原始 B01–B10 的截图不受影响。

## 6. 测试及构建状态

| 验证项 | R1 实际状态 |
| --- | --- |
| 目标编辑、证据、课程组件新增测试 | 已编写，**未运行** |
| 真实服务端 HTTP 人工维护标记集成测试 | 已编写，**未运行** |
| P2-6 原测试回归 | **未运行** |
| TypeScript / Web build / full build | **未运行** |
| 全量 Vitest（历史基准 2554／2550／1／3） | **未运行**，历史数字不是 R1 结果 |
| Chromium B01–B10 与 R01–R08 | **未运行**，无新浏览器截图或元素指标 |
| 实际错误原因 | 执行容器无法解析 github.com 域名，无法检出仓库与安装完整项目依赖 |

可复现的环境检查与真实阻塞日志：`P2-6-assets/r1-test-log.txt`。**不得将 PR 视为验收完成，直到在有依赖和浏览器的环境补齐日志、截图、指标，且无新增失败**。

## 7. 冻结检查与剩余风险

未修改服务端业务规则、知识状态引擎、证据生成/重放、学习记忆、数据库、掌握度/置信度/稳定性、正式复习资格、六类筛选、KnowledgeDraftGuard、P2-5 响应式机制，也未开始 P2-7。

剩余风险：测试与构建尚未实跑；在真实浏览器中须重点核对 Radix 状态选择、滑块端点按钮、320px 中英文文字裁切、脚本中的 route 模拟、原 B 场景复跑，以及是否存在 TS 编译问题。此 PR 应保持 **Draft / Not ready**，不得自动合并。

## 8. 交付清单

- 修复：`LearnerProfilePanel.tsx`、`CourseLearnerPanel.tsx`、`CourseOverviewPanel.tsx`、`KnowledgeProvenance.tsx`、`knowledge-provenance.ts`、双语 i18n。
- 测试：`GoalPriority.test.tsx`、`KnowledgeProvenance.test.tsx`、`knowledge-provenance.test.ts`、`KnowledgeProvenance.lifecycle.test.tsx`、`server.smoke.test.ts`。
- 本报告：`P2-6-R1-acceptance.md`。
- 独立脚本：`scripts/qa_p2_6_r1.py`（原有 `scripts/qa_p2_6.py` 保持原样）。
- 当前状态记录：`P2-6-assets/r1-browser-metrics.json` 和 `P2-6-assets/r1-test-log.txt`。
- 新 R1 截图：**尚未生成，不能列为已交付**。
