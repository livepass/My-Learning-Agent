## 概要

E4.9i-P1：审查现有「我的学习档案」页，核查学习状态语义，交付两套低保真原型与源码映射。

**本阶段只交付分析与原型。未修改任何业务代码、API、Store 或数据库字段**（`git diff 432a43ad -- apps/` 为 0 行）。

- 基准提交：`432a43ad594c69d3236ba189a4de4ecfd0b29126`（`main`）
- 工作分支：`design/e49i-p1-profile-prototype`

## 交付物

| 文件 | 内容 |
| --- | --- |
| `analysis.md` | 组件树、数据来源表、掌握状态语义核查、可信度矩阵、移动端实测、功能冻结清单 |
| `implementation-map.md` | 原型模块 ↔ 源码 ↔ 改造类型、CSS 断点、数据能力限制、P2 拆分 |
| `prototype-a.html` | 方案 A「概览优先」，10 个场景、深浅主题、四档视口 |
| `prototype-b.html` | 方案 B「知识状态优先」，同样场景 |
| `comparison.md` | 六维对比、响应式实测、推荐方案、待产品确认事项 |
| `P1-acceptance.md` | 完成标准核对与交互实测记录 |
| `assets/` | 10 张现状截图 + 32 张原型截图 |

## 关键发现（均在真实档案上复现，非推测）

1. **两套掌握状态口径并存。** 全部课程视图用前端 `masteryStateFor(mastery)` 按 0.8 / 0.4 阈值分档，指定课程视图用服务端 `state_label`。真实数据 `mastery: 0.05, state_label: "learning"` 因此在两个视图分别显示「待复习」与「学习中」。`state_label` 是唯一参与每日计划、计划建议与推荐规则的正式长期状态；`mastery` 只是启发式参考值。
2. **同屏自相矛盾。** 概览「待复习概念」按 `review_due_at <= now` 计数（该状态无到期时间 → 显示 0），知识行按 `mastery < 0.4` 显示「待复习」。
3. **证据条数被高估。** 本机 1 条 `concept_explained` 事件对应 2 个 `evidence_ids`（`legacy_` 镜像），课程视图会显示「证据 2 条」。
4. **可信度字段已返回但不可见。** `origin` / `provenance_unknown` / `confidence` 都在 `GET /api/learner/profile` 响应里，前端类型未声明、界面未渲染。编辑知识点会让服务端把 `origin` 改为 `manual`，界面没有任何提示。
5. **320px 布局破损。** 知识行固定列 170+42+74px，状态徽标右边界 365px 超出 320px 视口，被卡片裁切；进度条宽度为 0。390px 下进度条同样为 0。
6. **偏好显示内部英文 token**：`immediate_feedback`、`encouraging`。
7. **展开知识点即进入编辑态**，想读诊断必须面对可编辑滑块与文本框。

## 推荐

**方案 A「概览优先」+ 吸收方案 B 的状态筛选器**。理由：页面首要任务是「读学习情况」，A 用一句由计数派生的结论回答「我学得怎么样、下一步做什么」；A 与现有页面和课程视图结构同构，P2 是重排 + 修语义而非重建架构。

P2 必须先做**语义统一**（全部课程视图改读 `state_label`，删除 `masteryStateFor`），再做视觉重排。拆分见 `comparison.md` §4 与 `implementation-map.md` §6，**不一次性重写 1054 行的 `LearnerProfilePanel`**。

## 验证

- `npm run build`：✅ 通过
- `npx vitest run`（单独一次、无并发）：2227 / 2232 通过，3 跳过，2 失败
- 本阶段相关定向测试：`ProfilePage.courses.test.tsx` 3 项 + `LearnerProfilePanel.summary.test.tsx` 8 项，**11 项全部通过**

两个失败项均位于与基准提交**字节级一致**的 `apps/` 代码上：

| 用例 | 复跑 | 结论 |
| --- | --- | --- |
| `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting` | 单文件 3 次均失败 | 既有环境相关失败（mock provider 调用计数漂移），非本阶段引入 |
| `learning/answer-service.test.ts` › `completes a score that finished while the checkpoint was paused` | 单文件通过 34/34 | 全量并发下的时序抖动 |

先前两次全量运行因彼此重叠产生大量 `fetch failed` 与超时；相关文件单独复跑均通过，确认为并发资源竞争。

## P1-R1 修正及验收状态（2026-11-24）

- 已在方案 A 中加入 B 的六类状态筛选，保留概览优先信息架构。筛选按服务端 `state_label` 显示，不做前端复习资格判定。切换筛选处理编辑未保存确认。
- 已修正 A/B 默认日期示例：待复习样例从 2026-11-28 改为 2026-11-22（P1 日期 2026-11-24 为参考）。
- 已明确全部课程页面的「待复习状态知识点」计数不是正式「已到期复习」数量；正式资格仍依赖 `daily-plan.ts` 及相关服务端规则。
- 已更新 `analysis.md` / `comparison.md` / `implementation-map.md`：真实档案字段和渲染逻辑支持潜在冲突，但现有截图没有同一知识点在两个视图同时可见的证据。
- R1 **未触及正式 `apps/` 代码**。原有 42 张 PNG 是 R1 前的证据，**不能**声称新版 A+筛选器已完成浏览器 QA。

### 合并前门槛（R1_NOT_VERIFIED）

- [ ] 方案 A 1440px 与 320px 的 R1 新截图（含筛选器）。
- [ ] 浏览器核对筛选单选、`aria-pressed`、Enter/Space、空结果、切换场景重置。
- [ ] 320px 实测无遮挡/无溢出；未保存编辑时切换筛选可取消并保留草稿。
- [ ] 更新 `P1-acceptance.md` 和 PR 结论，附上本轮实测来源。

## 不自动合并

P1 只交付分析与原型，等方案确认后再开展 P2。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
