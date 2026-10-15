# v0.2.0 预发布

把国内版、国际版 WorkBuddy 模型接入 Codex 的本地套件首个可分享版本。

## 本次修复

- **WorkBuddy 独占启动**：不登录 ChatGPT 也能从套件入口启动；启动环境清除官方与第三方中转变量，避免弹出登录或回退到中转站。
- **第三方中转冲突**：cockpit 类工具改写 `model_provider` 时会被检测，启动前自动恢复本地网关接线，并保留你的其他配置；误把 WorkBuddy 模型发往中转站时返回可操作的错误说明，而不是裸 404/403。
- **运行时补丁固化**：请求体上限 16MB → 128MB；网关锁移出 WorkBuddy 守护进程写回的目录；新增 `compaction`、`agent_message` 输入支持；上游 `exec` 工具映射为 Codex 的 `shell`。

## 使用

Windows：

```powershell
irm https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.ps1 | iex
```

macOS：

```bash
bash -c "$(curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/ztg-pty/codex-workbuddy-suite/main/install.sh)"
```

## 已知限制

- 支持 Windows 与 macOS；Linux 明确不支持。
- macOS 真实账号登录与加密客户端兼容性尚待验收。
- 远端 `/responses/compact`、`previous_response_id`、音频／文件输入与背景持久响应尚未实现。

本版本共 113 项自动测试通过。
