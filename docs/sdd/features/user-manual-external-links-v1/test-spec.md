# 用户手册外链独立窗口 v1 — 测试规范

- **MANUAL-LINK-T1**：生产构建后，手册 Provider 控制台链接仍存在。
- **MANUAL-LINK-T2**：回归脚本确认 DocsPage 调用 `openExternalBestEffort`，且只接管 HTTP(S)。
- **MANUAL-LINK-T3**：Renderer 类型检查通过。
- **MANUAL-LINK-T4**：手册独立 chunk、图片懒加载和体积约束继续通过。
