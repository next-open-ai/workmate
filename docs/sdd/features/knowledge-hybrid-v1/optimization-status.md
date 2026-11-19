# KH-T5～T8 执行状态

2026-10-21；状态：已同步，相关功能工程验证通过。真实模型/桌面安装态未验收，通用并发限制见下文。

## 实际范围

同步Wiki阶段与失败详情、重新生成原资料预选、显式断点续跑、已有主题保守合并预览/更新草稿，以及离线快照评测报告。报告只在召回测试中按需加载，不参与正常查询、不自动调用模型或调参。保留Workmate品牌、端口、会话头、原库授权与其他未提交改动；EasyMate保持单Pi。不迁入独立阅读窗口、一跳扩展、本体增强、所有权迁移或统一Reranker。没有修改WorkExpert源项目。

SDD、架构说明、用户手册及应用内手册产物已同步。无新依赖/数据库表迁移；回滚入口可撤销，但必须保留新任务字段和私有检查点的兼容读写器。没有操作真实用户数据库、生产数据或真实模型。

## 分层验证

Node v22.22.1；在既有未提交工作区增量实现。两端均执行如下验证，非继承源项目结论：

| 验证 | Workmate | EasyMate |
| --- | --- | --- |
| storage test | 36/36通过 | 38/38通过 |
| orchestrator test | 112/112通过 | 108/108通过 |
| agent-core test | 232/232通过 | 181/181通过 |
| API test | 138通过、2既有跳过 | 130通过、2既有跳过 |
| knowledge:evaluation:regression | 6/6通过 | 6/6通过 |
| contracts、renderer构建与API生产构建 | 通过 | 通过 |
| API typecheck | 失败：既有voice/barge-in.test.ts:65的raw隐式any | 通过 |
| 手册回归、docs:build、diff whitespace | 通过 | 通过 |

命令：各产品 `pnpm --filter @<product>/<package> test`，`pnpm --filter @<product>/renderer build`，`pnpm --filter @<product>/api build`/`typecheck`，`pnpm knowledge:evaluation:regression`，`node scripts/user-manual-regression.mjs`，`pnpm docs:build`，`git diff --check`。保留既有bundle大小/SQLite实验提示。

- 新API专项（wiki-optimizations.test.ts）4项：真实临时SQLite恢复只重做未完成批次、私有正文不泄露、来源删除阻止续跑、模型变更拒绝、合并预览/CAS/幂等、原发布与源草稿保留。原知识API闭环同时通过。
- `node scripts/knowledge-wiki-actions-regression.mjs`：执行真实组件函数验证预选过滤、列表失败清空、确认前零启动请求、续跑失败重试复用幂等键。不是模型质量测试。
- `node scripts/knowledge-hybrid-ui-regression.mjs`：原搜索处理函数迟到响应/错误隔离和报告导出可用状态接线回归通过。
- `scripts/knowledge-optimizations-browser.mjs`：真实Vue进度/合并/报告组件、协议桩验证阶段、折叠详情、预览保存、导入导出、报告零额外API、390px布局。两端截图已检查，样式一致。不是全桌面集成E2E。agent-browser CLI缺失，按技能回退Playwright；运行时以TEST_PLAYWRIGHT_MODULE指定已安装的Playwright模块、TEST_BROWSER_PATH可指定浏览器，未安装新依赖。
- 首次组件浏览器夹具的路由前缀拦截了JS请求，修正为精确路由后运行；随后发现报告在grid布局下窄屏溢出，双端增加min-width:0并重跑通过，未放宽断言。

## 并发、同步门禁与未验证项

- Workmate首次双端同时默认端口运行遇认证失败；使用WORKMATE_API_PORT=17481运行隔离 `pnpm concurrency:regression` 后通过。
- EasyMate用EASYMATE_API_PORT=17482运行 `node scripts/concurrency-regression.mjs`（内含隔离concurrency-loadtest），退出0但Pi执行用例报模型认证失败，不记为完整并发执行验收。Wiki调度的同库互斥、取消、重复恢复等由编排专项通过验证。未为此修改无关模型/认证实现。
- EasyMate `pnpm work-results:parity` 和 `pnpm product:regression` 通过：53个已登记业务模块与实时Workmate及基线一致，保持品牌/端口/单Pi/瘦Python包装。基线原有5个Wiki文件因本次授权变更失配；逐文件核对两端归一化内容、完成上述测试后才更新，并新增9个优化模块/回归文件登记。没有单改哈希绕过差异审查。
- 未进行真实供应商质量、安装态、全应用浏览器E2E、大库性能基准或自动跑题库；没有据此宣称召回率提升或零CPU开销。离线计算只在用户显式操作时发生。
