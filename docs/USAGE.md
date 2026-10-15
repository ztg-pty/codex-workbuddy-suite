# 使用指南

适用版本：v0.2.0（预发布）。支持 Windows 10/11 与 macOS，Linux 暂不支持。

## 一、准备工作

本套件把 WorkBuddy 的模型接到你本机的 Codex 上。每个人用自己的账号，服务只监听本机 `127.0.0.1`，不需要服务器。

1. 安装并打开官方 WorkBuddy 客户端：
   - 国内版：https://www.codebuddy.cn/work/
   - 国际版：https://www.workbuddy.ai/
2. 在官方客户端里**注册并登录**。可以只登录国内版，或只登录国际版，登录一个即可使用。
3. 确认已安装 Codex（桌面版或 CLI），版本 0.162 及以上。

## 二、安装

在终端执行一行命令，安装器会自动下载固定版本、校验校验和、准备独立 Node 运行环境，然后引导你完成配置。

Windows，PowerShell：

```powershell
irm https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.ps1 | iex
```

macOS，终端：

```bash
bash -c "$(curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.sh)"
```

安装时会：

1. 检测系统、Codex 版本和 WorkBuddy 客户端。
2. 询问启用哪些区域（`cn` 国内、`intl` 国际、`all` 两者）。
3. 若检测到未登录，会打开对应官方客户端并提示你先登录，然后按回车重试。
4. 写入本机网关配置、安装两个插件、注册后台服务并创建桌面入口。

安装完成后会提示你**完全退出 Codex**，再用套件生成的入口重新打开。模型目录只在启动时读取，之后日常切换模型与推理强度无需重启。

## 三、启动

- Windows：双击桌面 **Codex WorkBuddy**。
- macOS：双击桌面 **Codex WorkBuddy.command**。

这个入口会先确保后台网关已运行，再启动 Codex。

**WorkBuddy 独占模式**：不登录 ChatGPT 也能用。启动入口会注入本地凭据，并清除官方与第三方中转的环境变量，避免弹出登录或把请求发到中转站。若界面仍出现登录提示，请关闭 Codex，从套件入口重新打开。

## 四、选择模型

在 Codex 的模型菜单里可以看到三类条目：

| 显示名称 | 说明 |
| --- | --- |
| 官方模型（原名，如 GPT-6 Luna） | 走你的 ChatGPT 登录，需要已登录 |
| 国内版 WorkBuddy · 模型名 | 走国内账号 |
| 国际版 WorkBuddy · 模型名 | 走国际账号 |

推理档位与上下文容量按各账号实际模型目录显示。只有一个档位的模型不显示可调项，这是供应商声明如此。

## 五、国内每日签到

启用国内区域后，套件会在启动 Codex 时自动为当前登录的国内账号签到。以服务端日期和账号去重，当天成功后不重复提交。

查询签到状态：

```text
node scripts/manage.mjs status
```

签到只处理当前登录账号，不会用别人的额度。

## 六、查看额度

双击桌面 **WorkBuddy Usage**（Windows）或 **WorkBuddy Usage.command**（macOS），会在浏览器打开统一额度面板：

- 国内、国际 WorkBuddy 的积分余额；
- 若已登录 ChatGPT，同时显示官方 5 小时／每周额度与重置时间。

面板打开时查询，页面可见时每分钟刷新。查询只读，不发起模型推理、不签到、不充值。

## 七、日常管理命令

在套件安装目录执行：

```text
node scripts/manage.mjs status      查询运行状态与账号
node scripts/manage.mjs doctor      诊断登录模式与配置是否被改写
node scripts/manage.mjs launch      启动 Codex
node scripts/manage.mjs usage       打开额度面板
node scripts/manage.mjs refresh     重新读取账号与模型目录
node scripts/manage.mjs stop        停止后台网关
node scripts/manage.mjs uninstall   卸载并恢复配置
```

没有全局 Node 时，用安装器准备的私有 Node 路径执行上述命令。

## 八、常见问题

**不登录 Codex 无法启动，或仍要求登录**
从套件启动入口打开，不要直接启动 Codex。入口会注入本地凭据。先运行 `doctor` 确认 `authMode` 为 `local`。

**用了第三方 OpenAI 兼容中转或 cockpit 类工具后，选 WorkBuddy 模型报 404/403**
这类工具会改写 `model_provider`，把 WorkBuddy 模型误导到中转站。`launch` 会在启动前自动恢复本地网关接线，并保留你的其他配置。运行 `doctor` 查看 `configDrift`。切换工具时不要选择 WorkBuddy 模型，这类模型只由本地网关提供。

**模型菜单里没有 WorkBuddy 条目**
完全退出 Codex 后再从套件入口打开；必要时先运行 `refresh`。确认 `doctor` 的 `regions` 含你登录的区域。

**长时间会话失败或断开**
先运行 `refresh` 重建模型目录。远端会话压缩尚未实现，超长会话建议新建聊天。

**WorkBuddy 模型里没有联网搜索**
WorkBuddy 不支持 OpenAI 托管的服务端搜索；客户端或 MCP 提供的搜索工具仍可使用。

## 九、卸载与安全

```text
node scripts/manage.mjs uninstall
```

卸载会恢复本套件管理的配置，保留备份和现有聊天。若配置已被其他操作改动，会停止并说明冲突。

账号凭据保存在官方客户端里，套件不会复制或上传。请勿把 `auth.json`、`.env`、`~/.codex/workbuddy-suite` 目录或连接密钥发到公开渠道。

## 十、反馈

遇到问题请到仓库提 Issue，附上操作系统、Codex 与 WorkBuddy 版本、错误信息和复现步骤，并先隐藏个人账号与凭据：

https://github.com/ztg-pty/codex-workbuddy-suite/issues
