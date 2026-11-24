## 概要

E4.9i-P1-R1：为方案 A + 状态筛选器补齐真实浏览器验收，作为 PR #15 的合并证据。

**未修改任何业务代码、API、Store、数据库或复习算法。** 改动全部位于 `docs/ui-redesign/phase5/`：

```
docs/ui-redesign/phase5/P1-acceptance.md
docs/ui-redesign/phase5/prototype-a.html
docs/ui-redesign/phase5/scripts/qa_p1_r1.py
docs/ui-redesign/phase5/assets/r1-*.png / r1-browser-metrics.json
```

- 基准：`main` @ `432a43ad594c69d3236ba189a4de4ecfd0b29126`
- 工作分支：`fix/e49i-p1-r1-viewport-qa`
- R1 起点提交：`8217f79`
- 验收证据提交：`256cc02`
- 最终提交：本 PR 的 head（含验收报告与 PR 描述文件）

## 浏览器验收结果

在 Windows 11 + Python 3.12.10 + Playwright 1.64.1（自带 Chromium）本地执行：

```bash
python docs/ui-redesign/phase5/scripts/qa_p1_r1.py
```

脚本以 `page.set_content` 直接加载 `prototype-a.html`，不启动 HTTP 服务、不调用生产 API。输出 `R1 PASS`。

| 编号 | 验收项 | 结果 |
| --- | --- | --- |
| R01 | 1440px 桌面：概览 + 六类筛选器 + 知识列表 | ✅ 概览 `bottom=575`、知识卡 `top=591`，不重叠；筛选器 1 行 |
| R02 | 320px：筛选器折行、无遮挡、无横向溢出 | ✅ `scrollWidth=clientWidth=320`；筛选器 2 行，chip 右边界 ≤ 298 |
| R03 | 点「待复习」只显示对应知识点 | ✅ 6 行 → 1 行，`aria-pressed` 仅 `review_due` 为 true |
| R04 | Enter / Space 可切换筛选 | ✅ Space →「全部」，Enter →「稳定」 |
| R05 | 无匹配数据有空结果提示 | ✅ 「当前筛选下没有知识点，可选择其他状态。」 |
| R06 | 切换场景后恢复「全部」 | ✅ `aria-pressed` 回到 `all` |
| R07 | 未保存编辑时切换筛选需确认 | ✅ 触发 `dialog` |
| R08 | 取消切换保留原编辑内容 | ✅ 草稿仍在，筛选未变 |
| R09 | 320px 设备模拟容器正确切换 | ✅ `#viewport` 含 `vp-320`，`frameWidth=320` |
| R10 | 「待复习状态」未被称作正式到期复习资格 | ✅ 概览副注「仅统计 state_label，不是已到期数」；筛选说明「不代表复习已到期或已获得复习资格」 |

补充确认：`aria-pressed` 任何时刻只有一个选中项；两档视口 `pageerror` 均为空；无水平溢出。

## 截图与指标

| 文件 | 尺寸 |
| --- | --- |
| `assets/r1-option-a-desktop.png` | 1440×2922 |
| `assets/r1-option-a-320.png` | 320×3863 |
| `assets/r1-option-a-320-filtered.png` | 320×3362 |
| `assets/r1-browser-metrics.json` | 两档视口实测指标，`verdict: "PASS"` |

全部为本轮真实生成（文件 mtime 2026-11-24 18:05），不是旧截图复制。

`r1-browser-metrics.json` 关键值：

| 指标 | 1440 | 320 |
| --- | --- | --- |
| `overflow` | false | false |
| `visibleRows` | 6 | 6 |
| `reviewDueRows` | 1 | 1 |
| `pressed` | `["all"]` | `["all"]` |
| `filterNames` | 全部 6 / 需要关注 4 / 待复习 1 / 存在误区 1 / 稳定 1 / 证据不足 1 | 同左 |
| `stateCountCaption` | 活跃目标 / 已记录知识点 / 待复习状态 / 未解决误区 | 同左 |

## 本轮修复

**F1：320px 筛选后截图把粘性原型栏画到页面中部，遮挡内容。**

根因：`position: sticky` 的元素在 `full_page` 截图中按当前滚动位置绘制。

修复：
- `prototype-a.html` 新增 `body[data-capture="true"]`：隐藏 `.proto-bar` 与 `.proto-note`，`.bottom-nav` 改为 `static`。
- `qa_p1_r1.py` 新增 `shoot()`：截图前设置该标记并把滚动复位到顶部，截图后撤销。

已验证正常浏览不受影响：无 `data-capture` 时原型栏照常显示，底部导航行为不变。

## 遗留问题（不阻断本轮）

1. 筛选器只依据 `state_label`，无法表达「已到期」——数据能力边界，已在界面与文档标注。
2. `full_page` 截图与粘性导航的交互属于原型设备框既有行为，非本轮范围。
3. 未在真实 React 页面执行同样断言（P1 按任务要求不改业务代码），该验证属于 P2 验收内容。

## 结论

**P1-R1 PASS。**

改动范围经 `git diff origin/main...HEAD --name-only` 确认仅 `docs/ui-redesign/phase5/`。不自动合并，等待最终代码审查。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
