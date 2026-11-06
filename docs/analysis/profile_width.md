# 我的学习档案 — 页面宽度调整

- 完成时间：2026-11-06
- 分支：`main`（工作区改动未提交）
- 验证方式：浏览器实测（真实后端 `runtime/config/config.json`）+ 自动化测试 + 构建

## 0. 结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| 电脑端左右留白明显减少 | 通过 | 1440×900 下卡片宽 820px → 1158px；1920×1080 下 1200px |
| 标题、内容与操作按钮对齐 | 通过 | 各视口 `h1.left === section.left`（1440/1366/1920 均为 228/452） |
| 内容区最大宽度约 1200–1280px | 通过 | 内容列 1200px（卡片内宽 1158–1190px，含卡片内边距） |
| 页面宽度随可用空间自适应 | 通过 | `.mla-profile { width:100%; max-width:1288px; margin:0 auto }`，窄屏自动收窄 |
| 保留左右边距 | 通过 | 1288px 上限 = 1200 内容 + 两侧 44px（24 页面 + 20 列内边距） |
| 各区块同步利用新宽度 | 通过 | 概览四宫格 271→（1440）单格宽 271→约 271；目标/知识/误解/偏好卡片全部 1158px |
| 长文本保持舒适阅读宽度 | 通过 | 摘要、诊断、下一步、修复说明等文本框统一 `max-w-[780px]` |
| 不放大字体/不增加内边距填充 | 通过 | 仅改容器宽度与 4 处 `max-w`，未改字号与 padding |
| 滚动不退化、无双滚动条 | 通过 | 页面内仅 1 个 `overflow-y:auto` 滚动容器；1366×768 滚到底部，学习偏好卡片完整可见（bottom 735 < 768） |
| 编辑按钮可达 | 通过 | 新增目标弹窗（460px）、行内编辑（含保存按钮）、知识行展开表单均实测可操作 |
| 移动端无横向溢出 | 通过 | 390/768/1024/1366/1440/1920 全部 `scrollWidth === clientWidth`，0 个溢出元素 |
| 构建与测试 | 通过 | `npm run build` 成功；`npx vitest run` 1404 通过 / 3 跳过 |
| 功能未改动 | 通过 | 仅改 2 个文件的样式类与 CSS 宽度；学习目标/知识/误解/偏好逻辑、L1 结构、B2 证据、掌握度计算零改动 |

## 1. 排查结果

本地代码仍存在两处宽度限制，且**互不一致**：

| 位置 | 旧值 | 问题 |
|---|---|---|
| `LearnerProfilePanel.tsx:933` | `max-w-[860px]` | 卡片列被限制在 860px |
| `shell.css .mla-profile-head` | `max-width: 900px` | 标题列 900px，且与面板各自居中 |

父容器 `.mla-main` 对 profile 使用 `mla-main--flush`（无 padding、`overflow:hidden`），`.mla-profile` 提供 `padding: 16px 24px 0` 且 `flex:1`，本身不限制宽度。所以 1440 视口下实际卡片仅 820px，左右各空约 310px，且标题左边缘比卡片左边缘**多偏 15px**（两个独立居中容器）。

## 2. 改动

### 2.1 单一居中列（`shell.css`）

宽度上限从"标题与面板各管一段"改为**页面级一个共享列**：

```css
.mla-profile {
	padding: 16px 24px 0;
	width: 100%;
	max-width: 1288px;   /* 1200 内容 + 两侧 44px */
	margin: 0 auto;
}

.mla-profile-head {
	width: 100%;
	padding: 8px 20px 0;   /* 去掉 max-width / 自动外边距 */
}

.mla-profile .mla-profile-body > * {
	scrollbar-gutter: stable;   /* 面板滚动、标题不滚动，预留滚动条槽 */
}
```

`scrollbar-gutter: stable` 解决了一个实测发现的对齐细节：滚动条出现时卡片列宽会被挤窄 15px，左侧边缘相对标题漂移；预留槽位后两者恒等（实测 h1 与卡片左边缘同为 228px）。

### 2.2 面板内列（`LearnerProfilePanel.tsx`）

```diff
- <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 pb-8 pt-2.5">
+ <div className="mla-profile-container mx-auto flex w-full flex-col gap-4 pb-8 pt-2.5">
```

新增 `.mla-profile-container { max-width: 1240px; padding-left/right: 20px }`（≤900px 时降为 12px），与 `.mla-profile-head` 的内边距一致，保证标题与卡片左右边缘同线。

### 2.3 长文本阅读宽度

拓宽后卡片可达 1158px，若正文继续满宽会形成 90+ 字符的长行。以下长文本保持约 780px（即拓宽前的行宽）：

| 元素 | 位置 |
|---|---|
| 整体认知摘要 `Textarea` | `SummarySection` |
| 学习目标成功标准 `ul` | `GoalRow` |
| 误解描述 `span` | `MisconceptionRow` |
| 目标编辑成功标准 `Textarea` | 行内编辑 |
| 知识诊断 / 下一步 `Textarea` ×2 | `KnowledgeRow` 展开 |
| 误解修复说明 `Textarea` | `MisconceptionRow` 编辑 |

这些是 `max-w` 而非固定宽度，窄屏仍随容器收缩（390px 下摘要框实测 280px）。

## 3. 响应式实测

| 视口 | 横向溢出 | 标题左 | 卡片左 | 卡片宽 | 备注 |
|---|---|---|---|---|---|
| 1920×1080 | 无 | 452 | 452 | 1190 | 命中 1288 上限 |
| 1440×900 | 无 | 228 | 228 | 1158 | 上限生效，左右各约 226px |
| 1366×768 | 无 | 228 | 228 | 1084 | 同上，滚到底部学习偏好完整可见 |
| 1024×768 | 无 | 228 | 228 | 742 | 列宽自适应，无固定上限压力 |
| 768×1024 | 无 | 36 | 36 | 686 | 侧栏收起，内边距降为 12px |
| 390×844 | 无 | 36 | 36 | 318 | 概览 2 列，摘要框 280px，无溢出元素 |

滚动行为：全部视口下 `overflow-y:auto` 容器恰好 1 个（`.h-full.overflow-y-auto`），页面本身不滚动；1366×768 下 `scrollTop` 可达 `maxScroll`(572)，末区块 bottom 735 < 768，说明底部内容与编辑按钮可滚动到达。

## 4. 功能实测

| 操作 | 结果 |
|---|---|
| 「+ 新增目标」弹窗 | 打开正常，卡片 460×455 居中，类型下拉 4 项（技能/概念/项目/考试），取消可关闭、可重新打开 |
| 行内「编辑」 | 展开表单（含保存按钮），取消后回到列表视图 |
| 知识行展开 | 展开表单出现，保存/取消按钮存在；滚动到底部时表单仍在滚动容器内 |
| 下拉弹层 | Radix 下拉在拓宽后位置正常，无溢出 |
| 数据 | 未做任何写入操作，档案数据未变 |

## 5. 修改文件

| 文件 | 改动 |
|---|---|
| `web/src/react/shell/shell.css` | `.mla-profile` 增加共享列宽上限与居中；`.mla-profile-head` 去掉独立 `max-width`；滚动容器加 `scrollbar-gutter: stable`；新增 `.mla-profile-container` 及其窄屏规则 |
| `web/src/react/LearnerProfilePanel.tsx` | 面板列由 `max-w-[860px] px-5` 改为 `.mla-profile-container`；6 处长文本加 `max-w-[780px]` |
| `web/src/react/shell/shell.css.test.ts` | 新增 1 个布局契约用例（共享列、标题无独立上限、滚动条槽） |

## 6. 截图

| 文件 | 内容 |
|---|---|
| `docs/ui/profile-width-before-1440x900.jpg` | **改前**：卡片 820px，标题与卡片左边缘错开 |
| `docs/ui/profile-width-after-1440x900.jpg` | 改后 1440 |
| `docs/ui/profile-width-after-1366x768.jpg` | 改后 1366 |
| `docs/ui/profile-width-after-1366x768-bottom.jpg` | 改后 1366 滚到底（学习偏好可见） |
| `docs/ui/profile-width-after-768x1024.jpg` | 改后 768 |
| `docs/ui/profile-width-after-390x844.jpg` | 改后 390 |
| `docs/ui/profile-width-after-dark-1440x900.jpg` | 改后 dark 1440 |
| `docs/ui/profile-width-after-1440x900-dialog.jpg` | 新增目标弹窗（460px） |

## 7. 遗留问题

1. 概览四宫格在 1440 下每格约 271px，数字卡较宽；未改其内部排版（任务要求不靠放大内边距填充空间）。
2. 知识行的概念名列固定 170px、状态列 74px，拓宽后行内留白变多；属既有行结构，本轮未改。
3. 未提交。
