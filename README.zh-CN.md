# My Learning Agent

个人学习 Agent 的 **v0.1.0-alpha 开发预览版**。本产品已收敛为单一学习产品：移除 full/learning 双模式切换，仅保留学习运行模式，产品名统一为 **My Learning Agent**。

## 当前功能

- 五页面学习前端：今日学习、AI 学习、练习与反馈、我的学习档案、系统设置。桌面为固定侧栏，手机上折叠为底部导航；320–1920 宽度均可用。
- 学习聊天：会话创建、切换与历史恢复，流式输出、Markdown / 代码 / 数学与图表渲染、停止生成与重连。
- 学习检查点：按会话读取公开状态、显式初始化、暂停与继续，带修订号冲突检测。权威记录保存在本机，元数据中的投影可从权威记录重建；重启后能恢复同一道题与同一修订。
- L1 学习画像、目标与偏好；按配置启用 L2/L3 查询。
- L1 串行异步保存、正式证据去重、投影恢复、历史重建及追加纠正的底层支持。
- 工具白名单与服务端接口限制：终端、通用文件操作、渠道、调度、MCP、子 Agent 等在本发行版禁用。

## 尚未实现

- 正式 AI 出题。
- 用户的练习提交与可靠评分。
- 自动学习证据生成。
- 完整的掌握状态评估闭环。
- 智能复习业务闭环。

练习页因此只提供结构占位和明确的空状态，不提供无法真正完成的「提交并评分」动作。已有的检查点存储与恢复能力**不等于**学习闭环已经打通。

## 快速开始

需要 Node.js 22 或更新版本及 npm。测试环境为 Windows / Node.js 24。

`xlsx` 依赖通过本地 tarball（`vendor/xlsx-0.20.3.tgz`）安装，该文件未纳入版本控制，克隆后需先下载：

```powershell
git clone https://github.com/livepass/My-Learning-Agent.git
cd My-Learning-Agent
New-Item -ItemType Directory -Force vendor
curl -L -o vendor/xlsx-0.20.3.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
npm ci
npm run build
New-Item -ItemType Directory -Force runtime/config
Copy-Item config.example.json runtime/config/config.json
```

将示例中的 provider 地址、模型 ID 和密钥替换为自己的配置，然后启动：

```powershell
npm start -- --home ./runtime --config-dir ./runtime/config --data-dir ./runtime/data --skills-dir ./runtime/skills --workspace ./workspace
```

访问 http://127.0.0.1:3000 。默认只监听本机回环地址。产品始终运行于学习模式；旧版 full 配置的 `profile` 字段与 `--profile` 启动参数已移除。

前端开发可运行 npm run web:dev。API 密钥只保存在本机配置中，不要提交 runtime、workspace 或个人学习数据。

## 验证

```powershell
npm run build
npx vitest run
```

保留上游 server.smoke.test.ts 作为兼容参考；它要求旧 full 接口开放，因此不属于本发行版的默认测试集合。学习专用服务由 server.learning.test.ts、server.learning-http.test.ts（真实 HTTP 端到端）及 capabilities/capability-policy 回归覆盖，其余存储、Agent 和界面回归继续运行。发布验证范围见 [预览说明](docs/ALPHA.md)。

## 来源与范围

保留上游 [MIT LICENSE](LICENSE) 及作者信息。工作区包名、部分内部模块和重型依赖沿用上游；完整依赖裁剪尚未完成，保留的内部代码不表示本发行版开放相应运行能力。

本仓库发布干净的当前源码快照，不包含开发仓库的历史、本机配置、学习数据、私人任务文档或验证截图。Electron 安装包、Docker 镜像及公网部署不在本次已验证发布范围。
