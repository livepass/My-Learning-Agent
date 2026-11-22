# E4.9g-P2-5-R1 验收报告：最终验收证据补齐

- **分支**：`test/e49g-p2-5-integration-qa`
- **基准提交**：`3861744db154e9680b6aad4396021e8bb2a43f65`（P2-5）
- **结论**：**P2-5-R1 PASS**（发现并修复 1 个真实 i18n 无障碍缺陷；更正 2 处报告技术描述）

---

## 1. 修复前缺陷与复现

### 1.1 英文深色截图名不副实

`P2-5-assets/dark-1440-sheet-en.png`、`dark-390-sheet-en.png` 文件名带 `-en`，但页面仍是中文界面。

**原因**：P2-5 的矩阵脚本用 `document.querySelector("select")` 切换语言，而语言控件是设置页里的 Radix `Select`（`role="combobox"`），页面中根本没有原生 `<select>`。`if (select)` 为假，切换静默失败，截图却按「英文」保存。

这是**证据缺陷**，不是产品缺陷：产品本身的语言切换正常。

### 1.2 切换语言后 `<html lang>` 不更新（真实缺陷）

复验英文时发现：界面文案已全部变成英文，但 `document.documentElement.lang` 仍是 `zh-CN`。

**原因**：`apps/learning-agent/web/index.html` 硬编码 `lang="zh-CN"`，`i18n/index.ts` 的 `setLocale()` 只写 `localStorage` 并通知桌面壳，从未更新 `<html lang>`。

**影响**：`lang` 是辅助技术读取的第一个属性。英文界面下屏幕阅读器仍会按中文发音规则朗读英文，断词与词典行为也不正确。属于无障碍缺陷，P1 级别中的可访问性问题。

**复现**：设置页把界面语言切到 English → DevTools 查看 `<html lang>` → 仍为 `zh-CN`。

---

## 2. 修改清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/.../i18n/index.ts` | 修改 | 新增 `syncDocumentLanguage()`，在初始化与每次 `setLocale()` 时同步 `<html lang>` |
| `i18n/index.test.ts` | 新增 | 3 项测试：切英文设置 `lang="en"`、切回中文恢复、语言持久化 |
| `P2-5-acceptance.md` | 修改 | 更正滚动锁实现说明、补充 `-en` 截图标注错误、明确三类覆盖范围 |
| `P2-5-R1-assets/` | 新增 | 13 张正确英文深色截图 + `i18n-dark.json`、`layers.json` |
| `P2-5-R1-acceptance.md` | 新增 | 本报告 |

**未修改**：`Sheet.tsx`、`modal-layer.ts`、`LearningWorkspace.tsx`、Store 业务逻辑、后端、任何布局与样式。

---

## 3. 英文深色补验

通过**真实设置页控件**（`role="combobox"` → `option "English"`）切换语言，再应用深色主题，三档视口全部验证。

| 视口 | `<html lang>` | 主题 | 横向溢出 | 控制台错误 |
| --- | --- | --- | ---: | ---: |
| 1440 × 900 | `en` | dark | 0 | 0 |
| 390 × 844 | `en` | dark | 0 | 0 |
| 320 × 640 | `en` | dark | 0 | 0 |

**系统 UI 文案（应翻译，已确认英文）**

| 位置 | 文案 |
| --- | --- |
| 顶部导航 | `AI Learning` / `Settings` |
| 底部导航 | `Today` / `AI Learning` / `Practice & Feedback` / `Learning Profile` |
| 课程栏 | `In progress` / `Free learning` / `Course plan` / `Learning status` / `New conversation` |
| 历史抽屉 | `New conversation` / `Free learning` |
| 上下文 Sheet | `Learning context` / `Course and task` / `Learning checkpoint` / `This session` / `Stage` / `Revision` / `In conversation` / `Pause learning` |
| 说明文字 | `This panel only shows the course, task and learning checkpoint the server recorded. …` |
| Composer | `Ask a follow-up…` |

**用户数据（不翻译，符合要求）**

- 课程名 `Python 编程`
- AI 回复正文与其中的表格内容

**检查点操作**：`Pause learning` 存在且可点（`sheetActions: { pause: true, resume: false, init: false }`），与检查点 `active` 状态一致。

**未发现残留中文的系统文案。**

截图：`en-dark-{1440,390,320}-{settings,conversation,sheet,drawer}.png`。

---

## 4. 历史抽屉与上下文 Sheet 交互

### 4.1 滚动锁实现：报告原文不准确

P2-5 报告称两者「均采用引用计数」。源码实际不同：

| 组件 | 实现 |
| --- | --- |
| `modal-layer.ts`（历史抽屉） | 模块级引用计数；第一个进入时记录原始值，最后一个离开时恢复 |
| `Sheet.tsx`（学习上下文） | 每次打开保存 `body.style.overflow` 当前值，关闭时写回 |

已在 `P2-5-acceptance.md` 更正。

### 4.2 实测：无残留

真实浏览器，4 档视口 × 5 轮连续开关，共 20 轮（`layers.json`）：

| 视口 | 场景 A 抽屉→会话→Sheet→关闭 | 场景 B Sheet→关闭→抽屉→关闭 | 5 轮连续开关 | 滚动锁残留 | 控制台错误 |
| --- | --- | --- | --- | ---: | ---: |
| 1024 × 768 | 正常 | 正常 | 正常 | **0** | 0 |
| 900 × 800 | 正常 | 正常 | 正常 | **0** | 0 |
| 390 × 844 | 正常 | 正常 | 正常 | **0** | 0 |
| 320 × 640 | 正常 | 正常 | 正常 | **0** | 0 |

每一轮结束后的可观测状态：`body.style.overflow` 为空字符串、`inert` 元素只剩关闭的历史抽屉本身（1 个）、焦点回到触发按钮。

**为什么两种实现不冲突**：UI 上两者互斥——打开抽屉会关闭 Sheet，打开 Sheet 会关闭抽屉。任一时刻最多只有一层持有滚动锁，因此「保存/恢复」与「引用计数」不会互相覆盖。

### 4.3 一个按设计成立的行为

900px 及以下时 Sheet 是模态的，会 `inert` 整个背景（含课程栏的「打开课程列表」按钮）。因此「Sheet 开着时点击历史按钮」在模态档位**不可达**——这不是缺陷，而是模态语义的正确结果。验证脚本改为断言该按钮确实被 `inert`，然后按真实路径（先关 Sheet）完成切换。

---

## 5. 自动化测试与构建

| 命令 | 结果 |
| --- | --- |
| `npx vitest run sessions-store.test.ts i18n/index.test.ts` | 2 文件 / 29 项通过 |
| `npm test -- apps/learning-agent/web/src/react/pages` | 18 文件 / 324 项通过 |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |
| `npx vitest run --maxWorkers=4` | 见第 6 节 |

P2-5 修复的会话重命名绑定问题**无回归**：`sessions-store.test.ts` 26 项（含 P2-5 新增的 2 项绑定保留用例）全部通过。

---

## 6. 全量测试

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4`（本轮） | 190 文件 / **2071 通过 / 1 失败 / 3 跳过**（2075 项） |

用例总数从 P2-5 的 2072 增至 2075（+3：`<html lang>` 回归测试）。

唯一失败：

| 文件 | 用例 | 判定 |
| --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2） | **基线既有失败**：P2-2-R1 起在 `853d470` 复现，P2-3 / P2-4 / P2-4-R1 / P2-5 均记录在案，本轮未改后端 |

**历史结果对照**（保留在 `P2-5-acceptance.md`）：

| 轮次 | 命令 | 结果 |
| --- | --- | --- |
| P2-5 | `npm test`（默认并发） | 2065 通过 / 4 失败 / 3 跳过 |
| P2-5 | `npx vitest run --maxWorkers=4` | 2068 通过 / 1 失败 / 3 跳过 |
| P2-5-R1 | `npx vitest run --maxWorkers=4` | 2071 通过 / 1 失败 / 3 跳过 |

没有删除、跳过或放宽任何测试。

---

## 7. 覆盖范围说明（与 P2-5 报告一致）

本轮**没有**新增浏览器端到端覆盖。以下仍只由自动化或接口契约覆盖，`P2-5-acceptance.md` 已按此更正：

| 项目 | 覆盖方式 |
| --- | --- |
| 删除会话 | 仅自动化（5 项，含三种 409 分支）；浏览器未执行 |
| 未归类历史的完整交互 | 仅接口契约 + 自动化；隔离数据集无未归类会话 |
| 课程暂停 / 完成 | 仅自动化；浏览器只验证了「归档课程」 |
| AI 回复质量 | 不覆盖（桩 provider 返回固定文本） |

---

## 8. 已知问题

1. **`server.e48-workbench` 基线失败**仍然存在，与前端无关。
2. **默认并发下偶发时序失败**：P2-5 观察到 3 项，隔离与受限并发下均通过。本轮直接使用 `--maxWorkers=4`，未复现。
3. **`P2-5-assets` 中两张错误的 `-en` 截图未删除**：保留原文件并在报告中标明其错误，正确证据在 `P2-5-R1-assets`。删除会破坏历史记录的完整性。

---

## 9. Git

- 提交到 `test/e49g-p2-5-integration-qa`
- 未合并 `main`

### PASS 判定

| 条件 | 结果 |
| --- | --- |
| 英文深色模式的系统 UI 正常 | 是（三档，`<html lang="en">`） |
| 新增截图与标注一致 | 是（通过真实设置控件切换） |
| 手机端抽屉与 Sheet 快速切换正常 | 是（20 轮，4 档） |
| 无背景滚动锁或焦点残留 | 是（`layers.json` 全 0） |
| 报告技术描述与代码一致 | 是（已更正滚动锁说明） |
| 覆盖范围表述准确 | 是（三类区分明确） |
| 会话重命名绑定修复无回归 | 是（26 项通过） |
| 无新增确定性测试失败 | 是（唯一失败为基线） |
| 完整构建通过 | 是 |
| 报告与证据完整 | 是 |

**结论：P2-5-R1 PASS。**
