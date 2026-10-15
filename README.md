# Codex WorkBuddy Suite

把国内版、国际版 WorkBuddy 模型接入 Codex 的本地套件：两个 Codex 插件、模型网关、国内每日签到、统一额度面板，以及 Windows / macOS 安装与启动工具。

每个人在自己的电脑上运行服务，登录自己的 WorkBuddy 账号。可以只用 WorkBuddy；已有 ChatGPT 登录时，可在同一模型菜单中继续选择官方模型。模型名称标注国内／国际供应商，推理档位与上下文容量来自账号实际模型目录。

> **v0.4.0**：Windows 与 macOS 可用，Linux 暂不支持。核心网关、模型路由、工具调用、ZCode 目录与并发队列均有自动测试覆盖；真实账号推理需要本机已登录对应客户端。发现问题请提供错误信息，不要发送令牌或账号文件。

## 一键安装

先安装并打开对应的官方 WorkBuddy 客户端：[国内版](https://www.codebuddy.cn/work/) · [国际版](https://www.workbuddy.ai/)。准备好账号后，在终端执行一行命令。首次安装会提示选择区域、完成登录，检测 Codex，并安装套件所需的 Node 运行环境。

**Windows：在 PowerShell 中执行**

```powershell
irm https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.ps1 | iex
```

**macOS：在终端中执行**

```bash
bash -c "$(curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.sh)"
```

安装脚本使用固定版本安装包，并检查 SHA-256。第一次启用或更新模型目录后，保存工作、完整退出 Codex，再从套件提供的启动入口打开。日常切换模型与推理强度无需重启。

完整安装、启动、模型选择、签到、额度面板与故障排查步骤见 **[使用指南](docs/USAGE.md)**。

下载与版本说明：[Releases](https://github.com/ztg-pty/codex-workbuddy-suite/releases)。仓库首次上传期间，安装脚本／Release 资源可能仍在同步；正式安装请确认对应 Release 已出现。

## 包含什么

| 组件 | 功能 |
| --- | --- |
| `codex-workbuddy-connect` | 查询两区连接、当前账号余额和模型目录 |
| `codex-workbuddy-checkin` | 国内当前账号每日签到，成功后按账号和服务端日期去重 |
| 本地模型网关 | Responses/SSE 转换、模型路由、函数和 custom 工具调用 |
| ZCode 提供方 | 复用本机已登录的 ZCode 客户端，把 GLM 系列模型加入同一模型菜单 |
| 统一额度面板 | 同页显示两区积分；有 ChatGPT 登录时显示官方额度和重置时间 |
| 安装与管理工具 | 环境检测、登录提示、后台启动、刷新、更新与配置恢复 |

## 登录与模型

- 国内和国际账号独立，可以只启用其中一个区域。
- 在官方 WorkBuddy 客户端中注册／登录，不需要把账号令牌发给任何人。
- 只用 WorkBuddy 时，本机网关生成自己的访问凭据；无需购买 ChatGPT 会员，也无需提供 OpenAI API Key。Codex 可能将这种本地鉴权显示为 API key 模式。
- 要使用官方模型，请在 Codex 中登录自己的 ChatGPT 账号，再重新执行安装流程更新连接模式。
- WorkBuddy 独占模式不会向 Codex 请求官方登录；启动入口会注入本地凭据并清除官方／中转环境变量。如果界面仍出现登录提示，请从套件启动入口重新打开。
- 国内条目标注“国内版 WorkBuddy”，国际条目标注“国际版 WorkBuddy”；官方模型显示名保留。
- 本机安装并登录 ZCode 客户端后，模型菜单会出现 `ZCode · 模型名` 条目；未登录则整条上游不显示。
- 余额、免费促销、模型列表和收费倍率由 WorkBuddy 决定。本项目不提供账号、积分或永久免费的承诺。

## 使用与管理

安装完成后使用生成的 Codex 启动入口和“统一额度”入口。面板打开时查询，页面可见时每分钟刷新，不发起模型推理。

在安装目录中，可运行：

```text
node scripts/manage.mjs status
node scripts/manage.mjs usage
node scripts/manage.mjs refresh
node scripts/manage.mjs launch
node scripts/manage.mjs stop
node scripts/manage.mjs uninstall
```

没有全局 Node 时，用安装器显示的私有 Node 路径执行上述命令。更新时重新运行一键安装命令。卸载恢复本套件管理的配置；配置已被其他操作修改时会停止并说明冲突，保留备份和现有聊天。

## 支持范围与已知限制

- Windows 10/11、macOS；Node 24+，Codex 内核 0.162+。Linux 安装会直接提示暂不支持。
- 服务仅监听本机 loopback，默认端口 `51123`；不需要部署云服务器。
- 新模型目录需要 Codex 下次启动读取。目前没有新增 WorkBuddy 原生的上下文档位选择器；采用各模型声明的最大容量。
- WorkBuddy 使用完整历史重放。远端 `/responses/compact`、`previous_response_id`、音频／文件输入及背景持久响应尚未实现；长会话可能需要新建聊天。
- WorkBuddy 不能使用 OpenAI 托管的服务端搜索；已提供的客户端／MCP 搜索工具仍可使用。
- 如果使用第三方 OpenAI 兼容中转或 cockpit 类切换工具选择 WorkBuddy 模型，本套件会检测到 `model_provider` 被改写，并在启动时自动恢复为本地网关；返回错误时会说明应为 `workbuddy_gateway`，避免被误导到中转站。
- macOS 真实账号／加密客户端版本兼容性尚待验收。请查看 Release 说明与后续补丁。

## 故障排查

运行诊断可查看登录模式、配置是否被外部工具改写、以及本地凭据是否就位：

```text
node scripts/manage.mjs doctor
node scripts/manage.mjs launch
```

`configDrift` 显示已漂移时，`launch` 会在启动前自动修复 provider 接线并保留你的其他配置。若你确实要临时使用官方或第三方中转，请在切换后不要选择 WorkBuddy 模型；这类模型只由本地网关提供。

## 数据与安全

账号凭据留在官方客户端当前登录文件／系统存储中。套件不扫描历史账号备份，不集中收集账号，不共享他人的额度。运行时和恢复数据位于当前用户的 `CODEX_HOME/workbuddy-suite`，默认是 `~/.codex/workbuddy-suite`；不要上传该目录、`auth.json` 或 `.env`。

源码和安装包不包含开发者账号、ChatGPT 凭据、余额快照或聊天记录。安装器保留现有代理配置，并为本机地址增加代理绕过，避免 localhost 请求被送进网络代理。

## 开发与反馈

```bash
npm test
node scripts/package.mjs
node scripts/release.mjs
```

测试使用合成账号与本机服务。真实模型测试、macOS 账号测试与安装验收分别记录，不把目录查询成功当作推理成功。

反馈请使用 [Issues](https://github.com/ztg-pty/codex-workbuddy-suite/issues)，附操作系统、Codex／WorkBuddy 版本、错误信息和复现步骤。请先隐藏个人账号和凭据。

## 许可证与致谢

本项目采用 MIT License。协议／认证及签到部分参考 Corrine Hu 的 `dsh-workbuddy-connect`、`dsh-buddy-checkin`，协议参考 Sliverkiss 的 `workbuddy2api`。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

这是社区本地集成，与 OpenAI、腾讯官方产品分别维护。
