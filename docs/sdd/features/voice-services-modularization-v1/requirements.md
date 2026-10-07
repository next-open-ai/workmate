# 语音服务模块化 V1

## 目标

在不删除 Workmate 现有实时通话、语音输入和手机语音能力的前提下，将三类能力拆成可独立配置、独立失效和独立测试的模块。

- VSM-01：`voice-input` 只负责 ASR 会话、音频转写和确认后写入草稿。
- VSM-02：`realtime-conversation` 只负责全双工通话、音频播放、音色及受控工作桥。
- VSM-03：`mobile-voice` 只负责手机令牌范围内的 HTTPS、移动端音频传输和重连。
- VSM-04：设置页仍提供一个“语音服务”入口，但分别保存实时通话和语音输入配置。
- VSM-05：任何一个模块未配置、关闭或上游失败，不得阻断另外两个模块和普通文字聊天。

## 兼容与迁移

旧 `voice-realtime-settings.json` 作为只读迁移源。首次读取新配置时分别生成 `voice-realtime-settings.v2.json`、`voice-input-settings.json` 和 `voice-preferences.json`；旧文件不删除，可直接回滚。原有 `/voice/realtime/*`、`/voice/asr/*` 和手机 URL 保持兼容。
