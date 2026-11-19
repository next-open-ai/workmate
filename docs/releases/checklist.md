# Workmate 发布前回归清单

## REL-RUNNER-20261119 · 托管 runner 兼容性

- R1 / T1：Release 与 PR 打包使用固定的 `macos-15` ARM64 runner；`macos-14` 已于 2026-11-02 退役。Windows x64、两个安装器、220 MB 上限及 tag 发布语义不变，不恢复暂停的平台。
- R2 / T2：checkout v5、setup-node v5、setup-python v6 使用 Node.js 24 Action runtime；项目构建仍显式使用 Node.js 22、Python 3.11。并发回归工作流同步 Action 版本，但保留暂停状态。
- R3 / T3 / AT2：所有 setup-node 步骤显式配置 `package-manager-cache: false`，避免 v5 根据 packageManager 自动执行尚未启用的 pnpm；不得同时显式指定 `cache: pnpm`。保持 setup-node → corepack enable → pnpm --version → pnpm install 顺序。修复不升级 pnpm、不改锁文件、不降级 Action。
- AT1：`node --test scripts/release-workflows.test.mjs` 检查所有工作流无退役的有效 runner、基础 Action 版本及 CI/Release 的目标与预算一致，并检查发布门禁未移除。该检查进入 PR CI；不访问 GitHub、不触发发布。
- 验收：新提交的 tag 在 GitHub 实际产出 ARM64 DMG 与 x64 EXE 后才算云端打包验证通过。旧运行的 Re-run 使用旧提交，不能验证本次修复；不移动已发布 tag，建议发新补丁 tag。无数据迁移，回滚仅还原工作流，但不得继续使用已退役 runner。
- 范围：Workmate 发布基础设施，不是共用业务能力；本次不修改 EasyMate 发布策略或执行内核。

依据：[GitHub macOS 14 退役公告](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/)。

2026-11-19 本地验证：新增回归在修复前 0/2、修复后 2/2 通过；Ruby YAML 解析三个工作流通过，`git diff --check` 通过。未执行完整应用构建、真实 GitHub runner 打包或发布；本次只修改发布/CI 基础设施，不变更应用代码与依赖。提交后需在包含修复的新 tag 上验收两个安装器与架构。

2026-11-19 T3：只读查询 [Actions Run 44547385835](https://github.com/next-open-ai/workmate/actions/runs/44547385835) 的 check annotations，Windows 与 macOS 均在 setup-node 失败，错误为 `Unable to locate executable file: pnpm`。setup-node v5 自动识别根 packageManager 并恢复 pnpm 缓存，早于工作流中的 Corepack 激活；上一轮升级未显式关闭该新默认值。五处 setup-node 均补 `package-manager-cache: false`，原 Node 22/Corepack/锁定 pnpm 顺序保持。AT2 修复前失败、修复后全部 3/3 通过；三个 YAML 语法及解析后的五处布尔配置检查通过，diff 检查通过。未重跑远端任务、未推送或移动 tag、未进行真实发布；无应用代码或依赖变更。

## PKG-BUDGET-20261014 · 安装包体积门槛

CI 与 Release 的 macOS ARM64 安装包上限暂从200 MB调整为220 MB（十进制字节），Windows仍为220 MB；体积检查继续强制执行。暂停的Intel矩阵示例同步为220 MB，不启用该构建。验证两工作流配置一致且仍调用 `report-package-size.mjs`；实际安装包需由新提交的Actions构建验证。本次不修改压缩、运行依赖或发布逻辑；回滚仅恢复上限，无数据迁移。

## 通用

- [ ] `pnpm install`
- [ ] `pnpm web:build`
- [ ] `pnpm agentscope:smoke`
- [ ] `pnpm dsh:regression`（dsh MCP + Skills 桥接）
- [ ] `pnpm orch:smoke`
- [ ] `pnpm concurrency:regression`
- [ ] `pnpm durable-task:regression`
- [ ] `pnpm voice:ui:regression && pnpm voice:command:regression`
- [ ] `pnpm quality:console:test`
- [ ] 可选使用 `pnpm quality:console` 查看本机执行记录和日志
- [ ] 数据目录 `~/.workmate` 可正常读写

## Electron 桌面模式

- [ ] `pnpm dev` 可启动
- [ ] 可发送一轮普通对话
- [ ] 实时对话与独立语音输入分别可启动、停止，收起字幕只显示最新一句
- [ ] 关联工作完成后仅播报一次简短通知，完整结果留在当前对话
- [ ] 手机 HTTP 文字/文件入口和 HTTPS 安全语音入口说明准确
- [ ] 可触发工具审批并正常允许 / 拒绝
- [ ] `Capabilities` 页面可搜索 Skills、安装 Skills、Git 导入 Skills
- [ ] `Projects` 页面可创建项目并运行任务
- [ ] 项目文件树可显示输出文件
- [ ] 资产可归档、关联到项目、取消关联
- [ ] HTML / PDF / 图片可预览
- [ ] “用系统应用打开”可拉起本机默认软件
- [ ] “在 Finder 中显示”可定位到目标文件
- [ ] `pnpm package` 可成功产出安装包

## npm Web Launcher 模式

- [ ] `pnpm web:start` 可启动
- [ ] 首页可正常打开
- [ ] 可发送一轮普通对话
- [ ] `Capabilities` 页面可搜索 / 安装 / Git 导入 Skills
- [ ] `Projects` 页面可查看项目文件树并预览文本 / 图片 / HTML / PDF
- [ ] `Assets` 页面在导航中可见
- [ ] 资产可归档、关联、取消关联、预览
- [ ] “在新标签页打开”可正常打开资源
- [ ] “下载”返回附件下载行为
- [ ] “复制文件链接”可生成有效 URL

## AgentScope 模式

- [ ] `WORKMATE_AGENT_ENGINE=agentscope pnpm dev`
- [ ] `WORKMATE_AGENT_ENGINE=agentscope pnpm web:start`
- [ ] 无模型密钥时能优雅回落 stub echo
- [ ] `pnpm concurrency:regression` 能稳定通过，并观测到 `user-capacity / global-capacity`
- [ ] MCP 工具可出现在运行时工具集中
- [ ] `tool.approval_required` 在桌面 / Web 流程都正常

## API 抽查

- [ ] `/api/health`
- [ ] `/api/providers/*`
- [ ] `/api/skills/*`
- [ ] `/api/workspace/*`
- [ ] `/api/assets/*`
- [ ] `/api/orch/*`
