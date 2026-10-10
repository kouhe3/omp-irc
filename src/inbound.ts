/**
 * 入站 IRC 消息 → 宿主主会话的注入。
 *
 * 走宿主扩展 API 的 `pi.sendMessage`（`deliverAs: "steer"`）：会话空闲时按一条带
 * `triggerTurn` 的注入唤起一轮，模型正忙时作为 steering 注入当前这一轮（下个 step 边界生效）。
 *
 * **为什么不走 omp 的 IRC 面**（`IrcBus` / `deliverIrcMessage` / `irc:incoming` 卡片 /
 * `write agent://irc-<nick>`）：那是给 omp 内部 agent 之间通信（子代理编排）设计的，
 * peer 面的语义（`kind: "sub"` 替身、广播扇出、Agent Hub 聚焦、`history://`）都不属于
 * 外部渠道。渠道要的只是「收得进来、发得出去」：入站走 sendMessage、出站走 irc 工具。
 *
 * 代价（有意取舍）：宿主对主会话不做任何代发，模型必须**显式**调用 `irc` 工具回话
 * ——所以注入正文末尾直接给出用法（见 {@link formatInboundBody}）。
 */
import type { IrcInboundMessage } from "./client";
import { type ConversationDirectory, type ConversationScope } from "./conversations";
import { sanitizeForDisplay, type TranscriptEntry } from "./transcript";

/** 注入用的自定义消息类型（TUI 卡片标题与宿主转录里的 `customType`）。 */
export const IRC_INCOMING_TYPE = "irc:message";

/** `pi.sendMessage` 的结构子集；生产里由 index.ts 绑定到宿主。 */
export interface InboundInjector {
	sendMessage(
		message: { customType: string; content: string; display: boolean; attribution: "agent" },
		options: { deliverAs: "aside" | "followUp" | "nextTurn" | "steer"; triggerTurn: boolean },
	): void;
}

/**
 * 生成入站投递函数。宿主把 `sendMessage` 的错误收进自己的错误通道（扩展侧拿不到返回值，
 * 也没有失败回调），所以这里没有「投递失败」分支——一次调用就是一次投递。
 *
 * 只传渲染好的正文：`deliverIrcMessage` 时代的那种信封（id/from/to/replyTo）是 peer 面的
 * 契约，渠道这边没有任何读者——RFC1459 本身也没有消息 id。
 *
 * 投递方式（四种都实测过，见 README「投递方式」）：用 `steer` —— 模型正忙时作为 steering 注入
 * **当前这一轮**（下个 step 边界生效，语义与 omp 自己的父 agent 给子代理发 IRC 一样），
 * 空闲时按 `triggerTurn` 唤起一轮。
 *
 * 为什么不是另外三种（都是实测结论）：`aside` 会在轮次收尾竞态里静默丢消息（连喷 3 条丢约
 * 1/6）；`followUp` / `nextTurn` 把消息park 在当前轮之后，而 TUI 的 **Esc 打断**会
 * `clearQueue({ forInterrupt: true })`（只保留 advisor 卡片）把排队消息丢掉（真 TUI 实测：
 * Esc 后卡片再也不出现）。steer 立刻被当前轮消费，暴露在打断窗口里的时间只有一个 step 边界。
 */
export function createHostSink(inject: InboundInjector): (body: string) => void {
	return body => {
		// display：人在 TUI 里看得见这条入站；triggerTurn：空闲时唤起一轮。
		inject.sendMessage(
			{ customType: IRC_INCOMING_TYPE, content: body, display: true, attribution: "agent" },
			{ deliverAs: "steer", triggerTurn: true },
		);
	};
}

/**
 * 入站正文的统一渲染：`[#omp] alice: hi` / `[私聊] alice: hi`（NOTICE 标出来），
 * 末尾另起一行给出回复方式（渠道没有代发，模型必须显式调用工具）。
 *
 * 整串过 {@link sanitizeForDisplay}（剥 ESC/OSC 等控制序列 + 转义 harness 标签：
 * 宿主把扩展注入的自定义消息当 developer 内容原样交给模型，而系统提示声明 `<system-*>` /
 * `<irc ...>` 这类块是 harness 自己写的——对端不该能靠这条通道伪造 harness 指令），
 * 再把所有行终止符压成空格：一张卡片 = 一条 IRC 消息，否则对端能用裸 CR / U+2028
 * 在卡片里伪造「另一个人发言」，甚至伪造下面那行回复指引。转录里仍是原文。
 */
export function formatInboundBody(event: {
	/** 会话 id（目录按 (类型, 原始目标) 算出的纯函数；名字有损时带 16 位短哈希）——模型回复时用它。 */
	id: string;
	scope: ConversationScope;
	targetId: string;
	senderNick: string;
	content: string;
	notice?: boolean;
}): string {
	const where = event.scope === "channel" ? event.targetId : "私聊";
	const kind = event.notice ? "NOTICE " : "";
	const body = sanitizeForDisplay(`[${kind}${where}] ${event.senderNick}: ${event.content}`)
		.replace(/\n+/g, " ")
		.trim();
	// 用法单独成行跟在正文之后，模型照抄即可（正文本身就是不可信输入，这一行是扩展自己写的）。
	return `${body}\n\n回复：irc 工具 {"action":"send","peer":"${event.id}","text":"<正文>"}`;
}

export interface InboundPipelineOptions {
	conversations: ConversationDirectory;
	transcripts: { record(id: string, entry: TranscriptEntry): void };
	/** 注入主会话的 sink（createHostSink 或测试替身），入参是渲染好的卡片正文。 */
	deliver: (body: string) => void;
	/** 我们自己的 nick（过滤自己的回声）。 */
	selfNick: () => string;
	now?: () => number;
}

/**
 * 入站消息 → 登记会话（首次即登记）→ 落转录 → 注入主会话卡片。
 * index.ts 与 e2e 共用这一条管线，测试跑的就是线上那条路径。
 */
export function createInboundHandler(options: InboundPipelineOptions): (message: IrcInboundMessage) => void {
	return message => {
		if (!message.text || message.from === options.selfNick()) return;
		// 服务端/网关的 NOTICE（主机名带点，如 irc.example.org）不是对话，别进模型上下文。
		if (message.notice && message.from.includes(".")) return;
		const scope: ConversationScope = message.channel ? "channel" : "query";
		const targetId = message.channel ? message.target : message.from;
		const ts = options.now?.() ?? Date.now();
		const record = options.conversations.ensure({ scope, targetId, timestamp: ts });
		// 先落原文再注入：转录是**全量账本**（含出站长文被切分的多条），`irc log` 读它。
		options.transcripts.record(record.id, { role: "user", text: message.text, ts, senderName: message.from });
		options.deliver(
			formatInboundBody({
				id: record.id,
				scope,
				targetId,
				senderNick: message.from,
				content: message.text,
				notice: message.notice,
			}),
		);
	};
}
