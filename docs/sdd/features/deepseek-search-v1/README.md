# DSS-v1 · DeepSeek 在线搜索与共享连接

状态：已实现，专项自动化通过；真实账号与桌面人工验收未执行。2026-10-22。

官方协议：[Search & Fetch](https://api-docs.deepseek.com/guides/search)、[Search API](https://api-docs.deepseek.com/api/search)。只接入Search，不扩展Fetch或模型内置搜索。

- DSS-R1/T1：web_search增加deepseek，POST https://api.deepseek.com/v1/tools/search，Bearer鉴权，query/count/need_content=false；归一化results的title/url/summary或snippet/date/site_name，保留现有超时、脱敏、引用及权限。query按Unicode码点限制128，不静默截断；freshness用after日期语法，超出长度明确失败。401/402/429/服务异常不伪装空结果，不回显凭据。
- DSS-R2/T2：保存官方DeepSeek Provider时自动建立唯一搜索项，沿用原默认搜索和其他服务配置；搜索凭据使用providerInstanceId引用，不再保存第二份Key。运行和加载时解析最新模型连接；Key更新、删除/失效不使用陈旧Key。多连接优先保留既有引用，否则选择当前活动对话模型的DeepSeek连接，再取首个有效官方连接。自定义模型网关不自动把其Key发给DeepSeek官方。
- DSS-R3/T3：Provider及新增弹窗用小字说明“在线搜索也可用”，实际保存完成后搜索设置显示已关联连接、无需重复填Key。保存不执行联网/计费测试，不宣称服务已通过验证；仍允许搜索开关和默认Provider设置。桌面安全存储、API设置、员工偏好、会话运行及搜索工具均支持新ID。
- DSS-R4/T4：相同业务同步EasyMate并保持单Pi。旧搜索设置兼容，独立手动配置仍可使用；不迁移真实用户配置或覆盖其他未提交工作。

测试：DSS-T1请求/结果/空态/鉴权失败/码点长度/时效参数；DSS-T2关联幂等、轮换、删除、多连接、无明文重复持久化；DSS-T3真实保存与界面接线、偏好与API保密；DSS-T4两端构建、相关包测试及产品同步门禁。只用临时设置和网络桩，不消费用户真实API额度。

兼容与回滚：新增搜索ID及可选providerInstanceId；无数据库迁移。移除关联时仅影响DeepSeek搜索，其他Provider不变；旧程序不理解新增ID，回滚前关闭该搜索项并保留模型Key及配置备份。

## 验证记录

2026-10-22：

- `contracts build`、`agent-core test`：Workmate234/234、EasyMate183/183通过。新增DSS-T1/T2覆盖真实工具调用协议、引用/空结果/非法响应、401/402/429/500、码点上限和after条件，以及引用幂等/轮换/删除/禁用/多连接/代理隔离。补齐ChatRequest同时携带7个搜索Provider的契约，最后专项2/2重跑通过。
- `api test`：Workmate139通过+2跳过，EasyMate131通过+2跳过。新用例使用临时目录及Fastify，验证保存模型→自动登记搜索、文件中无第二份模型Key、搜索保存保留引用、Key轮换、keyring运行时解析及删除后不使用旧Key；不访问真实服务。
- `node scripts/deepseek-search-regression.mjs` 两端通过：执行真实renderer模型保存流程、搜索配置同步和当前员工模式；VM执行真实桌面writeSearchConfig验证仅保存引用与空Key，界面小字接线存在。测试使用stub IPC，无用户密钥或网络计费。
- 两端renderer构建（含vue-tsc）、API生产构建、desktop main语法检查、docs:build和diff检查通过。EasyMate产品身份/单Pi及57个登记模块对Workmate实时比较通过。用户手册及应用内JSON已同步。
- EasyMate API typecheck通过。Workmate API typecheck仍有既有 `voice/barge-in.test.ts:65` raw隐式any，未修改该无关测试。
- Workmate既有Provider自动配置回归通过；EasyMate该旧回归不通过：断言现有Provider编辑器包含服务选择，而其原界面尚无该功能。保留EasyMate原界面，仅增加DeepSeek提示，不为迁移此功能引入Workmate新版编辑器/密钥组件；DS专项和构建通过。过程中遇到localhost DNS及并行构建时旧contracts导出未就绪，待依赖构建完成后专项重测通过。

复现入口：`pnpm deepseek-search:regression`。未进行真实收费API、真实账号余额/权限、浏览器视觉或Electron安装态测试；保留既有bundle大小警告。本次未读取/迁移真实用户配置，不提供自动联网测试或Fetch能力。重新启动桌面/API后加载新增运行时与安全存储白名单。
