# E3.1 UI v2 — 模型设置页面融合优化 验收报告

- 完成时间：2026-11-06
- 分支：`main`（工作区改动未提交）
- 验证方式：源码审查 + 自动化测试（全量 1398 通过）+ **真实本地 Magpie 网关联调**（`127.0.0.1:3425`，Magpie `0.1.2626`）+ 浏览器多视口实测

## 0. 结论摘要

| 验收项 | 结论 | 证据 |
|---|---|---|
| 两张参考图的主要元素已融合 | 通过 | `e31-v2-after-light-1440x900-{api,magpie}.jpg` |
| 不再出现旧的「已配置模型」长列表 | 通过 | 旧版 `e31-v2-before-light-1440x900.jpg` 中的 A/B 分组与「已保存的 Magpie 模型」分组已移除 |
| 七个厂商入口保留 | 通过 | 单测断言预设顺序 `deepseek,kimi,minimax,volcengine,xiaomimimo,bailian,custom`；截图三列网格 |
| Magpie 连接与模型列表可用 | 通过 | 真实网关返回 13 个模型，逐行展示真实元数据 |
| 当前模型下拉可跨两个通道切换 | 通过 | 实测 `qwen3.8-flash · API` ⇄ `Hy3 · Magpie`，切换后写入 `config.json` |
| 切换失败不产生错误状态 | 通过 | 单测：失败保留旧模型、显示 store 错误、不出现「已就绪」 |
| API Key 不以明文回显 | 通过 | 单测断言输入框 `type=password`、值不回显掩码 |
| 刷新/重启后配置可恢复 | 通过 | 页面刷新后仍为上次选择；`runtime/config/config.json` 中 `defaultProvider`/`defaultModel` 与保存的模型一致 |
| 1440 / 1366 / 768 / 390 布局 | 通过 | 四个视口 `scrollWidth === clientWidth`，无横向溢出；厂商网格 3→3→2→1 列 |
| 测试与构建 | 通过 | `npx vitest run` 136 文件 / 1398 通过 / 3 跳过；`npm run build` 成功 |

## 1. 页面结构（固定顺序）

1. 页标题「模型连接」+ 副标题；
2. 当前模型状态卡；
3. 通道切换（`API 接入` / `Magpie 接入`，`Tabs`，role=tablist）；
4. 所选通道的配置内容。

当前模型名只在状态卡出现一次；旧版的「A. 直接 API 接入 / B. Magpie 本地网关接入」两个并列长区块和「已保存的 Magpie 模型」分组列表不再出现。

## 2. 当前模型状态卡（`CurrentModelCard.tsx`）

- 模型名 + 通道标签（厂商名 / 「Magpie 接入」）；
- 上下文与最大输出（仅当两者均 > 0 时展示，如 `33k context · 4k max`）；
- Magpie 通道额外提示：元数据取自已保存配置，缺失字段为保守默认值；
- 就绪状态机 `未检测 → 检测中… → 模型已就绪 / 模型未就绪`，切换模型时自动回到「未检测」；
- 切换模型下拉：选项带 `· API` / `· Magpie` 来源标记，跨通道可选，调用既有 `POST /api/settings/model`，失败保留旧模型并显示 store 错误；
- 右侧刷新按钮触发真实检测。

**「网关已连接」与「模型已就绪」保持两个独立状态**：Magpie 面板的芯片只描述网关可达性（`已连接 Magpie v0.1.2626`），状态卡只在一次真实模型调用成功后才显示「模型已就绪」。

### 为此新增的服务端端点

`POST /api/settings/model/verify`（`server/routes/settings.ts`，由 `server.ts` 注入 `verifyModel`）：

- 复用 side channel（不进会话历史、不进队列）发一次真实补全，把 `ModelCompletionOutcome` 原样返回；
- 运行时未就绪时返回 `not_ready/agent_not_initialized`，异常返回 `error`，绝不伪造成功；
- 不改默认模型、不写配置文件（单测断言 `config.json` 字节级不变）；
- 已登记进能力白名单（`capability-policy.ts`）与 `requiresAgent`（`route-dispatch.ts`）。

### 联调中发现并修复的问题

首次实现用 `maxTokens: 16`，真实调用 `qwen3.8-flash` 返回 `stopReason: "length"`（推理 token 先占满预算），side channel 正确判为失败，界面显示「模型未就绪」——**一个可用模型被判为不可用**。改为 `maxTokens: 512` 后同一次真实调用返回 `{"status":"ok","text":"pong"}`，界面显示「模型已就绪」。原因与依据写在 `server.ts` 的注释里。

## 3. API 面板

- 七家厂商三列卡片网格（`lg:grid-cols-3` / `sm:grid-cols-2` / 单列），保留原图标、名称、描述；
- 名称仍为「新增模型」；点击厂商进入原有配置表单（复用 `AddProviderWizard` 的表单与保存逻辑）；
- 已保存的厂商配置、密钥、模型完全保留（`preserveApiKey: true` 与按厂商合并语义未改）；
- 网格常驻显示，不再是折叠的「新增模型」抽屉。

## 4. Magpie 面板

- 连接区：网关地址、网关密钥（`type=password`，不回显）、`检测连接`、芯片显示 `已连接 Magpie vX` / `已配置，未检测` / `未配置`；
- 模型列表：来自真实 `/v1/models`，每行显示名称、推理/视觉标记、模型 id、`{N}k context` / `{N}k max`（未知时显示「上下文未知」等而非编造数值）、协议下拉、`使用`、删除；当前模型行有「当前」标记且不显示删除；
- 刷新只更新列表，**不会切换默认模型**（单测覆盖）；选择集合为空时自动勾选第一个模型，便于首次保存；
- 保存只写 `magpie` 一项，不触碰直接 API 的厂商配置；
- 空列表、连接失败、网关不再提供已保存模型均有明确提示。

## 5. 修改文件清单

### 前端（`apps/learning-agent/web/src/`）

| 文件 | 状态 | 内容 |
|---|---|---|
| `react/settings/ModelsSettings.tsx` | 重写 | 页标题 + 状态卡 + 通道 Tabs + 对应面板 |
| `react/settings/CurrentModelCard.tsx` | 新增 | 当前模型状态卡与真实就绪检测 |
| `react/settings/MagpieSettings.tsx` | 重写 | 连接区 + 统一模型列表（目录行与已保存行合并） |
| `react/settings/AddProviderWizard.tsx` | 修改 | 厂商网格常驻、三列布局 |
| `api/settings.ts` | 修改 | `ModelVerifyResult` 类型与 `verifyCurrentModel()` |
| `react/settings/MagpieSettings.test.tsx` | 重写 | 19 个用例覆盖本报告第 0 节各项 |
| `i18n/locales/zh-CN.json`、`en.json` | 修改 | `settings.models.*` 命名空间与 Magpie 新文案 |

### 后端（`apps/learning-agent/src/`）

| 文件 | 状态 | 内容 |
|---|---|---|
| `server/routes/settings.ts` | 修改 | `verifyModel` 注入点与 `POST /api/settings/model/verify` |
| `server.ts` | 修改 | 装配 `verifyModel`（`ensureAgentReady` + side channel，`maxTokens: 512`） |
| `server/route-dispatch.ts` | 修改 | 该端点纳入 `requiresAgent` |
| `server/capability-policy.ts` | 修改 | 该端点纳入模型设置域白名单 |
| `server/routes/settings.magpie.test.ts` | 修改 | 新增 3 个校验端点用例 |
| `server/capability-policy.test.ts`、`server/route-dispatch.test.ts` | 修改 | 白名单与运行时门控断言 |

### 文档

`docs/ui/e31-v2-before-light-1440x900.jpg`、`e31-v2-after-light-{1440x900-api,1440x900-magpie,1366x768,768x1024,390x844,390x844-magpie}.jpg`、`e31-v2-after-dark-1440x900.jpg`。

## 6. 测试与构建

```
npx vitest run                     136 files / 1398 passed / 3 skipped
vitest settings.magpie 等 4 个文件  91 passed
npm run build                      ✓ built in 41.88s
backend tsc --noEmit / web tsc      无报错
```

## 7. 遗留问题

1. **切换模型的下拉只列「已保存的模型」**：Magpie 面板里未勾选保存的模型不会出现在下拉中，需要先勾选并保存。这是既有数据模型的限制（下拉读 `configuredModels`），不是本轮改动引入。
2. **就绪状态不持久**：刷新页面或切换模型后回到「未检测」，需要用户再次点击刷新检测。这是有意为之——不缓存历史成功结果，避免把旧结论当成当前事实。
3. **检测会真实消耗一次模型调用**（约 1 个请求，最大 512 token 预算），因此不做自动轮询。
4. **未做真实的多厂商逐个联调**（本轮只对 `example` 直连与 Magpie 网关做了真实调用），属于 E3.2 范围。
5. 深色主题已按 token 验证（卡片 `#2a2a2a`、边框 `#3b3b3b`、正文 `#ececec`），但截图只保留了一张深色整页图。
