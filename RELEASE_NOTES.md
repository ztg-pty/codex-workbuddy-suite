# v0.3.0 预发布

## 新增：ZCode 提供方

- 复用本机已登录的 ZCode 客户端凭据，把 GLM 系列模型加进同一个 Codex 模型菜单，显示为 `ZCode · 模型名`。
- 未检测到本机 ZCode 登录时，整条上游不显示，其余功能不受影响。
- 对话走 `open.bigmodel.cn` / `api.z.ai` 的 Anthropic Messages 端点；客户端请求签名（HKDF 握手 + Ed25519 + PoW）按官方客户端逐字复刻。
- 支持函数调用：OpenAI 工具与 `tool_use`/`tool_result` 双向转换。
- 思考档位通过 `output_config.effort` 下发，并映射到上游接受的取值。

## 本次修复

- 上游以 `finish_reason: "error"` 结束时（限流、模型端错误），改为按正常结束处理，保留已生成文本，不再断开流。

## 上一版内容

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
