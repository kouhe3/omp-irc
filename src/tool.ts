/**
 * `irc` 工具：补 `write agent://<peer>` 覆盖不到的能力。
 *
 * 收发正文的默认通道是 IRC peer（模型直接 `write agent://irc-<nick>`），工具只做四件事：
 * 查 peer、主动发文本、JOIN 频道、看连接状态。常驻（loadMode=essential），否则模型看不到它。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { IrcClientStatus } from "./client";
import type { IrcLogger } from "./config";
import { describePeer, resolveOrCreatePeer, type PeerDirectory, type PeerRecord } from "./peers";
import { formatTranscriptDigest, type TranscriptEntry } from "./transcript";

export interface IrcToolDeps {
	peers: PeerDirectory;
	client: { join(channel: string): void; status(): IrcClientStatus };
	/** 出站投递（与 PeerDirectory 用的是同一个实现：发 PRIVMSG 并落转录）。 */
	send: (peer: PeerRecord, text: string) => Promise<void>;
	/** peer 转录（`log` 动作读最近原文；正文不截断）。 */
	transcripts: { tail(peerId: string, limit: number): TranscriptEntry[]; pathFor(peerId: string): string };
	logger: IrcLogger;
	/** 渠道启动前的配置提示（缺 server 等）。 */
	notes: string[];
}

/** 所有分支共用的 details 形状，避免 registerTool 从分支联合里推出发散类型。 */
interface IrcToolDetails {
	action: string;
	peers?: PeerRecord[];
	status?: IrcClientStatus;
	notes?: string[];
}

export function defineIrcTool(pi: ExtensionAPI, getDeps: () => IrcToolDeps | undefined) {
	const z = pi.zod;
	return {
		name: "irc",
		label: "IRC",
		description:
			"IRC 消息渠道。回消息默认用 write（path: agent://irc-<nick> 私聊 / agent://irc-chan-<#频道> 频道）；本工具用于：list 查 peer、log 读最近若干条完整消息、say 主动发一条 PRIVMSG、join 加入频道、status 看连接状态。入站卡片正文会被截断（出站不截断），要原文用 log。",
		loadMode: "essential" as const,
		approval: "write" as const,
		parameters: z.object({
			action: z.enum(["list", "say", "join", "status", "log"]).describe("操作类型"),
			peer: z.string().optional().describe("say/log：peer id / nick / 频道 / 别名"),
			text: z.string().optional().describe("say：文本内容"),
			channel: z.string().optional().describe("join：频道名（缺 # 前缀自动补）"),
			limit: z.number().optional().describe("log：读最近多少条（默认 6，上限 50）"),
		}),
		async execute(
			_toolCallId: string,
			params: {
				action: "list" | "say" | "join" | "status" | "log";
				peer?: string;
				text?: string;
				channel?: string;
				limit?: number;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<IrcToolDetails>> {
			const deps = getDeps();
			if (!deps) {
				return {
					content: [{ type: "text" as const, text: "IRC 渠道未初始化（当前会话不是主会话，或扩展尚未收到 session_start）。" }],
					details: { action: params.action } satisfies IrcToolDetails,
					isError: true,
				};
			}
			try {
				switch (params.action) {
					case "list": {
						const peers = deps.peers.list();
						return {
							content: [
								{
									type: "text" as const,
									text:
										peers.length === 0
											? "还没有任何 IRC 会话；等对方先发一条消息过来，或用 say/join 主动开口。"
											: [`已知 IRC 会话 ${peers.length} 个（回消息：write path: "agent://<id>"）：`, ...peers.map(peer => `- ${describePeer(peer)}`)].join(
													"\n",
												),
								},
							],
							details: { action: params.action, peers } satisfies IrcToolDetails,
						};
					}
					case "log": {
						const known = deps.peers.list();
						const peer = params.peer ? deps.peers.resolve(params.peer) : known.length === 1 ? known[0] : undefined;
						if (!peer) throw new Error(`找不到 IRC 会话：${params.peer ?? "(未提供 peer)"}`);
						const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 6)));
						const file = deps.transcripts.pathFor(peer.id);
						return {
							content: [{ type: "text" as const, text: formatTranscriptDigest(deps.transcripts.tail(peer.id, limit), file) }],
							details: { action: params.action, peers: [peer] } satisfies IrcToolDetails,
						};
					}
					case "status": {
						const status = deps.client.status();
						const state = !status.connected ? "未连接" : status.registered ? "已连接 · 已注册" : "已连接 · 注册中";
						const endpoint = status.server ? `${status.server}:${status.port}${status.tls ? " TLS" : " 明文"}` : "未配置";
						const lines = [
							`IRC：${state}（${endpoint}，昵称 ${status.nick}）`,
							`留驻频道：${status.channels.length > 0 ? status.channels.join("、") : "(无)"}`,
							`已登记 peer：${deps.peers.list().length}`,
							...deps.notes.map(note => `· ${note}`),
						];
						return {
							content: [{ type: "text" as const, text: lines.join("\n") }],
							details: { action: params.action, status, notes: deps.notes } satisfies IrcToolDetails,
						};
					}
					case "say": {
						// 主动开口：还没会话过的 nick/频道当场登记（log 则要求已登记，避免给错名建出假 peer）。
						if (!params.text?.trim()) throw new Error("say 需要 text");
						const peer = params.peer ? resolveOrCreatePeer(deps.peers, params.peer, Date.now()) : undefined;
						if (!peer) throw new Error(`找不到 IRC 会话：${params.peer ?? "(未提供 peer)"}`);
						if (!deps.client.status().registered) throw new Error("IRC 未连接/未注册，消息未发出（status 看原因）");
						await deps.send(peer, params.text);
						return {
							content: [{ type: "text" as const, text: `已发送到 ${peer.id}` }],
							details: { action: params.action, peers: [peer] } satisfies IrcToolDetails,
						};
					}
					case "join": {
						const channel = params.channel?.trim();
						if (!channel) throw new Error("join 需要 channel");
						deps.client.join(channel);
						const status = deps.client.status();
						return {
							content: [
								{
									type: "text" as const,
									text: `已记为留驻频道 ${status.channels.join("、")}${status.registered ? "（已 JOIN）" : "（连接注册后自动 JOIN）"}`,
								},
							],
							details: { action: params.action, status } satisfies IrcToolDetails,
						};
					}
					default:
						throw new Error(`未知 action：${String(params.action)}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.logger.warn("irc 工具执行失败", { action: params.action, error: message });
				return {
					content: [{ type: "text" as const, text: `失败：${message}` }],
					details: { action: params.action } satisfies IrcToolDetails,
					isError: true,
				};
			}
		},
	};
}
