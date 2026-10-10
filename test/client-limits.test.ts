/**
 * client 传输层安全上限（P2）测试：入站缓冲/单行字节上限、服务端控 nick 校验、服务端改名、
 * 退避重置点、注册超时。全部用假 socket + 假定时器驱动真实 {@link IrcClient}，无网络。
 *
 * 与 test/protocol.test.ts 同风格（假 socket / 假定时器在那里也有一份；测试彼此独立，不跨文件共享）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	IrcClient,
	MAX_INBOUND_BUFFER_BYTES,
	MAX_INBOUND_LINE_BYTES,
	REGISTER_TIMEOUT_MS,
	nickEquals,
	type IrcClientOptions,
	type IrcInboundMessage,
	type IrcSocket,
	type IrcTimers,
} from "../src/client";
import type { IrcLogger } from "../src/config";

const clients: IrcClient[] = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.stop();
});

/** 假 socket：把事件面暴露给测试、记录写出的原始行。 */
class FakeSocket implements IrcSocket {
	readonly writes: string[] = [];
	/** destroy() 次数：上限/超时路径据此断言（真实 node 随后会发 close）。 */
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

/** 假定时器：只记录延迟，由测试手动触发「下一个到期」的回调（顺序确定性）。 */
class FakeTimers implements IrcTimers {
	readonly delays: number[] = [];
	readonly #pending: FakeTimerHandle[] = [];
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

	/** 还没被 clear 的定时器数量（断言「001/close 清掉了注册超时」）。 */
	get pending(): number {
		return this.#pending.length;
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

/** 记录 warn 文本的 logger（断言「只 warn 一次」「非法值有告警」）。 */
class RecordingLogger implements IrcLogger {
	readonly infos: string[] = [];
	readonly warns: string[] = [];

	info(message: string): void {
		this.infos.push(message);
	}

	warn(message: string): void {
		this.warns.push(message);
	}

	error(): void {}

	debug(): void {}
}

interface Harness {
	client: IrcClient;
	socket: FakeSocket;
	timers: FakeTimers;
	logger: RecordingLogger;
	errors: Error[];
}

/** 真实 IrcClient + 假 socket/假定时器/记录 logger。 */
function makeClient(overrides: Partial<IrcClientOptions> = {}): Harness {
	const socket = new FakeSocket();
	const timers = new FakeTimers();
	const logger = new RecordingLogger();
	const errors: Error[] = [];
	const client = new IrcClient({
		host: "mock",
		port: 6667,
		nick: "omp",
		socketFactory: () => socket,
		timers,
		logger,
		onError: error => errors.push(error),
		...overrides,
	});
	clients.push(client);
	return { client, socket, timers, logger, errors };
}

/** 记录 privmsg 的收集器。 */
function collectPrivmsg(client: IrcClient): IrcInboundMessage[] {
	const seen: IrcInboundMessage[] = [];
	client.onPrivmsg = message => seen.push(message);
	return seen;
}

/** 退避序列断言：滤掉注册超时定时器（每次 connect 都会排一个，与退避无关）。 */
function backoffDelays(timers: FakeTimers): number[] {
	return timers.delays.filter(ms => ms !== REGISTER_TIMEOUT_MS);
}

describe("nickEquals（RFC1459 casemapping）", () => {
	test("大小写与 []{}|~^ 折叠后相等；不同 nick 不相等", () => {
		expect(nickEquals("omp", "OMP")).toBe(true);
		expect(nickEquals("[omp]", "{OMP}")).toBe(true);
		expect(nickEquals("a|b", "a\\b")).toBe(true);
		expect(nickEquals("a~b", "a^b")).toBe(true);
		expect(nickEquals("omp", "omp_")).toBe(false);
		expect(nickEquals("", "")).toBe(true);
	});
});

describe("入站字节上限（P2：缓冲无界增长 / 超长行）", () => {
	test("无完整行的缓冲超过 MAX_INBOUND_BUFFER_BYTES → emitError + destroy，且不投递", () => {
		const { client, socket, errors } = makeClient();
		const seen = collectPrivmsg(client);
		client.start();
		socket.emit("connect");

		socket.emit("data", "A".repeat(MAX_INBOUND_BUFFER_BYTES + 1));
		expect(socket.destroyCalls).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("入站缓冲");
		expect(seen).toEqual([]);

		// 缓冲已被清空：后续一小段数据不会立刻再触发一次断开。
		socket.emit("data", ":alice!a@h PRIVMSG omp :after\r\n");
		expect(seen.map(message => message.text)).toEqual(["after"]);
		expect(socket.destroyCalls).toBe(1);
	});

	test("缓冲未超限（同一行的多段拼接仍然正常）", () => {
		const { client, socket } = makeClient();
		const seen = collectPrivmsg(client);
		client.start();
		socket.emit("connect");

		// 半行（无 `\n`）：缓冲远未到 MAX_INBOUND_BUFFER_BYTES，不触发断开。
		const head = "x".repeat(4_000);
		socket.emit("data", `:alice!a@h PRIVMSG omp :${head}`);
		expect(seen).toEqual([]);
		expect(socket.destroyCalls).toBe(0);
		// 补上后半行：整行在上限内 → 正常投递。
		socket.emit("data", "tail\r\n");
		expect(seen.map(message => message.text)).toEqual([`${head}tail`]);
	});

	test("单行超过 MAX_INBOUND_LINE_BYTES → 丢弃该行、只 warn 一次；后续行仍工作", () => {
		const { client, socket, logger } = makeClient();
		const seen = collectPrivmsg(client);
		client.start();
		socket.emit("connect");

		const oversize = `:alice!a@h PRIVMSG omp :${"x".repeat(MAX_INBOUND_LINE_BYTES)}\r\n`;
		socket.emit("data", oversize);
		socket.emit("data", oversize);
		expect(seen).toEqual([]);
		expect(socket.destroyCalls).toBe(0);
		expect(logger.warns.filter(message => message.includes("超长"))).toHaveLength(1);

		// 未超限的行照常投递（上限只丢超长行，不误伤边界内的行）。
		socket.emit("data", ":bob!b@h PRIVMSG omp :ok\r\n");
		socket.emit("data", `:bob!b@h PRIVMSG omp :${"y".repeat(MAX_INBOUND_LINE_BYTES - 30)}\r\n`);
		expect(seen.map(message => message.text)).toEqual(["ok", "y".repeat(MAX_INBOUND_LINE_BYTES - 30)]);
	});
});

describe("服务端可控 nick 校验", () => {
	test("001 的 nick 非法（带空格/数字开头/超长/带 !）→ 保留本地 nick 并 warn；合法特殊字符收下", () => {
		for (const bad of ["bad nick", "1omp", "x".repeat(31), "omp!"]) {
			const { client, socket, logger } = makeClient();
			client.start();
			socket.emit("connect");
			socket.emit("data", `:mock 001 :${bad}\r\n`);
			expect(client.status().nick).toBe("omp");
			expect(logger.warns.some(message => message.includes("不合法"))).toBe(true);
		}

		const { client, socket } = makeClient();
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp[x] :welcome\r\n");
		expect(client.status().nick).toBe("omp[x]");

		// 长度 30 是上界（合法），31 才拒收。
		const boundary = makeClient();
		boundary.client.start();
		boundary.socket.emit("connect");
		boundary.socket.emit("data", `:mock 001 ${"y".repeat(30)} :welcome\r\n`);
		expect(boundary.client.status().nick).toBe("y".repeat(30));
	});

	test("433 的 nick 非法 → 不用它（退回本地 nick + 下划线）并 warn；合法则照 RFC 加下划线", () => {
		const { client, socket, logger } = makeClient();
		client.start();
		socket.emit("connect");

		socket.emit("data", ":mock 433 * omp :Nickname in use\r\n");
		expect(client.status().nick).toBe("omp_");
		expect(socket.writes).toContain("NICK omp_\r\n");

		socket.emit("data", ":mock 433 * :bad nick\r\n");
		expect(client.status().nick).toBe("omp__");
		expect(socket.writes).toContain("NICK omp__\r\n");
		expect(logger.warns.some(message => message.includes("433"))).toBe(true);
	});
});

describe("服务端改名（NICK）与身份比较", () => {
	test("服务端按 casemapping 改我们的 nick → status().nick 更新；别人的改名忽略；非法新 nick 不收下", () => {
		const { client, socket } = makeClient({ nick: "[omp]" });
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 [omp] :welcome\r\n");
		expect(client.status().nick).toBe("[omp]");

		// 别人的 NICK 与我们的身份折叠不相等 → 不动我们的 nick。
		socket.emit("data", ":alice!a@h NICK :alice2\r\n");
		expect(client.status().nick).toBe("[omp]");

		// prefix `{OMP}` 在 casemapping 下就是 `[omp]`：认这个改名。
		socket.emit("data", ":{OMP}!o@h NICK :{omp}2\r\n");
		expect(client.status().nick).toBe("{omp}2");

		// 新 nick 非法（带空格）→ 不收下，保留本地值。
		socket.emit("data", ":{OMP}2!o@h NICK :bad nick\r\n");
		expect(client.status().nick).toBe("{omp}2");
	});

	test("casemapping 下自己发的 PRIVMSG 不当入站投递（同行从别人来的仍投递）", () => {
		const { client, socket } = makeClient({ nick: "[omp]" });
		const seen = collectPrivmsg(client);
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 [omp] :welcome\r\n");

		socket.emit("data", ":{OMP}!o@h PRIVMSG #chan :mine\r\n");
		expect(seen).toEqual([]);
		socket.emit("data", ":alice!a@h PRIVMSG #chan :yours\r\n");
		expect(seen.map(message => message.text)).toEqual(["yours"]);
	});
});

describe("退避重置点与注册超时", () => {
	/** 每次 connect 都产出一个新假 socket 的客户端。 */
	function makeBackoffClient(): { client: IrcClient; sockets: FakeSocket[]; timers: FakeTimers } {
		const sockets: FakeSocket[] = [];
		const timers = new FakeTimers();
		const client = new IrcClient({
			host: "mock",
			port: 6667,
			nick: "omp",
			timers,
			reconnect: { base: 20, max: 80 },
			socketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		});
		clients.push(client);
		return { client, sockets, timers };
	}

	test("accept-then-close 循环：TCP 连上不重置退避（20/40/80/80）", () => {
		const { client, sockets, timers } = makeBackoffClient();
		client.start();
		expect(sockets).toHaveLength(1);

		for (let round = 0; round < 4; round++) {
			sockets.at(-1)?.emit("connect"); // 只连上、永远不完成注册
			sockets.at(-1)?.emit("close");
			expect(backoffDelays(timers).at(-1)).toBe(Math.min(80, 20 * 2 ** round));
			timers.runNext();
		}
		expect(backoffDelays(timers)).toEqual([20, 40, 80, 80]);
		expect(sockets).toHaveLength(5);
	});

	test("注册成功（001）后退避归零：断线重新从 base 开始", () => {
		const { client, sockets, timers } = makeBackoffClient();
		client.start();
		sockets[0]?.emit("connect");
		sockets[0]?.emit("close"); // 未注册 → attempts 1
		timers.runNext();
		expect(backoffDelays(timers)).toEqual([20]);

		sockets[1]?.emit("connect");
		sockets[1]?.emit("data", ":mock 001 omp :welcome\r\n"); // 注册 → attempts 归零
		sockets[1]?.emit("close");
		expect(backoffDelays(timers)).toEqual([20, 20]); // 第二次仍是 base，而不是 40
	});

	test("connect 后 REGISTER_TIMEOUT_MS 内没等到 001 → emitError + destroy", () => {
		const { client, socket, timers, errors } = makeClient();
		client.start();
		socket.emit("connect");
		expect(timers.delays).toEqual([REGISTER_TIMEOUT_MS]);

		timers.runNext();
		expect(socket.destroyCalls).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("注册超时");
	});

	test("001 清掉注册超时（到点无事发生）", () => {
		const { client, socket, timers } = makeClient();
		client.start();
		socket.emit("connect");
		socket.emit("data", ":mock 001 omp :welcome\r\n");
		expect(timers.pending).toBe(0);

		timers.runNext(); // 无待触发项（已 clear）→ 空跑
		expect(socket.destroyCalls).toBe(0);
	});

	test("close 清掉注册超时（不残留、不误杀下一次连接）", () => {
		const { client, socket, timers, errors } = makeClient({ reconnect: { base: 20, max: 20 } });
		client.start();
		socket.emit("connect");
		socket.emit("close");
		expect(timers.pending).toBe(1); // 只剩重连定时器：注册超时已被 close 清掉

		timers.runNext();
		expect(errors).toEqual([]);
	});

	test("未 connect 时不武装注册超时", () => {
		const { client, timers } = makeClient();
		client.start();
		expect(timers.delays).toEqual([]);
	});
});
