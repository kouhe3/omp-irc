/**
 * omp 扩展入口：把 omp 作为 **IRC 客户端**接入 IRC server，把私聊/频道接成一条独立的渠道
 * （与 IRC 上的其它 agent 对等通话）。
 *
 * 装配顺序（配置/依赖都在这里注入，核心模块不碰宿主）：
 *   config → IrcTranscripts → ConversationDirectory → IrcClient → 入站注入
 * （注入口先建好、每个主会话 session_start 换代；会话目录与客户端随后挂上去。）
 * 与宿主之间只有两个面（都是公开扩展 API）：
 *   入站：`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`（src/inbound.ts）
 *   出站：`irc` 工具与 `/irc send` 命令（IRC 会话**不是** omp 子会话，不注册进 AgentRegistry）
 * 刻意不走宿主 omp 的 IRC 面（IrcBus / peer 替身 / `deliverIrcMessage` / `irc:incoming`）：
 * 那是给 omp 内部 agent 之间通信（子代理编排）设计的，peer 面的语义不属于外部渠道。
 *
 * 生命周期：主会话 session_start 连接，session_shutdown 断开并清掉状态栏；
 * `/irc disconnect` / `/irc connect` 可随时在同一会话里换手（断开只停传输层，会话登记与转录保留）；
 * 子会话（kind "sub"）不重复连接——IRC 连接是进程级单例。
 *
 * 昵称是**实例专属**的：最终昵称 = `nick` + `-` + 工作区标签（`ctx.cwd` 的目录名，`D:/JXAI` →
 * `omp-jxai`），因此同一台机器上多个 omp 实例连同一个频道也能分辨（`nickSuffix` 可改模板或关闭）。
 *
 * 配置见 README；最小可用：`<agentDir>/irc.json` 写 `{"server":"irc.example.org","nick":"omp"}`，
 * 或设 `IRC_SERVER` / `IRC_NICK`。不配也能加载：`/irc status` 会说明缺什么。
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { IrcClient, type IrcInboundMessage } from "./src/client";
import { runIrcCommand } from "./src/commands";
import { loadConfig, type IrcConfig, type IrcLogger } from "./src/config";
import { ConversationDirectory, type ConversationRecord } from "./src/conversations";
import { createHostSink, createInboundHandler, type InboundInjector } from "./src/inbound";
import { createOutboundSender } from "./src/outbound";
import { IrcTranscripts } from "./src/transcript";
import { defineIrcTool, type IrcToolDeps } from "./src/tool";

/** 会话上限（超出按最近活跃淘汰；转录文件不受影响）。 */
const CONVERSATION_LIMIT = 200;
/** 状态栏那一格的 key。 */
const IRC_STATUS_KEY = "irc";

/** 宿主 UI 上我们用到的一格（TUI 有，其它模式是 no-op 桩）。 */
interface StatusUiHost {
	setStatus(key: string, text: string | undefined): void;
}

interface IrcRuntime {
	config: IrcConfig;
	notes: string[];
	conversations: ConversationDirectory;
	client: IrcClient;
	/** 出站投递（发 PRIVMSG + 落转录）；工具与命令共用这一份。 */
	send: (record: ConversationRecord, text: string) => Promise<void>;
	transcripts: IrcTranscripts;
	logger: IrcLogger;
	ui: StatusUiHost;
	/**
	 * 入站注入口。扩展工厂会被每个会话重新绑定（进程级单例只保留第一份 runtime），
	 * 所以这里存的是**可变**对象：每次主会话 session_start 换代成当前的 `pi`。
	 */
	inject: InboundInjector;
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
	if (status.registered) return `IRC ● ${status.nick}（${target.conversations.list().length} 会话）`;
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
 * 断开并停止自动重连；重复调用是 no-op。只停传输层：会话登记与转录留在原地，
 * 所以重连后 `irc send <同一个 nick>` 继续可用。
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
	const transcripts = new IrcTranscripts(config.transcriptDir, logger);
	// 入站注入口（见 IrcRuntime.inject 的注释）：对象不变，方法每次 session_start 换代。
	const inject: InboundInjector = { sendMessage: (message, options) => pi.sendMessage(message, options) };
	// 每个会话一份 jsonl 转录：`/irc log`（人）与 `irc log`（模型）都读它，正文不截断。
	const conversations = new ConversationDirectory({
		limit: CONVERSATION_LIMIT,
		onChange: () => {
			if (runtime) updateStatus(runtime);
		},
	});

	// 客户端要先建（它持有回调），而入站管线要用 client 取自己的 nick：先占位、建完立刻换上。
	let onInbound: (message: IrcInboundMessage) => void = () => {};
	const client = new IrcClient({
		host: config.server ?? "",
		port: config.port,
		tls: config.tls,
		nick: config.nick,
		password: config.password,
		channels: config.channels,
		// 心跳缺省开（60s/30s）：半开连接不会产生任何 socket 事件，只靠 close 驱动的重连永远不会触发。
		keepalive:
			config.keepaliveSeconds > 0
				? {
						intervalMs: config.keepaliveSeconds * 1000,
						timeoutMs: (config.keepaliveTimeoutSeconds ?? config.keepaliveSeconds) * 1000,
					}
				: undefined,
		logger,
		onPrivmsg: message => onInbound(message),
		onNotice: message => onInbound(message),
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

	/** 入站消息：登记会话（首次即登记）→ 落转录 → 注入主会话卡片。 */
	onInbound = createInboundHandler({
		conversations,
		transcripts,
		deliver: createHostSink(inject),
		selfNick: () => client.status().nick,
	});

	const sendOutbound = createOutboundSender({
		client,
		transcripts,
		touch: id => conversations.touch(id),
	});

	const created: IrcRuntime = {
		config,
		notes,
		conversations,
		client,
		send: sendOutbound,
		transcripts,
		logger,
		ui: ctx.ui,
		inject,
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
					conversations: runtime.conversations,
					client: runtime.client,
					send: runtime.send,
					transcripts: runtime.transcripts,
					logger: runtime.logger,
					notes: runtime.notes,
				}
			: undefined;

	pi.registerTool(defineIrcTool(pi, deps));

	pi.registerCommand("irc", {
		description:
			"IRC 渠道：status | connect | disconnect | list | log <peer> [条数] | send <peer> <正文> | join <#频道> | part <#频道>（/irc help 看全部）",
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
					conversations: current.conversations,
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
		// 宿主会把扩展工厂重新绑定到新会话（runtime 仍是同一份）：入站注入要落到当前会话。
		current.inject.sendMessage = (message, options) => pi.sendMessage(message, options);
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
		// 会话登记是进程内的（id 由 nick/频道名派生，重连后可重建）；退出前清掉，状态栏也清。
		current.conversations.clear();
		ctx.ui.setStatus(IRC_STATUS_KEY, undefined);
	});
}
