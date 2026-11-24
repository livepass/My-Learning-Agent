# E4.9i-P1 验收记录：我的学习档案分析与原型

- **基准分支**：`main`
- **基准提交**：`432a43ad594c69d3236ba189a4de4ecfd0b29126`
- **工作分支**：`design/e49i-p1-profile-prototype`
- **原 P1 结论**：P1 PASS（原交付内容完整；R1 变更尚需浏览器复验）
- **当前 R1 结论**：**R1_NOT_VERIFIED**（新增 A 筛选器尚无 R1 后真实页面截图和可复核交互指标）
- **改动范围**：仅 `docs/ui-redesign/phase5/` 下的文档、HTML 与截图。**未修改任何业务代码、API、Store 或数据库字段。**

---

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `analysis.md` | 现状组件与数据来源、真实截图、已确认问题、待验证假设、掌握状态语义核查、可信度与字段矩阵、移动端问题、功能冻结清单 |
| `implementation-map.md` | 原型模块 ↔ 数据来源 ↔ 当前组件 ↔ 改造类型；CSS 断点；数据能力限制；P2 拆分 |
| `prototype-a.html` | 方案 A「概览优先」，10 个场景、深浅主题、三档视口、可交互 |
| `prototype-b.html` | 方案 B「知识状态优先」，同样场景与交互 |
| `comparison.md` | 六维对比、响应式实测、推荐方案、P2 拆分、待产品确认事项 |
| `assets/` | 10 张现状截图 + 32 张原型截图 |

---

## 2. 完成标准核对

| 标准 | 状态 | 证据 |
| --- | --- | --- |
| 已审查学习档案完整组件与数据流 | ✅ | `analysis.md` §1；`ProfilePage.tsx`、`LearnerProfilePanel.tsx`、`CourseLearnerPanel.tsx`、两个 store、两个 api、类型与 i18n |
| 已核查全部课程和指定课程两种数据范围 | ✅ | `analysis.md` §1.4、§5；截图 `current-course-desktop.png` |
| 已明确 `mastery` 与 `state_label` 的展示差异 | ✅ | `analysis.md` §2；真实数据上复现「待复习 / 学习中」并存 |
| 已明确正式证据、任务进度和掌握度的区别 | ✅ | `analysis.md` §3.1；并发现证据标识重复计数（§3.2） |
| 已取得现有页面截图 | ✅ | `assets/current-*.png` 10 张 |
| 已给出两个低保真方案 | ✅ | `prototype-a.html`、`prototype-b.html` |
| 已完成桌面与移动端原型 | ✅ | 1440 / 1024 / 390 / 320 四档，深浅主题 |
| 已提供原型与源码映射 | ✅ | `implementation-map.md` |
| 未修改业务代码 | ✅ | `git status` 仅 `docs/ui-redesign/phase5/` |
| 未新增 API、Store 或数据库字段 | ✅ | 无 `apps/` 改动 |
| 已给出推荐方案和后续 P2 开发拆分 | ✅ | `comparison.md` §3–§4 |

---

## 3. 必须包含的原型状态核对

| 场景 | 方案 A | 方案 B |
| --- | --- | --- |
| 1. 全部课程，有学习记录 | ✅ `option-a-desktop.png` | ✅ `option-b-desktop.png` |
| 2. 指定课程，有学习记录 | ✅ `option-a-course.png` | ✅ `option-b-course.png` |
| 3. 暂无知识证据 | ✅ `option-a-empty.png` | ✅ `option-b-empty.png` |
| 4. 存在待复习知识点 | ✅ `option-a-review.png` | ✅ `option-b-review.png` |
| 5. 存在活跃误区 | ✅ `option-a-misconception.png` | ✅ `option-b-misconception.png` |
| 6. 知识点详情展开 | ✅ `option-a-detail.png` | ✅ `option-b-detail.png` |
| 7. 编辑学习摘要 | ✅ `option-a-editing.png` | ✅ `option-b-editing.png` |
| 8. 数据读取失败 | ✅ `option-a-error.png` | ✅ `option-b-error.png` |
| 9. 长知识点名称 | ✅ `option-a-320-long.png` | ✅ `option-b-320-long.png` |
| 10. 移动端布局 | ✅ `option-a-mobile.png` | ✅ `option-b-mobile.png` |

---

## 4. 交互实测（DOM 断言，非目测）

| 断言 | 方法 | 结果 |
| --- | --- | --- |
| 保存失败时输入不丢失 | 勾选「模拟保存失败」→ 改写摘要 → 点保存 | 编辑器保持打开，文本仍为 `草稿内容不能丢`，显示 `role="alert"` 错误 |
| 知识点行可用键盘展开 | 聚焦行按钮 → 发送真实 `Enter` 键事件（CDP `Input.dispatchKeyEvent`） | A/B 均为 `aria-expanded=true`，`.kdetail` 出现 |
| 筛选 chip 可用键盘切换 | 聚焦「待复习」→ 真实 `Enter` | `aria-pressed=true`，列表只剩 1 行 |
| 320px 无横向溢出 | `document.documentElement.scrollWidth === innerWidth` | A/B 均为 `320 === 320` |
| 无内部元素溢出 | 遍历 `scrollWidth > clientWidth` 的元素 | 修复后无命中（此前 `.misc` 内 `input[type=range]` 因浏览器默认 `margin: 2px` 溢出 2px，已加 `margin: 0`） |
| 筛选器可切换 | 方案 B 的 6 个 chip | `aria-pressed` 状态正确，列表随之过滤 |

---

## 5. 已知限制（已在文档与原型中标注）

1. 证据明细（时间 / 题型 / 结果）无接口，原型只显示「证据标识 N 个」。
2. 课程视图不返回误区与画像摘要，原型显示「当前范围不提供」。
3. `diagnosis` 是模板句，未包装成「AI 解释」。
4. 原型中的课程名称映射来自课程列表，P2 需确认是否符合范围冻结规则。

---

## 6. 构建与测试

本阶段**没有任何 `apps/` 改动**（`git diff 432a43ad -- apps/` 为 0 行），以下均为对既有代码的回归确认。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | ✅ 退出码 0（后端 tsc + 前端 vite build 均通过） |
| `npx vitest run`（单独一次、无并发） | ⚠️ 199 个文件：197 通过 / 2 失败；2232 项：2227 通过 / 2 失败 / 3 跳过 |
| 本阶段相关定向测试 | ✅ `ProfilePage.courses.test.tsx` 3 项 + `LearnerProfilePanel.summary.test.tsx` 8 项，**11 项全部通过** |

### 两个失败项与本次改动无关的证据

| 失败用例 | 复跑结果 | 结论 |
| --- | --- | --- |
| `server.e48-workbench.test.ts` › `allows an in_progress course to continue chatting`（`expected 2 to be 1`） | 单文件复跑 3 次均失败 | 该测试断言 mock provider 被调用次数；`apps/` 与基准提交字节级一致，说明是**既有环境相关失败**（本机端口/进程复用导致 provider 计数漂移），非本阶段引入 |
| `learning/answer-service.test.ts` › `completes a score that finished while the checkpoint was paused` | 单文件复跑**通过**（34/34） | 全量并发下的时序抖动 |

另：先前两次全量运行因**彼此重叠**（第一次尚未结束时启动了第二次）导致大量 `fetch failed` 与 5s 超时；`evidence-recovery.test.ts` 单独复跑 12/12 通过，证实为并发资源竞争，不是代码问题。

本阶段未修改、也无法修改上述两个用例涉及的代码路径。


---

## 7. E4.9i-P1-R1 收尾验收（2026-11-24）

### 7.1 本轮实际完成

1. `prototype-a.html`：保留概览优先页面骨架，新增六类筛选 chip（全部、需要关注、待复习、存在误区、稳定、证据不足），使用 `aria-pressed` 表示当前过滤状态；切换场景恢复「全部」。存在未保存的知识点编辑时，筛选前先询问确认。
2. A/B 默认示例的「同义替换」复习日期统一从 2026-11-28 调整为 2026-11-22（以 P1 日期 2026-11-24 为静态示例基准）。
3. A 概览中不再以 `state_label === "review_due"` 冒充正式到期复习数量，改为「待复习状态」并说明服务端状态分类与复习资格门禁的区别。
4. `analysis.md`、`comparison.md`、`implementation-map.md` 修正状态、日期、资格定义，以及「跨视图渲染冲突」的截图证据等级。
5. **未修改 `apps/`、后端、Store、API、数据库和正式 React 界面**。原 42 张截图均为 R1 前样本，保留作历史记录。

### 7.2 R1 尚需补齐的浏览器核验

| 编号 | 场景 | 需保存的证据 | 当前结论 |
| --- | --- | --- | --- |
| R01 | 方案 A 1440×900 浅色：完整概览与筛选器同屏 | `assets/r1-option-a-desktop.png` | NOT_VERIFIED |
| R02 | 方案 A 320×640 浅色：筛选器合理折行、知识卡无遮挡、无横向溢出 | `assets/r1-option-a-320.png` + 实测 scrollWidth | NOT_VERIFIED |
| R03 | 点击/Enter 激活「待复习」，仅保留匹配状态行，`aria-pressed` 正确 | 实际 DOM 指标 / 对应截图 | NOT_VERIFIED |
| R04 | 无匹配筛选显示空态、切换场景后选中态复位 | 浏览器 DOM 记录 | NOT_VERIFIED |
| R05 | 知识点编辑未保存时切换筛选需确认，拒绝后草稿保留 | 浏览器行为记录 | NOT_VERIFIED |
| R06 | 复习资格提示不误导：状态分类计数与正式到期资格未混同 | 桌面与移动界面文案截图 | NOT_VERIFIED |

### 7.3 后续判定

原 P1 的构建 / 定向测试结果仍是 **R1 前历史运行**。此次原型更新无正式产品代码变更，但 R1 没有重新执行浏览器验证，不得据旧截图宣称新筛选已通过。

待 R01–R06 通过后，报告才可升级为 `P1-R1 PASS`，再解除 PR Draft。P2-1 应在 P1 PR 合并后开始，不提前修改正式学习业务。
