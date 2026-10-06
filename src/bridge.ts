/**
 * 入站 IRC 消息 → 宿主主会话的 IRC 投递。
 *
 * 走主会话自己的 `deliverIrcMessage`（宿主 IrcBridge 的公开方法）：它与 peer
 * 之间的消息完全同一条路径——空闲时唤起一轮（wake），流式中作为下个 step 边界的
 * interrupting aside，卡片类型同样是 `irc:incoming`。
 *
 * 为什么不走 `IrcBus`：宿主没有把 `IrcBus`/`executeSend` 放进包导出面，而扩展禁止
 * 运行时 import 宿主包；主会话对象则可以从 AgentRegistry 拿到。
 */
import type { IrcLogger } from "./config";
import type { IrcInboundMessage } from "./client";
import type { PeerDirectory, PeerRegistry, PeerScope } from "./peers";
import { stripControl, type TranscriptEntry } from "./transcript";

/** 宿主 AgentSession 上我们用到的面。 */
interface IrcDeliverySession {
	deliverIrcMessage?(message: {
		id: string;
		from: string;
		to: string;
		body: string;
		ts: number;
		replyTo?: string;
	}): Promise<unknown>;
}

export interface InboundDelivery {
	/** IRC 消息 id（扩展合成的 `irc-<ts>-<序号>`）。 */
	messageId: string;
	/** 发送方 peer id。 */
	from: string;
	body: string;
	ts: number;
	/** 被回复的 IRC 消息 id。 */
	replyTo?: string;
}

export interface HostSinkOptions {
	registry: PeerRegistry;
	mainAgentId: string;
	logger: IrcLogger;
}

/**
 * 主会话尚未注册（headless/未启动）时返回 false，由调用方决定是丢弃还是重试；
 * 投递异常向上抛，让调用方记日志。
 */
export function createHostSink(options: HostSinkOptions): (delivery: InboundDelivery) => Promise<boolean> {
	return async delivery => {
		const main = options.registry.get(options.mainAgentId);
		if (!main) {
			options.logger.warn("主 agent 未注册，IRC 消息丢弃", { from: delivery.from });
			return false;
		}
		// 结构性收窄：registry 的 session 字段是 unknown，这里按用到的面检查一次。
		const session = main.session;
		if (!session || typeof session !== "object" || !("deliverIrcMessage" in session)) {
			options.logger.warn("主会话不支持 IRC 投递，IRC 消息丢弃", { from: delivery.from });
			return false;
		}
		const deliver = session.deliverIrcMessage;
		if (typeof deliver !== "function") {
			options.logger.warn("主会话 IRC 投递接口异常，IRC 消息丢弃", { from: delivery.from });
			return false;
		}
		const bound: IrcDeliverySession = { deliverIrcMessage: deliver.bind(session) as IrcDeliverySession["deliverIrcMessage"] };
		await bound.deliverIrcMessage?.({
			id: delivery.messageId,
			from: delivery.from,
			to: options.mainAgentId,
			body: delivery.body,
			ts: delivery.ts,
			...(delivery.replyTo ? { replyTo: delivery.replyTo } : {}),
		});
		return true;
	};
}

/**
 * 入站正文的统一渲染：`[#omp] alice: hi` / `[私聊] alice: hi`（NOTICE 标出来）。
 * 整串过 {@link stripControl}：nick 与正文都是 IRC 来的不可信输入，而这张卡片（含模型侧上下文）
 * 是扩展自己渲染给人看的；对端不该能靠 ESC/OSC 序列操纵运维者的终端。转录里仍是原文。
 */
export function formatInboundBody(event: {
	scope: PeerScope;
	targetId: string;
	senderNick: string;
	content: string;
	notice?: boolean;
}): string {
	const where = event.scope === "channel" ? event.targetId : "私聊";
	const kind = event.notice ? "NOTICE " : "";
	return stripControl(`[${kind}${where}] ${event.senderNick}: ${event.content}`);
}

export interface InboundPipelineOptions {
	peers: PeerDirectory;
	transcripts: { record(peerId: string, entry: TranscriptEntry): void };
	/** 投递主会话的 sink（createHostSink 或测试替身）。 */
	deliver: (delivery: InboundDelivery) => Promise<boolean>;
	/** 我们自己的 nick（过滤自己的回声）。 */
	selfNick: () => string;
	logger: IrcLogger;
	/** 合成 IRC 消息 id（RFC1459 没有消息 id）。 */
	nextMessageId(): string;
	now?: () => number;
}

/**
 * 入站消息 → 登记 peer（首次即注册替身）→ 落转录 → 投进主会话 irc 卡片。
 * index.ts 与 e2e 共用这一条管线，测试跑的就是线上那条路径。
 *
 * 返回的函数不会 reject：投递失败只记日志（IRC 连接不该因主会话忙/未注册而断）。
 */
export function createInboundHandler(options: InboundPipelineOptions): (message: IrcInboundMessage) => Promise<void> {
	return async message => {
		if (!message.text || message.from === options.selfNick()) return;
		// 服务端/网关的 NOTICE（主机名带点，如 irc.example.org）不是对话，别进模型上下文。
		if (message.notice && message.from.includes(".")) return;
		const scope: PeerScope = message.channel ? "channel" : "query";
		const targetId = message.channel ? message.target : message.from;
		const ts = options.now?.() ?? Date.now();
		const messageId = options.nextMessageId();
		const record = options.peers.ensure({ scope, targetId, messageId, timestamp: ts });
		// 先落原文再投递：卡片正文会被截断，转录不截断（/irc log 与 Hub 转录视图读它）。
		options.transcripts.record(record.id, { role: "user", text: message.text, ts, senderName: message.from });
		const body = formatInboundBody({ scope, targetId, senderNick: message.from, content: message.text, notice: message.notice });
		try {
			await options.deliver({ messageId, from: record.id, body, ts });
		} catch (error) {
			options.logger.warn("IRC 入站投递失败", {
				peer: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
