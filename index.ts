/**
 * omp 扩展入口：把 omp 作为 **IRC 客户端**接入 IRC server，与 IRC 上的其它 agent 对等通话。
 *
 * 装配顺序（配置/依赖都在这里注入，核心模块不碰宿主）：
 *   config → PeerTranscripts → PeerDirectory(注册 peer 替身) → IrcClient → 入站桥接
 * 生命周期：主会话 session_start 连接，session_shutdown 断开并注销 peer 替身；
 * `/irc disconnect` / `/irc connect` 可随时在同一会话里换手（断开只停传输层，peer 与转录保留）；
 * 子会话（task/`/tan`）不重复连接——IRC 连接是进程级单例。
 *
 * 昵称是**实例专属**的：最终昵称 = `nick` + `-` + 工作区标签（`ctx.cwd` 的目录名，`D:/JXAI` →
 * `omp-jxai`），因此同一台机器上多个 omp 实例连同一个频道也能分辨（`nickSuffix` 可改模板或关闭）。
 *
 * 配置见 README；最小可用：`<agentDir>/irc.json` 写 `{"server":"irc.example.org","nick":"omp"}`，
 * 或设 `IRC_SERVER` / `IRC_NICK`。不配也能加载：`/irc status` 会说明缺什么。
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHostSink, createInboundHandler } from "./src/bridge";
import { IrcClient } from "./src/client";
import { runIrcCommand } from "./src/commands";
import { loadConfig, type IrcConfig, type IrcLogger } from "./src/config";
import { PeerDirectory, type PeerRecord, type PeerRegistry } from "./src/peers";
import { PeerTranscripts } from "./src/transcript";
import { defineIrcTool, type IrcToolDeps } from "./src/tool";

/** peer 上限（超出按最近活跃淘汰）。 */
const PEER_LIMIT = 200;
/** 状态栏那一格的 key。 */
const IRC_STATUS_KEY = "irc";

/** 宿主 UI 上我们用到的一格（TUI 有，其它模式是 no-op 桩）。 */
interface StatusUiHost {
	setStatus(key: string, text: string | undefined): void;
}

interface IrcRuntime {
	config: IrcConfig;
	notes: string[];
	peers: PeerDirectory;
	client: IrcClient;
	/** 出站投递（发 PRIVMSG + 落转录）；peer 替身与命令/工具共用这一份。 */
	send: (peer: PeerRecord, text: string) => Promise<void>;
	transcripts: PeerTranscripts;
	logger: IrcLogger;
	ui: StatusUiHost;
	/** 本会话是否已发起连接。 */
	started: boolean;
}

/** 进程级单例：扩展工厂会被每个会话重新绑定，IRC 连接只能有一份。 */
let runtime: IrcRuntime | undefined;

/** 状态栏文案：一眼看出「我连没连」。 */
function statusText(target: IrcRuntime): string {
	if (!target.config.configured) return "IRC ⨯ 未配置";
	const status = target.client.status();
	if (!target.started) return "IRC ○ 未连接（/irc connect）";
	// 带上自己的昵称：多个实例并排开着时，这一格是「我是哪个实例」的唯一线索。
	if (status.registered) return `IRC ● ${status.nick}（${target.peers.list().length} 会话）`;
	if (status.connected) return "IRC ◌ 注册中…";
	return status.attempts > 0 ? `IRC ◌ 重连中（第 ${status.attempts} 次）` : "IRC ◌ 连接中…";
}

function updateStatus(target: IrcRuntime): void {
	target.ui.setStatus(IRC_STATUS_KEY, statusText(target));
}

/** 发起连接（含自动重连）；重复调用是 no-op。连接/注册结果由回调与状态栏呈现。 */
function connectRuntime(target: IrcRuntime): void {
	if (target.started) return;
	target.started = true;
	target.logger.info("IRC 发起连接", {
		server: target.config.server,
		port: target.config.port,
		tls: target.config.tls,
		nick: target.config.nick,
	});
	target.client.start();
	updateStatus(target);
}

/**
 * 断开并停止自动重连；重复调用是 no-op。只停传输层：peer 替身与转录留在原地，
 * 所以重连后模型手里旧的 `agent://irc-<nick>` 继续可用。
 */
function disconnectRuntime(target: IrcRuntime): void {
	if (!target.started) return;
	target.started = false;
	target.client.stop();
	target.logger.info("IRC 已断开（/irc connect 可重连）");
	updateStatus(target);
}

function ensureRuntime(pi: ExtensionAPI, ctx: ExtensionContext): IrcRuntime {
	if (runtime) return runtime;
	const notes: string[] = [];
	// cwd 是昵称实例后缀（`{workspace}`）的来源：本机多实例据此得到不同的昵称。
	const { config } = loadConfig(pi.pi.getAgentDir(), { notes, cwd: ctx.cwd });
	const logger: IrcLogger = pi.logger;
	// AgentRegistry 满足 PeerRegistry 的结构子集（get/register/unregister）；
	// 类型层面两个模块无法互推，理由充分的断言集中在这一行。
	const registry = pi.pi.AgentRegistry.global() as unknown as PeerRegistry;
	const mainAgentId = pi.pi.MAIN_AGENT_ID;
	const transcripts = new PeerTranscripts(config.transcriptDir, logger);
	/** 入站消息序号（合成 IRC 消息 id 用；RFC1459 没有消息 id）。 */
	let seq = 0;

	let client: IrcClient | undefined;
	const sendOutbound = async (peer: PeerRecord, text: string): Promise<void> => {
		if (!client) throw new Error("IRC 客户端未初始化");
		// 出站正文原样落转录（卡片正文会截断，转录不截断），再按 512 字节上限切成 PRIVMSG。
		client.privmsg(peer.targetId, text);
		transcripts.record(peer.id, { role: "assistant", text });
	};
	// 每个 peer 一份 jsonl 转录：Agent Hub 的转录视图（⏎）与 history://<peer> 据此显示完整消息。
	const peers = new PeerDirectory({
		registry,
		mainAgentId,
		transcriptPath: peerId => transcripts.pathFor(peerId),
		send: sendOutbound,
		limit: PEER_LIMIT,
		onChange: () => {
			if (runtime) updateStatus(runtime);
		},
	});

	/** 入站消息：登记 peer（首次即注册替身）→ 落转录 → 投进主会话 irc 卡片。 */
	const onInbound = createInboundHandler({
		peers,
		transcripts,
		deliver: createHostSink({ registry, mainAgentId, logger }),
		selfNick: () => client?.status().nick ?? config.nick,
		logger,
		nextMessageId: () => `irc-${Date.now()}-${(seq += 1)}`,
	});

	client = new IrcClient({
		host: config.server ?? "",
		port: config.port,
		tls: config.tls,
		nick: config.nick,
		password: config.password,
		channels: config.channels,
		// 心跳缺省关闭（0）：真实 ircd 会 PING 客户端并在无 PONG 时断开，需要时在 irc.json 里打开。
		keepalive:
			config.keepaliveSeconds > 0
				? {
						intervalMs: config.keepaliveSeconds * 1000,
						timeoutMs: (config.keepaliveTimeoutSeconds ?? config.keepaliveSeconds) * 1000,
					}
				: undefined,
		logger,
		onPrivmsg: onInbound,
		onNotice: onInbound,
		onJoin: event => logger.debug?.("IRC JOIN", { channel: event.channel, nick: event.nick, self: event.self }),
		onRegistered: () => {
			logger.info("IRC 已连接并注册", { nick: client?.status().nick, channels: client?.status().channels });
			if (runtime) updateStatus(runtime);
		},
		onDisconnect: () => {
			if (runtime) updateStatus(runtime);
		},
		onError: error => logger.warn("IRC 客户端错误", { error: error.message }),
	});

	const created: IrcRuntime = {
		config,
		notes,
		peers,
		client,
		send: sendOutbound,
		transcripts,
		logger,
		ui: ctx.ui,
		started: false,
	};
	runtime = created;
	return created;
}

export default function (pi: ExtensionAPI): void {
	pi.setLabel("IRC");

	const deps = (): IrcToolDeps | undefined =>
		runtime
			? {
					peers: runtime.peers,
					client: runtime.client,
					// 走与 peer 替身同一条出站实现（发 PRIVMSG + 落转录）。
					send: runtime.send,
					transcripts: runtime.transcripts,
					logger: runtime.logger,
					notes: runtime.notes,
				}
			: undefined;

	pi.registerTool(defineIrcTool(pi, deps));

	pi.registerCommand("irc", {
		description:
			"IRC 渠道：status | connect | disconnect | list | log <peer> [条数] | say <peer> <正文> | join <#频道> | part <#频道>（/irc help 看全部）",
		handler: async (args, ctx) => {
			const current = runtime;
			if (!current) {
				ctx.ui.notify("IRC 渠道未初始化（当前不是主会话，或扩展尚未收到 session_start）", "warning");
				return;
			}
			const result = await runIrcCommand(
				{
					config: current.config,
					notes: current.notes,
					peers: current.peers,
					client: current.client,
					connection: {
						isStarted: () => current.started,
						connect: () => connectRuntime(current),
						disconnect: () => disconnectRuntime(current),
					},
					send: current.send,
					transcripts: current.transcripts,
					logger: current.logger,
				},
				args,
			);
			ctx.ui.notify(result.text, result.level);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 只有主会话拥有 IRC 连接；子会话共享同一个进程级 runtime。
		if (ctx.agent.kind !== "main") return;
		const current = ensureRuntime(pi, ctx);
		for (const note of current.notes) current.logger.info(`IRC: ${note}`);
		if (!current.config.configured) {
			current.logger.warn(`IRC: 未配置 server，暂不连接（写 ${current.config.configPath} 或设 IRC_SERVER）`);
			updateStatus(current);
			return;
		}
		connectRuntime(current);
		updateStatus(current);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const current = runtime;
		if (!current) return;
		current.started = false;
		current.client.stop();
		// peer 替身属于本次进程的 registry，退出前摘掉（peer 列表可按需从入站重建）。
		current.peers.clear();
		ctx.ui.setStatus(IRC_STATUS_KEY, undefined);
	});
}
