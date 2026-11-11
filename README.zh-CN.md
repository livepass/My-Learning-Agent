# My Learning Agent

一个**在本机运行的个人学习 Agent**（开发预览版）：用大模型陪你学习，把「出题 → 作答 → 评分 → 学习证据 → 掌握状态 → 复习」串成可追溯的闭环，并按课程组织资料、学习计划与长期记忆。数据全部留在本地，通过浏览器访问 `http://127.0.0.1:3000`，不提供公网服务。本发行版只保留学习运行模式，不含上游工作台能力。

## 架构

npm workspaces 单体仓库，三个包：`apps/learning-agent`（Node.js / TypeScript 后端）、`apps/learning-agent/web`（React 19 + Vite 前端）、`electron`（桌面壳，安装包未纳入验证范围）。后端同时提供 REST / SSE 接口和构建后的静态前端，默认只监听回环地址。

| 层 | 位置 | 作用 |
| --- | --- | --- |
| HTTP / SSE | `src/server/`、`src/server/routes/` | 会话、聊天、学习者、课程、设置、知识库等接口与流式输出 |
| Agent 编排 | `src/agent/` | `pi-runner` 驱动 PI SDK 会话；学习扩展只注册学习工具白名单，能力策略拦截已移除的工作台接口 |
| 学习业务 | `src/learning/`、`src/courses/` | 题目与请求指纹、作答与评分、证据转换、检查点状态机、推荐、课程与学习计划 |
| 三层记忆 | `src/memory/learner`（L1）、`l2`（L2）、`l3`（L3） | L1 学习画像与证据账本（JSON / JSONL 文件）；L2 知识库（Markdown 分片 + SQLite FTS5）；L3 跨会话回忆（SQLite FTS5） |
| 存储 | `src/storage/` | `file-store` 统一 JSON / JSONL 持久化，`writer-lock` 保证单一写入者 |

数据落在 `--data-dir` 指定的本机目录：会话 JSONL、B2 学习记录、L1 画像与事件账本、课程状态、L2 / L3 索引，各类状态由唯一组件写入。学习闭环跨 B2 与 L1 两套存储提交，靠 `evaluated → evidence_recorded → profile_projected → completed` 状态机与幂等重放保证一致，没有分布式事务。模型通过本机 `config.json` 配置的 OpenAI 兼容 Provider 调用，密钥不出本机。

前端是单页应用：今日学习、AI 学习、练习与反馈、我的学习档案四页进入主导航，设置从顶栏进入，课程详情为二级页面；桌面固定侧栏、移动端折叠为底部导航。

## 快速开始

需要 Node.js 22 或更新版本及 npm（L2 / L3 使用 Node 内置 `node:sqlite`；开发验证环境为 Windows / Node.js 24）。`xlsx` 依赖由本地 tarball 提供，`vendor/` 未纳入版本控制，克隆后需先下载：

```powershell
git clone https://github.com/livepass/My-Learning-Agent.git
cd My-Learning-Agent
New-Item -ItemType Directory -Force vendor
curl.exe -L -o vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
npm ci
npm run build
New-Item -ItemType Directory -Force runtime/config
Copy-Item config.example.json runtime/config/config.json
```

编辑 `runtime/config/config.json`，把 `providers` 里的 `baseUrl`、`apiKey`、`models[].id` 换成自己的模型服务（OpenAI 兼容接口），并让 `defaultProvider` / `defaultModel` 指向它；`memory.l1Enabled / l2Enabled / l3Enabled` 控制三层记忆开关。然后启动：

```powershell
npm start -- --home ./runtime --config-dir ./runtime/config --data-dir ./runtime/data --skills-dir ./runtime/skills --workspace ./workspace
```

浏览器打开 http://127.0.0.1:3000 。默认只监听 `127.0.0.1`，可用 `--port` 改端口；只跑后端用 `npm run dev:server`，前端单独开发用 `npm run web:dev`。`runtime/` 与 `workspace/` 存有本机配置和学习数据，不要提交到版本控制。

## 当前功能

- **学习对话**：会话创建 / 切换 / 历史恢复、流式输出、停止生成、Markdown / 代码 / 数学与图表渲染、消息复制与编辑后分支重发、全局默认模型切换；归档 / 恢复 / 永久删除，删除当前会话时安全接管到已有会话。
- **完整学习闭环**：按知识点并结合课程资料或模型知识出题（题目持久化、幂等生成、公开题干不含参考答案与评分标准）；保存作答、模型评分与显式重新评分（重试预算、模型就绪探测、评分身份隔离）；用户确认后把评分转成 L1 正式证据并推进检查点；掌握状态投影、同一会话连续出题、基于证据的只读「下一步建议」，以及从到期推荐进入的显式复习闭环。
- **三层记忆**：L1 学习画像（目标、偏好、证据账本、掌握状态，串行异步写入与去重）；L2 课程知识库（PDF / DOCX / Markdown / TXT 上传分片、索引级来源隔离检索）；L3 跨会话回忆（按课程会话集合限定范围）。
- **课程**：课程与目标 / 资料 / 会话的显式绑定、同名知识点按课程隔离、资料上传与管理、AI 生成学习计划草稿（草稿需确认才生效）、每日跨课程任务推荐与调整建议、由任务发起或续接学习会话、按课程裁剪的上下文注入、课程详情页。
- **界面**：四页主导航 + 顶栏设置 + 课程详情，320–1920 宽度响应式；学习档案、模型连接、主题等设置。
- **能力边界**：能力策略与工具白名单只放行学习相关能力，服务端对已移除的工作台接口返回 403。

## 尚未实现

- 全局题库、跨会话复习队列、后台自动生成复习任务、定时推送与通知、个性化复习排序模型；没有 FSRS / 遗忘曲线。复习只能由用户从到期项显式发起。
- 推荐只提供导航，不会自动绑定到题目、资料或复习流程；出题、记录证据、续题、复习都需要用户显式操作。
- 掌握状态是基于证据的启发式标签，不是校准后的掌握概率，`stable` 不代表永久掌握。B2 与 L1 独立提交，没有分布式事务，崩溃后靠下一次请求幂等自愈。
- 资料格式边界：XLSX / PPTX 上传明确拒绝，扫描 PDF / OCR 未支持，DOCX 只提取正文且无页码，FTS 仍为 OR 分词，`l2_archive` 未接入正文分片。
- 历史消息编辑不支持图片 / 附件、非 Web 渠道消息与已有正式证据的会话；没有消息级模型、重新生成、分支还原、Markdown 工具栏或文件上传。
- 上游工作台能力（终端、通用文件与工作区操作、飞书 / 微信等渠道、调度、MCP、子 Agent、Office / OCR / 计算机使用、内容市场）已移除，不属于本发行版。
- Electron 安装包、Docker 镜像与公网部署未纳入已验证范围；评分链路的自动化验证使用本地合成模型服务，不代表真实生产模型的表现。

## 验证

```powershell
npm run build
npx vitest run
```

测试分 node 与 jsdom（web）两个 project，覆盖后端路由与真实 HTTP 端到端、学习状态机、证据与投影、跨进程锁、L2 / L3 检索、课程与计划，以及前端页面与 Store；学习闭环和复习闭环有真实服务进程 + 真实存储的回归测试。上游 `server.smoke.test.ts` 依赖已移除的 full 模式接口，在 `vitest.config.ts` 中被排除，不属于默认测试集合。该预览版的阶段性验证记录与明确未执行项见 [docs/ALPHA.md](docs/ALPHA.md)。

## 来源与范围

基于上游 Inno Agent，保留其 [MIT LICENSE](LICENSE) 与作者信息；工作区包名、部分内部模块与重型依赖沿用上游，完整依赖裁剪尚未完成，保留的内部代码不表示开放相应运行能力。

本仓库是当前源码快照，不包含开发历史、本机配置、学习数据或验证截图。API 密钥只保存在本机配置中；Electron 安装包、Docker 镜像与公网部署不在本次已验证发布范围。
