# VIS-001 当前状态

M1 最小工程闭环已实现：设置模型视觉能力 → 上传原图 → Pi 主模型直接接收图文 → 回答 → 原图追问。

M2 已实现：纯文本主模型 → 统一图片理解工具（原图＋原始问题＋上下文/关注点）→ 视觉应用模型 → 主模型依据识图证据回答。新增能力须在模型配置绑定默认模型，并在员工侧开启；默认关闭，不改变主模型。见 [M2规格](M2-application-vision.md)。

验证：agent-core 108/108；orchestrator 41/41；API/Renderer 类型检查和构建；隔离 HTTP 与浏览器验证。证据见 [测试报告](../../../quality/features/image-understanding/M1-report.md)。

M2 自动化：agent-core 109/109，orchestrator 41/41；HTTP完整双路径、工具进度与追问通过。浏览器模型配置、工具回答、追问和员工关闭门禁通过，见[M2阶段报告](../../../quality/features/image-understanding/M2-report.md)。实际调用的是模型而非图片生成接口，复用已有Provider协议适配。

不支持 AgentScope/DSH 含图对话、不支持自动调度/协作者。旧配置默认不启用视觉，不改变用户主模型。当前模型能力采用显式声明，尚无型号目录自动识别。

未验证：真实厂商识图质量、Electron 粘贴、安装包跨平台；不能宣称已完成全平台产品验收。
