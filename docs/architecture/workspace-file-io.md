# 工作区文件读写与大文件策略

## 为什么「一次性写完」经常失败？

模型写文件不是直接写磁盘，而是：

```
模型 → tool_call JSON 参数 → JSON.parse → write_workspace_file.execute → 磁盘
```

大段文本（含引号、换行）塞进 JSON 字符串时，常见失败：

1. **控制字符 / 未转义引号** → `Bad control character` / `Expected ',' or '}'` → 工具根本进不了 execute
2. **参数过大** → provider / schema 截断 → `content` 丢失 → `Write body is empty`
3. **模型误用历史 stub** → 只传 path、不传正文 → 空 body

因此：**不是磁盘不能一次写，而是「经 LLM tool JSON 传大文本」不可靠。**

## 推荐策略（格式无关）

| 场景 | 工具 | 说明 |
|------|------|------|
| ≤ ~8KB 文本 | `write_workspace_file` + `content`（UTF-8） | 优先一次性写完；平台有 lenient JSON 修复 |
| 更大文件 / 漂亮整站 | `start` → `append(seq)` → `finish` | 内存按序拼齐，**一次**落盘（默认 replace） |
| 同一次调用多分片 | `chunks: string[]` | 按数组顺序拼接，仍是一次 write（每片 ≤4KB） |
| 逃生口 | `encoding: "base64"` | **仅** JSON 转义反复失败或近似二进制时；默认仍是 utf8 |

硬顶：单文件 **96KB**（`MAX_FILE_BYTES`）。单次 `content` schema 约 **12KB**。

**输出 token 预算**：pi 引擎 `maxTokens` 已提到 **32k**。若仍用一次 tool call 塞整站，模型输出被截断会出现 `Unterminated string`，写入根本不会执行——整站必须走分片协议。

**不做**按扩展名 / HTML / CSS 的内容特判。乱序、半截拼半截、重复整文件，一律用协议拒绝或显式 `reset`，不猜文件类型。

## JSON 修复（传输层）

`json-repair.ts` 在 tool-args `JSON.parse` 失败时依次尝试：

1. 转义字符串内裸换行/控制字符  
2. 闭合被截断的引号/括号  
3. 按字段启发式 salvage（容忍 HTML 属性里未转义的 `"`）

这是传输兜底，不是鼓励一次塞超大正文。

## 分阶段写入协议

```
start_workspace_write({ path, mode?, deliverable?, totalParts? })
  → writeId, nextSeq=1

append_workspace_write({ writeId, seq, text, total?, reset? })
  → seq 必须等于当前 nextSeq（从 1 递增）
  → total / totalParts 一旦设定不可变（除非 reset）
  → reset=true 且 seq=1：清空已收分片，从头再来

finish_workspace_write({ writeId })
  → 按 seq 顺序 join → 一次磁盘写入
  → 若声明了 totalParts 但未收齐 → 失败
```

设计要点：

1. **组装在内存，提交原子**：避免「磁盘上已是碎片 + 再 append 整文件」
2. **严格序号**：乱序直接报错，要求模型重发正确 seq 或 `reset`
3. **显式 reset**：禁止平台按内容启发式「看起来像完整文档就重启」
4. **UTF-8 为主**：base64 不进推荐路径，工具描述降级为 last resort

## 读文件

`read_workspace_file` 故意只返回约 **6KB**，防止把刚写的大文件整份灌回上下文。需要核对时读片段或用脚本检查字节数，不要整页回读。

## 上下文卫生

历史成功写入在下一轮只保留 **path**（见 `context-hygiene.md`）。分阶段 append 只保留 `writeId/seq/total/chars`，正文省略。那是「已成功」的摘要，**不是**下次 write 的参数模板。

## 工具清单

- `write_workspace_file` — 单次 / chunks /（逃生）base64
- `start_workspace_write` / `append_workspace_write` / `finish_workspace_write` — 有序分片大文件
- `read_workspace_file` — 短读
