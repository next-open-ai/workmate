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

## 6. MCP 与 Skills（员工授权注入）

每回合（非自定义 `WORKMATE_DSH_CORDIS`）会把当前 ChatRequest 里的员工 MCP / Skills 桥进 dsh：

### MCP
- 在生成的 cordis 里为每个已启用连接挂 `@deepseek-ai/dsh-mcp-client`
- `stdio` → dsh `transport: stdio`（command/args/env/cwd）
- Workmate `http` / `sse` → dsh `streamable-http`（SSE 端点为 best-effort）
- 工具名在 dsh 侧一般为 `mcp__<server>__<tool>`；prompt 会提示已连接的 server 名

### Skills
- 授权技能物化到 `DSH_CWD/.agents/skills/<kebab>/SKILL.md`（跳过平台 harness：`workmate-workspace` 等）
- cordis `agent-spine.skills.enabled: true` + `customSkillDirs` 指向物化根目录
- 模型通过 dsh 原生 `skill` 工具加载（不是 pi 的 `load_skill`）

| 文件 | 说明 |
|------|------|
| `dsh/skills-materialize.ts` | Skill → `.agents/skills` |
| `dsh/cordis-compose.ts` | MCP 插件行 + skills 配置 |
| `dsh/stream.ts` | 回合编排 |

## 7. 回归

```bash
pnpm dsh:regression
# 也作为 pnpm concurrency:regression 的前置 case
```

覆盖：cordis 注入 MCP（stdio / streamable-http）、skills.enabled + customSkillDirs、技能物化与平台 harness 跳过。

## 8. 关键路径

| 文件 | 说明 |
|------|------|
| `dsh/model-route.ts` | ModelConfig → pi-ai 路由 |
| `dsh/cordis-compose.ts` | 生成 cordis.yml |
| `dsh/stream.ts` | 启动与事件流 |
| `dsh/jsonrpc-client.ts` | stdio JSON-RPC |
| `dsh/launch.ts` | bin 发现 |
| `dsh/skills-materialize.ts` | Skills 物化 |
