/**
 * 端到端验证（不需要外部 IRC server、不需要 omp 进程）：
 *   真实 TCP 上起一个 mock IRC server，两个 IrcClient 分别扮演 omp（我们的扩展链路）与
 *   对端 agent（peerbot），跑完下面这条完整往返：
 *
 *   peerbot --PRIVMSG omp--> mock server --转发--> omp 客户端 → PeerDirectory(替身注册) + 转录
 *     → 主会话 deliverIrcMessage（irc:incoming 卡片）
 *   peerbot <--PRIVMSG peerbot-- mock server <--转发-- omp 客户端 <-- peer 替身 deliverIrcMessage（= write agent://）
 *
 * 断言覆盖验收点：注册/JOIN、PING→PONG、入站投递 + 转录、出站 PRIVMSG、512 切分、
 * 断线重连后重新 JOIN、peer 注册面（transcriptOnly / sessionFile）。
 *
 * 运行：bun run test/e2e-mock.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ircExtension from "../index";
import { createHostSink, createInboundHandler } from "../src/bridge";
import { IrcClient, parseIrcLine, MAX_IRC_BYTES, type IrcInboundMessage } from "../src/client";
import { loadConfig, silentLogger } from "../src/config";
import { runIrcCommand } from "../src/commands";
import { PeerDirectory, type PeerRegistry } from "../src/peers";
import { PeerTranscripts } from "../src/transcript";
import { createGate, startMockIrcServer } from "./mock-irc-server";

const failures: string[] = [];
const check = (ok: boolean, description: string, detail = ""): void => {
	console.log(`${ok ? "PASS" : "FAIL"} ${description}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(description);
};

const root = mkdtempSync(path.join(os.tmpdir(), "irc-e2e-"));
console.log(`e2e 目录：${root}`);
const server = await startMockIrcServer();
console.log(`mock IRC server：${server.host}:${server.port}`);
const gate = createGate();

// ---- 主会话（宿主 AgentSession 的替换）：记录 IRC 卡片投递 ----
interface Card {
	id?: string;
	from: string;
	to: string;
	body: string;
	ts?: number;
}
const cards: Card[] = [];
const refs = new Map<string, { id: string; status?: string; session?: unknown; sessionFile?: string | null; transcriptOnly?: boolean; activity?: string }>();
const registry: PeerRegistry = {
	get: id => refs.get(id),
	register: input => {
		const ref = {
			id: input.id,
			status: input.status,
			session: input.session,
			sessionFile: input.sessionFile,
			transcriptOnly: input.transcriptOnly,
			activity: input.activity,
		};
		refs.set(input.id, ref);
		return ref;
	},
	unregister: id => refs.delete(id),
};
registry.register({
	id: "Main",
	displayName: "Main",
	kind: "sub",
	session: {
		deliverIrcMessage: async (message: Card) => {
			cards.push(message);
			gate.pump();
			return "injected";
		},
	},
});

const transcripts = new PeerTranscripts(path.join(root, "irc-transcripts"));
const omp = new IrcClient({ host: server.host, port: server.port, nick: "omp", channels: ["#omp"], reconnect: { base: 20, max: 80 } });
const peers = new PeerDirectory({
	registry,
	mainAgentId: "Main",
	transcriptPath: peerId => transcripts.pathFor(peerId),
	send: async (peer, text) => {
		omp.privmsg(peer.targetId, text);
		transcripts.record(peer.id, { role: "assistant", text });
	},
	limit: 50,
});
let seq = 0;
const onInbound = createInboundHandler({
	peers,
	transcripts,
	deliver: createHostSink({ registry, mainAgentId: "Main", logger: silentLogger }),
	selfNick: () => omp.status().nick,
	logger: silentLogger,
	nextMessageId: () => `irc-e2e-${(seq += 1)}`,
});
omp.onPrivmsg = message => void onInbound(message).then(() => gate.pump());
omp.onNotice = message => void onInbound(message).then(() => gate.pump());
omp.start();

// ---- 对端 agent：第二个真实的 IRC 客户端 ----
const inbox: IrcInboundMessage[] = [];
const peerbot = new IrcClient({ host: server.host, port: server.port, nick: "peerbot", channels: ["#omp"], reconnect: { base: 20, max: 80 } });
peerbot.onPrivmsg = message => {
	inbox.push(message);
	gate.pump();
};
peerbot.start();

try {
	await server.waitForNick("omp");
	await server.waitForJoin("#omp");
	await server.waitForNick("peerbot");
	check(true, "双方注册成功并 JOIN #omp", server.nicks().join(","));
	check(server.channelsOf("omp").includes("#omp"), "omp 在频道 #omp 里", server.channelsOf("omp").join(","));

	// 1) PING → PONG
	server.ping("e2e-token");
	check((await server.waitForLine(/^PONG :e2e-token$/)) === "PONG :e2e-token", "PING → PONG");

	// 2) 入站私聊：peerbot → omp
	peerbot.privmsg("omp", "ping from peerbot");
	await gate.until(() => cards.length >= 1, "omp 主会话收到私聊");
	const direct = cards[0];
	check(direct?.body === "[私聊] peerbot: ping from peerbot", "入站私聊进了主会话 irc 卡片", direct?.body ?? "");
	check(direct?.from === "irc-peerbot", "peer id 是 irc-<nick小写化>", direct?.from ?? "");
	const directRef = refs.get("irc-peerbot");
	check(directRef?.status === "idle" && directRef.transcriptOnly === true, "peer 替身注册面正确（idle + transcriptOnly）");
	check(directRef?.sessionFile === transcripts.pathFor("irc-peerbot"), "peer 的 sessionFile 指向转录", directRef?.sessionFile ?? "");
	const directLines = (await Bun.file(transcripts.pathFor("irc-peerbot")).text()).trim().split("\n");
	check(directLines.length === 2, "转录多了一行（header + 入站原文）", `lines=${directLines.length}`);

	// 3) 入站频道：peerbot → #omp
	peerbot.privmsg("#omp", "hello channel");
	await gate.until(() => cards.length >= 2, "omp 主会话收到频道消息");
	check(cards[1]?.body === "[#omp] peerbot: hello channel", "频道消息进了主会话（带频道名）", cards[1]?.body ?? "");
	check(cards[1]?.from === "irc-chan--omp", "频道 peer id 正确", cards[1]?.from ?? "");

	// 4) 出站：peer 替身 deliverIrcMessage → peerbot 收到 PRIVMSG
	const adapter = refs.get("irc-peerbot")?.session as { deliverIrcMessage?: (message: { from: string; to: string; body: string }) => Promise<unknown> };
	const receipt = String(await adapter.deliverIrcMessage?.({ from: "Main", to: "irc-peerbot", body: "pong from omp" }));
	await gate.until(() => inbox.length >= 1, "peerbot 收到回话");
	check(receipt === "injected", "替身 deliverIrcMessage 回 injected", receipt);
	check(inbox[0]?.from === "omp" && inbox[0]?.text === "pong from omp", "出站走通了 server 转发", `${inbox[0]?.from}: ${inbox[0]?.text}`);
	check(
		server.received.includes("PRIVMSG peerbot :pong from omp"),
		"server 侧收到 PRIVMSG <target> :<text>",
		server.received.filter(line => line.startsWith("PRIVMSG")).join(" | "),
	);

	// 5) 出站超长正文：按 512 字节切分
	const long = "长".repeat(400);
	await adapter.deliverIrcMessage?.({ from: "Main", to: "irc-peerbot", body: long });
	await server.waitUntil(() => server.received.filter(line => line.startsWith("PRIVMSG peerbot :长")).length >= 2, "长文被切分");
	const chunks = server.received.filter(line => line.startsWith("PRIVMSG peerbot :长"));
	check(chunks.length >= 2, "超长正文切成多条 PRIVMSG", `chunks=${chunks.length}`);
	check(
		chunks.every(line => Buffer.byteLength(line, "utf8") <= MAX_IRC_BYTES),
		"每条 PRIVMSG 都不超 512 字节",
		`max=${Math.max(...chunks.map(line => Buffer.byteLength(line, "utf8")))}`,
	);
	check(chunks.map(line => parseIrcLine(line).params[1] ?? "").join("") === long, "切分后能拼回原文");

	// 6) 断线重连：掐断 omp 的连接，重连后应重新 JOIN #omp
	const joins = (): number => server.received.filter(line => line === "JOIN #omp").length;
	const joinsBefore = joins();
	const connectionsBefore = server.connections();
	// dropAll 会连 peerbot 一起掐（等价于一次网络抖动）：两个客户端都应各自重连回来。
	server.dropAll();
	await server.waitForConnections(0);
	// 注意要盯 omp 自己的频道状态：两个客户端重连都会发 `JOIN #omp`，数行数分不出是谁。
	await server.waitUntil(() => server.channelsOf("omp").includes("#omp"), "omp 重连后重新 JOIN");
	check(joins() > joinsBefore, "断线后自动重连（重新 JOIN 走了一遍）", `抖动前连接数 ${connectionsBefore}，JOIN #omp ${joinsBefore} → ${joins()}`);
	check(server.channelsOf("omp").includes("#omp"), "重连后重新 JOIN 了 #omp", server.channelsOf("omp").join(","));
	check(omp.status().registered, "omp 客户端回到已注册状态");

	// 7) 转录可读（/irc log 与 Hub 转录视图共用）
	const digest = transcripts.tail("irc-peerbot", 5);
	check(digest.length >= 3, "转录里能读到完整历史（入站 + 出站）", digest.map(entry => entry.role).join(","));
	const lastOut = digest.at(-1);
	check(lastOut?.role === "assistant" && lastOut.text === long, "出站长文在转录里不截断");

	// 8) 扩展入口（index.ts）装配冒烟：用 stub ExtensionAPI 拉起真实 factory，跑通
	//    config → client → peers → bridge → tool/commands 的整套装配与退出清理。
	const extRoot = path.join(root, "ext");
	mkdirSync(extRoot, { recursive: true });
	writeFileSync(
		path.join(extRoot, "irc.json"),
		JSON.stringify({
			server: server.host,
			port: server.port,
			tls: false,
			nick: "ompext",
			channels: ["#ext"],
			transcriptDir: path.join(root, "ext-transcripts"),
		}),
		"utf8",
	);
	process.env.IRC_CONFIG_PATH = path.join(extRoot, "irc.json");
	delete process.env.IRC_SERVER;

	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
	// omptype/zod 的 schema 面：defineIrcTool 只做链式构造，registerTool 是 stub，不需要真校验。
	const schema = (): Record<string, unknown> => {
		const node: Record<string, unknown> = {};
		node.describe = () => node;
		node.optional = () => node;
		return node;
	};
	let toolDefinition: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text?: string }[] }> } | undefined;
	let commandDefinition: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const stubPi = {
		logger: silentLogger,
		zod: { string: schema, number: schema, boolean: schema, enum: schema, object: (shape: unknown) => shape },
		setLabel: () => {},
		registerTool: (definition: unknown) => {
			toolDefinition = definition as typeof toolDefinition;
		},
		registerCommand: (_name: string, options: unknown) => {
			commandDefinition = options as typeof commandDefinition;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(event, handler),
		pi: { AgentRegistry: { global: () => registry }, MAIN_AGENT_ID: "Main", getAgentDir: () => extRoot },
	} as unknown as ExtensionAPI;
	ircExtension(stubPi);
	const extCtx = {
		agent: { kind: "main" },
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (text: string) => notices.push(text),
		},
	};

	check(toolDefinition?.name === "irc", "扩展注册了 irc 工具", toolDefinition?.name ?? "(未注册)");
	check(typeof commandDefinition?.handler === "function", "扩展注册了 /irc 斜杠命令");
	await handlers.get("session_start")?.({}, extCtx);
	// 等到扩展自己的客户端注册完成（001 之后才会 JOIN）：NICK/USER 到达 ≠ 注册完成。
	await server.waitForJoin("#ext");
	check(
		server.channelsOf("ompext").includes("#ext"),
		"按 irc.json 启动并 JOIN 了 #ext",
		`channels=${server.channelsOf("ompext").join(",")} received=${server.received.slice(-6).join(" | ")}`,
	);
	check(
		statuses.some(text => text?.startsWith("IRC ● 已连接") === true),
		"状态栏更新为已连接",
		statuses.filter(Boolean).join(" → "),
	);

	const extStatus = await toolDefinition?.execute("call-1", { action: "status" }, undefined, undefined, extCtx);
	check(extStatus?.content[0]?.text?.includes("已连接 · 已注册") === true, "irc status 工具报告已注册", extStatus?.content[0]?.text ?? "");
	await commandDefinition?.handler("status", extCtx);
	check(notices.at(-1)?.includes("irc.json") === true || notices.at(-1)?.includes("连接目标") === true, "/irc status 列出配置说明", notices.at(-1)?.slice(0, 60) ?? "");

	const cardsBefore = cards.length;
	peerbot.privmsg("ompext", "hi from peerbot");
	await gate.until(
		() => cards.length > cardsBefore && cards.at(-1)?.body === "[私聊] peerbot: hi from peerbot",
		"扩展链路把入站投给主会话",
	);
	check(cards.at(-1)?.from === "irc-peerbot", "扩展的 peer 目录登记了 irc-peerbot", cards.at(-1)?.from ?? "");

	await toolDefinition?.execute("call-2", { action: "say", peer: "peerbot", text: "reply via tool" }, undefined, undefined, extCtx);
	check(await server.waitForLine(/^PRIVMSG peerbot :reply via tool$/).catch(() => "") === "PRIVMSG peerbot :reply via tool", "irc say 工具发出了 PRIVMSG");

	// 8b) /irc disconnect → /irc connect：同一会话内换手。真 TCP 上验四件事：
	//     断开后 server 侧连接消失、断开期间的出站排队不上线、重连后重新 JOIN 留驻频道、排队正文被补发。
	//     出站走**扩展自己的** peer 替身（上面 say 已把它登记进 registry，覆盖了独立链路的那个）。
	const extAdapter = refs.get("irc-peerbot")?.session as { deliverIrcMessage?: (message: { from: string; to: string; body: string }) => Promise<unknown> };
	const extJoinsBefore = server.received.filter(line => line === "JOIN #ext").length;
	await commandDefinition?.handler("disconnect", extCtx);
	check(statuses.at(-1) === "IRC ○ 未连接（/irc connect）", "/irc disconnect 后状态栏变成未连接（带重连提示）", String(statuses.at(-1)));
	check(notices.at(-1)?.includes("已断开 IRC") === true, "/irc disconnect 回报断开", notices.at(-1) ?? "");
	await server.waitUntil(() => !server.nicks().includes("ompext"), "ompext 已从 server 掉线");
	check(server.channelsOf("ompext").length === 0, "断开后不在任何频道里", server.channelsOf("ompext").join(","));
	await commandDefinition?.handler("status", extCtx);
	check(
		notices.at(-1)?.startsWith("IRC：未连接（/irc connect 可连接）") === true,
		"/irc status 在断开后给出重连入口",
		notices.at(-1)?.split("\n")[0] ?? "",
	);

	const downReceipt = String(await extAdapter.deliverIrcMessage?.({ from: "Main", to: "irc-peerbot", body: "queued while disconnected" }));
	check(downReceipt === "injected", "断开期间的出站仍被受理（排队，不丢）", downReceipt);
	check(
		!server.received.some(line => line.includes("queued while disconnected")),
		"断开期间一个字节都没上线",
		server.received.filter(line => line.startsWith("PRIVMSG")).slice(-2).join(" | "),
	);

	await commandDefinition?.handler("connect", extCtx);
	check(notices.at(-1)?.includes("已发起连接") === true, "/irc connect 回报已发起连接", notices.at(-1) ?? "");
	check(statuses.at(-1) === "IRC ◌ 连接中…", "刚发起连接时状态栏是连接中（不是重连中）", String(statuses.at(-1)));
	// onRegistered 先于 JOIN 发生（client 处理 001 → 刷状态 → 再发 JOIN），所以 server 看到 JOIN 时状态栏已更新。
	await server.waitForJoin("#ext");
	check(statuses.at(-1)?.startsWith("IRC ● 已连接") === true, "重连后状态栏回到已连接", String(statuses.at(-1)));
	check(server.channelsOf("ompext").includes("#ext"), "重连后重新 JOIN 了 #ext", server.channelsOf("ompext").join(","));
	check(server.received.filter(line => line === "JOIN #ext").length > extJoinsBefore, "重新 JOIN 真的走了一遍");
	check(
		await server.waitForLine(/^PRIVMSG peerbot :queued while disconnected$/).catch(() => "") === "PRIVMSG peerbot :queued while disconnected",
		"重连后补发断开期间排队的正文",
	);

	await handlers.get("session_shutdown")?.({}, extCtx);
	check(statuses.at(-1) === undefined, "退出时清掉状态栏那一格");
	check(refs.get("irc-peerbot") === undefined, "退出时注销 peer 替身");

	// 9) 不配任何东西时扩展照样可用：loadConfig 走默认值，/irc status 说明缺什么。
	const bareDir = path.join(root, "bare");
	const bare = loadConfig(bareDir, { env: {}, notes: [] });
	check(!bare.config.configured, "缺 irc.json 时 configured=false（扩展仍加载）");
	check(
		bare.config.port === 6667 && bare.config.tls === false && bare.config.nick === "omp" && bare.config.channels.length === 0,
		"缺省 port/nick/tls/channels 正确",
		`${bare.config.port} ${bare.config.nick} tls=${bare.config.tls}`,
	);
	check(bare.notes.some(note => note.includes("未配置 server")), "notes 说明缺什么", bare.notes.join(" / "));
	// 未配置时没有连接：用「未连接」的客户端形状代表这种状态，连接控制面记下有没有被误调用。
	const bareCalls: string[] = [];
	const bareDeps = {
		config: bare.config,
		notes: bare.notes,
		peers,
		client: {
			join: () => {},
			part: () => {},
			status: () => ({ server: "", port: 6667, tls: false, nick: "omp", connected: false, registered: false, channels: [], attempts: 0 }),
		},
		connection: {
			isStarted: () => false,
			connect: () => bareCalls.push("connect"),
			disconnect: () => bareCalls.push("disconnect"),
		},
		send: async () => {},
		transcripts,
		logger: silentLogger,
	};
	const bareStatus = await runIrcCommand(bareDeps, "status");
	check(
		bareStatus.text.includes("未配置 server") && bareStatus.text.includes("IRC：未连接"),
		"/irc status 说明缺什么",
		bareStatus.text.split("\n").slice(0, 2).join(" / "),
	);
	const bareConnect = await runIrcCommand(bareDeps, "connect");
	check(
		bareConnect.level === "warning" && bareConnect.text.includes("未配置 IRC server") && bareConnect.text.includes("IRC_SERVER"),
		"/irc connect 未配置时拒绝并说明缺什么",
		bareConnect.text.split("\n")[0] ?? "",
	);
	check(bareCalls.length === 0, "未配置时 connect/disconnect 都没碰客户端", bareCalls.join(","));

	const fromEnv = loadConfig(bareDir, {
		env: { IRC_SERVER: "irc.example.org", IRC_TLS: "1", IRC_NICK: "bot", IRC_CHANNELS: "#a,#b" },
		notes: [],
	});
	check(
		fromEnv.config.configured &&
			fromEnv.config.port === 6697 &&
			fromEnv.config.tls &&
			fromEnv.config.nick === "bot" &&
			fromEnv.config.channels.join(",") === "#a,#b",
		"IRC_* 环境变量覆盖文件并生效",
		`${fromEnv.config.server}:${fromEnv.config.port} ${fromEnv.config.nick} ${fromEnv.config.channels.join(",")}`,
	);
	check(
		fromEnv.notes.some(note => note.includes("IRC_SERVER 生效")) && fromEnv.notes.some(note => note.includes("IRC_TLS 生效")),
		"生效的 env 覆盖逐条写进 notes",
		fromEnv.notes.join(" / "),
	);

	// 心跳缺省关闭；IRC_KEEPALIVE_SECONDS 打开并写进 notes（客户端侧行为见 protocol.test.ts）。
	check(bare.config.keepaliveSeconds === 0, "心跳缺省关闭", `keepaliveSeconds=${bare.config.keepaliveSeconds}`);
	const keepaliveEnv = loadConfig(bareDir, {
		env: { IRC_KEEPALIVE_SECONDS: "60", IRC_KEEPALIVE_TIMEOUT_SECONDS: "20" },
		notes: [],
	});
	check(
		keepaliveEnv.config.keepaliveSeconds === 60 && keepaliveEnv.config.keepaliveTimeoutSeconds === 20,
		"IRC_KEEPALIVE_* 覆盖到配置",
		`${keepaliveEnv.config.keepaliveSeconds}/${keepaliveEnv.config.keepaliveTimeoutSeconds}`,
	);
	check(
		keepaliveEnv.notes.some(note => note.includes("心跳：每 60s 发 PING，20s 内无任何入站则判死重连")),
		"心跳设置写进 notes",
		keepaliveEnv.notes.join(" / "),
	);
} catch (error) {
	check(false, "e2e 执行未抛错", error instanceof Error ? error.message : String(error));
} finally {
	omp.stop();
	peerbot.stop();
	await server.close();
}

console.log(failures.length === 0 ? "\nE2E PASS" : `\nE2E FAIL（${failures.length}）：${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
