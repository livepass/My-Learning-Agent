# E3.1 双通道模型接入改造 — 验收报告

- 验收时间：2026-11-06
- 分支：`main`（工作区改动未提交）
- 验收方式：源码审查 + 自动化测试 + **真实本地 Magpie 网关联调**（`127.0.0.1:3425`，Magpie `0.1.2626` 实际在线）

## 0. 本轮起点与结论摘要

本轮开始时工作区已存在一套未提交的 Magpie 实现（9 个修改文件 + 6 个新增文件，含 30 个通过的测试）。
本轮的任务是**审查这套实现、补齐缺口、并完成真实联调**。审查发现 5 个真实缺陷，其中 2 个是阻断级：

| # | 缺陷 | 级别 | 证据 | 处理 |
|---|---|---|---|---|
| 1 | `/api/settings/magpie/{health,models}` 未登记进能力白名单，落回**已移除**的 `externalResources`，生产环境一律 403 | **阻断** | 真实服务器请求返回 `{"error":"capability_disabled","capability":"externalResources"}`；单元测试直接调 handler 绕过了策略 | 已修复 + 测试 |
| 2 | 选中 `anthropic-messages` 协议时 base URL 仍为 `…/v1`，Anthropic SDK 拼成 `/v1/v1/messages` → 404 | **阻断** | 真实网关实测：`POST /v1/messages` 200，`POST /v1/v1/messages` 404 | 已修复（按模型独立 base URL）+ 测试 |
| 3 | 首次保存时留空网关密钥会存成 `""`，运行时 `apiKey \|\| "local"` 发送 `Bearer local`，与官方文档的 `magpie-my-learning-agent` 归因标识不符 | 中 | 读 `pi-runner.ts` 注册路径 + 文档 `Send magpie-<your-app-id>` | 已修复 + 测试 |
| 4 | `configuredModels` 丢失 `api`，Magpie 面板「不重新拉取直接再保存」时静默失败（模型不在 picker 里） | 高 | `providerModelToRuntimeModel` 未透传 `api` | 已修复 + 测试 |
| 5 | 上述再保存会把已确认的上下文/最大输出重置为保守默认值 | 中 | 保存路径只查 `catalog`，不含已保存模型 | 已修复 + 测试 |

**E3.1 验收结论：PASS**（真实联调全部完成，见第 5 节）。

---

## 1. 修改的源码文件清单

### 后端（`apps/learning-agent/src/`）

| 文件 | 状态 | 内容 |
|---|---|---|
| `shared/magpie.ts` | 新增 | 网关常量（provider id、默认地址、本地客户端标识）与 `magpieModelBaseUrl()`。无 node 依赖，服务端与前端共用，避免两份常量漂移 |
| `agent/magpie.ts` | 新增 | 网关探测与目录解析：`/api/hello` 身份校验、`/v1/models` 解析、URL 安全校验（仅本机/局域网、拒绝重定向）、错误码映射、超时与响应体上限 |
| `agent/magpie.test.ts` | 新增 | 15 个测试，含真实 HTTP 假网关 |
| `agent/provider-sync.ts` | 修改 | 子 Agent `models.json` 同步支持按模型的 `api` / `baseUrl` |
| `agent/provider-sync.test.ts` | 新增 | 2 个测试 |
| `agent/pi-runner.ts` | 修改 | 运行时 provider 注册支持按模型的 `api` / `baseUrl`（PI 的 `ProviderChatModelConfig` 本身支持模型级覆盖） |
| `config.ts` | 修改 | `InnoModelConfig` 增加可选 `api`、`baseUrl`；`normalizeModelConfig` 规范化并省略空值 |
| `server/routes/settings.ts` | 修改 | Magpie 探测端点；保存时校验网关地址；空密钥回落为本地客户端标识；`configuredModels`/`availableModels` 透传 `api` 与模型级 `baseUrl` |
| `server/routes/settings.magpie.test.ts` | 新增 | 8 个路由契约测试 |
| `server/capability-policy.ts` | 修改 | 把 Magpie 探测端点归入模型设置域（修复阻断缺陷 #1） |
| `server/capability-policy.test.ts` | 修改 | 新增 2 条断言 |

### 前端（`apps/learning-agent/web/src/`）

| 文件 | 状态 | 内容 |
|---|---|---|
| `react/settings/MagpieSettings.tsx` | 新增 | B 区面板：地址/密钥、检测连接、拉取模型、模型选择、协议选择、手动模型 ID、保存、已保存模型的使用/删除 |
| `react/settings/MagpieSettings.test.tsx` | 新增 | 10 个测试 |
| `react/settings/ModelsSettings.tsx` | 修改 | 增加 A/B 两段标题；Magpie 模型从直接 API 列表中排除，交由独立面板管理 |
| `api/settings.ts` | 修改 | `probeMagpieGateway()` / `fetchMagpieCatalog()` |
| `types/settings.ts` | 修改 | `api`、模型级 `baseUrl` 类型 |
| `i18n/locales/zh-CN.json` / `en.json` | 修改 | 新增 `settings.magpie.*` 文案（含“模型已被移除”提示） |

`web/src/react/settings/AddProviderWizard.tsx`、`provider-presets.ts`、`stores/settings-store.ts` **未改动**——原有 7 个厂商卡片与保存流程原样保留。

## 2. 核心设计与实现

### 2.1 复用而非平行（关键取舍）

Magpie 不是第二套 provider 系统：它被保存为 `config.json` 里一个**普通 provider 条目**（`providerId: "magpie"`），
因此直接复用了现有的 `upsertProvider` / `saveConfig` / `refreshConfiguredProviders` / `switchModel` /
`deleteModel` / 密钥脱敏 / 子 Agent 同步。新增的只有两件事：

1. **按模型的协议与 base URL 覆盖**（`api?`、`baseUrl?`）——Magpie 一个网关同时提供 OpenAI Chat Completions、
   OpenAI Responses 与 Anthropic Messages，且三种协议的路径前缀不同（见 2.3），单一 provider 级配置表达不了。
   PI 的 `ProviderChatModelConfig` 本就支持模型级 `api` / `baseUrl`，所以这是接线而非改造。
2. **网关探测/目录两个服务端端点**——复用 `probe-models` 同样的「服务端发起、密钥不进浏览器」原则。

### 2.2 网关检测与模型发现

- `GET /api/hello`，**必须** `name === "magpie"`；同端口其他服务返回 `not_magpie`。
  实测指向本应用自身端口时返回 502 `not_found`（对方无 `/api/hello`），同样被拒绝。
- `GET /v1/models` 解析真实字段：`id`（完整保留 `provider/model` 与路由组名）、`display_name`、
  `owned_by`、`context_window`/`context_length`、`max_output_tokens`、`reasoning`/`supported_reasoning_levels`、
  `modalities.input`（真实网关返回对象形态 `{input:[...]}`，解析器同时兼容数组与 `{models}` 旧形态）。
- **缺失字段不推断**：每个字段带 `confirmed` 标记，缺失时保存用保守默认值（128k / 8192）并在 UI 标注
  “未提供（保存用默认值）”；手动填写的模型 ID 明确提示“尚未验证”。
- 空列表返回 `models: []` + 警告，不抛错，允许手动填写模型 ID。

### 2.3 协议适配（本轮修复的核心）

真实网关实测三种协议路径：

| 协议 | 实际路径 | 客户端 base URL |
|---|---|---|
| OpenAI Chat Completions | `/v1/chat/completions` | `…:3425/v1` |
| OpenAI Responses | `/v1/responses` | `…:3425/v1` |
| Anthropic Messages | `/v1/messages` | `…:3425`（**根**，SDK 自己加 `/v1`） |

`magpieModelBaseUrl()` 按协议给出模型级 base URL；`modelConfigToProviderModel` / `provider-sync` /
`parseModelConfig` / `providerModelToRuntimeModel` 全链路透传。默认协议仍是 `openai-completions`，
未使用该能力的既有 provider 行为完全不变（`api`/`baseUrl` 为空时一律省略，测试有断言）。

### 2.4 鉴权

- 本机调用默认 `magpie-my-learning-agent`（官方文档的 `magpie-<your-app-id>` 归因标识）。
  **首次保存留空密钥时，服务端写入该标识**，避免运行时退化成通用 `local`。
- 跨机器/正式授权可填 Magpie 网关密钥；前端**从不**接触 Magpie 上游账号凭据，也从不保存。
- 前端密钥输入框留空表示“沿用已保存密钥”，脱敏值（`****`）同样按已保存处理。

### 2.5 安全（SSRF 防护）

网关地址由用户提供且由服务端请求，因此 `normalizeMagpieGatewayUrl()`：

- 只允许 `http`/`https`，拒绝内嵌用户名/密码，只接受「协议+主机+端口（可带 `/v1`）」；
- 主机名解析后**所有**地址必须是回环 / RFC1918 / CGNAT / IPv6 ULA，公网、链路本地
  （含 `169.254.169.254` 云元数据地址）一律 `unsafe_url`；
- 请求 `redirect: "manual"`，3xx 一律拒绝，避免重定向逃逸到未校验目标；
- 超时（health 4s / models 10s）、响应体上限 1MB、`AbortSignal.timeout`。
- **保存路径同样校验**（不只是探测路径），否则配置可被写成任意内网代理供后续聊天调用。
  实测 `PUT /api/settings/providers` 用 `http://8.8.8.8:3425/v1` → 400 `unsafe_url`，`config.json` 字节不变。

### 2.6 兼容性

- `config.json` 旧格式完全兼容：`api`/`baseUrl` 均为可选新增字段，`normalizeModelConfig` 对旧文件输出不变。
- 直接 API 密钥不被覆盖：Magpie 保存只写 `providers.magpie`；实测直接厂商密钥前后一致。
- 两种方式可同时保存；切换默认模型不删除任何一侧配置；重启后恢复上次默认（实测见 5.6）。
- 子 Agent：`provider-sync.ts` 已支持 Magpie 条目（含模型级协议），其写入路径保持不变（`~/.pi/agent/models.json`）。

## 3. 自动化测试结果

命令：`npx vitest run`（仓库根目录）

```
Test Files  136 passed (136)
     Tests  1384 passed | 3 skipped (1387)
  Duration  113.53s
```

其中本轮相关：

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `src/agent/magpie.test.ts` | 15 | URL 校验、身份校验（非 200 判定）、401/403/404/429/5xx/重定向映射、密钥传递、不可达、模型 ID 原样保留、真实元数据、空列表、非法响应、按协议 base URL |
| `src/server/routes/settings.magpie.test.ts` | 8 | 服务端探测、身份错误、离线、保存/重复保存、密钥脱敏与保留、空密钥回落本地标识、公网地址拒绝且文件不变、直接↔Magpie 切换、删除（默认模型需先切换）、网关故障不动直接配置 |
| `src/agent/provider-sync.test.ts` | 2 | 子 Agent 同步含模型级协议与 base URL；不虚构字段 |
| `src/server/capability-policy.test.ts` | 17 | Magpie 端点不再落入已移除能力 |
| `web/src/react/settings/MagpieSettings.test.tsx` | 10 | 7 个原厂商入口完整保留、A/B 分区、连接成功/失败、元数据展示、ID 不被改写、手动未验证 ID、Anthropic 根 base URL、不重拉再保存保留能力、切换失败提示、已移除模型告警、使用/删除 |

新增/修改的 Magpie 相关测试合计 52 条，全部通过。

构建：`npm run build`（后端 `tsc` + 前端 `vite build`）**通过**。

## 4. 真实网关联调结果（已完成）

环境：本机 Magpie `0.1.2626` 运行于 `127.0.0.1:3425`；被测应用以 `dist/server.js` 独立进程启动，
使用一次性 `--home` / `--data-dir` / `--workspace`（不触碰真实配置与会话）。

| 步骤 | 结果 |
|---|---|
| 1. 启动 Magpie | 在线，`/api/hello` → `{"name":"magpie","version":"0.1.2626"}` |
| 2. 检测网关（经应用 API） | 200，`{"ok":true,"gateway":{"name":"magpie","version":"0.1.2626"}}` |
| 3. 拉取模型 | 200，**13 个模型**，全部字段 `confirmed`（如 `today/glm-5.3` ctx 1,000,000 / max 8,192 / reasoning / text） |
| 4. 选择并保存 | `PUT /api/settings/providers` 成功；留空密钥被存为 `magpie-my-learning-agent`（响应脱敏 `****gent`）；直接厂商密钥 `****lder` 未变 |
| 5. 发送普通学习对话 | 200，SSE 完整流：`queued → running → text_delta → done`，最终文本正常落库（`persisted:true`） |
| 6. 流式输出 | 逐 chunk 增量输出正常（`text_delta` / `thinking_delta`） |
| 7. 至少一次工具调用 | **2 次工具调用**：`get_learner_context`、`review_learner_profile`（`tool_start`/`tool_end` 成对） |
| 8. 切回直接 API | `POST /api/settings/model {deepseek, deepseek-chat}` 200，`config.json` 中 `providers.magpie` 仍完整保留 |

额外验证：

- **Anthropic 协议真实调用**：切换到 `today/glm-5.3`（`anthropic-messages` + 根 base URL），对话返回 `"2"`，无错误事件。
  这直接证明缺陷 #2 的修复在真实链路上有效。
- **重启恢复**：以同一 home 重启进程，`/api/settings` 显示 `default: deepseek/deepseek-chat`、
  `providers: deepseek,magpie`、两个 Magpie 模型的协议与 base URL 均正确恢复。
- **离线降级**：网关不可达 → 502 `unreachable`；公网地址 → 400 `unsafe_url`；失败后直接 API 配置与默认模型完全不变。

未纳入本轮：ZCode / Trae / Codex 上游账号（按任务要求不要求）。

## 5. 已知限制与遗留问题

1. **模型能力缺失时的默认值**：网关未提供 `context_window` / `max_output_tokens` 时保存为 128k / 8192 并标注未确认。
   这是保守策略，不是网关确认值；若网关后续补齐，需要重新拉取并保存才会更新。
2. **单模型切换失败不会自动回退**：`switchModel` 失败只提示错误，默认模型仍是原值（不会“半切换”）。这是既有行为，未改动。
3. **`provider-sync.ts` 无生产调用点**：该模块在本仓库内只有测试引用（既有状态，非本轮引入）。
   本次已让它正确携带 Magpie 的模型级字段，但“子 Agent 使用同一 provider”这一链路本身不属于 E3.1 范围。
4. **`Docker` 场景**：`host.docker.internal` / `gateway.docker.internal` 被显式允许（该别名在宿主机侧未必可解析，
   请求会自然失败并给出 `unreachable`）。容器内访问宿主机 `127.0.0.1` 不通属于环境限制，需用户填宿主别名或局域网地址。
5. **上游账号余额等失败是 Magpie 侧问题**：实测 `deepseek/*` 返回 `Insufficient Balance`，而 `today/*`、`copilot/auto`、
   `trae-cn/*`、`workbuddy/*`、`auto/*` 正常——本应用如实透传该错误，不做自动转投。
6. **前端未做浏览器内交互验证**：面板行为由 10 个 jsdom 测试覆盖，未在真实浏览器中手工点击验收。

## 6. E3.1 验收结论

**PASS。**

七项功能要求（双通道分区、网关检测、模型拉取、模型选择与保存、重连/刷新/删除/切换默认、双配置并存、运行时刷新）
全部实现并在真实网关上跑通；自动化测试 1384 通过、构建通过。审查中发现并修复了 5 个缺陷，其中 2 个在真实环境是阻断级的
（能力白名单 403、Anthropic 双 `/v1` 404）——这两项若只跑单元测试会被漏掉，属于本轮真实联调的主要收获。

无遗留阻断项；第 5 节 6 条均为已知限制或范围外事项。
