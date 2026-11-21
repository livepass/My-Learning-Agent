# E4.9g-P2-1-R1 验收报告：加载态边界修复

- **仓库**：`livepass/My-Learning-Agent`
- **工作分支**：`refactor/e49g-p2-1-learn-components`
- **P2-1 基准**：`ae917e1`
- **本轮修复基准（P2-1 HEAD）**：`a65fb1b39f8d6b10d5bba2a21b6185dab835d559`
- **修复提交**：`285091accc6e60e78c936499f7f782700b448f64`（代码与测试）
- **最终提交**：本报告与视觉复核所在提交（分支 HEAD）
- **结论**：**PASS**（等待全量测试最终结果填入）

---

## 1. 问题与复现条件

重构前，`LearnPage` 的首次加载判断是：

```tsx
// ae917e1 — LearnPage.tsx:575
const loadingCourses = courseState.loading && courseState.courses.length === 0;
```

这里 `courseState.courses` 是完整课程列表，包含归档课程。

拆分到 `LearnStartPanel` 后，判断被写成只看未归档课程：

```tsx
const loadingCourses = coursesLoading && activeCourses.length === 0;
```

复现条件：

1. 课程列表全部为归档课程（`activeCourses = []`，`archivedCourses` 非空）。
2. 此时触发一次课程列表刷新（`coursesLoading = true`）。

错误结果：`loadingCourses` 被误判为 `true`，页面显示「正在加载课程…」，同时隐藏：

- 「课程都在归档中，可以先创建新课程，或到归档中心恢复原有课程。」
- 「创建课程」卡片
- 「查看归档」入口

即把「已有归档记录、正在刷新」错误地当成了「尚无任何课程数据」。这与重构前行为不一致。

---

## 2. 修改

### 2.1 产品代码

文件：`apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.tsx`

```diff
-const loadingCourses = coursesLoading && activeCourses.length === 0;
+// The original page treated "no course records at all" as loading. Archived
+// courses are records too: while a refresh runs with only archived courses,
+// the empty text and the create entry must stay visible instead of flipping
+// back to the first-load spinner.
+const loadingCourses = coursesLoading
+	&& activeCourses.length === 0
+	&& archivedCourses.length === 0;
```

`activeCourses`（非归档）与 `archivedCourses`（归档）共同覆盖完整课程列表，因此该条件与重构前的 `courses.length === 0` 等价。没有新增 Prop、状态或分支。

### 2.2 测试

文件：`apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.test.tsx`

新增 3 项边界测试，未修改任何既有断言。

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| T01 | 只有归档课程，正在刷新 | 不显示「正在加载课程…」；显示「课程都在归档中…」；保留「创建课程」与「查看归档」 |
| T02 | 完全没有课程，首次加载 | 显示「正在加载课程…」；不显示无课程空态；不显示创建课程卡片 |
| T03 | 已有正常课程，后台刷新 | 原课程卡片继续显示；不显示首次加载提示；选择按钮可用并回调正确课程 |

---

## 3. 测试结果

### 3.1 定向测试

| 命令 | 结果 |
| --- | --- |
| `npm test -- apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.test.tsx` | **11 / 11 通过**（原 8 + 新增 3） |
| 学习页 6 个既有测试 + 3 个组件测试 | **9 文件 / 106 项通过**（P2-1 为 103，新增 3） |

原有 T01–T18 行为断言全部继续通过。

### 3.2 全量测试

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 第一次全量 | `npm test` | **185 文件，1866 通过 / 14 文件失败 / 101 跳过** |
| 隔离复跑 | `npx vitest run server.course-archive.test.ts server.learning-http.test.ts` | **2 文件 / 27 项通过** |
| 第二次全量（受限并发） | `npx vitest run --maxWorkers=4` | **185 文件，1964 通过 / 0 失败 / 3 跳过**（`EXIT:0`） |

第一次失败的 14 个文件全部是 `apps/learning-agent/src/server.*.test.ts`，错误统一为 `server readiness timeout`（启动就绪超时），没有一条业务断言失败。默认并发为 8 个 worker，多个后端测试同时拉起临时服务时争抢资源；隔离复跑与降低并发后的全量均通过。

这是一次已知的环境抖动，不是本次一行条件修改引入的失败：

- 失败文件全部位于后端，本轮未修改任何后端、Store 或 API。
- 失败信息是启动超时，不是断言不匹配。
- 同一批文件隔离运行为 27/27 通过。
- 降低并发后 185 个文件全部通过。

3 项跳过仍为环境守卫（Node 无 SQLite FTS5、文件系统不支持符号链接、Windows 跳过 0o600 权限断言）。

---

## 4. 构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 通过，0 错误 |
| `npm --workspace my-learning-agent-web run build` | 通过 |
| `npm run build` | 通过（server + web） |

---

## 5. UI 影响

**没有视觉变化。**

- 未修改 CSS、类名、DOM 结构、文案或布局。
- 唯一变化是 `loadingCourses` 的布尔条件；对 `archivedCourses.length === 0` 的所有场景结果完全相同。
- P2-1 已验收的 18 个「分辨率 × 状态」组合（`archivedCourses` 均为 0）已在修复后重新截图，与 P2-1 基线 **18/18 逐像素完全一致（0 差异）**；结果在 `P2-1-R1-visual.json`。
- 修复只改变「全部为归档课程 + 刷新」这一边界状态：从错误的首次加载态恢复为归档空态。

---

## 6. 修改范围

修改：

- `apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.tsx`
- `apps/learning-agent/web/src/react/pages/learn/LearnStartPanel.test.tsx`
- `docs/ui-redesign/phase3/P2-1-R1-acceptance.md`（本报告）

未修改：

- `LearnPage.tsx` 业务逻辑
- `LearningWorkspace.tsx`
- 所有 Store 与 API
- 后端服务
- CSS / 响应式布局
- 其他已拆分组件

未新增目录、依赖或平行实现；`CourseErrorRef` 错误文案问题按任务要求留到后续处理。

---

## 7. 合并条件

| 条件 | 结果 |
| --- | --- |
| 加载态判断恢复原有语义 | 是 |
| 三个边界测试通过 | 是（11/11） |
| 原有测试无回归 | 是（定向 106/106） |
| 完整构建通过 | 是 |
| 未修改业务逻辑和 UI 布局 | 是 |
| 验收报告完整 | 是 |
| 全量测试无新增失败 | 是（受限并发 1964 通过 / 0 失败；默认并发仅环境就绪超时，隔离复跑通过） |

**结论：PASS。** 修复提交与报告已推送到 `origin/refactor/e49g-p2-1-learn-components`，未合并 `main`。

**PR 阻塞：** 本环境的 `gh` 未登录（`You are not logged into any GitHub hosts`），无法创建 PR。按任务要求保留分支、不推送 `main`；可在 GitHub 打开 compare 页面创建：

`https://github.com/livepass/My-Learning-Agent/compare/main...refactor/e49g-p2-1-learn-components?expand=1`
