# E3.1 UI v2 补丁 — 当前模型来源清理与协议区排版

- 完成时间：2026-11-06
- 分支：`main`（工作区改动未提交）
- 验证方式：源码审查 + 自动化测试 + 浏览器实测（真实 Magpie `0.1.2626` 网关，13 个模型）

## 0. 结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| 当前模型卡不再出现 `example` | 通过 | 页面实测卡片为「当前模型 / qwen3.8-flash / **API 接入**」；新增单测断言 `queryByText("example")` 为空 |
| 无明确来源时不显示内部 id | 通过 | `sourceLabel()` 对未知 provider 回落到通道标签，不再回落到 provider id |
| 协议区不再拥挤 | 通过 | 标题独立一行、下拉独立一行、按钮另起一行；1366px 下标签→下拉 4px、下拉→按钮 12px |
| 下拉宽度可读、不挤压 | 通过 | `min-w-[200px] max-w-[280px]`；实测 280px（390px 视口 264px），`openai-completions` 完整显示不换行 |
| 弹层宽度与触发器一致 | 通过 | Radix `--radix-select-trigger-width`；实测 trigger 280px / content 280px |
| 列表项行高与内边距舒适 | 通过 | 每项 32px 高、左 8px / 右 30px（右侧 30px 给勾选图标留位，未改动共享样式） |
| 窄屏自动换行 | 通过 | 390px 下「使用 / 删除」换到下拉下方，无横向溢出（`scrollWidth === clientWidth`） |
| 1440 / 1366 / 768 / 390 | 通过 | 四个视口 `scrollWidth === clientWidth`，无元素横向溢出 |
| 功能与数据流不变 | 通过 | 仅 JSX 排版与文案函数改动；保存/切换/删除逻辑未触碰 |
| 测试与构建 | 通过 | `npx vitest run` 1401 通过 / 3 跳过；`npm run build` 成功 |

## 1. 任务一：移除 `example`

`CurrentModelCard.tsx` 的 `sourceLabel()` 原先在找不到预设时直接回落到 provider id：

```ts
return findPreset(provider)?.name ?? provider;   // example 就是这样漏出来的
```

`example` 是配置文件里写入的占位 provider key，用户从未这样命名过它，属于内部标识。改为：

```ts
function sourceLabel(provider: string, t: Translate): string {
	if (provider === MAGPIE_PROVIDER_ID) return t("settings.models.sourceMagpie", { defaultValue: "Magpie 接入" });
	return findPreset(provider)?.name ?? t("settings.models.sourceApi", { defaultValue: "API 接入" });
}
```

行为：已知厂商显示品牌名（DeepSeek / Kimi / …），Magpie 显示「Magpie 接入」，其余一律显示「API 接入」——即这次请求实际走的通道，信息完整但不泄露内部 id。

新增文案 `settings.models.sourceApi`（zh: `API 接入`，en: `API`），未新增其它一次性文案。

## 2. 任务二：协议区排版

改前（单行横向塞入）：`[模型信息][协议下拉 132px][使用][删除]`，下拉与按钮 gap 仅 6px，`openai-completions` 在 132px 内被截断。

改后（每行一件事）：

```
[✓] 模型名  [推理] [视觉] [当前使用]
    auto/deepseek-v4-pro  1049k context  393k max
    ──────────────────────────────────────
    协议
    [ openai-completions      ▼ ]  [使用] [🗑]
```

- 标题 `协议` 用 `<label htmlFor>` 独立一行，下拉独占一行，操作按钮在同一行但 `gap-3`（12px）；
- 控件区顶部加分隔线与 10px 上间距，与模型信息明确分层；左侧缩进 26px 对齐勾选框之后的文字列；
- 下拉 `w-full min-w-[200px] max-w-[280px]`，弹层由 Radix `--radix-select-trigger-width` 保持一致；
- 未勾选但已保存的行只显示「使用 / 删除」，同样独立成行；
- 按钮由 `xs` 提到 `sm`，与 32px 的下拉高度对齐。

只改 JSX 结构与宽度类，协议枚举、`protocols` 状态、`handleUse` / `handleDelete` 完全未动。

## 3. 响应式实测

| 视口 | 页面横向溢出 | 下拉宽度 | 布局 |
|---|---|---|---|
| 1440×900 | 无（1440=1440） | 280px | 标题/下拉/按钮各一行 |
| 1366×768 | 无（1366=1366） | 280px | 同上；标签→下拉 4px，下拉→按钮 12px |
| 768×1024 | 无（768=768） | 280px | 下拉与「使用」同行，间距 12px |
| 390×844 | 无（390=390），0 个横向溢出元素 | 264px | 「使用 / 删除」换行到下拉下方 |

行高：桌面 145px/行（含协议区），窄屏 209px/行；未勾选行更矮。

## 4. 修改文件清单

| 文件 | 改动 |
|---|---|
| `web/src/react/settings/CurrentModelCard.tsx` | `sourceLabel()` 不再回落到 provider id |
| `web/src/react/settings/MagpieSettings.tsx` | 协议/按钮区改为分行布局 |
| `web/src/react/settings/MagpieSettings.test.tsx` | 新增 3 个用例（见下） |
| `web/src/i18n/locales/zh-CN.json`、`en.json` | 新增 `settings.models.sourceApi` 一条 |

新增测试：

1. `never prints an internal provider id as the current model's source` — provider 为 `example` 时页面不含 `example`，显示 `sourceApi`；
2. `keeps the brand name for a known vendor and hides unknown ids` — `DeepSeek` 显示、`deepseek`（id）不显示；
3. `puts the protocol label, dropdown and actions on their own lines` — label 是下拉的兄弟节点且在其上方、下拉含 `min-w-[200px]`。

## 5. 截图

| 文件 | 内容 |
|---|---|
| `docs/ui/e31-v2-after-light-1440x900-magpie.jpg` | **改前**：协议下拉与按钮挤在一行 |
| `docs/ui/e31-v2b-after-light-1440x900-magpie.jpg` | **改后**：协议区独立成行（1440） |
| `docs/ui/e31-v2b-after-light-1366x768-magpie.jpg` | 改后（1366） |
| `docs/ui/e31-v2b-after-light-768x1024-magpie.jpg` | 改后（768，下拉与按钮同行） |
| `docs/ui/e31-v2b-after-light-390x844-magpie.jpg` | 改后（390，按钮换行） |
| `docs/ui/e31-v2b-after-light-1440x900-api.jpg` | 改后 API 面板 |
| `docs/ui/e31-v2b-after-light-1366x768-card.jpg` | 改后当前模型卡（显示「API 接入」） |

## 6. 遗留问题

1. **下拉弹层行高/内边距未改**：`SelectItem` 的 32px 行高与 `padding: 6px 30px 6px 8px` 来自共享 `react/ui/Select.tsx` 与 `app.css`，属于全站统一规范（design.md 要求复用共享控件、不新增一次性样式）。本轮只调整了业务侧触发器宽度，没有改共享样式，以免影响其它所有下拉。若确需更宽松的选项行，应在 `react/ui` 统一调整。
2. **模型名仍可能被压缩**：模型名不再 `truncate`，长名称会自然换行而非省略；在极窄屏下会让行变高，但不会溢出。
3. 未提交。E3.2 真实多厂商兼容性测试仍未开始。
