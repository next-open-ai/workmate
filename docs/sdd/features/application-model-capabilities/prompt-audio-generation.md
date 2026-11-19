# AMC-AUDIOGEN-001 · 阿里提示词音频生成

状态：已实现，mock 与构建已验证；真实歌曲效果待账号试听。日期：2026-11-05。

## 范围与契约

- R1 / T1：在现有 `tts` 应用模型中可选 `qwen-audio-3.1-tts-next`，复用阿里连接、绑定、员工授权、`model_synthesize_speech` 工具及成果登记，不新增执行引擎或自动替换原默认 TTS。
- R2 / T2：该模型的工具 `text` 为完整声音创作提示词（含风格及可选歌词），不是必须逐字朗读的文本。原样发送 `input.text_prompt`，不发送不支持的 `voice`。支持 mp3/wav/pcm、最多 3000 字符；默认 MP3，48000 Hz、双声道。仅文本首版，不实现参考音频、声音复刻、歌曲拼接或指定时长参数。
- R3 / T3：复用业务空间地址解析；官方共享域名未填写 Workspace ID 时在付费请求前报配置错误。不自动探测、不自动重试收费 POST。生成请求最长 300 秒，取消贯穿提交与下载；临时 URL 下载不携带模型密钥。保留现有 25 MB 产物上限。
- R4 / T4：模型列表对该模型隐藏默认音色，展示业务空间/提示词帮助。模型测试使用同一工具协议并可试听，错误不假报成功。实际歌曲能力以账号开通和试听为准，不承诺完整歌曲质量；官方中文音频生成文档主要列举语音、音效与环境音，控制台概览另列 music。

## 测试规格与追踪

- R11 / T11 / AT11（2026-11-06）：模型登记与能力启用分开显示。没有有效默认绑定的应用模型不注入工具，禁止为补救而绕过关闭状态或自动选择歌曲模型。手工新增首个专用模型时补默认绑定；已有绑定（包括 disabled）保持，除非用户明确选择替换。Next 卡片显示“未启用 / 已选为默认”，提供显式“用于音频创作并保存”入口，校验 Workspace 后复用正常配置保存，失败保留未保存提示；不改员工总开关、历史授权、模型提示或系统提示。回归覆盖空绑定、已有/disabled 绑定、默认替换、普通模型与 UI 保存路径。沿用 v3，无自动数据迁移；回滚只移除入口，不删除已有配置。

- R10 / T10 / AT10（2026-11-06）：Native 请求错误记录 DNS/TCP/TLS/请求发送/响应阶段、请求是否完整发出、是否开始响应及耗时；结构化诊断不包含密钥、请求正文、签名查询或 IP。异常包装保留已有错误码，不自动重放 POST、不降低 TLS 证书验证、不修改系统代理/DNS，不固定阿里公网 IP。分别验证连接建立前、提交后重置及响应体中断的阶段；网络阶段信息用于诊断，不将“未收到响应”等同“服务未计费”。未鉴权探测成功不能证明真实生成成功。

- R9 / T9 / AT9（2026-11-06）：Next 在每轮注册为 `model_generate_audio`，普通 TTS 仍为 `model_synthesize_speech`，两者沿用同一 `tts` 配置及授权。Next 工具自身标明当前模型、configured/not-tested-this-run，区分历史失败和本轮执行结果；不从旧错误推断当前不可用，不把统一音频生成等同固定文本朗读。仅匹配任务时建议使用，不硬编码歌曲意图/自动调用，不修改员工 profile、Pi 全局系统提示、历史消息或通用 shell 权限。Pi 成果事件映射覆盖新名字；模型测试 API 仍从当前模型工具取首项，不改请求 DTO。新工具名称是运行时增量，历史记录保持，旧配置 v3 不迁移。已有直接按旧工具名调用 Next 的消费者须读取本轮目录；普通 TTS 名字不变。

AT9：两产品验证 Next/普通 TTS 工具发现、模型/能力映射、关闭能力不暴露、全局指令不注入、失败缓存不跨 Run；带有历史错误的会话不依赖清空历史即可构造全新音频工具。此为确定性工具目录/状态测试，不代表 LLM 一定会选择调用或真实歌曲成功；人工多轮验收仍待执行。

- R7 / T7 / AT7（2026-11-06）：Next 长时提交使用独立 Node HTTP/1.1 请求（关闭连接复用），首次即选定传输，不在提交失败后切换传输重发；同一 300 秒截止和上层取消覆盖响应体。保留格式/大小校验，原始返回音频直接落盘，不经 ffmpeg。HTTP/1.1 仅为缓解 Undici socket 兼容性风险，不保证修复远端重置。
- R8 / T8 / AT8：TTS 网络错误返回模型 ID、无密钥 Endpoint、稳定错误码、提交结果是否未知、`retryable=false`、本轮禁止再次提交、新轮允许用户明确重试。网络错误不能证明权限或内容正确，也不能断言厂商宕机。Next 工具明确歌词须演唱、人声与伴奏，不将元音/哼鸣或算法合成伪报为模型歌曲；失败返回禁止自动降级的说明，保留用户明确同意备选方案的空间。此为模型指导，不新增全局 shell 封禁或假称可机器判断音频里是否有人唱词。

AT7：本机 HTTP 桩验证单次 POST/JSON、提前断连不重发、响应体断连/取消/超时、无密钥下载和原始字节保存。AT8：连续两次工具调用实际只提交一次、不同 Run 独立、模型 ID 可追溯，读取失败与提交未知区分、失败不生成音频文件；旧 TTS 与 ASR 回归保持。

- R6 / T6 / AT6（2026-11-06）：阿里新增/编辑连接直接展示 Workspace ID 与 Next 必填说明、默认空间实际 ID 的获取指引；已登记 Next 且未填 ID 的连接展示“Next 待配置”及配置按钮。自动配置仍登记 Next 并保留默认 TTS，结果摘要提示补填，不将登记成功表述为可调用。填好后撤下待配置提示；非阿里不提示。不解析 API Key，不联网猜测空间，不改写已有凭据；修改限于 Renderer，回滚不影响 v3 数据。

- R5 / T5 / AT5：阿里自动配置在 TTS Profile 生效时额外登记 Next 音频创作模型（无需音色）；不覆盖默认 TTS、已有手工登记、能力绑定、员工模式。不因缺少 Workspace 跳过登记，但保留运行前配置提示。仅语言/仅实时服务不添加。新增、已有连接补齐、重复运行及跨连接分别验证；不执行付费探测。沿用 v3，回滚后已登记模型仍保留，可手工删除。

- AT1 → R1/R2：模型推荐存在，普通 TTS 不变；Next 请求精确使用 text_prompt、不含 text/voice，返回音频落盘为成果，下载无密钥。
- AT2 → R2/R3：超长提示词、不支持格式、错误音色、缺业务空间在网络请求前拒绝；供应商 403、无 URL、非音频、空文件及取消不返回成功。
- AT3 → R3：请求可用 300 秒截止且不被通用 120 秒截止覆盖；无收费 POST 自动重试。
- AT4 → R4：Renderer 构建、模型测试及配置逻辑回归；Workmate 与 EasyMate 同步业务，不修改各自执行内核和已有产品差异。

## 兼容与回滚

沿用 v3 配置及 tts 契约，新增推荐项和精确模型协议分支，不迁移或改写用户配置。取消绑定该模型或选回原 TTS 即可回滚。真实收费调用与歌曲试听需要用户账号，不属于 mock 验收。

## 官方依据

- https://help.aliyun.com/zh/model-studio/audio-generation-api
- https://help.aliyun.com/zh/model-studio/audio-generation
- https://help.aliyun.com/en/model-studio/qwen-audio-3-1-tts-next

## 验证记录

2026-11-06 T11：只读核对最新新会话，Run 无工具活动；本机模型设置在该 Run 前约 13 秒保存，模型列表含 Next，但 capabilityBindings 只有 decision/realtime/embedding，没有 tts 默认绑定。员工总开关为 true，工具注册仅消费绑定，故本次配置不能提供 Next；不是本轮 POST 失败，亦不能归因于旧会话历史。未解密密钥、改写本机配置或发起收费调用。修正手工新增首个专用模型漏绑默认值，新增 Next 状态与显式绑定保存入口。已有绑定（包括 disabled）不被自动改写；旧数据须用户点击启用，不从登记模型猜测默认。

T11 验证：两端专项脚本 AT11 通过，两端 Renderer build（含 vue-tsc）通过；EasyMate parity 57 模块通过。构建后生成的手册资源与最后的小改动再次 typecheck，两端通过。额外运行 Workmate provider-auto-config-regression 失败于旧断言要求 Workspace 放在 details 内，与 T6 已批准的外置输入设计不符；本轮不放宽该历史断言。未进行真实账号生成及 Electron 点击验收，原网络重置仍待定位；不能把绑定修复等同真实音频已生成。无配置迁移，员工提示与执行内核未改，EasyMate 保持单 Pi。

2026-11-06 T10：当前请求已正确选中 Next/native HTTP/1.1，约 3 秒重置；旧错误未记录握手阶段，不能事后断言是 TLS、代理还是服务端生成故障。只读诊断发现本机 DNS 返回 198.18.0.21，路由接口 utun4；阿里公共 DoH 返回公网负载均衡地址。Node 默认 TLS/TLS1.2、curl、固定本次查询所得地址但保留原 SNI 的无 Key POST 均得到 401；公网地址同样经过 utun4，故这不是成功绕过代理的对照实验，不能证明隧道有错。没有固定 IP 到生产代码或修改用户网络配置。

T10 实现只补连接阶段可观测性，不新增代理绕行、不降级证书、不重放生成。两端 agent-core 全量测试通过（Workmate 243/243、EasyMate 192/192）；专项音频/传输 12/12，覆盖 TLS 前失败、请求已发出重置、响应体中断及隐私字段不泄露。两端 API build、EasyMate parity 57 模块及 diff 检查通过。真实鉴权后的 Next 重置尚未复现，未发起收费生成；已请求用户确认一次简短真实测试，不能将本次诊断增强标为外部故障已修复。原资产、模型配置不变，无数据迁移。

2026-11-06 T9：只读核对用户“云上某人”Run，15 项活动均为 bash/安装依赖/写文件/提交成果，没有 capability 调用事件；与前一失败 Run 属同一会话。当前应用模型开关未关闭；未读取密钥或改写配置。Pi 每轮重建工具、再载入历史，TTS 失败缓存不跨轮；所以不是本轮防重锁拦截了首次调用。历史回答的“TTS 不能唱旋律/上次断连”与旧工具名称形成了错误选路依据；缺少原始请求工具目录快照，不能以访问日志断言当时实际向 LLM 发送了哪些 Schema。

T9 验证：两端 `pnpm --filter @<product>/agent-core test` 通过（Workmate 242/242、EasyMate 191/191）；`node scripts/prompt-audio-regression.mjs` 通过，包含 Pi 新名字的成果路径和未加入 Next 局部说明到全局指令的断言。EasyMate parity 57 模块通过。确定性测试覆盖新工具目录、继承 tts 权限、普通 TTS 不变、disabled 不暴露、统一工具调用和新轮失败隔离。未改员工系统提示/历史消息/全局工具权限，未发起收费生成；真实 LLM 多轮选路与生成效果仍待验收，不声称改名即可保证模型必调。

2026-11-06 T7/T8 排障：只读核对用户指定歌曲 Run 的持久化事件，两个 `capability.started` 均为 Next；均在提交阶段网络重置，未出现成功下载/保存事件。该 Run 的 `work/sing.py` 是元音共振峰合成，不是歌词声学模型；本轮保留所有原成果和记录，不重写歌曲。附加 HTTP 访问日志没有请求体，不能从中还原当时实际提示词。未带密钥的 curl/Node HEAD 探测收到 401，证明当前域名可达，不证明付费生成已成功或账号权限正确。

两端模型协议分支以当前官方 `audio-generation-api` 为依据；Next 首次选定独立 HTTP/1.1，无失败后 POST 重放；模型返回字节原样保存的桩测试通过。两端网络失败状态与工具指导已同步，未新增全局 shell 禁令，也不声称程序能识别“是否真唱歌词”。原文件未删、模型设置未改、未读取 API Key 或进行付费生成；远端负载/代理导致的重置及实际歌曲质量仍待真实调用验收。

T7/T8 验证：Workmate `pnpm --filter @workmate/agent-core test` 241/241，EasyMate 对应命令 190/190；最后诊断文案调整后，两端 agent-core build 与 `node --test packages/agent-core/dist/test/prompt-audio-generation.test.js packages/agent-core/dist/test/speech-http.test.js` 10/10 通过。两端 API 生产构建、EasyMate parity 57 模块、`git diff --check` 通过。仅修改应用模型工具及音频传输，不改 ffmpeg、主模型或执行引擎。回滚可恢复原 Next 传输调用，已归档资产/业务配置无需迁移。

2026-11-06 T6：两端 `node scripts/prompt-audio-regression.mjs`（AT4/AT5/AT6）通过，覆盖未填/已填、无 Next、非阿里、专属端点已有空间时的提示状态、配置按钮、摘要提示与中英文文案。两端 Renderer build（含类型检查）通过；最终文案/缩进调整后重跑 Renderer typecheck。EasyMate parity 57 模块通过，无修改已有基准。未执行 Electron 人工视觉验收及真实 API；没有读取或改写用户凭据，提示不代表已开通模型。

T5 自动配置增量（2026-11-05）：两端 `node scripts/prompt-audio-regression.mjs`（AT4/AT5）及 Renderer 生产构建（含类型检查）通过，覆盖新连接同时登记、旧连接只补缺失项、幂等、手工标签/音色/绑定与关闭授权保留、服务范围、双连接及无 Workspace 登记。Workmate `node scripts/provider-auto-config-regression.mjs` 通过；EasyMate 同一旧回归仍在既有 Provider UI 断言 `providerRequiresServiceSelection(addDraft.type)` 失败（旧界面与脚本不一致，本轮未修改该界面或放宽断言）。EasyMate parity 57 模块通过。无真实配置写入或付费请求；旧用户需主动重新运行自动配置。

2026-11-05，在已有未提交业务改动的 macOS 工作区验证（不覆盖既有改动）：

- 两产品 `pnpm --filter @<product>/contracts build` 通过。
- `pnpm --filter @workmate/agent-core test`：239/239；EasyMate 对应命令：188/188。最终文案调整后，两端重新 build 并执行 `node --test packages/agent-core/dist/test/prompt-audio-generation.test.js`，均 5/5 通过。
- 两产品 `node scripts/prompt-audio-regression.mjs` 通过：推荐模型、业务空间路由、不替换原默认 TTS、音频配置/测试 UI 断言。
- 两产品 `pnpm --filter @<product>/renderer build`（含 vue-tsc）、API build、`pnpm docs:build` 通过。既有 bundle 大小提示不作为功能失败。
- EasyMate `pnpm work-results:parity` 通过，57 个已登记业务模块一致；本次音频 Adapter 两端同步，不改变单 Pi 内核，不调整既有 parity 哈希。
- `git diff --check` 通过。没有改写用户模型配置，没有新增依赖或配置版本迁移。
- 未执行真实收费 API、真实演唱效果及 Electron 人工操作验收：需要用户的开通权限和收费授权，mock 不代表已生成真实歌曲。
