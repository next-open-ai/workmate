# 语音服务模块化 V1 架构

```text
voice/routes.ts（组合根）
├─ realtime-routes.ts       全双工会话与音色
├─ asr-routes.ts            单向语音输入
└─ chat-mobile/voice.ts     手机令牌范围适配

voice/settings.ts（兼容门面）
├─ realtime-settings.ts     实时通话配置
├─ asr-settings.ts          ASR 配置
└─ voice-preferences.ts     默认入口模式
```

Renderer 使用统一 `voice-services.ts` 客户端，但实时会话命令、ASR 命令与三组设置接口分别实现。组合能力接口只做状态汇总，不共享会话生命周期。

配置迁移采用 lazy migration：新文件不存在时读取旧文件并原子写入新文件；新文件一旦存在即为对应模块事实源。密钥仍只在服务端 0600 文件或环境变量中，公开 DTO 只返回掩码。
