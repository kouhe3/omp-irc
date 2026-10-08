/**
 * 测试用的本地 mock IRC server（`net.createServer`，真 TCP、真 IRC 线格式）。
 *
 * 实现 RFC1459 里我们用到的那一小块，并像真 server 一样**转发** PRIVMSG/NOTICE
 * （频道消息发给同频道其它连接，私聊发给目标 nick 的连接）——所以两个 {@link IrcClient}
 * 连上来就能真的互相说话，`bun test` 与 `bun run test/e2e-mock.ts` 都不需要外网。
 *
 * 只服务测试：不做认证、不持久、不做 flood 保护。
 */
import * as net from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { parseIrcLine, prefixNick } from "../src/client";

/** 一条连接的服务端侧状态。 */
interface Connection {
	socket: Socket;
	nick?: string;
	username?: string;
	registered: boolean;
	/** 装死：socket 保持打开，但服务端不再写任何字节（复现半开连接现场）。 */
	muted: boolean;
	readonly channels: Set<string>;
	buffer: string;
}

interface Waiter {
	check(): boolean;
	resolve(): void;
	timer: NodeJS.Timeout;
}

export interface MockIrcServerOptions {
	host?: string;
	/** 已被占用的 nick：撞上就回 433（测客户端换名自愈）。 */
	takenNicks?: readonly string[];
}

export interface MockIrcServer {
	readonly host: string;
	readonly port: number;
	/** 所有从客户端收到的原始行（不含 CRLF），按到达顺序。 */
	readonly received: string[];
	/** 当前活着的连接数。 */
	connections(): number;
	/** 已注册完成的 nick。 */
	nicks(): string[];
	/** 某个 nick 已 JOIN 的频道。 */
	channelsOf(nick: string): string[];
	/** 服务端 → 全部连接发一行（自动补 CRLF）。 */
	send(line: string): void;
	/** 服务端 → 指定 nick 的连接发一行。 */
	sendTo(nick: string, line: string): void;
	/** 模拟另一个 IRC 用户发言（按 IRC 语义转发给频道成员或私聊对象）。 */
	simulatePrivmsg(from: string, target: string, text: string): void;
	simulateNotice(from: string, target: string, text: string): void;
	/** 向所有连接发 PING。 */
	ping(token?: string): void;
	/** 掐断所有连接（模拟网络中断，客户端应退避重连）。 */
	dropAll(): void;
	/**
	 * 让某个 nick 的连接「装死」：socket 保持打开（服务端视角仍是 ESTABLISHED），但不再向它写
	 * 任何字节——模拟服务端已把客户端踢掉、FIN/ERROR 却没有到达客户端的半开现场。
	 */
	mute(nick: string): void;
	/** 等服务端收到匹配的行。 */
	waitForLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
	/** 等某个 nick 出现在服务端（注册完成）。 */
	waitForNick(nick: string, timeoutMs?: number): Promise<void>;
	/** 等某个频道被 JOIN。 */
	waitForJoin(channel: string, timeoutMs?: number): Promise<void>;
	/** 等连接数到达 count。 */
	waitForConnections(count: number, timeoutMs?: number): Promise<void>;
	/** 等任意服务端侧条件成立（事件驱动，不用真实时间轮询）。 */
	waitUntil(check: () => boolean, description: string, timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}

/**
 * 事件驱动的等待门（测试共用）：`until()` 挂条件，事件到达后由 `pump()` 唤醒。
 * 客户端侧的条件（onPrivmsg 收到几条）用它，服务端侧的条件用 {@link MockIrcServer.waitForLine} 等。
 */
export interface Gate {
	until(check: () => boolean, description: string, timeoutMs?: number): Promise<void>;
	pump(): void;
}

export function createGate(): Gate {
	const entries: { check: () => boolean; settle(): void; timer: NodeJS.Timeout }[] = [];
	return {
		until: (check, description, timeoutMs = DEFAULT_TIMEOUT_MS) => {
			if (check()) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				entries.splice(
					entries.findIndex(entry => entry.timer === timer),
					1,
				);
				reject(new Error(`等待 ${description} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			entries.push({
				check,
				timer,
				settle: () => {
					clearTimeout(timer);
					resolve();
				},
			});
			return promise;
		},
		pump: () => {
			for (const entry of [...entries]) {
				if (!entry.check()) continue;
				entries.splice(entries.indexOf(entry), 1);
				entry.settle();
			}
		},
	};
}

const DEFAULT_TIMEOUT_MS = 2_000;

export async function startMockIrcServer(options: MockIrcServerOptions = {}): Promise<MockIrcServer> {
	const host = options.host ?? "127.0.0.1";
	const taken = new Set(options.takenNicks ?? []);
	const conns = new Set<Connection>();
	const received: string[] = [];
	const waiters = new Set<Waiter>();

	const connections = (): Connection[] => [...conns];
	const nicks = (): string[] => connections().flatMap(conn => (conn.nick === undefined ? [] : [conn.nick]));
	const channelsOf = (nick: string): string[] => {
		const found = connections().find(conn => conn.nick === nick);
		return found ? [...found.channels] : [];
	};

	/** 每有状态变化就唤醒满足条件的等待者。 */
	function pump(): void {
		for (const waiter of [...waiters]) {
			if (!waiter.check()) continue;
			clearTimeout(waiter.timer);
			waiters.delete(waiter);
			waiter.resolve();
		}
	}

	/** 等 check() 成立；超时 reject（测试不该挂死）。 */
	function wait(check: () => boolean, description: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
		if (check()) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				check,
				resolve,
				timer: setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`mock IRC server：等待 ${description} 超时（${timeoutMs}ms）`));
				}, timeoutMs),
			};
			waiters.add(waiter);
		});
	}

	/** 写一行；连接被标记「装死」（{@link Connection.muted}）时一个字节都不写（socket 仍打开）。 */
	function writeLine(conn: Connection, line: string): void {
		if (conn.muted || conn.socket.destroyed) return;
		conn.socket.write(`${line}\r\n`);
	}

	function broadcast(line: string, except?: Connection): void {
		for (const conn of connections()) {
			if (conn !== except) writeLine(conn, line);
		}
	}

	/** IRC 转发语义：频道 → 同频道其它连接；nick → 该 nick 的连接。 */
	function deliver(target: string, line: string, except?: Connection): void {
		if (target.startsWith("#") || target.startsWith("&")) {
			for (const conn of connections()) {
				if (conn !== except && conn.channels.has(target)) writeLine(conn, line);
			}
			return;
		}
		for (const conn of connections()) {
			if (conn !== except && conn.nick === target) writeLine(conn, line);
		}
	}

	function maybeWelcome(conn: Connection): void {
		if (conn.registered || !conn.nick || !conn.username) return;
		conn.registered = true;
		writeLine(conn, `:mock 001 ${conn.nick} :Welcome to the mock IRC network`);
		pump();
	}

	function handleLine(conn: Connection, line: string): void {
		received.push(line);
		pump();
		const { prefix, command, params } = parseIrcLine(line);
		switch (command) {
			case "NICK": {
				const wanted = params[0] ?? "";
				if (taken.has(wanted)) {
					writeLine(conn, `:mock 433 * ${wanted} :Nickname is already in use`);
					return;
				}
				conn.nick = wanted;
				maybeWelcome(conn);
				return;
			}
			case "USER": {
				conn.username = params[0];
				maybeWelcome(conn);
				return;
			}
			case "PING": {
				writeLine(conn, `:mock PONG mock :${params[0] ?? ""}`);
				return;
			}
			case "JOIN": {
				for (const raw of (params[0] ?? "").split(",")) {
					const channel = raw.trim();
					if (!channel) continue;
					conn.channels.add(channel);
					broadcast(`:${conn.nick ?? "*"}!mock@${host} JOIN :${channel}`);
				}
				pump();
				return;
			}
			case "PART": {
				const channel = (params[0] ?? "").trim();
				conn.channels.delete(channel);
				broadcast(`:${conn.nick ?? "*"}!mock@${host} PART :${channel}`);
				pump();
				return;
			}
			case "PRIVMSG":
			case "NOTICE": {
				const target = params[0] ?? "";
				const text = params[1] ?? "";
				const from = conn.nick ?? (prefixNick(prefix) || "*");
				deliver(target, `:${from}!mock@${host} ${command} ${target} :${text}`, conn);
				return;
			}
			case "QUIT": {
				conn.socket.end();
				return;
			}
			default:
				return;
		}
	}

	const server = net.createServer(socket => {
		socket.setEncoding("utf8");
		const conn: Connection = { socket, registered: false, muted: false, channels: new Set(), buffer: "" };
		conns.add(conn);
		socket.on("data", chunk => {
			conn.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let index = conn.buffer.indexOf("\n");
			while (index !== -1) {
				const line = conn.buffer.slice(0, index).replace(/\r$/, "");
				conn.buffer = conn.buffer.slice(index + 1);
				if (line.trim()) handleLine(conn, line);
				index = conn.buffer.indexOf("\n");
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			conns.delete(conn);
			pump();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => resolve());
	});
	const port = (server.address() as AddressInfo).port;

	return {
		host,
		port,
		received,
		connections: () => conns.size,
		nicks,
		channelsOf,
		send: line => broadcast(line),
		sendTo: (nick, line) => {
			for (const conn of connections()) if (conn.nick === nick) writeLine(conn, line);
		},
		simulatePrivmsg: (from, target, text) => deliver(target, `:${from}!mock@${host} PRIVMSG ${target} :${text}`),
		simulateNotice: (from, target, text) => deliver(target, `:${from}!mock@${host} NOTICE ${target} :${text}`),
		ping: (token = "keepalive") => broadcast(`PING :${token}`),
		dropAll: () => {
			for (const conn of connections()) conn.socket.destroy();
		},
		mute: nick => {
			for (const conn of connections()) if (conn.nick === nick) conn.muted = true;
		},
		waitForLine: async (pattern, timeoutMs) => {
			await wait(() => received.some(line => pattern.test(line)), `匹配行 ${pattern}`, timeoutMs);
			return received.find(line => pattern.test(line)) ?? "";
		},
		waitForNick: (nick, timeoutMs) => wait(() => nicks().includes(nick), `nick ${nick}`, timeoutMs),
		waitForJoin: (channel, timeoutMs) => wait(() => connections().some(conn => conn.channels.has(channel)), `JOIN ${channel}`, timeoutMs),
		waitForConnections: (count, timeoutMs) => wait(() => conns.size === count, `${count} 条连接`, timeoutMs),
		waitUntil: (check, description, timeoutMs) => wait(check, description, timeoutMs),
		close: async () => {
			for (const waiter of waiters) clearTimeout(waiter.timer);
			waiters.clear();
			for (const conn of connections()) conn.socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
