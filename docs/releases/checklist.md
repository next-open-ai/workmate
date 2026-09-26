# Workmate 发布前回归清单

## 通用

- [ ] `pnpm install`
- [ ] `pnpm web:build`
- [ ] `pnpm agentscope:smoke`
- [ ] `pnpm dsh:regression`（dsh MCP + Skills 桥接）
- [ ] `pnpm orch:smoke`
- [ ] `pnpm concurrency:regression`
- [ ] 数据目录 `~/.workmate` 可正常读写

## Electron 桌面模式

- [ ] `pnpm dev` 可启动
- [ ] 可发送一轮普通对话
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
