/**
 * 扩展入口（index.ts）的生命周期测试：**主/子会话的分工**。
 *
 * 只有主会话拥有 IRC 连接、决定入站注入落哪个宿主、退出时清理；子会话（`kind: "sub"`）
 * 在同一个进程里共享同一条连接，必须三件事都不做：不重复连接、不改编注入目标、不断开不清目录。
 * 这些是「子代理会话跑到一半把主会话的渠道搞坏」这类回归的现场，只有真装配 + 真 socket 能验。
 *
 * **index.ts 的 runtime 是模块级单例**（一个进程只有一条 IRC 连接），所以整个文件只做一次
 * 真实装配：断言全部按顺序写在同一个 test 里（子会话先于主会话 → 主会话接管 → 子会话不越权
 * → 主会话退出清理）。stub 只提供公开扩展 API（logger/zod/setLabel/registerTool/
 * registerCommand/on/sendMessage 与 `pi.getAgentDir`），没有 AgentRegistry/peer 面；
 * 线路走 test/mock-irc-server 的真 TCP。
 *
 * 等条件全部事件驱动（gate.pump() / server.waitUntil），不用 wall-clock 轮询：
 * 「子会话没连接」这类否定断言靠**同步可见的状态**取证（handler 里若真起连接，`updateStatus`
 * 是同步写状态栏的，或 NICK/JOIN 会让服务端计数变化），不靠「等一会儿看看」。
 *
 * 配置全部隔离在临时目录/临时 env 里（`IRC_CONFIG_PATH` + `IRC_*`），测试结束恢复 env 并删目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import ircExtension from "../index";
import { silentLogger, workspaceTag } from "../src/config";
import { createGate, startMockIrcServer, type Gate, type MockIrcServer } from "./mock-irc-server";

/** 注入主会话的卡片（与 e2e-mock 同一形状）。 */
interface Injection {
	customType: string;
	content: string;
	display: boolean;
	attribution: string;
	options: { deliverAs: string; triggerTurn: boolean };
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface ToolResult {
	content: { type: string; text?: string }[];
	isError?: boolean;
}
interface ToolDefinition {
	name: string;
	execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext): Promise<ToolResult>;
}
interface CommandDefinition {
	handler(args: string, ctx: ExtensionContext): Promise<void>;
}

/** 一个「宿主」的替身：只实现扩展用到的公开 API，把注册/注入分别收集起来。 */
interface Host {
	pi: ExtensionAPI;
	/** 扩展注入主会话的卡片；每个 stub 一份，用来分辨注入落到哪个宿主。 */
	cards: Injection[];
	/** 状态栏写入序列（含 `undefined` = 清掉那一格）。 */
	statuses: (string | undefined)[];
	notices: string[];
	/** 事件名 → 扩展注册的 handler（session_start / session_shutdown）。 */
	handlers: Record<string, Handler>;
	tool(): ToolDefinition | undefined;
	command(): CommandDefinition | undefined;
}

/**
 * 每个 stub 有**自己的** `sendMessage` 与状态栏数组——这正是区分「注入落到哪个宿主」的手段。
 * 卡片到达时 `gate.pump()` 唤醒测试里挂的条件（不用 wall-clock 轮询）。
 */
function makeHost(agentDir: string, gate: Gate): Host {
	const cards: Injection[] = [];
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const handlers: Record<string, Handler> = {};
	let tool: ToolDefinition | undefined;
	let command: CommandDefinition | undefined;
	// zod 的 schema 面：defineIrcTool 只做链式构造（registerTool 是 stub，不真校验）。
	const inlineSchema = (): Record<string, unknown> => {
		const node: Record<string, unknown> = {};
		node.describe = () => node;
		node.optional = () => node;
		return node;
	};
	const pi = {
		logger: silentLogger,
		zod: { string: inlineSchema, number: inlineSchema, boolean: inlineSchema, enum: inlineSchema, object: (shape: unknown) => shape },
		setLabel: () => {},
		registerTool: (definition: unknown) => {
			tool = definition as ToolDefinition;
		},
		registerCommand: (_name: string, options: unknown) => {
			command = options as CommandDefinition;
		},
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		sendMessage: (message: Omit<Injection, "options">, options: Injection["options"]) => {
			cards.push({ ...message, options });
			gate.pump();
		},
		pi: { getAgentDir: () => agentDir },
	} as unknown as ExtensionAPI;
	return { pi, cards, statuses, notices, handlers, tool: () => tool, command: () => command };
}

/** 一个会话的 ExtensionContext 替身：状态栏/通知写进该宿主自己的数组。 */
function makeCtx(kind: "main" | "sub", cwd: string, host: Host): ExtensionContext {
	return {
		agent: { kind },
		cwd,
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				host.statuses.push(text);
			},
			notify: (text: string) => {
				host.notices.push(text);
			},
		},
	} as unknown as ExtensionContext;
}

const root = mkdtempSync(path.join(os.tmpdir(), "irc-ext-"));
const agentDir = path.join(root, "agent");
const workspaceDir = path.join(root, "My Workspace");
const BASE_NICK = "omptest";
/** 实例专属昵称：`nick` + 工作区标签（ctx.cwd 的目录名），与 loadConfig 同一规则。 */
const EXPECTED_NICK = `${BASE_NICK}-${workspaceTag(workspaceDir)}`;

mkdirSync(agentDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

const server: MockIrcServer = await startMockIrcServer();
writeFileSync(
	path.join(agentDir, "irc.json"),
	JSON.stringify({
		server: server.host,
		port: server.port,
		tls: false,
		nick: BASE_NICK,
		channels: ["#life"],
		transcriptDir: path.join(root, "transcripts"),
	}),
	"utf8",
);

/** 机器上真实的 IRC_* 先摘掉（否则会盖住临时配置），测试结束原样放回。 */
const savedEnv = new Map<string, string>();
for (const key of Object.keys(process.env)) {
	if (!key.startsWith("IRC_")) continue;
	savedEnv.set(key, process.env[key] ?? "");
	delete process.env[key];
}
process.env.IRC_CONFIG_PATH = path.join(agentDir, "irc.json");
process.env.IRC_SERVER = server.host;
process.env.IRC_PORT = String(server.port);
process.env.IRC_NICK = BASE_NICK;
process.env.IRC_TRANSCRIPT_DIR = path.join(root, "transcripts");

afterAll(async () => {
	await server.close();
	for (const key of Object.keys(process.env)) if (key.startsWith("IRC_")) delete process.env[key];
	for (const [key, value] of savedEnv) process.env[key] = value;
	rmSync(root, { recursive: true, force: true });
});

test("子会话不连接/不改编注入目标/不清理，主会话接管并负责退出清理", async () => {
	expect(EXPECTED_NICK).toBe("omptest-my-workspace");

	// 两个宿主替身（index.ts 的工厂会被每个会话重新绑定一次），各有自己的 sendMessage。
	const gate = createGate();
	const sub = makeHost(agentDir, gate);
	const main = makeHost(agentDir, gate);
	ircExtension(sub.pi);
	ircExtension(main.pi);
	expect(sub.tool()?.name).toBe("irc");
	expect(typeof main.command()?.handler).toBe("function");

	// ── 1) 子会话先派发 session_start：不连接、不装配、不写状态栏 ─────────────────────
	const subCtx = makeCtx("sub", workspaceDir, sub);
	await sub.handlers.session_start?.({}, subCtx);
	// handler 是同步返回的（没在等 I/O），所以「没写状态栏」当场可见：真起连接的话
	// connectRuntime 会同步 updateStatus。
	expect(sub.statuses).toHaveLength(0);
	expect(server.connections()).toBe(0); // 连一个 socket 都没开
	// 子会话没有装配出 runtime：工具如实报「未初始化」（不假装自己连着）。
	const subStatus = await sub.tool()?.execute("sub-status", { action: "status" }, undefined, undefined, subCtx);
	expect(subStatus?.isError).toBe(true);
	expect(subStatus?.content[0]?.text).toContain("未初始化");

	// ── 2) 主会话派发 session_start：连接、注册、JOIN ────────────────────────────────
	const mainCtx = makeCtx("main", workspaceDir, main);
	await main.handlers.session_start?.({}, mainCtx);
	await server.waitForNick(EXPECTED_NICK);
	await server.waitForJoin("#life");
	expect(server.nicks()).toEqual([EXPECTED_NICK]);
	expect(server.channelsOf(EXPECTED_NICK)).toContain("#life");
	expect(main.statuses.at(-1)).toBe(`IRC ● ${EXPECTED_NICK}（0 会话）`);
	// 走到「主会话注册完成」时，若子会话也试过连接，它的 NICK 早就该到了：全进程只有一次握手。
	expect(server.received.filter(line => line.startsWith("NICK "))).toEqual([`NICK ${EXPECTED_NICK}`]);
	expect(server.received.filter(line => line === "JOIN #life")).toHaveLength(1);

	// ── 3) 入站落 main 那次绑定的 pi.sendMessage（sub 的计数保持 0） ─────────────────
	server.simulatePrivmsg("ircpeer", EXPECTED_NICK, "hi from ircpeer");
	await gate.until(() => main.cards.length >= 1, "主会话收到入站注入");
	expect(main.cards.at(-1)?.customType).toBe("irc:message");
	expect(main.cards.at(-1)?.content).toContain("hi from ircpeer");
	expect(sub.cards).toHaveLength(0);

	// ── 4) 主会话已在跑时再派发一次子会话 session_start：不连接、不抢注入目标 ─────────
	const cardsBefore = main.cards.length;
	await sub.handlers.session_start?.({}, subCtx);
	expect(sub.statuses).toHaveLength(0);
	// 注入目标没被改写成 sub 的 pi：后续入站仍落 main 的 sendMessage（这一轮已过服务端往返，
	// 若子会话刚起过连接，下面的 NICK/JOIN 计数也会变）。
	server.simulatePrivmsg("ircpeer", EXPECTED_NICK, "second ping");
	await gate.until(() => main.cards.length > cardsBefore, "子会话介入后入站仍注入主会话");
	expect(sub.cards).toHaveLength(0);
	expect(server.received.filter(line => line.startsWith("NICK "))).toEqual([`NICK ${EXPECTED_NICK}`]);
	expect(server.received.filter(line => line === "JOIN #life")).toHaveLength(1);

	// ── 5) `/irc disconnect` 只停传输层：会话登记与转录留在原地，connect 回来还能用 ────
	// 放在步骤 4 的 NICK/JOIN 计数断言之后，才不污染那份「全进程只握手一次」的取证。
	const command = main.command()?.handler;
	expect(typeof command).toBe("function");
	await command?.("disconnect", mainCtx); // 斜杠命令的 args 不含命令名本身
	await server.waitUntil(() => !server.nicks().includes(EXPECTED_NICK), "断开后掉线");
	expect(server.nicks()).not.toContain(EXPECTED_NICK);
	// 「只停传输层」：登记没被清（若 disconnectRuntime 里 clear() 了目录，下面这条会变成
	// 「还没有任何 IRC 会话」）。
	const afterDisconnect = await main.tool()?.execute("list-disconnect", { action: "list" }, undefined, undefined, mainCtx);
	expect(afterDisconnect?.content[0]?.text).toContain("irc-ircpeer");

	await command?.("connect", mainCtx);
	await server.waitForNick(EXPECTED_NICK);
	await server.waitForJoin("#life");
	const afterReconnect = await main.tool()?.execute("list-reconnect", { action: "list" }, undefined, undefined, mainCtx);
	expect(afterReconnect?.content[0]?.text).toContain("irc-ircpeer");
	// 转录路径仍由同一个 id 派生：重连后用重启前那个句柄能解析回同一条会话。
	const reconnectLog = await main.tool()?.execute("log-reconnect", { action: "log", peer: "irc-ircpeer" }, undefined, undefined, mainCtx);
	expect(reconnectLog?.isError).toBeUndefined();
	expect(reconnectLog?.content[0]?.text).toContain("irc-ircpeer.jsonl");
	expect(reconnectLog?.content[0]?.text).toContain("hi from ircpeer");

	// ── 6) 子会话 session_shutdown：不断开、不清目录、不清状态栏 ────────────────────
	await sub.handlers.session_shutdown?.({}, subCtx);
	expect(server.nicks()).toContain(EXPECTED_NICK); // client.stop() 没被调用
	expect(server.channelsOf(EXPECTED_NICK)).toContain("#life");
	expect(sub.statuses).toHaveLength(0); // 子会话自己那格状态栏没被写（也没被清）
	const afterSubShutdown = await main.tool()?.execute("list-sub-shutdown", { action: "list" }, undefined, undefined, mainCtx);
	expect(afterSubShutdown?.content[0]?.text).toContain("irc-ircpeer"); // 会话目录仍在

	// ── 7) 主会话 session_shutdown：清状态栏、清目录、停连接 ─────────────────────────
	await main.handlers.session_shutdown?.({}, mainCtx);
	expect(main.statuses.at(-1)).toBeUndefined();
	const afterMainShutdown = await main.tool()?.execute("list-main-shutdown", { action: "list" }, undefined, undefined, mainCtx);
	expect(afterMainShutdown?.content[0]?.text).toContain("还没有任何 IRC 会话");
	await server.waitUntil(() => !server.nicks().includes(EXPECTED_NICK), "主会话退出后掉线");
	expect(server.nicks()).not.toContain(EXPECTED_NICK);
});
