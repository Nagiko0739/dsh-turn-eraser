/**
 * dsh-turn-eraser —— 界面侧（Client half）
 *
 * 界面上一共两样东西：
 *
 * ① **一个常驻的小垃圾桶**，挂在官方"AI 回复操作栏"插槽里，和复制/赞/踩
 *    同一排。点它，会在旁边浮出我们自绘的两个按钮：**删除本轮** /
 *    **删除此处及以后**；选中哪个哪个就变成"再点一次确认"，再点一下才
 *    真删。全程不操作的话，4 秒后面板自己收起。
 *
 * ② **一个隐藏的轮尾标记**。宿主会告诉界面"哪些轮次已经被删掉了"，被删的
 *    那一轮就会在自己的轮尾渲染出这个标记；标记顺着 DOM 往前找兄弟行，
 *    把整轮一起藏起来，并用 MutationObserver 盯着后续变化。
 *
 * ② 的做法借鉴了社区插件 dsh-turn-delete（MIT，作者 hanshenmesen）：它不碰
 * 日志序号，纯靠 DOM 的"这一轮的行就在轮尾前面"这层结构关系——我们之前用
 * 序号匹配踩过的坑（空回没有锚点、刷新后事件窗口不全、容器藏不住）它一个
 * 都遇不到。
 *
 * 官方文档不建议插件引用 `@deepseek-ai/dsh-client-ui-primitives`（"它们随时
 * 会变"）。这里用它是为了拿到和原生完全一致的外观，风险已知并接受。
 */

window.__ModuleLoader__.load({
	id: "dsh-turn-eraser",
	factory(require) {
		const React = require("react");
		const { useEffect, useLayoutEffect, useRef, useState } = React;
		// 官方组件库能拿到就用（外观和原生完全一致）；万一拿不到——比如它改了
		// 包名、或者 DSH 没把模块喂给插件——就退回自绘，至少保证按钮照常出现、
		// 功能照常可用，而不是整块界面代码加载失败、按钮彻底消失。
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? null;
		} catch {
			primitives = null;
		}
		const IconTrashOutline16 = primitives?.IconTrashOutline16 ?? FallbackTrashIcon;
		const Tooltip = primitives?.Tooltip ?? FallbackTooltip;

		const NS = "session-tools";
		const ROUTE = "/dsh-turn-eraser";
		const BUILD = "2026-10-04.2";
		/** 浮出的面板多久没动作就自己收起。 */
		const AUTO_CLOSE_MS = 4000;

		/** 兜底垃圾桶图标（自绘 SVG），只在官方组件库不可用时上场。 */
		function FallbackTrashIcon() {
			return React.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("path", {
					d: "M2.8 4.1h10.4M6.4 4.1V2.7h3.2v1.4M4.5 4.1l.6 9.2h5.8l.6-9.2M6.6 6.7v4.3M9.4 6.7v4.3",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
			);
		}

		/** 兜底提示：退化成浏览器原生 title。 */
		function FallbackTooltip(props) {
			return React.createElement(
				"span",
				{ title: props.label, style: { display: "inline-flex" } },
				props.children,
			);
		}

		// #region 文案
		const zh = {
			"action.open": "删除这一轮对话",
			"action.delete": "删除本轮",
			"action.truncate": "删除此处及以后",
			"action.arm": "再点一次确认",
			"action.busy": "运行中…",
			"error.AGENT_BUSY": "任务正在运行，等它结束（或先点停止）再删。",
			"error.TARGET_NOT_FOUND": "这一轮已经不在了，或早被删过。",
			"error.SESSION_NOT_LIVE": "这条会话当前没有在运行，先打开它再操作。",
			"error.SPAN_NOT_CONTIGUOUS": "这一轮和别的内容交错（可能被压缩过），没法整轮删除。",
			"error.INTERNAL": "服务端出错了，请看 DSH 的日志。",
			"error.generic": "操作失败：{message}",
			"error.NO_TURN": "读不到这一轮的编号，刷新页面后再试。",
			"turn.label": "第 {turn} 轮",
		};
		const en = {
			"action.open": "Delete this turn",
			"action.delete": "Delete turn",
			"action.truncate": "Delete onward",
			"action.arm": "Click again to confirm",
			"action.busy": "Running…",
			"error.AGENT_BUSY": "Wait for the task to finish before deleting.",
			"error.TARGET_NOT_FOUND": "This turn is gone, or was already deleted.",
			"error.SESSION_NOT_LIVE": "This session is not running; open it first.",
			"error.SPAN_NOT_CONTIGUOUS": "This turn is interleaved (likely compacted) and cannot be removed as a whole.",
			"error.INTERNAL": "The server failed; check the DSH logs.",
			"error.generic": "Operation failed: {message}",
			"error.NO_TURN": "Could not read this turn's number; refresh the page and retry.",
			"turn.label": "Turn {turn}",
		};

		function fill(text, slots) {
			if (!slots) return text;
			let out = text;
			for (const [key, value] of Object.entries(slots)) out = out.split(`{${key}}`).join(String(value));
			return out;
		}

		/** 中文环境用中文，明确是英文才用英文——拿不到语言时按中文走。 */
		function tableFor(active) {
			if (typeof active !== "string") return zh;
			return active.toLowerCase().startsWith("en") ? en : zh;
		}
		// #endregion

		// #region 与宿主通信
		async function rpc(body) {
			const response = await fetch(ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			let envelope = null;
			try {
				envelope = await response.json();
			} catch {
				envelope = null;
			}
			if (envelope === null || typeof envelope !== "object") {
				throw Object.assign(new Error(`HTTP ${String(response.status)}`), { code: "INTERNAL" });
			}
			if (envelope.ok !== true) {
				const error = envelope.error ?? {};
				throw Object.assign(new Error(typeof error.message === "string" ? error.message : "unknown"), {
					code: typeof error.code === "string" ? error.code : "INTERNAL",
				});
			}
			return envelope.value;
		}
		// #endregion

		// #region 已删除的轮次（模块级一份，操作栏和轮尾标记共用）
		let deletedTurns = new Set();
		const listeners = new Set();

		function subscribeDeleted(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}

		/** 问宿主"哪些轮次已经被删了"。宿主握着完整日志，只有它答得准。 */
		let lastSessionId = null;

		/**
		 * 把界面此刻的现场打包送回宿主（诊断用）。
		 * 之前排查"删了但界面不消失"绕了很多圈，全靠猜 DOM 长什么样；
		 * 有这个通道，我直接从宿主那边读真实数据。
		 */
		function collectDiagnostics() {
			const tails = [...document.querySelectorAll("[data-turn-tail]")];
			const turnTextOf = (element) => element.getAttribute("data-turn-tail");
			const marker = document.querySelector("[data-dsh-st-marker]");
			return {
				build: BUILD,
				deletedTurns: [...deletedTurns],
				tailCount: tails.length,
				tailTurns: tails.map(turnTextOf).slice(0, 80),
				markerCount: document.querySelectorAll("[data-dsh-st-marker]").length,
				markerInsideTail: marker === null ? null : marker.closest("[data-turn-tail]") !== null,
				hiddenTurns: tails.filter((element) => element.hidden).map(turnTextOf),
			};
		}

		async function refreshDeleted(sessionId) {
			lastSessionId = sessionId;
			try {
				const value = await rpc({ sessionId, action: "hidden" });
				deletedTurns = new Set(Array.isArray(value?.turns) ? value.turns.map(String) : []);
				for (const fn of listeners) fn();
			} catch {
				/* 拿不到就当作"没有已删除的轮次"，只是那一轮藏不掉 */
			}
			try {
				await rpc({ sessionId, action: "report", payload: collectDiagnostics() });
			} catch {
				/* 诊断通道坏了不该影响正事 */
			}
		}
		// #endregion

		// #region 藏掉被删的整轮（借鉴 dsh-turn-delete）
		let ownerSequence = 0;

		/** 从轮尾标记往前收集"这一轮"的所有行，遇到上一轮的轮尾就停。 */
		function turnRows(marker) {
			const tail = marker.closest("[data-turn-tail]");
			if (tail === null) return [];
			// 轮尾那一行：优先认官方的 flow 标记；万一官方改了这个属性名，
			// 就退回 data-turn-tail 自己所在的那一层，不至于整套隐藏失效。
			const tailRow = tail.closest('[data-chat-flow-kind="turn-tail"]') ?? tail;
			const rows = [tailRow];
			let cursor = tailRow.previousElementSibling;
			while (cursor instanceof HTMLElement) {
				if (cursor.querySelector("[data-turn-tail]") !== null) break;
				rows.push(cursor);
				cursor = cursor.previousElementSibling;
			}
			return rows;
		}

		/** 找到"这一轮"的那一行（同上，带兜底）。 */
		function tailRowOf(marker) {
			const tail = marker.closest("[data-turn-tail]");
			if (tail === null) return null;
			return tail.closest('[data-chat-flow-kind="turn-tail"]') ?? tail;
		}

		/** 把这一轮的行藏起来，返回一个"还原"函数。 */
		function concealTurn(marker) {
			const owner = `st-${String(++ownerSequence)}`;
			const changed = [];
			for (const element of turnRows(marker)) {
				changed.push({ element, hidden: element.hidden });
				element.dataset.dshStOwner = owner;
				element.hidden = true;
			}
			return () => {
				for (const entry of changed) {
					if (entry.element.dataset.dshStOwner !== owner) continue;
					delete entry.element.dataset.dshStOwner;
					entry.element.hidden = entry.hidden;
				}
			};
		}

		/** 读出标记所在的这一轮是第几轮——直接取官方写在 DOM 上的属性。 */
		function markTurnNumber(marker) {
			const tail = marker.closest("[data-turn-tail]");
			return tail === null ? null : tail.getAttribute("data-turn-tail");
		}

		/**
		 * 轮尾的隐藏标记：渲染一个不可见的 span，然后在它附近把整轮藏掉。
		 * 每次 DOM 有变化都重算一遍——新渲染出来的行也会被藏住。
		 *
		 * 【踩过的坑】最初是靠插槽传进来的 `turn` 参数判断"我该不该藏"。但那个
		 * 参数叫什么、有没有真的传，从没被验证过；实际拿到的是 undefined，于是
		 * `deletedTurns.has(String(undefined))` 恒为 false，界面纹丝不动。
		 * 现在直接读官方自己写在 DOM 上的 `data-turn-tail`，不依赖任何 props。
		 */
		function DeletedTurnMarker() {
			const ref = useRef(null);
			const [tick, bump] = useState(0);

			useEffect(() => subscribeDeleted(() => bump((value) => value + 1)), []);

			useLayoutEffect(() => {
				const marker = ref.current;
				if (marker === null) return undefined;
				const turnText = markTurnNumber(marker);
				if (turnText === null || !deletedTurns.has(turnText)) return undefined;
				// 观察范围：这一轮所在的行容器。拿不到就逐级退回，保证
				// 后续 DOM 变化仍然会触发重算（新渲染出来的行也要被藏住）。
				const list = tailRowOf(marker)?.parentElement ?? marker.parentElement ?? document.body;
				if (list === null) return undefined;
				let restore = concealTurn(marker);
				const observer = new MutationObserver(() => {
					restore();
					restore = concealTurn(marker);
				});
				observer.observe(list, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					restore();
				};
			}, [tick]);

			return React.createElement("span", { ref, hidden: true, "data-dsh-st-marker": "" });
		}
		// #endregion

		// #region 轮尾的「第 N 轮」标签
		/**
		 * 轮尾那行淡灰的「第 N 轮」。
		 *
		 * 轮次号的取法和 DeletedTurnMarker 一模一样：组件自己就渲染在轮尾容器
		 * （`[data-turn-tail]`）内部，所以顺着 DOM 往上找一次就能读到官方写在
		 * 属性里的编号。同样不依赖插槽 props —— 那个 `turn` 参数到底传没传，
		 * 我们踩过一次坑，不再赌第二次。
		 *
		 * 为什么第一帧要渲染一个 display:none 的空壳：不渲染 DOM 就没有 ref，
		 * effect 里拿不到元素，编号永远算不出来。所以先挂壳、effect 里立刻填上；
		 * useLayoutEffect 是同步执行的，你不会看到中间态闪一下。
		 */
		const turnLabelStyle = {
			display: "inline-flex",
			alignItems: "center",
			// 它渲染在垃圾桶那个 inline-flex 容器内部，auto margin 会吃掉左侧
			// 剩余空间，于是贴着同一行的最右边——和垃圾桶齐平，且不多占一行高度。
			marginLeft: "auto",
			fontSize: 11,
			lineHeight: "16px",
			// 固定色号（不跟主题变量走，免得换主题时深浅不一）。
			color: "#81858d",
			fontVariantNumeric: "tabular-nums",
			userSelect: "none",
			whiteSpace: "nowrap",
		};

		function TurnNumberLabel({ sessionTools, t }) {
			const ref = useRef(null);
			const [turn, setTurn] = useState(null);

			useLayoutEffect(() => {
				const node = ref.current;
				if (node === null) return;
				setTurn(markTurnNumber(node));
			}, []);

			const table = tableFor(sessionTools?.locale?.getLocale?.().active);
			const fallback = typeof t === "function" ? t("turn.label") : "第 {turn} 轮";
			const template = typeof table["turn.label"] === "string" ? table["turn.label"] : fallback;

			return React.createElement(
				"span",
				{
					ref,
					style: turn === null ? { display: "none" } : turnLabelStyle,
					"data-dsh-st-turn-label": turn ?? "",
				},
				turn === null ? "" : fill(template, { turn }),
			);
		}
		// #endregion

		// #region 操作栏里的垃圾桶 + 浮出的按钮组
		const panelStyle = {
			position: "absolute",
			bottom: "calc(100% + 6px)",
			right: 0,
			zIndex: 40,
			display: "inline-flex",
			alignItems: "center",
			gap: 2,
			padding: "3px 5px",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(38,38,38,.96))",
			boxShadow: "0 2px 10px rgba(0,0,0,.3)",
			whiteSpace: "nowrap",
		};

		const buttonStyle = (danger, armed) => ({
			border: "none",
			background: armed ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))" : "transparent",
			color: armed ? "var(--dsw-alias-state-error-primary, #f87171)" : "var(--dsw-alias-label-tertiary, #9a9a9a)",
			font: "inherit",
			fontSize: 12,
			lineHeight: 1.5,
			padding: "2px 8px",
			borderRadius: 999,
			cursor: "pointer",
			whiteSpace: "nowrap",
		});

		const iconButtonStyle = (disabled) => ({
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 28,
			height: 28,
			padding: 6,
			border: "none",
			borderRadius: 28,
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			cursor: disabled ? "default" : "pointer",
			opacity: disabled ? 0.4 : 1,
		});

		const errorStyle = {
			position: "absolute",
			top: "calc(100% + 6px)",
			// 从按钮左边缘**向右**展开。原先用 right:0 向左展开，稍长的错误信息
			// 会顶出视口左边界，开头的字被直接裁掉（"服务端出错了"只剩"请看…"）。
			left: 0,
			zIndex: 41,
			// 固定宽度 + 允许换行。父元素只是一个 28px 的图标按钮，靠 max-content
			// 撑开会被反压成"中文一行一个字"的竖排。
			width: 300,
			maxWidth: "60vw",
			padding: "5px 10px",
			borderRadius: 8,
			fontSize: 12,
			lineHeight: 1.6,
			whiteSpace: "normal",
			wordBreak: "break-word",
			color: "var(--dsw-alias-state-error-primary, #f87171)",
			background: "var(--dsw-alias-bg-layer-2, rgba(38,38,38,.97))",
		};

		function TurnToolsAction({ turn, sessionId, sessionTools, useSession, t }) {
			const running = useSession((snapshot) => snapshot.running);
			const [open, setOpen] = useState(false);
			const [armed, setArmed] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const timer = useRef(0);
			const alive = useRef(true);
			const host = useRef(null);

			/**
			 * 这一轮是第几轮。
			 *
			 * 优先用插槽给的 `turn`（turnTail 插槽无条件传它）；万一哪天官方不传了，
			 * 就从 DOM 上读官方自己写的 `data-turn-tail` —— 这个兜底是踩过坑换来的：
			 * 早先的版本想当然以为插槽会传参数，结果拿到 undefined，判断恒为假、
			 * 界面纹丝不动，白查好几轮。
			 */
			const turnOfThis = () => {
				if (Number.isSafeInteger(turn)) return turn;
				const element = host.current;
				if (element === null) return null;
				const text = markTurnNumber(element);
				if (text === null) return null;
				const value = Number(text);
				return Number.isSafeInteger(value) ? value : null;
			};

			useEffect(() => {
				alive.current = true;
				// 插件挂载时先问一次"哪些轮次已被删"，让轮尾标记能立刻工作。
				void refreshDeleted(sessionId);
				return () => {
					alive.current = false;
					window.clearTimeout(timer.current);
				};
			}, [sessionId]);

			const tFn = typeof t === "function" ? t : (key) => key;
			const table = tableFor(sessionTools?.locale?.getLocale?.().active);
			const label = (key) => {
				const fromDict = table[key];
				return typeof fromDict === "string" ? fromDict : tFn(key);
			};

			/** 4 秒没动作就收起面板、清掉确认态。 */
			const armClose = () => {
				window.clearTimeout(timer.current);
				timer.current = window.setTimeout(() => {
					if (!alive.current) return;
					setOpen(false);
					setArmed(null);
					setError(null);
				}, AUTO_CLOSE_MS);
			};

			const toggle = () => {
				if (running) return;
				window.clearTimeout(timer.current);
				setError(null);
				setArmed(null);
				setOpen((value) => !value);
				armClose();
			};

			const pick = (action) => {
				if (running || busy) return;
				if (armed !== action) {
					setArmed(action);
					armClose();
					return;
				}
				const targetTurn = turnOfThis();
				if (targetTurn === null) {
					setError(table["error.NO_TURN"]);
					armClose();
					return;
				}
				window.clearTimeout(timer.current);
				setBusy(true);
				setError(null);
				rpc({ sessionId, action, target: { turn: targetTurn } })
					.then((value) => {
						if (!alive.current) return;
						setBusy(false);
						setOpen(false);
						setArmed(null);
						// 先按宿主的回话立刻把这一轮藏起来（体感是"点了就没"），
						// 再回头跟日志对齐：truncate 一次删好几轮，只有日志知道全部名单。
						const changedTurn = value?.turn;
						if (Number.isSafeInteger(changedTurn)) {
							deletedTurns = new Set([...deletedTurns, changedTurn]);
							for (const fn of listeners) fn();
						}
						void refreshDeleted(sessionId);
					})
					.catch((caught) => {
						if (!alive.current) return;
						setBusy(false);
						setArmed(null);
						const code = String(caught?.code ?? "");
						const key = `error.${code}`;
						const known = table[key];
						const detail = typeof caught?.message === "string" ? caught.message : String(caught ?? "");
						// 服务端出错的场景，把原始信息一并显示——上次就是它被
						// "任务正在运行"这句固定文案挡住，害我们查了半天。
						setError(
							typeof known === "string"
								? code === "INTERNAL" && detail !== ""
									? `${known} 详情：${detail}`
									: known
								: fill(table["error.generic"], { message: detail }),
						);
						// 报"这一轮已经不在了"时，正说明别的操作（或上一次点击）
						// 已经把它删掉了——界面状态得跟着刷新，否则就是一个
						// 永远藏不掉、点了还报错的死按钮。
						void refreshDeleted(sessionId);
						armClose();
					});
			};

			const renderAction = (action, danger) => {
				const isArmed = armed === action;
				return React.createElement(
					"button",
					{
						key: action,
						type: "button",
						style: buttonStyle(danger, isArmed),
						"aria-label": label(action === "delete" ? "action.delete" : "action.truncate"),
						onClick: () => pick(action),
					},
					label(isArmed ? "action.arm" : action === "delete" ? "action.delete" : "action.truncate"),
				);
			};

			return React.createElement(
				"span",
				{ ref: host, style: { position: "relative", display: "inline-flex" } },
				React.createElement(
					Tooltip,
					{ label: label(running ? "action.busy" : "action.open"), side: "bottom" },
					React.createElement(
						"button",
						{
							type: "button",
							style: iconButtonStyle(running),
							"aria-label": label("action.open"),
							"aria-disabled": running || undefined,
							onClick: toggle,
						},
						React.createElement(IconTrashOutline16, null),
					),
				),
				open
					? React.createElement("span", { style: panelStyle }, renderAction("delete", true), renderAction("truncate", true))
					: null,
				error === null ? null : React.createElement("span", { style: errorStyle, role: "alert" }, error),
				// 「第 N 轮」和垃圾桶共用这一行：它在同一个 inline-flex 容器里，
				// 靠 margin-left:auto 顶到最右。既满足"和垃圾桶齐平"，又不像
				// 单独注册成一项那样多占一行高度。
				React.createElement(TurnNumberLabel, { sessionTools, t }),
			);
		}
		// #endregion

		const inject = ["slots", "locale"];

		function apply(ctx) {
			console.info(`[session-tools] client bundle ${BUILD}`);
			if (globalThis.__DSH_SESSION_TOOLS_APPLIED__ === true) return;
			globalThis.__DSH_SESSION_TOOLS_APPLIED__ = true;
			ctx.effect(() => () => {
				globalThis.__DSH_SESSION_TOOLS_APPLIED__ = false;
			}, "session-tools: release the apply guard");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-tools: dictionaries");

			const kit = { locale: ctx.locale };

			// ① 删除入口：挂在**轮次尾部**（turnTail），而不是 AI 回复下方的操作栏。
			//
			// 为什么换位置：操作栏那段官方代码是
			//     const messageId = closing.finalNode.messageId;
			//     const assistantActions = messageId === void 0 ? null : renderSlot(...)
			// —— 也就是说**必须有正式回答的 messageId，操作栏才会渲染**。空回那种
			// 消息只有思考、没有正文，于是操作栏里的插件按钮整个不出现，**空回就永远
			// 删不掉**。而 turnTail 插槽是无条件渲染的，每一轮都有。
			// 顺带这也是用户一开始就想要的"把小垃圾桶放在 turn 下方"。
			ctx.slots.inject(
				"conversation.chat.turnTail",
				() =>
					ctx.slots.register(
						{
							name: "conversation.chat.turnTail",
							id: NS,
							order: 10,
							locale: NS,
							inject: (sessionId) => ({ sessionTools: { ...kit, sessionId } }),
						},
						TurnToolsAction,
					),
				"session-tools: delete action",
			);

			// ② 同一个插槽里再挂一个隐藏标记：负责把"已被删除"的那一轮整轮藏起来。
			ctx.slots.inject(
				"conversation.chat.turnTail",
				() =>
					ctx.slots.register(
						{
							name: "conversation.chat.turnTail",
							id: `${NS}-marker`,
							order: 20,
							locale: NS,
						},
						DeletedTurnMarker,
					),
				"session-tools: deleted-turn marker",
			);

			// 「第 N 轮」不在这里单独注册——它由 TurnToolsAction（①）顺带渲染。
			// 理由：插槽项在轮尾容器（纵向 flex）里各占一行，单独注册就必然多出
			// 一行高度；而它只需要和垃圾桶共用同一行。
		}

		return { inject, apply };
	},
});
