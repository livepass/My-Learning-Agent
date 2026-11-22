# E4.9g-P2-4 验收报告：AI 学习历史栏与开始面板改造

- **基准分支**：`main`
- **基准提交**：`26e67269ca40715da9209c0991f99ba09b2bd3cf`（PR #4 合并后的 `main`，与任务给出的基准一致）
- **工作分支**：`feat/e49g-p2-4-history-start-panel`
- **设计依据**：`docs/ui-redesign/phase3/analysis.md`、`index.html`、`prototype.html`、`implementation-map.md`（方向 A「专注书桌」）
- **结论**：**P2-4 增量 PASS，项目全量仍存在基线失败**（见第 9 节）

---

## 1. 修改文件清单

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `react/pages/learn/LearnHistoryRail.tsx` | 新增 | 历史栏展示组件：课程名/状态、新建对话、完整会话列表、未归类分组、归档入口、错误提示、返回课程选择；抽屉态增加关闭按钮、焦点移入/回收、Escape |
| `react/pages/learn/LearnStartPanel.tsx` | 修改 | 新增 `mostRecentConversation()` 与「最近学习」卡片；新增 `onResumeRecent` 回调 |
| `react/pages/LearnPage.tsx` | 修改 | 内联历史栏 JSX 换为 `LearnHistoryRail`；`contextOpen` 改为 `contextSessionId` 派生；`learningForSession` 隔离旧会话检查点；`viewport` 同时驱动 Sheet 模态与历史栏抽屉 |
| `react/shell/shell.css` | 修改 | 常驻栏 264px；新增 `901–1279px` 抽屉断点；删除旧的 `≤1100px` 三列规则；新增最近学习卡片与抽屉关闭按钮样式；侧栏标题截断 |
| `react/pages/learn/LearnHistoryRail.test.tsx` | 新增 | 12 项组件测试 |
| `react/pages/LearnPage.course-bar.test.tsx` | 修改 | 新增 4 项 Sheet 会话身份测试（32 → 36） |
| `react/pages/learn/LearnStartPanel.test.tsx` | 修改 | 新增 4 项最近学习测试（11 → 15） |
| `react/shell/shell.css.test.ts` | 修改 | 布局契约改为 264px 两列；新增断点测试；读取时归一化 CRLF |
| `react/pages/LearnPage.welcome.test.tsx` / `.workbench.test.tsx` / `LearnPage.test.tsx` | 修改 | 会话名出现两次的断言改为限定作用域 |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `learn.welcome.recentLabel`、`resumeRecent` |
| `docs/ui-redesign/phase3/P2-4-assets/` | 新增 | 22 张真实页面截图 + `metrics.json` |
| `docs/ui-redesign/phase3/P2-4-acceptance.md` | 新增 | 本报告 |

**未修改**：`LearningWorkspace.tsx`、Store、API、后端、学习检查点评估、学习证据、掌握度、其他页面、全局导航。

---

## 2. `LearnHistoryRail` 职责与 Props

**职责**：纯展示。打开/重命名/归档/删除/切换课程/新建对话全部通过回调交回 `LearnPage`。

| Prop | 用途 |
| --- | --- |
| `draggable` | 当前是否为抽屉（<1280px）；决定关闭按钮与 Escape 监听是否存在 |
| `open` | 抽屉可见性；常驻模式下忽略 |
| `course` / `title` | 会话自身绑定的课程与标题（P2-2-R2 的 `conversationCourse`，不读 `selectedCourse`） |
| `canStartNew` / `creating` | 新建对话的权限与进行中状态 |
| `conversations` / `conversationCount` | 本课程完整会话列表与总数（空态只在总数为 0 时出现） |
| `unclassifiedSessions` / `showUnclassified` | 未归类历史分组，独立折叠 |
| `archiveEntryCount` / `archivedCourseCount` / `hiddenSessionCount` | 归档入口文案 |
| `actionError` | 会话操作错误 |
| `renderSessionRow` | 复用既有 `LearnSessionRow`，不复制行逻辑 |
| `onBack` / `onClose` / `onNewConversation` / `onToggleUnclassified` / `onOpenArchive` | 回调 |

---

## 3. 断点行为

| 视口 | 历史栏 | 聊天区 | 抽屉控件 |
| --- | --- | --- | --- |
| ≥1280px | 常驻，264px，`position: static` | 占剩余列宽 | 无（无遮罩、无关闭按钮、无 `aria-hidden`） |
| 901–1279px | 320px 覆盖式抽屉，`position: fixed` | 独占内容列 | 有：遮罩、关闭按钮、Escape、焦点管理 |
| ≤900px | 86vw / 最大 320px 抽屉（保持原样） | 手机全宽 | 同上 |

浏览器实测：

| 宽度 | 栏位置 | 打开按钮 | 聊天宽（关闭） | 聊天宽（打开） | 差值 | 溢出 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1440 | static | 无 | 1048 | — | — | 0 |
| 1280 | static | 无 | 888 | — | — | 0 |
| 1279 | fixed | 有 | 1183 | 1183 | **0** | 0 |
| 1024 | fixed | 有 | **928** | 928 | **0** | 0 |
| 901 | fixed | 有 | 805 | 805 | **0** | 0 |
| 900 | fixed | 有 | 876 | 876 | **0** | 0 |
| 390 | fixed | 有 | 366 | 366 | **0** | 0 |
| 320 | fixed | 有 | 296 | 296 | **0** | 0 |

- 1280 与 1279 是同一断点的两侧，位置从 `static` 切到 `fixed`，没有空档。
- 901px 仍走抽屉，900px 走手机布局，两条规则首尾相接。
- 抽屉打开时聊天宽度不变，说明它是覆盖而非挤压。

---

## 4. 聊天宽度实测对比

| 视口 | P2-3 基线 | P2-4 | 变化 |
| --- | ---: | ---: | ---: |
| 1024 × 768 | 684 | **928** | **+244** |
| 901 × 800 | 805 | 805 | 0（901px 原本就是常驻栏，改为抽屉后由内容列独占，见下） |
| 1440 × 900 | 1052 | 1048 | −4（常驻栏 260 → 264px） |

1024px 达到任务要求的 900px 门槛（实测 928px），横向溢出为 0。

> 901px 的 805px 不是回归：该宽度此前是 232px 常驻栏 + 聊天，现在 805px 就是内容列的全部宽度（页面左右 padding 各 16px + 2px 边框）。

---

## 5. 历史抽屉交互与焦点验证

浏览器实测（1279 / 1024 / 901 / 900 / 390 / 320 六档全部一致）：

| 检查 | 结果 |
| --- | --- |
| 点击课程栏历史按钮打开 | 是（`mla-learn--nav-open`） |
| 遮罩出现 | 是（关闭时 `display: none`） |
| Escape 关闭 | 是（6 档 `closedByEscape: true`） |
| 关闭后焦点回到触发按钮 | 是（6 档 `focusReturned: true`） |
| 抽屉内关闭按钮 | 是（仅抽屉态渲染） |
| 常驻栏被错误声明为对话框 | 否（`role` 为空，无 `aria-modal`） |
| 抽屉关闭时 `aria-hidden` | `true`，不可访问 |
| 窗口从抽屉宽度放大到 ≥1280px | 自动关闭抽屉，不遗留遮罩 |
| 与学习上下文 Sheet 互斥 | 是（见下） |

互斥验证（1024px）：先打开 Sheet → `sheetOpenBefore: true`；再点历史按钮 → `sheetOpenAfterRail: false`、`railOpen: true`。两者不会同时展开。

---

## 6. 欢迎态与最近学习

- **未选课程**：真实课程列表 + 创建课程 + 归档入口；无课程、仅归档、加载中、读取失败四种空态均按服务端数据区分（截图 `1440-welcome-no-courses.png`、`1440-welcome-archived-only.png`）。
- **已选课程**：课程名 + 状态徽章 + 三个快捷入口 + 「最近学习」卡片 + 「继续之前的对话 · N」+ 切换课程。
- **最近学习**：按 `SessionMeta.updatedAt` 取最新一条**未归档**记录；时间相同取列表靠前者（稳定）；无法解析的时间不参与；没有历史则不渲染卡片。
- **完整历史**：卡片下方仍可展开全部会话（浏览器实测 3 条，测试中 9 条全部渲染）。
- **点击继续学习**：走既有 `openConversation` → `sessionsStore.openSession`，实测 URL 变为 `?page=learn&course=course_python&session=s_newest`，没有新建会话。

`mostRecentConversation()` 是导出的纯函数，只读 `SessionMeta`，没有新增接口。

---

## 7. 快捷操作与首次发送回归

| 规则 | 证据 |
| --- | --- |
| 快捷学习只填草稿 | `LearnStartPanel` / `LearnPage.welcome` 既有用例：点击后 `appStore.chatDraft` 有值，`startCourseLearning` 与 `chatStore.send` 均未调用 |
| 选择课程不创建会话 | `switches course without creating a session and clears the draft` |
| 首次发送才建绑定会话 | `creates the course-bound conversation on the first send` |
| 未归类历史只读 | 既有用例 + P2-3 的 Sheet 用例 |
| 归档会话只读 | 既有用例 |
| 暂停/完成课程不能发送 | P2-2-R2 用例（T02 / T07 / T11）本轮全部通过 |
| 新建对话不自动发送 | `starts a new conversation at the course start without sending` |

P2-2-R2 的权限模型未改：`conversationCourse`、`conversationUnclassified`、`authorityStatus`、`readOnlySession`、`conversationBlock`、`canInitialize/canPause/canResume` 原样沿用；历史栏的「新建对话」也走同一份判断。

---

## 8. Sheet 会话身份防护（P2-4-1）

**修复**：`contextOpen` 由布尔改为 `contextSessionId`，可见性派生为

```
contextOpen = Boolean(currentSessionId) && contextSessionId === currentSessionId
```

切换会话的同一次渲染中 Sheet 即不可见，不再依赖 `useEffect` 事后关闭。

**旧检查点防护**：`learningForSession` 只在 `learningStore.sessionId === currentSessionId` 时转发真实状态，否则转发 `{ state: null, isLoading: true }`。异步读取未完成时显示「正在读取学习状态…」，不会出现上一会话的题目。

| 测试 | 结果 |
| --- | --- |
| T17a 切换会话同一次渲染即隐藏 | 通过 |
| T17b B 未加载时不显示 A 的检查点 | 通过 |
| T17c 快速 A → B → A 不自动重开 | 通过 |
| T17d 暂停写入发往 B 的 session 与 revision | 通过（`pauseLearning("s2.jsonl", 8)`，未以 A 的参数调用） |

---

## 9. TypeScript、构建与全量测试

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p apps/learning-agent/web/tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |
| `npm test` | 189 文件 / 2052 通过 / 1 失败 / 3 跳过 |

### 定向测试

| 文件 | 用例数 |
| --- | ---: |
| `learn/LearnHistoryRail.test.tsx` | 12 |
| `learn/LearnStartPanel.test.tsx` | 15 |
| `learn/LearnContextSheet.test.tsx` | 21 |
| `LearnPage.course-bar.test.tsx` | 36 |
| `LearnPage.welcome.test.tsx` | 8 |
| `LearnPage.workbench.test.tsx` | 15 |
| `shell/shell.css.test.ts` | 18 |
| **合计** | **125 / 125 通过** |

全 Web 目录：44 文件 / 520 项通过。

### 全量失败对照

| 文件 | 用例 | 判定 |
| --- | --- | --- |
| `src/server.e48-workbench.test.ts` | `allows an in_progress course to continue chatting`（`providerCalls` 期望 1 实得 2） | **基线既有失败**：P2-2-R1 起在 `853d470` 基线复现，P2-3 与 R2 均记录在案，本轮未改后端 |

用例总数从 P2-3 的 2035 增至 2056（+21：历史栏 12、最近学习 4、Sheet 身份 4、CSS 断点 1）。没有删除、跳过或放宽任何失败测试。

**结论：P2-4 增量 PASS，项目全量仍存在基线失败。**

---

## 10. 各尺寸截图（`docs/ui-redesign/phase3/P2-4-assets/`，22 张 + `metrics.json`）

| 组 | 文件 |
| --- | --- |
| 八档视口 × 关闭 | `{1440,1280,1279,1024,901,900,390,320}-rail-closed.png` |
| 抽屉宽度 × 打开 | `{1279,1024,901,900,390,320}-rail-open.png` |
| 欢迎态 | `1440-welcome-recent.png`、`1440-welcome-history.png`、`1440-welcome-no-courses.png`、`1440-welcome-archived-only.png` |
| 互斥 | `1024-rail-over-sheet.png` |
| 长课程名 + 深色 | `light-1280-long-name.png`、`dark-1024-long-name.png`、`dark-390-long-name.png` |
| 指标 | `metrics.json` |

全部页面控制台 0 错误，所有视口 `document.scrollWidth - innerWidth = 0`。

---

## 11. 已知问题与下一阶段建议

1. **`server.e48-workbench` 基线失败**仍然存在，与前端无关，本轮按要求未修改。
2. **1440px 常驻栏从 260 增至 264px**，聊天区相应少 4px。这是任务表格指定的宽度，不是回归。
3. **抽屉在 901–1279px 与 ≤900px 是两套 CSS 规则**（宽度 320 与 86vw），行为一致但样式来源不同。P2-5 可考虑合并为一条，但本轮按「不改变手机抽屉」的要求保留。
4. **最近学习卡片只取一条**：任务要求突出最近一条且不截断历史，当前实现符合；若后续需要「最近 N 条」，应复用同一排序函数。
5. **建议 P2-5**：整体集成验收时复核 1024–1279px 的抽屉与 Sheet 叠加顺序、深浅主题下的全部空态，并清理 `shell.css` 中已无引用的旧类。

---

## 12. Git

- 代码与报告提交在 `feat/e49g-p2-4-history-start-panel`
- 未合并 `main`，未推送 `main`
- PR 目标：`main`

### PASS 判定

| 条件 | 结果 |
| --- | --- |
| ≥1280px 历史栏常驻 | 是（264px，`static`） |
| 901–1279px 历史栏以抽屉展示 | 是（320px，`fixed`，实测 1279/1024/901） |
| ≤900px 移动端历史抽屉正常 | 是（900/390/320 实测） |
| 1024px 聊天区宽度达到要求 | 是（928px ≥ 900px） |
| 历史会话完整、归档和未归类规则不变 | 是（9 条全渲染；未归类独立分组） |
| 最近学习入口可正确继续会话 | 是（打开 `session=s_newest`） |
| 快捷操作不自动发送 | 是 |
| Sheet 切换会话时不显示旧检查点 | 是（T17a–T17d） |
| P2-2-R2 权限模型无回归 | 是 |
| 自动化测试和构建满足验收门槛 | 是（定向 125/125，构建通过） |
| 无阻断性响应式及无障碍问题 | 是（0 溢出、0 控制台错误） |
| 报告与截图齐全 | 是 |

**结论：P2-4 增量 PASS，项目全量仍存在基线失败。**
