/**
 * 极简 IRC 客户端（RFC1459 子集）：够我们与 IRC 上的其它 agent 对等通话即可。
 *
 * 覆盖：NICK/USER（+ 可选 PASS）注册、PING→PONG、JOIN/PART、PRIVMSG/NOTICE 收发、
 * 001（RPL_WELCOME）与 433（ERR_NICKNAMEINUSE，自动换名重试）、CRLF 分帧、正文按
 * 512 字节上限切分、断线指数退避重连并在重连后重新 JOIN。**不做** SASL / IRCv3 扩展
 * （见 README）。
 *
 * 出站不做「未注册就排队」，也不在客户端里拦未注册：`privmsg`/`notice` 只在 **socket 已连上**
 * 时写出（{@link IrcClient.send}），是否「已注册」由调用方先查 `status().registered`
 * （`irc` 工具与 `/irc send` 都查，见 src/tool.ts、src/commands.ts）——握手窗口（TCP 已连、
 * 001 未到）里写进去的 PRIVMSG 会被服务端按 451 丢掉，所以那一层必须挡在前面。
 *
 * 可测性：socket 由 {@link SocketFactory} 注入（默认 net.connect / tls.connect），
 * 定时器由 {@link IrcTimers} 注入，因此重连退避与协议解析都能在 `bun test` 下无网络断言。
 */
import * as net from "node:net";
import * as tls from "node:tls";
import type { IrcLogger } from "./config";

/** IRC 行（含 CRLF 前）的字节上限，RFC1459 §2.3。 */
export const MAX_IRC_BYTES = 512;

/** 客户端实际用到的 socket 面（net.Socket / tls.TLSSocket 都满足，工厂里做一次断言）。 */
export interface IrcSocket {
	write(data: string): boolean;
	end(): void;
	destroy(): void;
	on(event: "connect", listener: () => void): unknown;
	on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: () => void): unknown;
}

export interface IrcSocketOptions {
	host: string;
	port: number;
	tls: boolean;
}

export type SocketFactory = (options: IrcSocketOptions) => IrcSocket;

/** 默认 socket 工厂：明文走 net，TLS 走 tls（按系统 CA 校验）。 */
export const defaultSocketFactory: SocketFactory = options => {
	const socket = options.tls
		? tls.connect({ host: options.host, port: options.port })
		: net.connect({ host: options.host, port: options.port });
	socket.setEncoding("utf8");
	// 真实 net/tls Socket 满足 IrcSocket 的事件面与 write/end/destroy（多出的成员不影响结构化赋值）。
	return socket as unknown as IrcSocket;
};

/** 注入的定时器面（测试里用假实现把退避变成确定性的）。 */
export interface IrcTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemTimers: IrcTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown,
	clearTimeout: handle => {
		clearTimeout(handle as NodeJS.Timeout);
	},
};

/** 一条归一化的入站消息（PRIVMSG/NOTICE 共用）。 */
export interface IrcInboundMessage {
	/** 发送方 nick（prefix 里 `nick!user@host` 的第一段）。 */
	from: string;
	/** 频道名（含 #/&）或我们的 nick（私聊）。 */
	target: string;
	text: string;
	/** 目标是不是频道（决定会话是频道还是私聊）。 */
	channel: boolean;
	/** NOTICE 而不是 PRIVMSG。 */
	notice: boolean;
	/** IRCv3 `msgid` 标签（RFC1459 没有，缺省 undefined）。 */
	serverId?: string;
	/** 原始行（排障用）。 */
	raw: string;
}

export interface IrcJoinEvent {
	nick: string;
	channel: string;
	/** 是不是我们自己。 */
	self: boolean;
}

export interface IrcClientStatus {
	server: string;
	port: number;
	tls: boolean;
	nick: string;
	connected: boolean;
	registered: boolean;
	/** 期望留驻的频道（重连后据此重新 JOIN）。 */
	channels: string[];
	/** 连续重连次数（成功后归零）。 */
	attempts: number;
}

export interface IrcClientOptions {
	host: string;
	port: number;
	tls?: boolean;
	nick: string;
	/** USER 命令的用户名，缺省用 nick。 */
	username?: string;
	/** USER 命令的 realname，缺省 "omp IRC channel"。 */
	realname?: string;
	/** 连接密码（PASS）。 */
	password?: string;
	/** 启动时 JOIN 的频道。 */
	channels?: readonly string[];
	logger?: IrcLogger;
	socketFactory?: SocketFactory;
	/** 指数退避：base * 2^attempts，上限 max（毫秒）。 */
	reconnect?: { base?: number; max?: number };
	/**
	 * 心跳（缺省关闭）：每隔 `intervalMs` 主动 `PING :token`；若某个 PING 之后 `timeoutMs`
	 * 内仍 **没有任何入站行**（服务端的 PING、别人的 PRIVMSG 都算），就判定连接已死并主动
	 * 断开，走既有的退避重连。`timeoutMs` 缺省 = `intervalMs`。
	 */
	keepalive?: { intervalMs: number; timeoutMs?: number };
	timers?: IrcTimers;
	onPrivmsg?(message: IrcInboundMessage): void;
	onNotice?(message: IrcInboundMessage): void;
	onJoin?(event: IrcJoinEvent): void;
	onRegistered?(): void;
	onDisconnect?(error?: Error): void;
	onError?(error: Error): void;
}

interface ParsedLine {
	prefix?: string;
	command: string;
	params: string[];
}

/** 把 IRC 行拆成 prefix / command / params（trailing 前面带 ":" 的按一个参数处理）。 */
export function parseIrcLine(line: string): ParsedLine {
	let rest = line;
	let prefix: string | undefined;
	if (rest.startsWith(":")) {
		const end = rest.indexOf(" ");
		if (end === -1) return { command: "", params: [] };
		prefix = rest.slice(1, end);
		rest = rest.slice(end + 1);
	}
	const params: string[] = [];
	while (rest.length > 0) {
		if (rest.startsWith(":")) {
			params.push(rest.slice(1));
			break;
		}
		const end = rest.indexOf(" ");
		if (end === -1) {
			params.push(rest);
			break;
		}
		params.push(rest.slice(0, end));
		rest = rest.slice(end + 1);
	}
	const command = params.shift() ?? "";
	return { prefix, command, params };
}

/** prefix → nick（`nick!user@host` → `nick`）。 */
export function prefixNick(prefix: string | undefined): string {
	if (!prefix) return "";
	const cut = prefix.search(/[!@]/);
	return cut === -1 ? prefix : prefix.slice(0, cut);
}

/** 一行 `:nick!user@host PRIVMSG target :` + CRLF 的字节上界（host 按 63 字节上限估）。 */
export function payloadBudget(kind: "PRIVMSG" | "NOTICE", nick: string, user: string, target: string): number {
	const overhead =
		1 +
		Buffer.byteLength(nick, "utf8") +
		1 +
		Buffer.byteLength(user, "utf8") +
		1 +
		63 +
		1 +
		kind.length +
		1 +
		Buffer.byteLength(target, "utf8") +
		2 +
		2;
	return MAX_IRC_BYTES - overhead;
}

/**
 * 按 UTF-8 字节切分正文（不切碎多字节字符）：换行是硬断点，命中预算时优先在最近的
 * 空格处断开。返回的每一块都 ≤ budget 字节。
 */
export function splitByBytes(text: string, budget: number): string[] {
	const limit = Math.max(8, Math.floor(budget));
	const chunks: string[] = [];
	let current = "";
	let bytes = 0;
	/** current 里最后一个可断空格的下标。 */
	let lastBreak = -1;
	for (const char of text) {
		if (char === "\n") {
			if (current) chunks.push(current);
			current = "";
			bytes = 0;
			lastBreak = -1;
			continue;
		}
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > limit && current) {
			const cut = lastBreak > 0 ? lastBreak : current.length;
			chunks.push(current.slice(0, cut));
			current = lastBreak > 0 ? current.slice(cut + 1) : "";
			bytes = Buffer.byteLength(current, "utf8");
			lastBreak = -1;
		}
		current += char;
		bytes += size;
		if (char === " ") lastBreak = current.length - 1;
	}
	if (current) chunks.push(current);
	return chunks;
}

export class IrcClient {
	onPrivmsg?: (message: IrcInboundMessage) => void;
	onNotice?: (message: IrcInboundMessage) => void;
	onJoin?: (event: IrcJoinEvent) => void;
	onRegistered?: () => void;
	onDisconnect?: (error?: Error) => void;
	onError?: (error: Error) => void;

	readonly #host: string;
	readonly #port: number;
	readonly #tls: boolean;
	readonly #username: string;
	readonly #realname: string;
	readonly #password: string | undefined;
	readonly #logger: IrcLogger | undefined;
	readonly #factory: SocketFactory;
	readonly #timers: IrcTimers;
	readonly #base: number;
	readonly #max: number;
	/** 期望留驻的频道；重连成功后据此重新 JOIN（也是 `status().channels`）。 */
	readonly #desired = new Set<string>();
	#nick: string;
	#socket?: IrcSocket;
	#buffer = "";
	#connected = false;
	#registered = false;
	#running = false;
	#attempts = 0;
	#reconnectTimer?: unknown;
	#keepalive?: { intervalMs: number; timeoutMs: number };
	/** 下一次发 PING 的定时器。 */
	#keepaliveTimer?: unknown;
	/** 本次 PING 的判死截止定时器（收到任何入站行即取消）。 */
	#keepaliveDeadline?: unknown;
	/** 已发出、尚未被任何入站行确认的 PING 时间；undefined = 没有未决心跳。 */
	#pingSentAt?: number;
	#pingSeq = 0;

	constructor(options: IrcClientOptions) {
		this.#host = options.host;
		this.#port = options.port;
		this.#tls = options.tls ?? false;
		this.#nick = options.nick;
		this.#username = options.username ?? options.nick;
		this.#realname = options.realname ?? "omp IRC channel";
		this.#password = options.password;
		this.#logger = options.logger;
		this.#factory = options.socketFactory ?? defaultSocketFactory;
		this.#timers = options.timers ?? systemTimers;
		this.#base = options.reconnect?.base ?? 500;
		this.#max = options.reconnect?.max ?? 30_000;
		const interval = options.keepalive?.intervalMs ?? 0;
		this.#keepalive =
			interval > 0
				? { intervalMs: interval, timeoutMs: Math.max(1, options.keepalive?.timeoutMs ?? interval) }
				: undefined;
		for (const channel of options.channels ?? []) this.#desired.add(normalizeChannel(channel));
		this.onPrivmsg = options.onPrivmsg;
		this.onNotice = options.onNotice;
		this.onJoin = options.onJoin;
		this.onRegistered = options.onRegistered;
		this.onDisconnect = options.onDisconnect;
		this.onError = options.onError;
	}

	/** 启动（含自动重连）。重复调用是 no-op。 */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#attempts = 0;
		this.#open();
	}

	/** 主动断开并停止自动重连。 */
	stop(): void {
		this.#running = false;
		if (this.#reconnectTimer !== undefined) {
			this.#timers.clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		this.#clearKeepalive();
		const socket = this.#socket;
		this.#socket = undefined;
		this.#buffer = "";
		this.#connected = false;
		this.#registered = false;
		if (socket) {
			try {
				socket.end();
				socket.destroy();
			} catch {
				// 已断开的 socket 再 end/destroy 可能抛：主动收尾时忽略。
			}
		}
	}

	/** 发送注册握手（PASS / NICK / USER）。连接建立后自动调用；换 nick 时可再调。 */
	register(): void {
		if (this.#password) this.send(`PASS ${this.#password}`);
		this.send(`NICK ${this.#nick}`);
		this.send(`USER ${this.#username} 0 * :${this.#realname}`);
	}

	/** 发一条 PRIVMSG；正文按 512 字节上限切分成多条。 */
	privmsg(target: string, text: string): void {
		const budget = payloadBudget("PRIVMSG", this.#nick, this.#username, target);
		for (const chunk of splitByBytes(text, budget)) this.send(`PRIVMSG ${target} :${chunk}`);
	}

	/** 发一条 NOTICE；同样按上限切分。 */
	notice(target: string, text: string): void {
		const budget = payloadBudget("NOTICE", this.#nick, this.#username, target);
		for (const chunk of splitByBytes(text, budget)) this.send(`NOTICE ${target} :${chunk}`);
	}

	/** JOIN 并记住它（重连后会自动重新 JOIN）。未注册时只记住。 */
	join(channel: string): void {
		const name = normalizeChannel(channel);
		this.#desired.add(name);
		if (this.#registered) this.send(`JOIN ${name}`);
	}

	/** PART 并忘记它（重连后不再自动 JOIN）。未注册时只忘记。 */
	part(channel: string, reason?: string): void {
		const name = normalizeChannel(channel);
		this.#desired.delete(name);
		if (this.#registered) this.send(reason ? `PART ${name} :${reason}` : `PART ${name}`);
	}

	/** 回 PONG（PING 的 token 原样带回）。 */
	pong(token: string): void {
		this.send(token ? `PONG :${token}` : "PONG");
	}

	/** 发一行原始命令（自动补 CRLF；IRC 行内不允许 CR/LF，会被替换成空格）。 */
	send(line: string): void {
		const socket = this.#socket;
		if (!socket || !this.#connected) return;
		const flat = line.replace(/[\r\n]+/g, " ");
		try {
			socket.write(`${flat}\r\n`);
		} catch (error) {
			this.#emitError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	status(): IrcClientStatus {
		return {
			server: this.#host,
			port: this.#port,
			tls: this.#tls,
			nick: this.#nick,
			connected: this.#connected,
			registered: this.#registered,
			channels: [...this.#desired],
			attempts: this.#attempts,
		};
	}

	#open(): void {
		if (!this.#running) return;
		let socket: IrcSocket;
		try {
			socket = this.#factory({ host: this.#host, port: this.#port, tls: this.#tls });
		} catch (error) {
			this.#emitError(error instanceof Error ? error : new Error(String(error)));
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		this.#buffer = "";
		// 所有事件都按 socket 身份守卫：`destroy()` 的 close 是异步到达的，旧 socket 的 close 若在
		// 新连接建立之后才到（`/irc disconnect` 紧跟 `/irc connect`），未加守卫就会把新连接的
		// 句柄与状态覆盖掉（新连接被孤立：写不出去，还会多连一条）。
		socket.on("connect", () => {
			if (this.#socket !== socket) return;
			this.#connected = true;
			this.#attempts = 0;
			this.register();
		});
		socket.on("data", chunk => {
			if (this.#socket !== socket) return;
			this.#consume(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});
		socket.on("error", error => {
			if (this.#socket !== socket) return;
			this.#emitError(error);
		});
		// error 之后必然 close：断线处理只放这里，避免重复回调。
		socket.on("close", () => this.#onClose(socket));
	}

	/** 当前连接的 close：把状态归零并排重连。已 stop / 已被新连接接管的旧 socket 到这里直接退出。 */
	#onClose(socket: IrcSocket): void {
		if (this.#socket !== socket) return;
		const wasConnected = this.#connected;
		this.#socket = undefined;
		this.#buffer = "";
		this.#connected = false;
		this.#registered = false;
		this.#clearKeepalive();
		if (!this.#running) return;
		this.#logger?.warn("IRC 连接断开", { host: this.#host, port: this.#port, connected: wasConnected });
		this.onDisconnect?.();
		this.#scheduleReconnect();
	}

	/** 注册成功后开始心跳；`keepalive` 未配置时是 no-op。 */
	#armKeepalive(): void {
		this.#clearKeepalive();
		const keepalive = this.#keepalive;
		if (!keepalive || !this.#running) return;
		this.#keepaliveTimer = this.#timers.setTimeout(() => this.#tickKeepalive(), keepalive.intervalMs);
	}

	#tickKeepalive(): void {
		this.#keepaliveTimer = undefined;
		const keepalive = this.#keepalive;
		if (!keepalive || !this.#running || !this.#connected) return;
		this.#pingSeq += 1;
		this.#pingSentAt = Date.now();
		this.send(`PING :omp-${this.#pingSeq}`);
		// 一次静默只留一个判死截止：已经有（上一次 PING 之后没被入站撤销的）就不再排。
		// 每次心跳都重排会覆盖句柄而不 clearTimeout，旧句柄既泄漏又带着「PING 之后一直没入站」
		// 的语义在更晚的时刻触发——入站流量只撤销了「最新」那个句柄，连接就会被误判为死。
		if (this.#keepaliveDeadline === undefined) {
			this.#keepaliveDeadline = this.#timers.setTimeout(() => this.#onKeepaliveTimeout(), keepalive.timeoutMs);
		}
		this.#keepaliveTimer = this.#timers.setTimeout(() => this.#tickKeepalive(), keepalive.intervalMs);
	}

	/** PING 之后一直没有任何入站行：判定半开连接，主动断开并交给既有重连路径。 */
	#onKeepaliveTimeout(): void {
		this.#keepaliveDeadline = undefined;
		const keepalive = this.#keepalive;
		if (!keepalive || !this.#running || this.#pingSentAt === undefined) return;
		this.#pingSentAt = undefined;
		this.#logger?.warn("IRC 心跳超时，判定连接已死", {
			host: this.#host,
			port: this.#port,
			timeoutMs: keepalive.timeoutMs,
		});
		// destroy → close → #onClose()：与断线同一条恢复路径（退避重连 + 重新 JOIN）。
		this.#socket?.destroy();
	}

	/** 任何入站行都算活着：撤掉未决心跳与它的判死截止。 */
	#noteInbound(): void {
		this.#pingSentAt = undefined;
		if (this.#keepaliveDeadline === undefined) return;
		this.#timers.clearTimeout(this.#keepaliveDeadline);
		this.#keepaliveDeadline = undefined;
	}

	#clearKeepalive(): void {
		this.#pingSentAt = undefined;
		if (this.#keepaliveTimer !== undefined) {
			this.#timers.clearTimeout(this.#keepaliveTimer);
			this.#keepaliveTimer = undefined;
		}
		if (this.#keepaliveDeadline !== undefined) {
			this.#timers.clearTimeout(this.#keepaliveDeadline);
			this.#keepaliveDeadline = undefined;
		}
	}

	#scheduleReconnect(): void {
		if (!this.#running || this.#reconnectTimer !== undefined) return;
		const delay = Math.min(this.#max, this.#base * 2 ** this.#attempts);
		this.#attempts += 1;
		this.#logger?.info("IRC 准备重连", { delay });
		this.#reconnectTimer = this.#timers.setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#open();
		}, delay);
	}

	/** 逐行消费：CRLF 分帧，容忍服务端的裸 \n 与一次 data 里半行/多行。 */
	#consume(chunk: string): void {
		this.#buffer += chunk;
		let index = this.#buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.#buffer.slice(0, index).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(index + 1);
			if (line.trim()) {
				// 任何入站行（含服务端自己的 PING）都证明连接活着：撤掉未决心跳。
				this.#noteInbound();
				this.#handle(line);
			}
			index = this.#buffer.indexOf("\n");
		}
	}

	#handle(line: string): void {
		const { prefix, command, params } = parseIrcLine(line);
		switch (command) {
			case "PING": {
				this.pong(params[0] ?? "");
				return;
			}
			case "001": {
				// 服务端给的最终 nick 以 001 的第一个参数为准（433 自愈后我们也会用本地值）。
				const welcome = params[0];
				if (welcome) this.#nick = welcome;
				this.#registered = true;
				this.#logger?.info("IRC 已注册", { nick: this.#nick });
				this.onRegistered?.();
				this.#armKeepalive();
				// 重连后的重新 JOIN：desired 是留驻频道集合，这里一次性补上。
				for (const channel of this.#desired) this.send(`JOIN ${channel}`);
				return;
			}
			case "433": {
				// ERR_NICKNAMEINUSE：换名重试（RFC 建议加下划线）。
				const wanted = params[1];
				this.#nick = `${wanted && wanted !== "*" ? wanted : this.#nick}_`;
				this.#logger?.warn("IRC 昵称被占用，改用", { nick: this.#nick });
				this.send(`NICK ${this.#nick}`);
				return;
			}
			case "PRIVMSG":
			case "NOTICE": {
				const target = params[0] ?? "";
				const text = params[1] ?? "";
				const from = prefixNick(prefix);
				if (!target || !from || from === this.#nick) return;
				// CTCP（\x01ACTION …\x01 等）不属于对话正文，忽略以免噪声进模型上下文。
				if (text.startsWith("\u0001")) return;
				const message: IrcInboundMessage = {
					from,
					target,
					text,
					channel: isChannelName(target),
					notice: command === "NOTICE",
					raw: line,
				};
				if (command === "NOTICE") this.onNotice?.(message);
				else this.onPrivmsg?.(message);
				return;
			}
			case "JOIN": {
				const channel = params[0] ?? "";
				const nick = prefixNick(prefix);
				if (!channel || !nick) return;
				this.onJoin?.({ nick, channel, self: nick === this.#nick });
				return;
			}
			case "ERROR": {
				this.#emitError(new Error(`IRC ERROR：${params[0] ?? line}`));
				return;
			}
			default:
				return;
		}
	}

	#emitError(error: Error): void {
		this.#logger?.warn("IRC 客户端错误", { error: error.message });
		this.onError?.(error);
	}
}

/** 频道名以 # 或 & 开头；其余（含我们的 nick）都是私聊目标。 */
export function isChannelName(target: string): boolean {
	return target.startsWith("#") || target.startsWith("&");
}

/** 用户手写的频道名容错：没带前缀就当 #频道。 */
export function normalizeChannel(channel: string): string {
	const name = channel.trim();
	if (!name) return name;
	return isChannelName(name) ? name : `#${name}`;
}
