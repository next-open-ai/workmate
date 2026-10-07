# 实时语音 V1 架构

```text
Workmate Renderer
  ├─ getUserMedia (AEC / NS / AGC)
  ├─ PCM 16 kHz 上行
  └─ PCM 24 kHz 播放
          │ Workmate 登录态
          ▼
Workmate API /api/voice/realtime/*
  ├─ 用户鉴权与会话归属
  ├─ 火山凭证托管
  ├─ 会话生命周期与 SSE
  └─ 火山 WebSocket 协议适配
          │ X-Api-Key，仅服务端
          ▼
火山实时语音 WebSocket
```

Workmate API 默认从权限为 `0600` 的本地服务端配置文件读取 API Key，设置接口只回传末四位掩码；`WORKMATE_VOLCENGINE_REALTIME_API_KEY` 可作为运维环境变量覆盖。可用 `WORKMATE_VOLCENGINE_REALTIME_URL` 覆盖上游地址；默认是火山双工实时对话地址。这条能力随 Workmate 独立部署和发布。

工作能力关联默认关闭，此时使用空工具列表。启用后仅注册四个受控工具，通过 Workmate 编排器执行独立工作会话，复用员工的 Skill、MCP 与审批规则；火山会话不直接访问用户工作区。工具结果只包含状态和产物数量，完整输出保存在工作台。详见 [工作桥接设计](./work-bridge.md)。

独立语音输入使用 `/api/voice/asr/*`，在 agent-core 中适配 SAUC binary v1 / gzip WebSocket，API 负责鉴权、归属、SSE 与容量。Renderer 采集 16 kHz PCM，识别结果全量覆盖修正，最终文字经用户确认追加到聊天草稿，不进入编排器执行。默认复用实时语音密钥；独立配置可通过 `WORKMATE_VOLCENGINE_ASR_API_KEY` 覆盖。端到端链路不创建 ASR 连接。详见 [语音输入设计](./asr-input.md)。
