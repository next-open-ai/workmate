# DeepSeek Harness（dsh）编码 Sidecar

> 状态：ExecutionBackend `dsh` 已注册；按 **Workmate ModelConfig** 生成 `llm-pi-ai` cordis。  
> 抽象层见 [execution-backend.md](execution-backend.md)。

## 1. 角色

| 引擎 | 用途 |
|------|------|
| `pi` | 默认日常对话 |
| `agentscope` | 通用 Python sidecar 池 |
| **`dsh`** | **编码专用**：bash/fs/edit 等 harness 工具链 |

## 2. 模型怎么接（重要）

默认**不再**锁死 DeepSeek adapter。每回合会：

1. 读取本回合 `ChatRequest.model`（即 Workmate 已配置并选中的连接）
2. 映射为 pi-ai 手写路由 `provider: workmate`
3. 写出 `.workmate-dsh.cordis.yml`（挂 `@deepseek-ai/dsh-llm-pi-ai`）
4. 把 key 放进环境变量 `WORKMATE_DSH_API_KEY`（以及 OPENAI_/ANTHROPIC_/DEEPSEEK_ 别名）
5. JSON-RPC `initialize({ provider: 'workmate', model: chatModel })`

| Workmate `provider` | dsh 协议 | baseUrl |
|---------------------|----------|---------|
| `openai` | openai-completions | 设置值或 `https://api.openai.com/v1` |
| `anthropic` | anthropic-messages | 设置值或 `https://api.anthropic.com` |
| `deepseek` | openai-completions | 设置值或 `https://api.deepseek.com` |
| `ollama` | openai-completions | 设置值或 `http://127.0.0.1:11434/v1`（key 可空→`ollama`） |
| `qwen` / `openai-compatible` | openai-completions | **必须**在设置里填 baseUrl |
| `google` | openai-completions | **必须**填 OpenAI 兼容网关 baseUrl（原生 Gemini 协议未接入手写路由） |

逃脱舱：设置 `WORKMATE_DSH_CORDIS=/path/to/custom.cordis.yml` 则跳过生成，仍会注入上述凭据别名；自定义 composition 需自行提供可 `initialize` 的 provider 路由（建议仍用 `workmate`）。

## 3. 启用

```bash
export WORKMATE_AGENT_ENGINE=dsh
# 可选：WORKMATE_DSH_ROOT=...  WORKMATE_DSH_BIN=...
pnpm dev
```

或 `streamAgentReply(req, { preferCoding: true })`。

## 4. 体积

- Workmate 内仅薄桥（KB 级），**不**把 harness monorepo 打进安装包。
- Runtime 外置（sibling / `WORKMATE_DSH_BIN`）。

## 5. 关键路径

| 文件 | 说明 |
|------|------|
| `dsh/model-route.ts` | ModelConfig → pi-ai 路由 |
| `dsh/cordis-compose.ts` | 生成 cordis.yml |
| `dsh/stream.ts` | 启动与事件流 |
| `dsh/jsonrpc-client.ts` | stdio JSON-RPC |
| `dsh/launch.ts` | bin 发现 |
