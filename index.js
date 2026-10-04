/**
 * dsh-turn-eraser —— 宿主侧（Host half）
 *
 * 给 DSH 补上"删除会话内容"的能力。一期提供两个操作：
 *
 *   delete   —— 删除一条消息。你自己发的提问只删它自己；AI 的回复连同它那
 *               一步发起的工具结果一起删（只删一半，下一次请求会因为"工具
 *               调用和结果对不上"而报错）。
 *   truncate —— 删除某条消息以及它之后的一切（就地截断，不新建会话）。
 *
 * 为什么不能"直接擦掉"：DSH 的会话日志是只追加的事实记录，fork、恢复、
 * 回放都从它派生。所以这里一行历史都不改写——每次操作只是往日志尾部追加
 * 一条 user/message 墓碑，带一个 surfaceOp 位置替换声明，把目标在"模型可见
 * 上下文"（surface）里的那段区间遮蔽掉。surface 是派生模型历史的唯一来源，
 * 因此被遮蔽的内容从下一轮起就不会再发给模型；而原始事件仍留在日志里，
 * 可追溯、可读回（注意：不防篡改，也不能撤销）。
 *
 * 做法参考了社区插件 dsh-message-recall（MIT，作者 kyle123740），在此致谢。
 */

import { randomUUID } from "node:crypto";

const name = "session-tools";
/** 依赖的服务：会话、Agent、本地 HTTP 服务端。缺一个插件就不激活。 */
// 这里曾经有 "tools"（2.1 期的 agent 工具需要）。2026-10-01 用户实测后决定停用
// 该功能，依赖一并去掉 —— 少一个依赖就少一个插件激活失败的可能。
// 想重新启用：把 "tools" 加回来，并恢复 apply() 里的工具注册。
const inject = ["sessions", "agents", "webServer"];

/** 界面这一侧往这里 POST。 */
const ROUTE = "/dsh-turn-eraser";
/** 写进墓碑 source.producer 的插件身份。 */
const PLUGIN_ID = "session-tools";
/** 墓碑上的占位文本。**绝不能为空**：严格的第三方服务商拒绝空 user 消息，
 *  会让整个请求 400。DeepSeek 官方线路会跳过空消息，所以这个坑只在换了
 *  服务商之后才炸——参考实现就踩过，我们直接照抄它的教训。 */
const PLACEHOLDER_TEXT = "[已删除]";
/**
 * 带规模的占位文本（2026-10-01 新增）。
 * 模型看不到事件 seq、也看不到 token 数，但能数出"轮"，所以"删了几轮"是它
 * 唯一能理解的规模单位——目的是让模型知道洞有多大，而不只是"这里有个洞"。
 * **不要带主题**：主题本身可能正是要删的内容。
 */
const placeholderText = (turns) => (turns > 0 ? `[已删除 ${turns} 轮]` : PLACEHOLDER_TEXT);
/** 墓碑的 model 标记：界面靠它识别"这条记录代表一次删除"。 */
const TOMBSTONE_MODEL = "tombstone";
/** 允许的操作。 */
const ACTIONS = new Set(["delete", "truncate", "hidden", "report", "stats"]);

/** 界面侧回传的现场数据，按会话分开存（仅供诊断，只放内存，不落盘）。 */
const clientReports = new Map();
/** 墓碑里保留的原文预览上限（按字符数）。 */
const TEXT_PREVIEW_MAX = 4000;
/** 请求体上限，防止有人往这个路由灌大数据。 */
const MAX_BODY_BYTES = 64 * 1024;

// #region 官方函数的本地等价实现
// 下面这几个函数原本来自 @deepseek-ai/ 的包，行为照抄官方源码。
// 不能直接 import 的原因见文件头的【关键约束】说明。

/** 递归冻结一个值。等价于 @deepseek-ai/dsh-util-values 的 deepFreeze。 */
function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	Object.freeze(value);
	for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
	return value;
}

/** 补一个全新 id 并深冻结。等价于 @deepseek-ai/dsh-llm 的 createMessage。 */
function createMessage(input) {
	return deepFreeze(structuredClone({ ...input, id: randomUUID() }));
}

/** 等价于 @deepseek-ai/dsh-llm 的 createUserMessage。 */
function createUserMessage(input) {
	return createMessage({ ...input, role: "user" });
}

/**
 * 等价于 @deepseek-ai/dsh-llm 的 createAssistantMessage。
 * 官方的实现会给 source 补上 `kind: "model"`，其余字段保持调用方给的。
 */
function createAssistantMessage(input) {
	return createMessage({
		role: "assistant",
		content: input.content,
		source: { kind: "model", ...input.source },
	});
}

/**
 * 等价于 @deepseek-ai/dsh-session 的 SessionId。
 * 官方实现是 brandString(id)，而 brandString 是恒等函数（只做编译期类型
 * 标记），所以运行时它就是把原字符串还回来。
 */
function SessionId(id) {
	return id;
}

/** 等价于 @deepseek-ai/dsh-session/surface 里的 SURFACE_EVENT_TYPES。 */
const SURFACE_EVENT_TYPES = new Set([
	"system/message",
	"developer/message",
	"user/message",
	"assistant/message",
	"tool/result",
]);

/**
 * 这个事件是不是"替换型"的 surface 事件。
 * 等价于官方的 isSurfaceEvent(event) && event.surfaceOp !== "append"。
 */
function isReplacementSurfaceEvent(event) {
	return (
		event !== null &&
		typeof event === "object" &&
		SURFACE_EVENT_TYPES.has(event.type) &&
		event.surfaceOp !== undefined &&
		event.surfaceOp !== "append"
	);
}
// #endregion

/** 带错误码的业务异常，界面侧据此显示中文提示。 */
class ToolsError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ToolsError";
		this.code = code;
	}
}

/** 把内容块数组里的散文拼起来，非文本块用标记占位。 */
function textOf(content) {
	const blocks = Array.isArray(content) ? content : [];
	const parts = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[图片]");
		else if (block.type === "file") parts.push(`[文件 ${block.attachment?.name ?? ""}]`.trim());
	}
	return parts.join("\n");
}

/** 读一条会话的实时日志：seq -> 事件 的映射，加上 surface 上的顺序。 */
function readSurface(session) {
	const events = session.snapshotEvents();
	const bySeq = new Map();
	for (const event of events) bySeq.set(event.seq, event);
	return { bySeq, nodes: [...session.surface.nodes] };
}

/** 一条消息在 surface 上的下标；找不到就报错。 */
function locate({ bySeq, nodes }, input) {
	if (Number.isSafeInteger(input.seq)) {
		const index = nodes.indexOf(input.seq);
		if (index === -1) {
			// 把附近的节点一并报出来：一看就知道这个序号到底在不在 surface 上、
			// 还是擦着边落在被遮蔽或被丢弃的区间里。
			const near = nodes.filter((seq) => Math.abs(seq - input.seq) <= 60);
			throw new ToolsError(
				"TARGET_NOT_FOUND",
				`序号 ${String(input.seq)} 不在模型可见上下文里（surface 共 ${String(nodes.length)} 个节点）。附近的节点：${near.length > 0 ? near.join(",") : "无"}`,
			);
		}
		return index;
	}
	// 按"第几轮"定位：取这一轮在 surface 上的第一个节点，交给 spanOf 去算整轮。
	// 空回那种消息没有 messageId 可指（界面上也没有正式回答），但轮次号一定有——
	// 这正是小垃圾桶从"AI 回复下方"挪到"轮次尾部"之后要用的定位方式。
	if (Number.isSafeInteger(input.turn)) {
		for (let index = 0; index < nodes.length; index += 1) {
			if (turnOf(bySeq, nodes[index]) === input.turn) return index;
		}
		throw new ToolsError(
			"TARGET_NOT_FOUND",
			`第 ${String(input.turn)} 轮不在模型可见上下文里（可能已经删过了）`,
		);
	}
	if (typeof input.messageId === "string" && input.messageId !== "") {
		for (let index = 0; index < nodes.length; index += 1) {
			const event = bySeq.get(nodes[index]);
			if (event === undefined) continue;
			if (event.type === "assistant/message" && event.data.message.id === input.messageId) return index;
			if (event.type === "user/message" && String(event.data.id) === input.messageId) return index;
		}
		throw new ToolsError("TARGET_NOT_FOUND", "没有找到这条消息（可能已被删除，或还没落盘）");
	}
	throw new ToolsError("INVALID_REQUEST", "需要提供 seq、turn 或 messageId");
}

/** 一条 assistant/tool 事件属于哪一步（turn:step）。 */
function stepOf(event) {
	if (event === undefined) return undefined;
	if (event.type !== "assistant/message" && event.type !== "tool/result") return undefined;
	const { turn, step } = event.data;
	return Number.isSafeInteger(turn) && Number.isSafeInteger(step) ? `${String(turn)}:${String(step)}` : undefined;
}

/**
 * 一次点击要遮蔽的 surface 区间。
 *
 * 用户提问只删它自己；AI 的回复则拥有它那一步的全部工具结果，而孤立的工具
 * 结果会破坏服务商的"调用/结果配对"，所以整整一步一起删——点哪一行都解析
 * 到同一步。
 *
 * @returns surface 下标上的闭区间 [start, end]
 */
function spanOf({ bySeq, nodes }, start) {
	const event = bySeq.get(nodes[start]);
	if (event === undefined) throw new ToolsError("TARGET_NOT_FOUND", "这条消息已不在当前上下文里");
	if (isReplacementSurfaceEvent(event)) throw new ToolsError("TARGET_NOT_FOUND", "这条消息已经删除过了");
	if (event.type === "system/message") throw new ToolsError("NOT_DELETABLE", "系统提示不能删除");
	if (event.type === "user/message") {
		// 删除你的提问 = 连同它引出的整轮 AI 输出一起删。
		// 一轮对话本来就是一个整体：单独删 AI 的某一步，只会留下"回复没了、
		// 思考还在"这种半截状态。所以入口放在提问这一边，语义只有一个：删掉
		// 这一轮。
		let turn;
		for (let index = start; index < nodes.length; index += 1) {
			const candidate = bySeq.get(nodes[index]);
			if (candidate?.type === "assistant/message" && Number.isSafeInteger(candidate.data?.turn)) {
				turn = candidate.data.turn;
				break;
			}
		}
		if (turn === undefined) return [start, start];
		let last = start;
		for (let index = start; index < nodes.length; index += 1) {
			const candidate = bySeq.get(nodes[index]);
			if (candidate === undefined) continue;
			if (candidate.type !== "assistant/message" && candidate.type !== "tool/result") continue;
			if (candidate.data?.turn !== turn) continue;
			last = index;
		}
		return [start, last];
	}

	// 一轮对话通常有好几步（每次模型调用 + 它请求的工具执行 = 一步）。如果只删
	// "正式回复"那一步，前面几步的思考和工具调用就会孤零零地留在界面上——用户
	// 看到的正是这个：回复没了，思考过程还在。所以删除 AI 消息时，把**这一轮的
	// 全部 AI 节点**一起删掉：它们本来就是同一件事的不同阶段；而且孤立的工具调用
	// 会破坏服务商的"调用/结果配对"，本来也不允许拆开删。
	const turn = event.data?.turn;
	if (!Number.isSafeInteger(turn)) {
		// 拿不到轮次号时，退回"只删这一步"的老行为。
		const step = stepOf(event);
		if (step === undefined) return [start, start];
		const one = [];
		for (let index = 0; index < nodes.length; index += 1) {
			if (stepOf(bySeq.get(nodes[index])) === step) one.push(index);
		}
		return [one[0], one[one.length - 1]];
	}
	const members = [];
	for (let index = 0; index < nodes.length; index += 1) {
		const candidate = bySeq.get(nodes[index]);
		if (candidate === undefined) continue;
		if (candidate.type !== "assistant/message" && candidate.type !== "tool/result") continue;
		if (candidate.data?.turn !== turn) continue;
		members.push(index);
	}
	if (members.length === 0) return [start, start];
	// 一轮 = 你的提问 + AI 的全部输出。按钮虽然挂在 AI 回复下方，但删的是整轮，
	// 否则又会留下"回复没了、提问还杵着"的半截状态。
	let first = members[0];
	for (let index = first - 1; index >= 0; index -= 1) {
		const candidate = bySeq.get(nodes[index]);
		if (candidate === undefined) continue;
		if (candidate.type === "user/message") {
			first = index;
			break;
		}
		// 撞到上一轮的 AI 内容，说明这轮没有提问（例如续写），就别再往前找。
		if (candidate.type === "assistant/message" || candidate.type === "tool/result") break;
	}
	const span = [first, members[members.length - 1]];
	// replace 会把整个下标区间一起遮蔽，所以区间里不能混进别的轮次的内容。
	for (let index = span[0]; index <= span[1]; index += 1) {
		const candidate = bySeq.get(nodes[index]);
		if (candidate === undefined) continue;
		if (candidate.type === "user/message") continue;
		if (candidate.type !== "assistant/message" && candidate.type !== "tool/result") continue;
		if (candidate.data?.turn !== turn) {
			throw new ToolsError("SPAN_NOT_CONTIGUOUS", "这一轮的内容和别的轮次交错在一起（可能被压缩过），没法整轮删除");
		}
	}
	return span;
}

/** 某个 seq 属于哪一轮（从它前面最近的 turn/start 读）。 */
function turnOf(bySeq, seq) {
	for (let cursor = seq; cursor >= 0; cursor -= 1) {
		const event = bySeq.get(cursor);
		if (event?.type === "turn/start") return event.data.turn;
	}
	return null;
}

/** 一条 surface 事件的机器可读标签，界面侧负责翻译成人话。 */
function labelOf(event) {
	if (event.type === "user/message") return "user";
	if (event.type === "assistant/message") return "assistant";
	if (event.type === "tool/result") return "tool";
	return "other";
}

/**
 * 在一条会话上执行操作：解析目标、算出区间、追加墓碑。
 * 对 Session 是纯操作（不查 context、不 flush），方便单独测试。
 */
function applyAction(session, request) {
	const view = readSurface(session);
	const { bySeq, nodes } = view;
	const index = locate(view, request);
	const target = nodes[index];
	const event = bySeq.get(target);
	if (event.type === "system/message") throw new ToolsError("NOT_DELETABLE", "系统提示不能删除");

	const span = request.action === "truncate" ? [index, nodes.length - 1] : spanOf(view, index);
	if (span[0] === 0 && bySeq.get(nodes[0])?.type === "system/message") {
		throw new ToolsError("NOT_DELETABLE", "系统提示不能删除");
	}

	const startSeq = nodes[span[0]];
	const endSeq = nodes[span[1]];
	const shadowed = nodes.slice(span[0], span[1] + 1);

	const kinds = [];
	const spanTurns = new Set();
	for (const seq of shadowed) {
		const removed = bySeq.get(seq);
		if (removed === undefined) continue;
		kinds.push(labelOf(removed));
		// 被遮蔽区间可能跨多轮（truncate 尤其明显），逐节点回溯它属于哪一轮。
		const spanTurn = turnOf(bySeq, seq);
		if (Number.isSafeInteger(spanTurn)) spanTurns.add(spanTurn);
	}
	const turn = turnOf(bySeq, startSeq);

	// 墓碑写成 **user/message**。这个形状是两条官方约束夹出来的唯一出路：
	//   ① `assistant/message` 只要带 `sourceEventSeqs`，写入校验立刻抛
	//      SessionFormatError（"retains obsolete chunk references"）；
	//   ② 而 `surfaceOp: replace` 又**强制要求** `sourceEventSeqs` 完整列出被
	//      遮蔽的每一个 surface 节点（"must include every shadowed surface node"）。
	//      两条合起来 = assistant/message 在本版本里根本当不了墓碑。
	//   user/message 不受 ① 限制，所以带 sourceEventSeqs 完全合法。
	//   ③ 内容必须是占位文本、**绝不能为空**：严格的第三方服务商拒绝空 user 消息，
	//      会让整个请求 400（DeepSeek 官方线路会跳过空消息，所以这坑只在换服务商后炸）。
	//   ④ source.turn / source.removed 是留给我们自己的：界面据此把整轮藏起来。
	const step = Number.isSafeInteger(event.data?.step) ? event.data.step : 0;
	const tombstoneTurn = Number.isSafeInteger(turn) ? turn : 0;
	const previewSource = event.type === "assistant/message" ? event.data?.message?.content : event.data?.content;
	const tombstone = session.append("user/message", createUserMessage({
		content: [{ type: "text", text: placeholderText(spanTurns.size) }],
		source: {
			kind: "user",
			producer: PLUGIN_ID,
			action: request.action,
			removed: shadowed,
			kinds,
			turn: tombstoneTurn,
			step,
			preview: textOf(previewSource).slice(0, TEXT_PREVIEW_MAX),
			truncated: request.action === "truncate",
		},
	}), {
		surfaceOp: { op: "replace", startSeq, endSeq },
		// 必须恰好是"被遮蔽的 surface 节点"，一个不能多、一个不能少——官方逐个核对。
		sourceEventSeqs: shadowed,
	});

	return {
		action: request.action,
		seq: tombstone.seq,
		turn: tombstoneTurn,
		removed: shadowed,
		kinds,
		targetSeq: target,
	};
}

/** 在一条实时会话上执行操作并落盘。 */
async function handle(ctx, agent, request) {
	const session = agent.session;
	if (ctx.get("sessions").get(session.id) !== session) {
		throw new ToolsError("SESSION_NOT_LIVE", `会话 "${String(session.id)}" 已经不在运行了`);
	}
	const value = applyAction(session, request);
	await ctx.get("sessions").flush(session);
	return value;
}

/**
 * 在 Agent 的维护锁里执行一段"改动会话"的操作，保证不会插进正在跑的步骤中间。
 *
 * 传的是任务函数而不是 request，因为现在有两个调用者：HTTP 路由（界面按钮）
 * 和 agent 工具，两者要做的事不同，但都需要同一把锁。
 */
async function runUnderMaintenance(ctx, agent, job) {
	/** 任务体是否真的开始跑了——用来区分"锁没拿到"和"锁内出错"。 */
	let entered = false;
	try {
		return await agent.runMaintenance((signal) => {
			entered = true;
			signal.throwIfAborted();
			return job();
		});
	} catch (error) {
		if (error instanceof ToolsError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		// 任务体已经跑起来了 = 锁是拿到的，错在我们自己（写日志失败之类）。
		// 这种情况必须原样报出来，不能再伪装成"任务正在运行"——上次就是
		// 被这层伪装盖住了真凶，白查半天。
		if (entered) throw new ToolsError("INTERNAL", message);
		throw new ToolsError("AGENT_BUSY", message);
	}
}

/**
 * 收集本插件墓碑遮蔽掉的所有"轮次:步骤"。
 *
 * 界面侧刷新之后，它自己的事件窗口可能只加载了最近一段，反查不出老消息的
 * 序号；而宿主这边始终握着完整日志，所以由这里把"哪些步已经被删掉"算好
 * 交给它。旧墓碑同样算得出来——它们的 `source.removed` 记着被遮蔽的序号。
 */
function collectHidden(session) {
	const events = session.snapshotEvents();
	const bySeq = new Map();
	for (const event of events) bySeq.set(event.seq, event);
	const turns = new Set();
	const steps = new Set();
	/** 把一个被遮蔽的事件序号换算成"轮次"（顺带记下轮次:步骤）。 */
	const absorb = (seq) => {
		const target = bySeq.get(seq);
		if (target === undefined) return;
		const { turn, step } = target.data ?? {};
		if (!Number.isSafeInteger(turn)) return;
		turns.add(turn);
		if (Number.isSafeInteger(step)) steps.add(`${String(turn)}:${String(step)}`);
	};
	for (const event of events) {
		const message = event.data?.message;
		// 新格式墓碑：assistant/message + source 上的插件标记。
		// 它自带 `data.turn`（就是被删的那一轮），另外 `sourceEventSeqs` 记着
		// 真正被遮蔽的序号——truncate 一次遮好几轮，就靠它把后续轮次也补上。
		const isTombstone =
			event.type === "assistant/message" &&
			message?.source?.provider === PLUGIN_ID &&
			message?.source?.model === TOMBSTONE_MODEL;
		if (isTombstone) {
			if (Number.isSafeInteger(event.data.turn)) turns.add(event.data.turn);
			const origins = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
			if (origins.length > 0) {
				for (const seq of origins) absorb(seq);
			} else if (event.surfaceOp !== null && typeof event.surfaceOp === "object") {
				// 没记来源时退回 surfaceOp 区间（端点是事件 seq，不是数组下标）。
				const { startSeq, endSeq } = event.surfaceOp;
				if (Number.isSafeInteger(startSeq) && Number.isSafeInteger(endSeq)) {
					for (let seq = startSeq; seq <= endSeq; seq += 1) absorb(seq);
				}
			}
			continue;
		}
		// 旧格式墓碑：user/message + source.producer，遮蔽范围记在 source.removed。
		if (event.type === "user/message" && event.data?.source?.producer === PLUGIN_ID) {
			const removed = Array.isArray(event.data.source.removed) ? event.data.source.removed : [];
			for (const seq of removed) absorb(seq);
		}
	}
	return { turns: [...turns].sort((left, right) => left - right), steps: [...steps] };
}

//#region Agent 工具（2.1 期）
// 让 AI 直接执行删除：用户说"删掉第 45 轮"，模型调用这个工具就完成，不用点按钮。
// 官方文档管这叫"一个操作，两个调用者"——界面按钮和 agent 工具共用同一套
// applyAction，绝不维护第二份逻辑。

/** 工具名。 */
const TOOL_NAME = "session_tools_delete_turns";

/** 列出会话里所有"已经结束"的轮次号（升序）。当前还没跑完的那一轮不在其中。 */
function completedTurns(session) {
	const started = new Set();
	const ended = new Set();
	for (const event of session.snapshotEvents()) {
		const turn = event.data?.turn;
		if (!Number.isSafeInteger(turn)) continue;
		if (event.type === "turn/start") started.add(turn);
		if (event.type === "turn/end") ended.add(turn);
	}
	return [...started].filter((turn) => ended.has(turn)).sort((left, right) => left - right);
}

/** 某一轮在模型可见上下文（surface）里的第一个节点 seq。 */
function firstSurfaceSeqOfTurn(session, turn) {
	const { bySeq, nodes } = readSurface(session);
	for (const seq of nodes) {
		if (turnOf(bySeq, seq) === turn) return seq;
	}
	return null;
}

/** 把工具参数翻译成"要删哪几轮"。参数不合法时抛出带原因的 ToolsError。 */
function planTurnDeletion(session, args) {
	const done = completedTurns(session);
	if (done.length === 0) throw new ToolsError("TARGET_NOT_FOUND", "这个会话还没有已完成的轮次");
	const rawFrom = args?.from;
	const from =
		rawFrom === "latest" || rawFrom === undefined || rawFrom === null ? done[done.length - 1] : Number(rawFrom);
	if (!Number.isSafeInteger(from)) throw new ToolsError("INVALID_REQUEST", 'from 必须是轮次号，或 "latest"');
	const rawTo = args?.to;
	let to = from;
	if (rawTo === "end") to = done[done.length - 1];
	else if (rawTo !== undefined && rawTo !== null) {
		to = Number(rawTo);
		if (!Number.isSafeInteger(to)) throw new ToolsError("INVALID_REQUEST", 'to 必须是轮次号，或 "end"');
	}
	const low = Math.min(from, to);
	const high = Math.max(from, to);
	const picked = done.filter((turn) => turn >= low && turn <= high);
	if (picked.length === 0) {
		throw new ToolsError(
			"TARGET_NOT_FOUND",
			`没有第 ${String(low)}${low === high ? "" : `~${String(high)}`} 轮。这个会话已完成的轮次是 ${String(done[0])}~${String(done[done.length - 1])}`,
		);
	}
	return picked;
}

/**
 * 逐轮写墓碑。
 *
 * 为什么不用一次 truncate 覆盖整个范围：truncate 会一直删到 surface 末尾，
 * 而"末尾"可能包含**当前还没跑完的这一轮**——那等于删掉正在进行的对话。
 * 逐轮删只碰已完成的轮次，安全。
 */
function deleteTurns(session, turns) {
	const removed = [];
	const skipped = [];
	for (const turn of turns) {
		const seq = firstSurfaceSeqOfTurn(session, turn);
		if (seq === null) continue;
		try {
			removed.push(applyAction(session, { action: "delete", seq }).turn);
		} catch (error) {
			// 这一轮已经有内容被删过（或目标失效）时不要中断整批——否则删一批
			// 范围只要撞上一个删过的轮次就整个失败，剩下的永远删不掉。
			if (error instanceof ToolsError && (error.code === "TARGET_NOT_FOUND" || error.code === "NOT_DELETABLE")) {
				skipped.push(turn);
				continue;
			}
			throw error;
		}
	}
	return { removed, skipped };
}

/** 工具定义。写成工厂函数是为了闭包住 ctx。 */
function makeToolDefinition(ctx) {
	return {
		name: TOOL_NAME,
		description:
			"删除当前会话里的若干轮对话。删除是在你（模型）可见的上下文里遮蔽这些轮次，" +
			"原始记录仍留在会话日志中，可追溯、可读回，所以删完之后你自己也看不到它们了。" +
			'from：起始轮次号（整数），或字符串 "latest" 表示最后一个已完成的轮次。' +
			'to：省略 = 只删 from 这一轮；给整数 = 删到该轮（含）；给 "end" = 从 from 一路删到最后一轮。' +
			'轮次号就是界面上每轮对话的编号，也就是用户口中的"第 XX 轮"。',
		parameters: {
			type: "object",
			properties: {
				from: { description: '起始轮次号（整数），或 "latest"（最后一次已完成的对话）' },
				to: { description: '结束轮次号（整数，含）；省略 = 只删 from 这一轮；"end" = 删到最后一轮' },
			},
			required: ["from"],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				properties: {
					turns: { type: "array", items: { type: "integer" }, description: "被删除的轮次" },
					queued: { type: "boolean", description: "true = 会话正忙，已排队等它空闲后执行" },
				},
				required: ["turns"],
				additionalProperties: false,
			},
			render: (_args, value) => {
				const turns = Array.isArray(value?.turns) ? value.turns : [];
				const list = turns.join("、");
				const queued = value?.queued === true;
				return [
					{
						type: "text",
						text: queued
							? `已排队：本轮对话结束后删除第 ${list} 轮`
							: `已删除第 ${list} 轮（模型上下文里已遮蔽，界面刷新后消失）`,
					},
				];
			},
		},
		execute: async (args, exec) => {
			const agent = exec?.agent;
			if (agent === undefined || agent === null) {
				throw new ToolsError("SESSION_NOT_LIVE", "这个工具只能在某个会话里调用");
			}
			const session = agent.session;
			const turns = planTurnDeletion(session, args);
			const job = async () => {
				const outcome = deleteTurns(session, turns);
				await ctx.get("sessions").flush(session);
				return outcome;
			};
			try {
				const outcome = await runUnderMaintenance(ctx, agent, job);
				return { turns: outcome.removed, skipped: outcome.skipped, queued: false };
			} catch (error) {
				if (!(error instanceof ToolsError) || error.code !== "AGENT_BUSY") throw error;
				// 会话正忙 —— 等价于"模型正在跑这一轮、顺手要删自己的内容"。
				// 工具调用必然发生在 agent 运行期间，所以这是常态，不是异常。
				//
				// 【为什么不再排队】下面三种"等它闲下来"的做法都在真机上试过，
				// 全都没能执行（表现都是"排上队，然后什么都不发生"）：
				//   · whenIdle() 等 Promise —— 轮不到；
				//   · ctx.on("turn/end")   —— 事件压根没派发过来；
				//   · 定时泵每 3 秒轮询      —— 也没等到执行。
				// 失败还会被 catch 静默吞掉，所以连错误都看不见。
				// 于是改成直接改。安全性由两条硬保证兜住：
				//   ① 只动"已经结束"的轮次 —— planTurnDeletion 已用 completedTurns
				//      过滤过，碰不到正在进行的这一轮，不存在"删掉自己脚下的台阶"；
				//   ② 写墓碑是纯追加 + flush，不改写任何已有事件。
				const outcome = await job();
				return { turns: outcome.removed, skipped: outcome.skipped, queued: false };
			}
		},
	};
}
//#endregion

//#region HTTP

/** 读完整个请求体，超过上限直接拒绝。 */
function readJson(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		request.on("data", (chunk) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				reject(new ToolsError("INVALID_REQUEST", "请求体过大"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new ToolsError("INVALID_REQUEST", "请求体不是合法 JSON"));
			}
		});
		request.on("error", (error) => reject(new ToolsError("INVALID_REQUEST", error instanceof Error ? error.message : String(error))));
	});
}

/** 校验请求体，返回规范化的输入。 */
function decodeInput(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ToolsError("INVALID_REQUEST", "请求体必须是一个 JSON 对象");
	}
	const action = value.action;
	if (!ACTIONS.has(action)) throw new ToolsError("INVALID_REQUEST", `不支持的操作 "${String(action)}"`);
	const sessionId = value.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") throw new ToolsError("INVALID_REQUEST", "缺少 sessionId");
	// 只读查询 / 诊断回传：都不需要指明操作目标。
	if (action === "hidden" || action === "report" || action === "stats") {
		return { action, sessionId, target: {}, payload: value.payload };
	}
	const target = value.target;
	if (target === null || typeof target !== "object" || Array.isArray(target)) {
		throw new ToolsError("INVALID_REQUEST", "缺少 target");
	}
	return { action, sessionId, target };
}

function sendJson(response, status, value) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

const STATUS_BY_CODE = {
	AGENT_BUSY: 423,
	SESSION_NOT_LIVE: 409,
	TARGET_NOT_FOUND: 409,
	NOT_DELETABLE: 409,
	SPAN_NOT_CONTIGUOUS: 409,
	INVALID_REQUEST: 400,
};

async function handleRequest(ctx, request, response) {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	const contentType = request.headers?.["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
		sendJson(response, 415, { ok: false, error: { code: "INVALID_REQUEST", message: "需要 application/json" } });
		return;
	}
	try {
		const input = decodeInput(await readJson(request));
		// 诊断回传：界面把它看到的现场（每一行的类型、有没有被藏起来）送回宿主，
		// 存在内存里，方便从宿主这一侧读出来定位渲染问题。
		if (input.action === "report") {
			clientReports.set(input.sessionId, { at: Date.now(), payload: input.payload ?? null });
			sendJson(response, 200, { ok: true, value: { stored: true } });
			return;
		}
		if (input.action === "stats") {
			sendJson(response, 200, {
				ok: true,
				value: { reports: [...clientReports.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })) },
			});
			return;
		}
		// 只读查询：告诉界面"哪些步骤已经被删了"，界面据此把对应的行藏起来。
		// 这条路径不碰日志，所以不需要 Agent 的维护锁。
		if (input.action === "hidden") {
			const session = ctx.get("sessions")?.get(SessionId(input.sessionId));
			if (session === undefined) {
				throw new ToolsError("SESSION_NOT_LIVE", "这条会话当前没有在运行，先打开它再操作");
			}
			// 界面拿着这份"已删除的轮次"清单，把对应的整轮藏起来。
			// turns 是整轮号（界面用它隐藏），steps 是轮次:步骤（旧版界面用）。
			const hidden = collectHidden(session);
			sendJson(response, 200, { ok: true, value: { turns: hidden.turns, steps: hidden.steps } });
			return;
		}
		const agent = ctx.get("agents")?.get(SessionId(input.sessionId));
		if (agent === undefined) {
			throw new ToolsError("SESSION_NOT_LIVE", "这条会话当前没有在运行，先打开它再操作");
		}
		// 变量别叫 request：handleRequest 的第一个参数就叫这个名字，在同一函数体里
		// 再声明一个同名 const 会让上面所有对 request 的访问落进暂时性死区，直接抛
		// "Cannot access 'request' before initialization"。（踩过，2026-09-30）
		const plan = { action: input.action, ...input.target };
		const value = await runUnderMaintenance(ctx, agent, () => handle(ctx, agent, plan));
		sendJson(response, 200, { ok: true, value });
	} catch (error) {
		const code = error instanceof ToolsError ? error.code : "INTERNAL";
		sendJson(response, code === "INTERNAL" ? 500 : (STATUS_BY_CODE[code] ?? 400), {
			ok: false,
			error: { code, message: error instanceof Error ? error.message : String(error) },
		});
	}
}

//#endregion

/** 一个进程里只登记一条路由，谁先挂上算谁的。 */
let routeClaimed = false;

function apply(ctx) {
	// 两条入口各自独立注册：缺了 webServer 不该连 agent 工具也一起没有。
	const webServer = ctx.get("webServer");
	if (webServer !== undefined) {
		// 这里传的是一个 thunk（做登记、返回清理函数）。cordis 会执行它并保存
		// 返回值用于卸载；如果直接把清理函数传进去，插件刚启动就会被注销掉。
		ctx.effect(
			() => {
				if (routeClaimed) return;
				routeClaimed = true;
				const release = webServer.register({
					kind: "exact",
					path: ROUTE,
					handler: (request, response) => handleRequest(ctx, request, response),
				});
				return () => {
					routeClaimed = false;
					release();
				};
			},
			"session-tools: HTTP route",
		);
	}

	// 【2.1 期 agent 工具：已停用（2026-10-01，用户实测后决定）】
	// 实现完整保留在 makeToolDefinition 里，随时可恢复：把下面几行放回去，
	// 并把 "tools" 加回 inject。
	// 停用经过：① 排队等空闲（whenIdle / turn-end / 定时泵）三种方式在真机上都不执行；
	// ② 改为直接执行后，用户实测仍不理想（具体现象未记录）。
	// 界面上的小垃圾桶（一期）工作正常，日常够用。
	//
	// const tools = ctx.get("tools");
	// if (tools !== undefined) {
	// 	ctx.effect(() => tools.register(makeToolDefinition(ctx)), "session-tools: agent tool");
	// }
	// 【这里原本有一个"排队 + 定时泵"，2026-10-01 删掉了】
	// 它想解决的问题是：工具调用必然发生在 agent 运行期间，那时拿不到维护锁。
	// 但三种唤醒方式（whenIdle / turn-end 事件 / 定时泵）在真机上都没能执行，
	// 失败还被静默吞掉，表现就是"排上队、永远不删"。
	// 现在改为在工具里直接执行（见 makeToolDefinition 的 execute），
	// 安全性由"只删已完成的轮次 + 纯追加写"保证。
}

export {
	ToolsError,
	handleRequest,
	PLACEHOLDER_TEXT,
	ROUTE,
	TOOL_NAME,
	apply,
	applyAction,
	collectHidden,
	completedTurns,
	firstSurfaceSeqOfTurn,
	inject,
	makeToolDefinition,
	name,
	planTurnDeletion,
	spanOf,
	textOf,
};
