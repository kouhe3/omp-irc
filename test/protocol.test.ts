/**
 * IRC 协议层测试：分帧/解析/切分（假 socket，无网络）+ 真实 TCP 的注册/PING/JOIN/
 * 433 换名/断线重连（mock IRC server）。
 *
 * 全是事件驱动的等待（`Gate` / `server.waitForLine` / `server.waitUntil`），不睡真实时间。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	IrcClient,
	MAX_IRC_BYTES,
	parseIrcLine,
	payloadBudget,
	splitByBytes,
	type IrcClientOptions,
	type IrcInboundMessage,
	type IrcSocket,
	type IrcTimers,
} from "../src/client";
import { createGate, startMockIrcServer, type MockIrcServer } from "./mock-irc-server";

const servers: MockIrcServer[] = [];
const clients: IrcClient[] = [];

async function startServer(options?: Parameters<typeof startMockIrcServer>[0]): Promise<MockIrcServer> {
	const server = await startMockIrcServer(options);
	servers.push(server);
	return server;
}

function startClient(server: MockIrcServer, overrides: Partial<IrcClientOptions> = {}): IrcClient {
	const client = new IrcClient({
		host: server.host,
		port: server.port,
		nick: "omp",
		channels: ["#omp"],
		// 测试要快：真实退避是 500ms 起。
		reconnect: { base: 20, max: 80 },
		...overrides,
	});
	clients.push(client);
	client.start();
	return client;
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	for (const server of servers.splice(0)) await server.close();
});

/** 假 socket：把事件面暴露给测试、记录写出的原始行。 */
class FakeSocket implements IrcSocket {
	readonly writes: string[] = [];
	/** destroy() 次数：心跳判死路径据此断言（真实 node 随后会发 close）。 */
	destroyCalls = 0;
	readonly #listeners = new Map<string, ((arg?: unknown) => void)[]>();

	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}

	end(): void {}

	destroy(): void {
		this.destroyCalls += 1;
	}

	on(event: "connect", listener: () => void): unknown;
	on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: string, listener: (...args: never[]) => void): unknown {
		// 实现签名只要求「能被 on 收下」；客户端用到的四个事件都 ≤1 个参数，测试按单参调用。
		const handler = listener as (arg?: unknown) => void;
		const listeners = this.#listeners.get(event) ?? [];
		listeners.push(handler);
		this.#listeners.set(event, listeners);
		return this;
	}

	emit(event: string, arg?: unknown): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(arg);
	}
}

/** 假定时器的排队项：句柄本身就是它（`clearTimeout(handle)` 直接摘掉）。 */
interface FakeTimerHandle {
	callback: () => void;
	due: number;
}

/**
 * 假定时器：只记录延迟，由测试手动触发下一个回调（退避/心跳序列因此是确定性的）。
 * 「下一个」按 **到期时间** 取（同刻按入队顺序，与 node timers 一致）——心跳有「下一次」与
 * 「判死」两个并行定时器，延迟不同，谁先到点必须如实复现，否则测不出时间维度的错。
 */
class FakeTimers implements IrcTimers {
	readonly delays: number[] = [];
	/** 句柄就是排队项本身，`clearTimeout(handle)` 只摘掉它——心跳有「下一次」与「判死」两个并行定时器。 */
	readonly #pending: FakeTimerHandle[] = [];
	/** 假时钟：前进到被触发定时器的到期时刻，嵌套的 setTimeout 因此有正确的基准。 */
	#now = 0;

	setTimeout(callback: () => void, ms: number): unknown {
		this.delays.push(ms);
		const entry = { callback, due: this.#now + ms };
		this.#pending.push(entry);
		return entry;
	}

	clearTimeout(handle: unknown): void {
		const index = this.#pending.indexOf(handle as FakeTimerHandle);
		if (index !== -1) this.#pending.splice(index, 1);
	}

	runNext(): void {
		let next = 0;
		for (let index = 1; index < this.#pending.length; index++) {
			if ((this.#pending[index]?.due ?? 0) < (this.#pending[next]?.due ?? 0)) next = index;
		}
		const [entry] = this.#pending.splice(next, 1);
		if (!entry) return;
		this.#now = entry.due;
		entry.callback();
	}
}

describe("splitByBytes / payloadBudget（512 字节上限）", () => {
	test("多字节字符不被切碎，每块不超预算，拼回原文", () => {
		const text = "中".repeat(300);
		const chunks = splitByBytes(text, 100);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(100);
		expect(chunks.join("")).toBe(text);
	});

	test("换行是硬断点；长行优先在空格处断开", () => {
		expect(splitByBytes("abc\ndef", 20)).toEqual(["abc", "def"]);
		const chunks = splitByBytes("aaaa bbbb cccc dddd", 10);
		for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(10);
		expect(chunks.join(" ")).toBe("aaaa bbbb cccc dddd");
	});

	test("payloadBudget 把 `:nick!user@host PRIVMSG target :` + CRLF 扣掉", () => {
		// 512 - (1 + 3 + 1 + 3 + 1 + 63 + 1 + 7 + 1 + 4 + 2 + 2)
		expect(payloadBudget("PRIVMSG", "omp", "omp", "#omp")).toBe(MAX_IRC_BYTES - 89);
	});
});

describe("IrcClient（假 socket：分帧与退避）", () => {
	test("一次 data 里的半行 + 多行都能解析（CRLF 分帧）", () => {
		const socket = new FakeSocket();
		const client = new IrcClient({ host: "mock", port: 6667, nick: "omp", socketFactory: () => socket });
		clients.push(client);
		const seen: IrcInboundMessage[] = [];
		client.onPrivmsg = message => seen.push(message);
		client.start();
		socket.emit("connect");
		expect(socket.writes).toEqual(["NICK omp\r\n", "USER omp 0 * :omp IRC channel\r\n"]);

		socket.emit("data", ":alice!a@h PRIVMSG omp :par");
		expect(seen).toHaveLength(0);
		socket.emit("data", "tial\r\n:bob!b@h PRIVMSG omp :two\r\n");
		expect(seen.map(message => message.text)).toEqual(["partial", "two"]);
		expect(seen[0]?.from).toBe("alice");
		expect(seen[0]?.channel).toBe(false);
	});

	test("断线按指数退避重连（20 → 40 → 80 → 封顶 80），连上后退避归零", () => {
		const sockets: FakeSocket[] = [];
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			socketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			reconnect: { base: 20, max: 80 },
			timers,
		});
		clients.push(client);
		client.start();
		expect(sockets).toHaveLength(1);

		for (let round = 0; round < 4; round++) {
			sockets.at(-1)?.emit("close");
			expect(timers.delays.at(-1)).toBe(Math.min(80, 20 * 2 ** round));
			timers.runNext();
		}
		expect(sockets).toHaveLength(5);
		expect(timers.delays).toEqual([20, 40, 80, 80]);

		sockets.at(-1)?.emit("connect");
		sockets.at(-1)?.emit("close");
		expect(timers.delays.at(-1)).toBe(20);
	});

	test("stop 之后不再重连", () => {
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const client = new IrcClient({ host: "mock", port: 6667, nick: "omp", socketFactory: () => socket, timers });
		clients.push(client);
		client.start();
		client.stop();
		socket.emit("close");
		expect(timers.delays).toEqual([]);
	});

	test("keepalive 未配置时不发 PING、也不排任何定时器（缺省行为不变）", () => {
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const client = new IrcClient({ host: "mock", port: 6667, nick: "omp", socketFactory: () => socket, timers });
		clients.push(client);
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp :welcome\r\n");
		expect(socket.writes.some(line => line.startsWith("PING "))).toBe(false);
		expect(timers.delays).toEqual([]);
	});

	test("keepalive：静默 interval 后发 PING，任何入站行都撤销判死截止", () => {
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			socketFactory: () => socket,
			timers,
			keepalive: { intervalMs: 1_000, timeoutMs: 400 },
		});
		clients.push(client);
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp :welcome\r\n");
		// 注册后才排第一次心跳；之前不排。
		expect(timers.delays).toEqual([1_000]);

		timers.runNext(); // 心跳到点：发 PING，并排下「判死 400」与「下一次 1000」
		expect(socket.writes).toContain("PING :omp-1\r\n");
		expect(timers.delays.slice(1)).toEqual([400, 1_000]);

		socket.emit("data", ":mock PONG mock :omp-1\r\n"); // 任何入站行都算活着
		timers.runNext(); // 跑到下一次心跳（判死截止已被撤销，不会 destroy）
		expect(socket.destroyCalls).toBe(0);
		expect(socket.writes).toContain("PING :omp-2\r\n");
	});

	test("keepalive：PING 后超时没有任何入站 → 判死并走退避重连", () => {
		const sockets: FakeSocket[] = [];
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			timers,
			keepalive: { intervalMs: 1_000, timeoutMs: 300 },
			reconnect: { base: 20, max: 20 },
			socketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		clients.push(client);
		client.start();
		const first = sockets[0];
		first?.emit("connect");
		first?.emit("data", ":mock 001 omp :welcome\r\n");

		timers.runNext(); // 心跳：发 PING + 排判死
		expect(first?.writes).toContain("PING :omp-1\r\n");
		timers.runNext(); // 判死截止到点，期间没有任何入站
		expect(first?.destroyCalls).toBe(1);

		first?.emit("close"); // 真实 node：destroy → close
		expect(timers.delays.at(-1)).toBe(20);
		timers.runNext();
		expect(sockets).toHaveLength(2);
	});

	test("keepalive：timeout > interval 时，历史判死截止不会误杀活连接", () => {
		// interval(1000) < timeout(3000)：每个心跳都会到点一次，判死截止必须「一次静默只留一个」。
		// 回归：旧实现每个心跳都直接覆盖句柄（不 clearTimeout），入站只撤销「最新」那个，
		// 更早的句柄带着「PING 后一直没入站」的语义在 t=4000 触发，把活连接判死。
		const socket = new FakeSocket();
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			socketFactory: () => socket,
			timers,
			keepalive: { intervalMs: 1_000, timeoutMs: 3_000 },
		});
		clients.push(client);
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp :welcome\r\n");

		timers.runNext(); // t=1000 心跳 1：PING + 判死截止(3000) + 下一拍(1000)
		timers.runNext(); // t=2000 心跳 2：截止还没到点，不该（在被入站撤销前）再排一个
		socket.emit("data", ":mock PONG mock :omp-2\r\n"); // 入站：撤销「当前」那个截止
		timers.runNext(); // t=3000 心跳 3：重新排一个判死截止
		timers.runNext(); // t=4000 心跳 4：旧实现泄漏的截止也在这一刻到点

		// 最后一次入站（t≈2000）与最后一次心跳（t=4000）都远没到 timeout 的静默口径。
		expect(socket.destroyCalls).toBe(0);
		expect(socket.writes).toContain("PING :omp-3\r\n");
	});

	test("半开连接：服务端装死（不写任何字节、也不关 socket）→ 心跳判死并重连回房", async () => {
		// 线上现场：Ergo 以 `Ping timeout: 2m30s` 把我们踢掉，但 ERROR/FIN 没到达本机
		// （netstat 一直 ESTABLISHED、close 事件永不触发）→ 只有我们自己的心跳能发现并重连。
		const server = await startServer();
		const registered: string[] = [];
		const client = startClient(server, {
			// 生产缺省口径（60s/30s）的压缩版；缺省值本身在 config.test.ts 里钉住。
			keepalive: { intervalMs: 100, timeoutMs: 100 },
			onRegistered: () => registered.push(client.status().nick),
		});
		await server.waitForJoin("#omp");
		const joinsBefore = server.received.filter(line => line === "JOIN #omp").length;

		server.mute("omp"); // 服务端从此一个字节都不写，socket 仍是 ESTABLISHED
		await server.waitUntil(
			() => server.received.filter(line => line === "JOIN #omp").length > joinsBefore,
			"心跳判死后重连并重新 JOIN",
			3_000,
		);

		expect(registered).toHaveLength(2);
		expect(client.status().registered).toBe(true);
		expect(server.channelsOf("omp")).toEqual(["#omp"]);
	});

	test("旧 socket 迟到的 close 不得覆盖新连接（disconnect → connect 紧挨着的情况）", () => {
		// 回归：destroy() 的 close 是异步事件。旧 socket 的 close 若在新连接建立之后才到，
		// 旧实现会把 #socket/连接状态覆盖成新 socket 的（新连接被孤立：写不出去、还会多连一条）。
		const sockets: FakeSocket[] = [];
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			timers,
			reconnect: { base: 20, max: 20 },
			socketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		clients.push(client);
		client.start();
		const first = sockets[0] as FakeSocket;
		first.emit("connect");
		first.emit("data", ":mock 001 omp :welcome\r\n");

		client.stop(); // 旧 socket 的 close 还没到
		client.start(); // 立刻重连（/irc connect 紧跟 /irc disconnect）
		const second = sockets[1] as FakeSocket;
		second.emit("connect");
		second.emit("data", ":mock 001 omp :welcome\r\n");

		first.emit("close"); // 迟到的 close
		expect(client.status().registered).toBe(true);
		expect(second.destroyCalls).toBe(0);
		expect(timers.delays).toEqual([]); // 没有额外排一次重连
		client.privmsg("alice", "still connected");
		expect(second.writes).toContain("PRIVMSG alice :still connected\r\n");
		expect(sockets).toHaveLength(2);
	});

	// 出站只由 `irc` 工具与 `/irc send` 驱动：它们先查 `status().registered`，注册前根本不发。
	// 客户端自己**没有**出站队列，`send` 只守 `!socket || !#connected`——所以「未连接就不写」靠这里，
	// 「未注册就不写」靠工具/命令层；握手窗口（TCP 已连、未回 001）的 `privmsg` 客户端不拦。
	test("connect 之前 privmsg 不写任何字节；握手窗口的拦截在工具/命令层（客户端只守 !socket || !#connected）", () => {
		const socket = new FakeSocket();
		const client = new IrcClient({ host: "mock", port: 6667, nick: "omp", socketFactory: () => socket });
		clients.push(client);
		client.start();
		// socket 已建但未连通：连 NICK/USER 都还没发（register 只在 connect 事件里调）。
		client.privmsg("alice", "x");
		expect(socket.writes).toEqual([]);

		// 握手窗口：已 TCP 连通、尚未收到 001 → `#connected` 为真，客户端照样写。
		socket.emit("connect");
		expect(client.status().registered).toBe(false);
		client.privmsg("alice", "x");
		expect(socket.writes).toContain("PRIVMSG alice :x\r\n");
	});

	test("stop() 之后 privmsg 不抛错也不写任何字节", () => {
		const socket = new FakeSocket();
		const client = new IrcClient({ host: "mock", port: 6667, nick: "omp", socketFactory: () => socket });
		clients.push(client);
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp :welcome\r\n");
		expect(client.status().registered).toBe(true);

		client.stop();
		const before = socket.writes.length;
		expect(() => client.privmsg("alice", "x")).not.toThrow();
		expect(socket.writes.length).toBe(before);
	});

});

describe("IrcClient（mock IRC server：真 TCP）", () => {
	test("注册：NICK/USER → 001 → JOIN 配置的频道", async () => {
		const server = await startServer();
		const client = startClient(server);
		await server.waitForNick("omp");
		await server.waitForJoin("#omp");
		expect(server.channelsOf("omp")).toContain("#omp");
		expect(client.status()).toMatchObject({ connected: true, registered: true, nick: "omp" });
		expect(server.received).toContain("USER omp 0 * :omp IRC channel");
	});

	test("PING → PONG（token 原样带回）", async () => {
		const server = await startServer();
		startClient(server);
		await server.waitForNick("omp");
		server.ping("tok-123");
		expect(await server.waitForLine(/^PONG :tok-123$/)).toBe("PONG :tok-123");
	});

	test("入站 PRIVMSG 私聊/频道、NOTICE、JOIN 事件", async () => {
		const server = await startServer();
		const gate = createGate();
		const privmsgs: IrcInboundMessage[] = [];
		const notices: IrcInboundMessage[] = [];
		const joins: string[] = [];
		const client = startClient(server, {
			onPrivmsg: message => {
				privmsgs.push(message);
				gate.pump();
			},
			onNotice: message => {
				notices.push(message);
				gate.pump();
			},
			onJoin: event => {
				joins.push(`${event.nick}->${event.channel}${event.self ? "(self)" : ""}`);
				gate.pump();
			},
		});
		await server.waitForNick("omp");
		await server.waitForJoin("#omp");

		server.simulatePrivmsg("alice", "omp", "你好");
		server.simulatePrivmsg("bob", "#omp", "频道广播");
		server.simulateNotice("carol", "omp", "悄悄话");
		await gate.until(() => privmsgs.length >= 2 && notices.length >= 1 && joins.length >= 1, "客户端收到 2 条 PRIVMSG + 1 条 NOTICE");

		expect(privmsgs.map(message => `${message.from}|${message.target}|${message.channel}|${message.text}`)).toEqual([
			"alice|omp|false|你好",
			"bob|#omp|true|频道广播",
		]);
		expect(notices.map(message => `${message.from}|${message.notice}|${message.text}`)).toEqual(["carol|true|悄悄话"]);
		expect(joins).toContain("omp->#omp(self)");
		expect(client.status().channels).toEqual(["#omp"]);
	});

	test("433 昵称被占用 → 自动换名并完成注册", async () => {
		const server = await startServer({ takenNicks: ["omp"] });
		const client = startClient(server);
		await server.waitForNick("omp_");
		expect(await server.waitForLine(/^NICK omp_$/)).toBe("NICK omp_");
		expect(client.status().nick).toBe("omp_");
	});

	test("超长正文切成多条 PRIVMSG，每条（含 IRC 前缀）都不超 512 字节，拼回原文", async () => {
		const server = await startServer();
		const client = startClient(server);
		await server.waitForNick("omp");
		const text = "中".repeat(300);
		client.privmsg("alice", text);
		const chunks = (): string[] => server.received.filter(line => line.startsWith("PRIVMSG alice :"));
		await server.waitUntil(() => chunks().length >= 2, "正文被切成至少两条");

		const sent = chunks();
		expect(sent.length).toBeGreaterThan(1);
		for (const line of sent) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_IRC_BYTES);
		expect(sent.map(line => parseIrcLine(line).params[1] ?? "").join("")).toBe(text);
	});

	test("socket 断开 → 自动重连并重新 JOIN", async () => {
		const server = await startServer();
		const client = startClient(server);
		await server.waitForJoin("#omp");
		const joins = (): number => server.received.filter(line => line === "JOIN #omp").length;
		const before = joins();

		server.dropAll();
		await server.waitForConnections(0);
		await server.waitUntil(() => joins() > before, "重连后重新 JOIN");
		expect(client.status().registered).toBe(true);
		expect(server.channelsOf("omp")).toContain("#omp");
	});
});

describe("parseIrcLine", () => {
	test("prefix / command / trailing 的常规形状", () => {
		expect(parseIrcLine(":nick!user@host PRIVMSG #chan :hello : world")).toEqual({
			prefix: "nick!user@host",
			command: "PRIVMSG",
			params: ["#chan", "hello : world"],
		});
		expect(parseIrcLine("PING :tok")).toEqual({ prefix: undefined, command: "PING", params: ["tok"] });
		expect(parseIrcLine("JOIN #a,#b")).toEqual({ prefix: undefined, command: "JOIN", params: ["#a,#b"] });
	});
});
