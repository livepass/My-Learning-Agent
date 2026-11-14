# E4.9c — 公共 UI 组件与样式统一

- 基准：`691826b`（E4.9b）
- 范围：学习页面重复实现的基础控件；未改后端、课程数据、Agent 运行时与 L1/L2/L3/B2

## 1. 提交清单

| 批次 | 内容 | 提交 |
| --- | --- | --- |
| C0 | 英文资源中文残留、归档排序随语言 | `03155af` |
| C1 | Badge / Card / EmptyState / Field 组件 | `a960cd8` |
| C2/C3-1 | Textarea prose 变体、练习页迁移 | `9188997` |
| C3-2 | 今日学习与课程卡片 | `952ddbe` |
| C3-3 | 归档中心 | `1cc902e` |
| C3-4/5 | AI 学习、表单与收尾 | `78d5de7` |

## 2. 新增公共组件（`react/ui/`）

| 组件 | 职责 | 约束 |
| --- | --- | --- |
| `Badge` / `StatusBadge` | 统一标签表面与语义 tone（neutral/accent/success/warning/danger） | 页面传入已翻译文案；tone 是语义不是颜色 |
| `Card` | 共享表面 + 四种变体（default/practice/group/selectable） | 卡片内部布局仍由调用方决定，不强制统一 |
| `EmptyState` | 图标 + 标题 + 说明 + 可选操作，含 compact 变体 | 不决定「是否该显示空态」，读取失败仍走错误分支 |
| `Field` | label / hint / error 与控件的关联 | 控件由调用方传入，保留各自业务结构 |

四个组件都不依赖 store / api，不写死任何语言文案；`primitives.test.tsx` 8 项覆盖 tone 类名、变体类名、`id + htmlFor + aria-describedby + aria-invalid` 关联与紧凑变体。

`AsyncSection` **未实现**：审计阶段预期的三态共享，在实际迁移中每个页面的 loading/error 分支都带着不同的重试语义（课程列表要重读 store、归档中心要同时刷新两侧），强行抽象会把业务逻辑塞进通用组件。本轮保留各页面的既有分支。

## 3. 各页面迁移情况

| 页面 | 迁移内容 |
| --- | --- |
| 练习与反馈 | 作答框改 `Textarea variant="prose"`（删除 `.mla-practice-input`）；练习卡改 `Card variant="practice"`；状态标签改 `Badge`；两处空态改 `EmptyState` |
| 今日学习 | `CourseCard` 改 `Card` + `Badge`；五处空态改 `EmptyState`；建议/复习标签改 `Badge` |
| 课程管理 | 上下文条、学习目标、概况、知识库面板标签改 `Badge`；来源状态用语义 tone；创建课程表单改 `Field` |
| 归档中心 | 分组改 `Card variant="group"`；原因/已归档/会话数标签改 `Badge`；空态改 `EmptyState` |
| AI 学习 | 课程状态、未归类、检查点标签改 `Badge`；欢迎页与会话布局未改 |
| 学习档案 | 摘要编辑框使用同一 `prose` 表面；其余沿用既有 `profile.*` 与 `Card` 结构 |

## 4. C0 修复

1. `en.json` 的 `archive.group.sessionCount` / `manualArchivedCount` 原本仍是中文单数值，会在英文下显示中文；改为英文只保留 `_one`/`_other`，中文只保留单数形式。
2. `locales.test.ts` 新增「英文资源不得含中文」校验，显式豁免语言自称（`settings.languageOptions.zh-CN`）、品牌名与两条本就中英混排的技能触发提示（`settings.smartInput.*`，它们刻意引用用户要输入的「技能」）。同时让双语校验理解「中文单数 + 英文复数」的写法。
3. `buildGroups(courses, sessions, locale)` 显式接收 locale，`ArchiveSettings` 把 `i18n.language` 纳入 `useMemo` 依赖，语言切换后排序重新计算。

## 5. 定向测试

```
npx vitest run apps/learning-agent/web/src/react apps/learning-agent/web/src/i18n apps/learning-agent/web/src/stores
→ 44 files / 504 tests passed
```

- `primitives.test.tsx`：8 项（新增）
- `i18n/locales.test.ts`：8 项（含新增的英文中文残留校验）
- `PracticePage`、`LearnPage*`、`LearningWorkspace`、`TodayPage*`、`CourseDetailPage`、`DeletionDialog`、`ProfilePage*`、`SettingsPage.archived`、`settings/*`、`courses/*`：全部通过
- `npx tsc --noEmit -p apps/learning-agent/web/tsconfig.json`：无错误
- `npm run build`：通过

## 6. 视觉验收

已在真实浏览器（1440×1000 与 390×844）检查计算后布局：

| 截图 | 内容 |
| --- | --- |
| `docs/ui/e49c-archive-en-1440x1000.jpg` | 归档中心英文：分组卡、Badge、课程级操作 |
| `docs/ui/e49c-archive-en-390x844.jpg` | 归档中心手机端：无横向溢出（分组宽 316px） |
| `docs/ui/e49c-archive-en-dark-390x844.jpg` | 深色主题归档中心 |
| `docs/ui/e49c-learn-welcome-en-1440x1000.jpg` | AI 学习英文欢迎态 |
| `docs/ui/e49c-learn-selected-en-1440x1000.jpg` | 已选课程态：快捷入口、Badge |
| `docs/ui/e49c-practice-empty-en-1440x1000.jpg` | 练习页英文空态 |
| `docs/ui/e49c-practice-zh-390x844.jpg` | 练习页中文手机端 |

**未完成的视觉检查**：练习页「已提交答案 + 评分反馈」状态没有截图——需要在真实会话里完成一次提交与评分，本轮未构造该数据；该状态的组件结构由 `PracticePage.test.tsx` 覆盖，但**视觉验收未完成**。

## 7. 仍保留的专用 UI 及原因

| 保留项 | 原因 |
| --- | --- |
| `.mla-course-card` 附加类（在 `Card` 之上） | 课程卡有专属的头部/任务行/操作区布局，只复用表面而非整块结构 |
| `.mla-archive-group-head` / `-toggle` / `-sessions` | 归档分组的可展开头与缩进子列表是其业务形态，不属于通用卡片 |
| `.mla-practice-*`（除已删除的 input） | 题目、分隔线、作答、提交、反馈的顺序与间距是练习卡专有 |
| 计划结构编辑器、复习准备表单 | 动态增删阶段/任务、知识点选择等交互无法用 `Field` 表达 |
| `SegmentedControl` 的 `toolbar` / `rail` 变体 | 仅 Markdown 渲染族使用，属既有专用控件 |

## 8. 未执行检查与残余风险

- 未跑全量 Vitest（仅 web 前端与 i18n）；未重做 E4.7/E4.8 业务验收。
- 练习页「已提交 + 评分」视觉状态未截图（见 §6）。
- 英文长文案在窄屏的换行未逐条核对（仅覆盖归档、练习、AI 学习三页）。
- `shell.css` 未做拆分，仅新增了 `mla-field-label` / `mla-field-message` / `mla-empty--compact` 三条共享规则；`.mla-badge` 与 `.mla-card` 系列仍是既有实现，未重排层叠顺序。
- 课程详情四个面板的空态仍是手写 `mla-empty`（未改），因为它们的图标与文案组合各不相同，留待后续按需迁移。
