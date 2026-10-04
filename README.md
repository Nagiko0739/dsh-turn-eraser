# dsh-turn-eraser

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的会话工具：**删除某一轮对话**，并在轮尾**显示轮次编号**。
>
> 删除 = 把内容从**模型可见的上下文**里遮蔽掉。原始会话日志不变，随时可回溯。
>
> 使用删除后，模型在当轮会话中读取/占用的上下文是变小了的。

[English summary ↓](#english-summary)

---

## 为什么做这个

DSH 的会话记录是只追加的事件日志，本身不提供删除某一轮对话的入口。而实际使用中确实会遇到需要"擦掉"某段对话的场景：

- **上下文被污染**：某几轮让对话跑偏了，之后每轮都受影响，越聊越歪
- **发错了话**：提问打错、贴错文件
- **整理会话**：把试错的过程清理掉，留下干净的结论
- **清理过长的上下文**，防止模型上下文过重但是又暂时不想手动压缩。

本插件的特点是：**每一轮都能删（包括"空回"轮次），并且删除可追溯**。

## 功能

| 能力                           | 状态                      |
| ---------------------------- | ----------------------- |
| 删除某一轮（你的提问 + AI 的整轮输出）       | ✅ 已实现                   |
| 删除此处及以后                      | ✅ 已实现                   |
| 每轮都有删除入口（**含没有正式回答的"空回"轮次**） | ✅ 已实现                   |
| 删除后把该轮从界面上隐藏                 | ✅ 已实现                   |
| 轮尾显示「第 N 轮」编号                | ✅ 已实现                   |
| **可追溯：读回被删除的原文**            | ✅ 已实现（见下）               |
| 删除整个会话                       | ❌ 未实现                   |
| 彻底擦除（物理抹掉日志）                 | ❌ 未实现，**也不建议**（见「已知限制」） |

## 安装

**推荐：从 npm 安装**（最省事）

在 DSH 的 **设置 → 插件 → 添加插件** 里，填入包名：

```
dsh-turn-eraser
```

或者用命令行：

```bash
dsh plugin --profile <你的配置档名> add dsh-turn-eraser
```

**其他方式**：同一个输入框也支持 GitHub 仓库地址或本地目录路径。
（本插件的仓库在 `Nagiko0739/dsh-turn-eraser`。）

## 使用

**每一轮的尾部**有一个小垃圾桶图标：

1. 点它 → 浮出两个按钮：**删除本轮** / **删除此处及以后**
2. 选中哪个，哪个就变成 **再点一次确认**
3. 再点一次，才真正删除（4 秒不操作自动收起，防误触）

删除后：

- **模型**：从下一轮起再也看不到已删除的内容，只会看到一个占位符，例如 `[已删除第 20~22 轮]`
- **界面**：那一轮整体隐藏（含思考过程、工具调用的折叠块）
- **磁盘上的日志**：**原文完整保留**

## 工作原理：墓碑（tombstone）

DSH 的会话日志是"只追加"的，历史无法就地改写。所以本插件的删除是这样实现的：

> 往日志尾部**追加一条墓碑事件**，声明「把第 X 到第 Y 条事件从可见上下文里替换掉」。

原始事件仍然躺在日志里，只是**不再进入模型可见的 surface**。

> **墓碑里写什么是有讲究的**：写的是**轮次号**（如 `[已删除第 20~22 轮]`），不是内容摘要。
> 因为模型只需要知道**洞在哪**，不需要知道**洞里是什么**——而被删的**主题**本身，
> 可能正是你想让它消失的东西。

一条墓碑长这样：

```json
{
  "type": "user/message",
  "data": {
    "content": [{ "type": "text", "text": "[已删除第 20~22 轮]" }],
    "source": {
      "producer": "session-tools",
      "action": "delete",
      "removed": [1634, 1636, 1638],
      "turn": 20,
      "preview": "（被删内容的一小段预览）"
    }
  },
  "surfaceOp": { "op": "replace", "startSeq": 1634, "endSeq": 1654 },
  "sourceEventSeqs": [1634, 1636, 1638]
}
```

> ⚠️ 两个技术细节，踩过坑：
>
> 1. 墓碑必须是 `user/message`，**不能是** `assistant/message`（后者携带 `sourceEventSeqs` 会被 DSH 的写入校验拒绝）
> 2. 墓碑内容**不能为空**（严格的第三方服务商会拒绝空 user 消息）

## 可追溯：把删除的内容读回来

**这是本插件的一个设计**：删除不等于销毁。

```bash
# 列出所有会话的删除记录
python3 tools/trace_deletions.py

# 筛选 + 展开被删原文
python3 tools/trace_deletions.py <关键词> --full
```

输出示例：

```
会话 session-xxxxxxxx
  共 1 条墓碑

  墓碑 seq=1891  动作=delete  遮蔽 8 个事件
  被删内容预览：'行，咱们试试新上手的 pypdf 工具…'
  ---- 以下为原始内容（模型已看不到，日志里仍在）----
    seq=1634 [user/message]      （你的原话，完整）
    seq=1636 [assistant/message] （AI 回复正文）
    seq=1638 [tool/result]       （工具执行结果）
```

**能做与不能做**，说清楚：

| 能                     | 不能                         |
| --------------------- | -------------------------- |
| 查出"删了什么、什么时候删的、属于哪一轮" | ❌ 查不出"**谁**删的"（日志里没有操作者身份） |
| 读回被删的原文（含思考过程、工具结果）   | ❌ 不能一键撤销删除 |

## 轮次编号

垃圾桶的**右边**常驻显示这一轮的编号，例如「第 38 轮」。

编号在人和 AI 眼里是同一个数字，所以可以直接说「咱们第 38 轮说过什么？」，双方指的一定是同一轮。配合本插件的可追溯设计，AI 还能据此把那一轮的原文从会话日志里捞回来，**哪怕它早就被压缩出了上下文**。

编号取的是官方写在界面上的 `data-turn-tail` 属性（不依赖插件插槽传参）。

## 已知限制

1. **不能一键撤销**。DSH 的 surface 只有 `append` 和 `replace` 两种操作，`replace` 一旦执行，被替换的节点就从可见列表里消失了，后续事件无法把它放回去。要恢复已删除的对话，可以用「可追溯：把删除的内容读回来」一节里的 `tools/trace_deletions.py` 把原文读出来，或者直接让 agent 找回第 X 轮。
2. **可追溯不等于防篡改**。日志是明文 JSON，谁能读就能改。如果需要防篡改，得引入哈希链或外部存证——本插件没有。
3. **依赖 DSH 的界面结构**。删除入口挂在官方插槽 `conversation.chat.turnTail` 上。这是官方支持的做法，但如果 DSH 大改界面结构，插件可能需要跟进。代码里做了"读 DOM 兜底"以防万一。
4. **引用了一个官方组件库**（`@deepseek-ai/dsh-client-ui-primitives`）。官方文档并不推荐插件引用它。代码里做了**自绘兜底**：拿不到这个库时按钮依然可用，只是外观退化。
5. **"删除整个会话"尚未实现，目前也没有实现这个功能的计划**。
6. **不做物理擦除**。本插件不会去重写会话日志文件——那是高风险操作（日志有连续编号，重排出错会导致整个会话打不开）。
7. **删除只作用于当前会话**。已经在运行的子 Agent 持有自己的上下文快照，**看不到你之后的删除操作**。所以主会话里删掉的内容，正在跑的子代理**可能仍然记得**——没人会告诉它"这段已经被删了"。多 Agent 场景下请留意这一点。

## 开发与测试

零运行时依赖（安装插件不会带进任何第三方 npm 包）。

```bash
node --check index.js client.js

node tests/01-tombstone-shape.mjs      # 墓碑形状是否符合 DSH 的全部约束
node tests/02-tool-params.mjs          # 工具参数解析
node tests/03-tool-execute.mjs         # 工具执行路径（含防死锁）
node tests/04-http-entry.mjs           # 界面按钮走的 HTTP 入口
node tests/05-real-log-regression.mjs  # 真实日志回归（无日志时自动跳过）
node tests/06-client-load.mjs          # 客户端 bundle 加载
node tests/07-truncate-span.mjs        # 截断的区间计算
node tests/08-tombstone-text.mjs       # 墓碑文案的轮数统计
```

## 致谢

- **[dsh-turn-delete](https://github.com/hanshenmesen/dsh-turn-delete)**（MIT，作者 hanshenmesen）—— 「整轮删除」的思路、以及"用 DOM 兄弟遍历隐藏整轮"的做法借鉴自它。
- **[dsh-message-recall](https://github.com/kyle123740/dsh-message-recall)**（MIT）—— 墓碑写入的方式（`user/message` + `surfaceOp: replace`）参考了它，包括"占位文本不能为空"这个踩坑经验。
- **开发过程**：本项目由 **Nagiko0739**（需求、产品决策、测试、验收）与 **AI 助手**协作完成。代码主要由 AI 编写，方向与判断由人把关。
  > 依照多数司法辖区的规则，AI 生成内容不享有著作权，因此版权行只署名人类作者；AI 的贡献记在这里。

## License

[MIT](LICENSE) © 2026 Nagiko0739

---

## English summary

**dsh-turn-eraser** — a plugin for DeepSeek Harness (DSH) that deletes a conversation turn
and shows each turn's number.

Install from npm: `dsh-turn-eraser` (or add the GitHub repo / local path in the DSH Plugins page).

Deletion works by appending a **tombstone** event that hides the target range from the
**model-visible context**. The underlying session log is never rewritten, so the original
text can always be read back with `tools/trace_deletions.py`.

- ✅ Delete one turn (your prompt + the whole assistant reply), including turns with no visible answer
- ✅ Delete from this turn onward
- ✅ Every turn has a delete entry point (official `conversation.chat.turnTail` slot)
- ✅ Shows the turn number at each turn's footer (「第 N 轮」), so you and the AI can name the same turn
- 🔎 The placeholder carries **turn numbers** (e.g. `[已删除第 20~22 轮]`), not a summary — the model learns *where* the gap is, never *what* was in it
- ✅ Traceable by design — deleted content is hidden, not erased
- ❌ No "undo"; to recover content, read it back from the log
- ❌ Not tamper-proof (the log is plaintext)
- ⚠️ Deletion applies to the **current session only**: a sub-agent that is already running keeps its own context snapshot and may still "remember" deleted content

Licensed under MIT. Built by **Nagiko0739** in collaboration with an AI assistant.
