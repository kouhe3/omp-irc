/**
 * `irc` 工具：IRC 渠道唯一的模型侧收发面。
 *
 * IRC 会话不是 omp 子会话，`write agent://…` 到不了它：回消息用 `send`、看完整消息用 `log`、
 * 另有 list/join/status。常驻（loadMode=essential），否则模型看不到它。
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { IrcClientStatus } from "./client";
import type { IrcLogger } from "./config";
import {
	describeConversation,
	resolveOrCreateConversation,
	type ConversationDirectory,
	type ConversationRecord,
} from "./conversations";
import { formatTranscriptDigest, sanitizeSingleLine, type TranscriptEntry } from "./transcript";

export interface IrcToolDeps {
	conversations: ConversationDirectory;
	client: { join(channel: string): void; status(): IrcClientStatus };
	/** 出站投递（发 PRIVMSG + 落转录）；命令层用的是同一个实现。 */
	send: (record: ConversationRecord, text: string) => Promise<void>;
	/** 会话转录（`log` 动作读最近正文，不截断；入账已剥控制序列）。 */
	transcripts: { tail(id: string, limit: number): TranscriptEntry[]; pathFor(id: string): string };
	logger: IrcLogger;
	/** 渠道启动前的配置提示（缺 server 等）。 */
	notes: string[];
}

/** 所有分支共用的 details 形状，避免 registerTool 从分支联合里推出发散类型。 */
export interface IrcToolDetails {
	action: string;
	conversations?: ConversationRecord[];
	status?: IrcClientStatus;
	notes?: string[];
}

/** `irc` 工具的参数（与 `parameters` 里的 zod schema 同形；测试直接按这个类型喂 `execute`）。 */
export interface IrcToolParams {
	action: "list" | "send" | "join" | "status" | "log";
	peer?: string;
	text?: string;
	channel?: string;
	limit?: number;
}

export function defineIrcTool(pi: ExtensionAPI, getDeps: () => IrcToolDeps | undefined) {
	const z = pi.zod;
	return {
		name: "irc",
		label: "IRC",
		description:
			"IRC 消息渠道（外部 IRC 网络，不是 omp 子会话：write agent://… 到不了它）。回消息用 send（peer + text）；list 查已知会话、log 读某个会话的完整收发记录（正文与顺序）、join 加入频道、status 看连接状态。模型/人在 IRC 里说的都得用本工具回，宿主不会代发。",
		loadMode: "essential" as const,
		approval: "write" as const,
		parameters: z.object({
			action: z.enum(["list", "send", "join", "status", "log"]).describe("操作类型"),
			peer: z.string().optional().describe("send/log：会话 id / nick / 频道"),
			text: z.string().optional().describe("send：文本内容"),
			channel: z.string().optional().describe("join：频道名（缺 # 前缀自动补）"),
			limit: z.number().optional().describe("log：读最近多少条（默认 6，上限 50）"),
		}),
		async execute(
			_toolCallId: string,
			params: IrcToolParams,
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
						const known = deps.conversations.list();
						return {
							content: [
								{
									type: "text" as const,
									text:
										known.length === 0
											? "还没有任何 IRC 会话；等对方先发一条消息过来，或用 send/join 主动开口。"
											: [`已知 IRC 会话 ${known.length} 个（回消息：irc 工具 action=send）：`, ...known.map(describeConversation)].join(
													"\n",
												),
								},
							],
							details: { action: params.action, conversations: known } satisfies IrcToolDetails,
						};
					}
					case "log": {
						const known = deps.conversations.list();
						const record = params.peer
							? deps.conversations.resolve(params.peer)
							: known.length === 1
								? known[0]
								: undefined;
						if (!record) throw new Error(`找不到 IRC 会话：${params.peer ?? "(未提供 peer)"}`);
						const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 6)));
						const file = deps.transcripts.pathFor(record.id);
						return {
							content: [
								{ type: "text" as const, text: formatTranscriptDigest(deps.transcripts.tail(record.id, limit), file) },
							],
							details: { action: params.action, conversations: [record] } satisfies IrcToolDetails,
						};
					}
					case "status": {
						const status = deps.client.status();
						const state = !status.connected ? "未连接" : status.registered ? "已连接 · 已注册" : "已连接 · 注册中";
						const endpoint = status.server ? `${status.server}:${status.port}${status.tls ? " TLS" : " 明文"}` : "未配置";
						// nick 是进程里唯一「取自服务端又直接进模型上下文」的字符串（001 的第一个参数，
						// 见 client.ts 的 001 分支）：恶意/被劫持的 ircd 能借它注入控制序列或伪造
						// harness 标签。状态栏那一份由宿主自己净化，这一份得我们自己过。
						const lines = [
							`IRC：${state}（${endpoint}，昵称 ${sanitizeSingleLine(status.nick)}）`,
							`留驻频道：${status.channels.length > 0 ? status.channels.join("、") : "(无)"}`,
							`已知会话：${deps.conversations.list().length}`,
							...deps.notes.map(note => `· ${note}`),
						];
						return {
							content: [{ type: "text" as const, text: lines.join("\n") }],
							details: { action: params.action, status, notes: deps.notes } satisfies IrcToolDetails,
						};
					}
					case "send": {
						if (!params.peer?.trim()) throw new Error("send 需要 peer");
						if (!params.text?.trim()) throw new Error("send 需要 text");
						// 先查连接：未注册就直接失败，别先说「已登记」再报错（那会留下幽灵会话）。
						if (!deps.client.status().registered) throw new Error("IRC 未连接/未注册，消息未发出（status 看原因）");
						// 主动开口：还没会话过的 nick/频道当场登记（log 则要求已登记，避免给错名建出假会话）。
						const record = resolveOrCreateConversation(deps.conversations, params.peer, Date.now());
						await deps.send(record, params.text);
						return {
							content: [{ type: "text" as const, text: `已发送到 ${record.id}` }],
							details: { action: params.action, conversations: [record] } satisfies IrcToolDetails,
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
