/**
 * `/irc <subcommand>` 的实装（index.ts 的斜杠命令 handler 只做通知）。
 *
 * 与 QQ 扩展同一形状：命令把结果作为文本返回，宿主 UI 负责展示；抛错由调用方兜成 error。
 * 正文参数按宿主的**原样余量**处理（`send` 的正文可以带换行/缩进，不做 `split(/\s+/)` 预切分）。
 */
import type { IrcClientStatus } from "./client";
import type { IrcConfig, IrcLogger } from "./config";
import { describePeer, resolveOrCreatePeer, type PeerDirectory, type PeerRecord } from "./peers";
import { formatTranscriptDigest, type TranscriptEntry } from "./transcript";

export const IRC_HELP = [
	"/irc 子命令：",
	"- status：连接/注册/频道/已登记 peer + 配置说明（默认）",
	"- connect：连接 IRC server（session 启动时已自动连接；断开后用这条重连）",
	"- disconnect：断开并停止自动重连（peer 登记与转录保留，connect 可随时回来）",
	"- list：已知 IRC 会话（id / 别名 / 最近活跃）",
	"- log <peer> [条数]：最近的完整消息记录（主会话卡片正文有上限，长文看这里）",
	"- say <peer> <正文>：以本会话身份发一条 PRIVMSG（模型侧照旧用 write agent://<peer>）",
	"- join <#频道>：JOIN 并记为留驻频道（重连后自动重新 JOIN）",
	"- part <#频道>：PART 并取消留驻",
].join("\n");

export interface IrcCommandResult {
	text: string;
	level: "info" | "warning" | "error";
}

export interface VerbArgs {
	/** 子命令名；空参数返回空串，由调用方兜默认值。 */
	verb: string;
	/** 子命令之后的原样余量（保留内部空白与换行，两侧空白已去）。 */
	restRaw: string;
}

/** `args` → 子命令名 + 原样余量。 */
export function splitVerb(args: string): VerbArgs {
	const head = args.trim();
	const cut = head.search(/\s/);
	if (cut === -1) return { verb: head, restRaw: "" };
	return { verb: head.slice(0, cut), restRaw: head.slice(cut + 1).trim() };
}

/** 前缀引用的 token 上限：别名超过这么多词就按正文处理。 */
const MAX_REFERENCE_TOKENS = 4;

interface ReferenceCandidate {
	reference: string;
	body: string;
}

/**
 * 按引用长度递增列出候选（peer 引用允许含空格，正文跟在后面，边界天然有歧义）。
 * 取「前 N 个 token」逐个试、**最短命中优先**：最长优先更容易把正文开头的 token 吃进
 * 引用里，那种错会静默发给别人。
 */
export function referenceCandidates(restRaw: string): ReferenceCandidate[] {
	const text = restRaw.trim();
	if (!text) return [];
	const candidates: ReferenceCandidate[] = [];
	const token = /\S+/g;
	let match: RegExpExecArray | null;
	while ((match = token.exec(text)) !== null) {
		const end = match.index + match[0].length;
		candidates.push({ reference: text.slice(0, end), body: text.slice(end).replace(/^\s+/, "") });
		if (candidates.length >= MAX_REFERENCE_TOKENS) break;
	}
	return candidates;
}

export interface IrcCommandChannel {
	join(channel: string): void;
	part(channel: string): void;
	status(): IrcClientStatus;
}

/**
 * 连接控制面（index.ts 注入）。命令层只负责「判断该不该调」与文案，连接本体在客户端；
 * `isStarted` 必须与状态栏同一个事实（index.ts 的 `runtime.started`），否则 `/irc status`
 * 会与状态栏打架。
 */
export interface IrcConnectionControl {
	/** 本会话是否已发起连接（含正在重连）。 */
	isStarted(): boolean;
	/** 发起连接（含自动重连）；已发起时是 no-op。 */
	connect(): void;
	/** 断开并停止自动重连；已断开时是 no-op。 */
	disconnect(): void;
}

export interface IrcCommandDeps {
	config: IrcConfig;
	/** 启动配置说明（缺 server 等），status 原样列出。 */
	notes: string[];
	peers: PeerDirectory;
	client: IrcCommandChannel;
	/** connect / disconnect 子命令的执行面。 */
	connection: IrcConnectionControl;
	/** 出站投递（与 PeerDirectory 用的是同一个实现：发 PRIVMSG 并落转录）。 */
	send: (peer: PeerRecord, text: string) => Promise<void>;
	transcripts: { tail(peerId: string, limit: number): TranscriptEntry[]; pathFor(peerId: string): string };
	logger: IrcLogger;
}

/** 连接状态一句话（status 与 connect 共用；与 index.ts 状态栏同一套状态机）。 */
function connectionState(deps: IrcCommandDeps): string {
	const status = deps.client.status();
	if (!deps.connection.isStarted()) {
		return deps.config.configured ? "未连接（/irc connect 可连接）" : "未连接";
	}
	// attempts 是「连续重连次数」：0 = 首次连接还在握手，别把它写成「重连中（第 0 次）」。
	if (!status.connected) return status.attempts > 0 ? `重连中（第 ${status.attempts} 次）` : "连接中…";
	return status.registered ? "已连接 · 已注册" : "已连接 · 注册中";
}

function statusText(deps: IrcCommandDeps): string {
	const status = deps.client.status();
	const endpoint = status.server ? `${status.server}:${status.port}${status.tls ? " TLS" : " 明文"}` : "未配置";
	const lines = [
		`IRC：${connectionState(deps)}（${endpoint}）`,
		`昵称：${status.nick}`,
		`留驻频道：${status.channels.length > 0 ? status.channels.join("、") : "(无)"}`,
		`已登记 peer：${deps.peers.list().length}`,
		...deps.notes.map(note => `· ${note}`),
	];
	return lines.join("\n");
}

/** 执行一个子命令，返回要展示的文本。 */
export async function runIrcCommand(deps: IrcCommandDeps, args: string): Promise<IrcCommandResult> {
	const { verb: rawVerb, restRaw } = splitVerb(args);
	const verb = rawVerb || "status";
	const rest = restRaw ? restRaw.split(/\s+/) : [];
	try {
		switch (verb) {
			case "help":
			case "?":
				return { text: IRC_HELP, level: "info" };
			case "status":
				return { text: statusText(deps), level: "info" };
			case "connect": {
				if (!deps.config.configured) {
					return {
						text: ["未配置 IRC server，无法连接", ...deps.notes.map(note => `· ${note}`)].join("\n"),
						level: "warning",
					};
				}
				if (deps.connection.isStarted()) {
					return { text: `已经在连接：${connectionState(deps)}（要重连先 /irc disconnect）`, level: "info" };
				}
				deps.connection.connect();
				const status = deps.client.status();
				return {
					text: `已发起连接 ${status.server}:${status.port}${status.tls ? "（TLS）" : ""}，昵称 ${status.nick}；结果看状态栏或 /irc status`,
					level: "info",
				};
			}
			case "disconnect": {
				if (!deps.connection.isStarted()) return { text: "IRC 未在连接（无需断开）", level: "info" };
				deps.connection.disconnect();
				return { text: "已断开 IRC 并停止自动重连（peer 登记与转录保留，/irc connect 可重连）", level: "info" };
			}
			case "list": {
				const known = deps.peers.list();
				return {
					text: known.length ? [`已知 IRC 会话 ${known.length} 个：`, ...known.map(describePeer)].join("\n") : "还没有 IRC 会话",
					level: "info",
				};
			}
			case "log": {
				// 末尾的纯数字 token 当条数，其余当作 peer 引用（别名里可以有空格）。
				const last = rest[rest.length - 1];
				const tailArgs = last !== undefined && /^\d+$/.test(last) ? rest.slice(0, -1) : rest;
				const reference = tailArgs.join(" ").trim();
				const known = deps.peers.list();
				const peer = reference ? deps.peers.resolve(reference) : known.length === 1 ? known[0] : undefined;
				if (!peer) {
					return {
						text:
							known.length === 0
								? "还没有 IRC 会话"
								: `用法：/irc log <peer|nick|频道|别名> [条数]\n${known.map(describePeer).join("\n")}`,
						level: known.length === 0 ? "info" : "warning",
					};
				}
				const limit = Math.min(50, Math.max(1, last !== undefined && /^\d+$/.test(last) ? Number(last) : 6));
				const file = deps.transcripts.pathFor(peer.id);
				return { text: formatTranscriptDigest(deps.transcripts.tail(peer.id, limit), file), level: "info" };
			}
			case "say": {
				const candidates = referenceCandidates(restRaw);
				const known = candidates.find(candidate => deps.peers.resolve(candidate.reference) !== undefined);
				const raw = candidates[0];
				// 已经聊过的引用按最短命中；否则把最短的一个当原始 nick/频道当场登记（主动开口）。
				const target = known ? deps.peers.resolve(known.reference) : raw ? resolveOrCreatePeer(deps.peers, raw.reference, Date.now()) : undefined;
				const body = known?.body ?? raw?.body ?? "";
				if (!target) return { text: "用法：/irc say <peer|nick|频道|别名> <正文>", level: "warning" };
				if (!body) return { text: `用法：/irc say ${target.id} <正文>`, level: "warning" };
				const status = deps.client.status();
				if (!status.registered) return { text: "IRC 未连接/未注册，消息未发出（/irc status 看原因）", level: "warning" };
				await deps.send(target, body);
				return { text: `已发送到 ${target.id}（${body.length} 字符）`, level: "info" };
			}
			case "join": {
				const channel = rest[0];
				if (!channel) return { text: "用法：/irc join <#频道>", level: "warning" };
				deps.client.join(channel);
				const status = deps.client.status();
				return {
					text: `已记为留驻频道 ${status.channels.join("、")}${status.registered ? "（已 JOIN）" : "（连接注册后自动 JOIN）"}`,
					level: "info",
				};
			}
			case "part": {
				const channel = rest[0];
				if (!channel) return { text: "用法：/irc part <#频道>", level: "warning" };
				deps.client.part(channel);
				const status = deps.client.status();
				return {
					text: `已取消留驻 ${channel}${status.registered ? "（已 PART）" : ""}；留驻频道：${status.channels.join("、") || "(无)"}`,
					level: "info",
				};
			}
			default:
				return { text: `未知子命令：${verb}\n${IRC_HELP}`, level: "warning" };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.logger.warn("irc 命令执行失败", { verb, error: message });
		return { text: `失败：${message}`, level: "error" };
	}
}
