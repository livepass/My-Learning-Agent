# E4.9i-P1 验收记录：我的学习档案分析与原型

- **基准分支**：`main`
- **基准提交**：`432a43ad594c69d3236ba189a4de4ecfd0b29126`
- **当前分支**：`fix/e49i-p1-r1-viewport-qa`
- **R1 起点提交**：`8217f79491873a04185005dd9c6f33de42e59b79`
- **原 P1 结论**：P1 PASS（PR #14 已合并）
- **当前 R1 结论**：**P1-R1 PASS**（R01–R10 全部通过，证据见 §8）
- **改动范围**：仅 `docs/ui-redesign/phase5/` 下的文档、HTML、验收脚本与截图。**未修改任何业务代码、API、Store 或数据库字段。**

> 说明：PR #14 已合并。当前收尾对象是 **PR #15**（`fix/e49i-p1-r1-viewport-qa`）。本报告中此前出现的「PR #14 改为 Ready」均指 PR #15。

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

> **§8 已补齐该验证。** 本节保留为当时的历史状态。


### 7.4 R1 追加修复与本地浏览器复验脚本

- 对新增的 A+筛选器执行静态 DOM 入口审计时发现，原型「视口」下拉框和模拟设备容器同时使用 `id="viewport"`，使 `document.getElementById("viewport")` 可能指向下拉框而非容器。已将下拉框改名为 `viewport-control`，同时更新 `syncControls` 与变更监听；设备容器保留唯一 `id="viewport"`。
- 新增 `scripts/qa_p1_r1.py`，使用真实 Playwright Chromium 打开本地原型 HTML，覆盖：1440px/320px 新版截图、六类筛选、Enter/Space 键盘操作、无匹配空态、切换场景重置、未保存编辑的取消与确认、视口切换、水平溢出与 JS 运行错误。输出截图 `assets/r1-option-a-desktop.png`、`assets/r1-option-a-320.png`、`assets/r1-option-a-320-filtered.png` 和 `assets/r1-browser-metrics.json`。
- 在**具有浏览器权限的本地 Codex 环境**运行：

  ```bash
  python3 -m pip install playwright
  python3 -m playwright install chromium
  python3 docs/ui-redesign/phase5/scripts/qa_p1_r1.py
  ```

- **执行状态：NOT_VERIFIED**。当前交互环境能审查与提交 GitHub 文件，但 Chromium 导航受环境访问限制；尚未从真实运行产生以上图片或 JSON。提交的是自动化验收**脚本**，不是测试通过结果。
- 如脚本发现失败或 UI 越界，修复 HTML 原型并保留失败及复测记录；脚本运行通过后提交新增证据，更新本报告后才有资格将 PR #15 改为 Ready for review。

> **该阻塞已在 §8 解除。** 本轮在具备 Chromium 的本地环境实际执行了脚本。

---

## 8. R1 浏览器验收执行结果（2026-11-24）

### 8.1 环境与运行

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11（win32） |
| Python | 3.12.10 |
| Playwright | 1.64.1（`python -m pip install playwright`） |
| 浏览器 | Playwright 自带 Chromium（`python -m playwright install chromium`） |
| 被测对象 | `docs/ui-redesign/phase5/prototype-a.html`（`page.set_content` 直接加载，不启动 HTTP 服务，不调用任何生产 API） |
| 命令 | `python docs/ui-redesign/phase5/scripts/qa_p1_r1.py` |
| 脚本输出 | `R1 PASS — see .../assets/r1-browser-metrics.json` |
| 证据生成时间 | 2026-11-24 18:05（文件系统 mtime，全部为本次运行新生成） |

### 8.2 截图与指标（均为本轮真实生成）

| 文件 | 尺寸 | 内容 |
| --- | --- | --- |
| `assets/r1-option-a-desktop.png` | 1440×2922 | 1440px 浅色，概览 + 六类筛选器 + 6 条知识行 |
| `assets/r1-option-a-320.png` | 320×3863 | 320px，筛选器两行折行、6 条知识行 |
| `assets/r1-option-a-320-filtered.png` | 320×3362 | 320px，「待复习」筛选后仅 1 条 |
| `assets/r1-browser-metrics.json` | — | 两档视口的实测指标与 `verdict: "PASS"` |

`r1-browser-metrics.json` 关键数值：

| 指标 | 1440 | 320 |
| --- | --- | --- |
| `outerWidth` / `frameWidth` | 1440 / 1440 | 320 / 320 |
| `scrollWidth` / `clientWidth` | 1440 / 1440 | 320 / 320 |
| `overflow` | `false` | `false` |
| `visibleRows`（全部） | 6 | 6 |
| `reviewDueRows`（筛选后） | 1 | 1 |
| `pressed` | `["all"]` | `["all"]` |
| `filterNames` | 全部 6 / 需要关注 4 / 待复习 1 / 存在误区 1 / 稳定 1 / 证据不足 1 | 同左 |
| `stateCountCaption` | 活跃目标 / 已记录知识点 / **待复习状态** / 未解决误区 | 同左 |
| `keyboardAndEditConfirm` | `PASS` | `PASS` |

### 8.3 R01–R10 逐项结果

| 编号 | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| R01 | 1440px 桌面原型：概览、六类筛选器、知识列表正常显示 | ✅ PASS | `r1-option-a-desktop.png`；概览卡 `bottom=575`、知识卡 `top=591`，不重叠；筛选器 1 行（y=653） |
| R02 | 320px 移动原型：筛选器折行、无遮挡、无横向溢出 | ✅ PASS | `r1-option-a-320.png`；`scrollWidth=320=clientWidth`；筛选器 2 行（y=1020 / 1052），全部 6 个 chip 右边界 ≤ 298 < 320 |
| R03 | 状态筛选：点「待复习」只显示对应知识点 | ✅ PASS | 行数 6 → 1；`aria-pressed="true"` 仅在 `review_due` |
| R04 | 键盘：Enter、Space 可切换筛选 | ✅ PASS | Space 激活「全部」、Enter 激活「稳定」，脚本断言通过 |
| R05 | 无匹配数据：显示明确空结果提示 | ✅ PASS | `review-due` 场景下点「稳定」，出现「当前筛选下没有知识点，可选择其他状态。」 |
| R06 | 场景切换后自动恢复「全部」筛选 | ✅ PASS | 切换场景后 `aria-pressed` 回到 `all` |
| R07 | 未保存知识点时切换筛选需确认 | ✅ PASS | 编辑诊断后点筛选，`dialog` 被触发 |
| R08 | 取消切换后保留原编辑内容 | ✅ PASS | 取消后 `draft-diagnosis` 值仍为 `R1 uncommitted edit must survive`，筛选未变 |
| R09 | 320px 设备模拟容器正确切换 | ✅ PASS | `#viewport` 类含 `vp-320`；`frameWidth=320` |
| R10 | 复习语义：状态未被称作正式到期复习资格 | ✅ PASS | 概览标题为「待复习状态」，副注「仅统计 state_label，不是已到期数」；筛选说明「不代表复习已到期或已获得复习资格」；结论句「是否到期以今日学习核查为准」 |

补充确认：

- `aria-pressed` 在任何时刻**只有一个**选中项（脚本在两档视口各断言一次）。
- 两档视口 `pageerror` 均为空列表，无 JavaScript 运行错误。
- `state_label` 仅用于状态分类：原型全文未把它当作复习资格判据，界面文案明确指向「今日学习核查」。

### 8.4 本轮发现并修复的问题

| # | 问题 | 根因 | 修复 | 复测 |
| --- | --- | --- | --- | --- |
| F1 | 320px「筛选后」全页截图把粘性原型栏画到页面中部，遮挡内容 | `position: sticky` 的元素在 `full_page` 截图里按当前滚动位置绘制 | `prototype-a.html` 新增 `body[data-capture="true"]`：隐藏 `.proto-bar` / `.proto-note`，并把 `.bottom-nav` 改为 `static`；脚本新增 `shoot()`，截图前设置该标记、把滚动复位到顶部，截图后撤销 | 重跑脚本后 `r1-option-a-320-filtered.png` 顶部即为产品界面，无遮挡 |

修复仅影响截图路径：正常浏览与交互时 `data-capture` 不存在，原型栏与底部导航行为不变。

### 8.5 尚未解决的问题（不阻断本轮）

1. 筛选器只依据 `state_label`，无法表达「已到期」；这是数据能力边界，已在界面与文档中标注，需 P2 或后续接口补齐。
2. 截图为 `full_page`，粘性导航条在正常滚动时覆盖内容属于原型设备框的既有行为，非本轮范围。
3. 本轮未在真实 React 页面执行同样断言（P1 阶段按任务要求不改业务代码）；该验证属于 P2 的验收内容。

### 8.6 结论

**P1-R1 PASS。**

R01–R10 全部通过，两档视口均无横向溢出、无 JS 错误、`aria-pressed` 唯一，复习语义未与正式到期资格混同。改动范围经 `git diff origin/main...HEAD --name-only` 确认为 `docs/ui-redesign/phase5/` 三项文件（报告、原型、脚本）。
