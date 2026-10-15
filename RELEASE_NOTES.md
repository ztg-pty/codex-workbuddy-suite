# v0.3.1 预发布

## 本次改动

- **上下文缓存**：模型目录按 TTL 缓存（默认 60 秒），并发刷新合并为一次；目录内容未变时不再重写文件。ZCode 目录纳入同一刷新周期。
- **并行队列**：每个上游独立排队。官方模型不限流；WorkBuddy 不设并发上限；ZCode 默认最多 4 个并发，其余排队等待。队列满时返回 503 并提示稍后重试。
- **上游 429 不再透传**：被限流时按指数退避重试（最多 6 次），客户端得到的是可用的流而不是 429。额度耗尽不重试，立即返回原有含义；已在输出中的流不会重放。
- **事件循环**：实测 PoW 求解在 8 位难度下不足 1 毫秒，因此不引入 worker 线程，避免为优化而增加复杂度。

## v0.3.0 内容

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
