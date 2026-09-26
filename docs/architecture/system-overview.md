# Workmate 系统架构总览

> 详细权威文档：[全局架构](architecture.md)

```text
Desktop / Web / Message Channels
               │
          API / Gateway
               │
          Orchestrator
               │
           Agent Core
       ┌───────┼────────┐
   Providers  Tools/MCP  Sidecars
       │          │         │
    Models    Workspace   Runtimes
```

核心边界：Renderer 只通过 API/受控 IPC 使用能力；Orchestrator 管理运行状态；Agent Core 负责模型和工具循环；Contracts 定义跨包协议；API 是领域数据写入者；Sidecar 与通道通过稳定协议隔离。

专题说明从 [架构中心](README.md) 进入。
