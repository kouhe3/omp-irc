/**
 * peer 目录 + 入站/出站桥接测试。
 *
 * 覆盖验收点：
 * - 入站 PRIVMSG → 主会话 `deliverIrcMessage` 被调用 + 转录文件多一行；
 * - 出站：对 peer 替身调用 `deliverIrcMessage` → mock server 收到 `PRIVMSG <target> :<text>`；
 * - peer 注册面（`kind/status/transcriptOnly/sessionFile/activity`）与故意抛错的聚焦入口。
 */
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createHostSink, createInboundHandler } from "../src/bridge";
import { IrcClient } from "../src/client";
import { silentLogger } from "../src/config";
import { encodePeerId, PeerDirectory, resolveOrCreatePeer, type PeerRegistry } from "../src/peers";
import { PeerTranscripts } from "../src/transcript";
import { createGate, startMockIrcServer, type MockIrcServer } from "./mock-irc-server";

interface FakeRef {
	id: string;
	displayName?: string;
	status?: string;
	session?: unknown;
	sessionFile?: string | null;
	transcriptOnly?: boolean;
	activity?: string;
}

function createFakeRegistry() {
	const refs = new Map<string, FakeRef>();
	const registry: PeerRegistry = {
		get: id => refs.get(id),
		register: input => {
			const ref: FakeRef = {
				id: input.id,
				displayName: input.displayName,
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
	return { registry, refs };
}

function transcripts(): PeerTranscripts {
	return new PeerTranscripts(path.join(mkdtempSync(path.join(os.tmpdir(), "irc-transcript-")), "irc-transcripts"));
}

/** 取出注册进去的 peer 替身，模拟宿主 IrcBus 调 deliverIrcMessage。 */
async function deliverTo(ref: FakeRef | undefined, body: string): Promise<string> {
	const session = ref?.session as { deliverIrcMessage?: (message: { from: string; to: string; body: string }) => Promise<unknown> };
	if (typeof session?.deliverIrcMessage !== "function") throw new Error("no adapter");
	return String(await session.deliverIrcMessage({ from: "Main", to: ref?.id ?? "?", body }));
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Stack {
	server: MockIrcServer;
	client: IrcClient;
	peers: PeerDirectory;
	refs: Map<string, FakeRef>;
	transcripts: PeerTranscripts;
	delivered: { id: string; from: string; to: string; body: string; ts: number }[];
	gate: ReturnType<typeof createGate>;
}

/** 装配线上同一条链路：mock server ↔ IrcClient ↔ PeerDirectory/转录 ↔ 主会话 sink。 */
async function buildStack(): Promise<Stack> {
	const server = await startMockIrcServer();
	const { registry, refs } = createFakeRegistry();
	const delivered: Stack["delivered"] = [];
	// 主会话替身：宿主 AgentSession 的 deliverIrcMessage。
	registry.register({
		id: "Main",
		displayName: "Main",
		kind: "sub",
		session: {
			deliverIrcMessage: async (message: { id: string; from: string; to: string; body: string; ts: number }) => {
				delivered.push(message);
				return "injected";
			},
		},
	});
	const store = transcripts();
	const client = new IrcClient({
		host: server.host,
		port: server.port,
		nick: "omp",
		channels: ["#omp"],
		reconnect: { base: 20, max: 80 },
	});
	const peers = new PeerDirectory({
		registry,
		mainAgentId: "Main",
		transcriptPath: peerId => store.pathFor(peerId),
		send: async (peer, text) => {
			client.privmsg(peer.targetId, text);
			store.record(peer.id, { role: "assistant", text });
		},
		limit: 10,
	});
	let seq = 0;
	const gate = createGate();
	const onInbound = createInboundHandler({
		peers,
		transcripts: store,
		deliver: createHostSink({ registry, mainAgentId: "Main", logger: silentLogger }),
		selfNick: () => client.status().nick,
		logger: silentLogger,
		nextMessageId: () => `irc-test-${(seq += 1)}`,
	});
	client.onPrivmsg = message => {
		void onInbound(message).then(() => gate.pump());
	};
	client.onNotice = message => {
		void onInbound(message).then(() => gate.pump());
	};
	client.start();
	cleanups.push(async () => {
		client.stop();
		await server.close();
	});
	await server.waitForNick("omp");
	await server.waitForJoin("#omp");
	return { server, client, peers, refs, transcripts: store, delivered, gate };
}

describe("PeerDirectory（注册面）", () => {
	test("入站消息注册 idle 的 sub peer：transcriptOnly + sessionFile + activity", () => {
		const { registry, refs } = createFakeRegistry();
		const store = transcripts();
		const peers = new PeerDirectory({
			registry,
			mainAgentId: "Main",
			transcriptPath: peerId => store.pathFor(peerId),
			send: async () => {},
			limit: 10,
		});

		const peer = peers.ensure({ scope: "query", targetId: "Alice", messageId: "m1", timestamp: 1_700_000_000_000 });
		expect(peer.id).toBe("irc-alice");
		const ref = refs.get(peer.id);
		expect(ref?.status).toBe("idle");
		expect(ref?.displayName).toBe("IRC私聊 Alice");
		// 契约：替身只是出站投递端点，Hub 的 ⏎ 打开转录而不是 attach（见 README）。
		expect(ref?.transcriptOnly).toBe(true);
		expect(ref?.sessionFile).toBe(store.pathFor("irc-alice"));
		expect(ref?.activity).toBe("IRC 私聊 Alice");

		const channel = peers.ensure({ scope: "channel", targetId: "#omp", messageId: "m2", timestamp: 1 });
		expect(channel.id).toBe("irc-chan--omp");
		expect(refs.get(channel.id)?.activity).toBe("IRC 频道 #omp");
	});

	test("同一会话重复入站不重复注册，只刷新 lastMsgId", () => {
		const { registry, refs } = createFakeRegistry();
		const peers = new PeerDirectory({ registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		peers.ensure({ scope: "query", targetId: "Alice", messageId: "m1", timestamp: 1 });
		peers.ensure({ scope: "query", targetId: "Alice", messageId: "m2", timestamp: 2 });
		expect(refs.size).toBe(1);
		expect(peers.get("irc-alice")?.lastMsgId).toBe("m2");
	});

	test("resolve 支持 id / 原始 nick / 别名，且大小写不敏感；ensureTarget 支持主动开口", () => {
		const { registry } = createFakeRegistry();
		const peers = new PeerDirectory({ registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		peers.ensure({ scope: "query", targetId: "Alice", messageId: "m1", timestamp: 1 });
		peers.alias("irc-alice", "老王");
		expect(peers.resolve("IRC-ALICE")?.targetId).toBe("Alice");
		expect(peers.resolve("alice")?.id).toBe("irc-alice");
		expect(peers.resolve("老王")?.id).toBe("irc-alice");
		expect(peers.resolve("nobody")).toBeUndefined();

		// 还没聊过的目标：确保 scope 推断正确（# 开头是频道）。
		const created = resolveOrCreatePeer(peers, "#omp", 5);
		expect(created.id).toBe("irc-chan--omp");
		expect(resolveOrCreatePeer(peers, "#omp", 6).id).toBe("irc-chan--omp");
	});

	test("超出上限按最近活跃淘汰并从 registry 注销", () => {
		const { registry, refs } = createFakeRegistry();
		const peers = new PeerDirectory({ registry, mainAgentId: "Main", send: async () => {}, limit: 2 });
		peers.ensure({ scope: "query", targetId: "A", messageId: "m", timestamp: 1 });
		peers.ensure({ scope: "query", targetId: "B", messageId: "m", timestamp: 2 });
		peers.ensure({ scope: "query", targetId: "C", messageId: "m", timestamp: 3 });
		expect(peers.list().map(peer => peer.targetId)).toEqual(["C", "B"]);
		expect(refs.has("irc-a")).toBe(false);
		expect(refs.size).toBe(2);
	});

	test("serialize/restore 往返保住 id、别名；被篡改的条目丢弃", () => {
		const first = createFakeRegistry();
		const source = new PeerDirectory({ registry: first.registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		source.ensure({ scope: "channel", targetId: "#omp", messageId: "m", timestamp: 1 });
		source.alias("irc-chan--omp", "主频道");
		const snapshot = source.serialize();

		const second = createFakeRegistry();
		const target = new PeerDirectory({ registry: second.registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		expect(target.restore(snapshot)).toBe(1);
		expect(target.get("irc-chan--omp")?.alias).toBe("主频道");

		// id 与 targetId 不自洽 → 丢弃，避免回消息打到错的会话。
		const tampered = { version: 1, peers: [{ ...snapshot.peers[0], id: "irc-alice" }] };
		const third = createFakeRegistry();
		const other = new PeerDirectory({ registry: third.registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		expect(other.restore(tampered)).toBe(0);
	});

	test("clear 注销 registry 里的全部 peer，且不触发落盘回调", () => {
		const { registry, refs } = createFakeRegistry();
		let changes = 0;
		const peers = new PeerDirectory({
			registry,
			mainAgentId: "Main",
			send: async () => {},
			limit: 10,
			onChange: () => {
				changes += 1;
			},
		});
		peers.ensure({ scope: "query", targetId: "A", messageId: "m", timestamp: 1 });
		peers.ensure({ scope: "query", targetId: "B", messageId: "m", timestamp: 2 });
		const snapshot = peers.serialize();
		const changesBeforeClear = changes;
		peers.clear();
		expect(refs.size).toBe(0);
		expect(changes).toBe(changesBeforeClear);
		expect(snapshot.peers.map(peer => peer.targetId).sort()).toEqual(["A", "B"]);
	});

	test("替身对 Hub 的聚焦路径明确拒绝（不是可查看的 omp 会话）", () => {
		// 回归：Agent Hub 点 peer 曾崩在 `viewSession.agent.getPendingToolResults`。
		const { registry, refs } = createFakeRegistry();
		const peers = new PeerDirectory({ registry, mainAgentId: "Main", send: async () => {}, limit: 10 });
		const record = peers.ensure({ scope: "query", targetId: "Alice", messageId: "m", timestamp: 1 });
		const session = refs.get(record.id)?.session as {
			subscribe(): unknown;
			agent: Record<string, () => unknown>;
		};
		expect(() => session.subscribe()).toThrow(/外部渠道端点/);
		expect(() => session.agent.getPendingToolResults?.()).toThrow(/外部渠道端点/);
		expect(() => session.agent.n?.()).toThrow(/外部渠道端点/);
	});
});

describe("入站/出站（mock IRC server，真 TCP）", () => {
	test("入站 PRIVMSG → 主会话 deliverIrcMessage 被调用 + 转录多一行", async () => {
		const stack = await buildStack();
		stack.server.simulatePrivmsg("Alice", "omp", "ping from irc");
		await stack.gate.until(() => stack.delivered.length >= 1, "主会话收到入站投递");

		expect(stack.delivered).toHaveLength(1);
		expect(stack.delivered[0]?.body).toBe("[私聊] Alice: ping from irc");
		expect(stack.delivered[0]?.from).toBe("irc-alice");
		expect(stack.delivered[0]?.to).toBe("Main");

		// 转录：header + 1 条 message（原文，含署名）。
		const lines = (await Bun.file(stack.transcripts.pathFor("irc-alice")).text()).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "").type).toBe("session");
		expect(JSON.parse(lines[1] ?? "").message.content[0].text).toBe("Alice: ping from irc");
		expect(stack.transcripts.tail("irc-alice", 1)[0]?.text).toBe("Alice: ping from irc");
	});

	test("频道消息 → 频道 peer（irc-chan-…），入站正文带频道名", async () => {
		const stack = await buildStack();
		stack.server.simulatePrivmsg("Bob", "#omp", "hello all");
		await stack.gate.until(() => stack.delivered.length >= 1, "主会话收到频道消息");

		expect(stack.delivered[0]?.body).toBe("[#omp] Bob: hello all");
		expect(stack.delivered[0]?.from).toBe("irc-chan--omp");
		expect(stack.refs.get("irc-chan--omp")?.activity).toBe("IRC 频道 #omp");
	});

	test("按 IRC 语义过滤：服务端主机名的 NOTICE 不进模型，真人 NOTICE 进", async () => {
		const stack = await buildStack();
		// 顺序有保证（同一条 TCP 连接）：先噪音后真消息，只收到 1 条即证明噪音被过滤。
		stack.server.simulateNotice("irc.mock.net", "omp", "*** Looking up your hostname");
		stack.server.simulatePrivmsg("Alice", "omp", "hi");
		stack.server.simulateNotice("Carol", "omp", "psst");
		await stack.gate.until(() => stack.delivered.length >= 2, "收到过滤后的两条");

		expect(stack.delivered.map(delivery => delivery.body)).toEqual(["[私聊] Alice: hi", "[NOTICE 私聊] Carol: psst"]);
	});

	test("入站卡片过 stripControl（对端不能用 ESC/OSC 操纵终端），转录仍存原文", async () => {
		const stack = await buildStack();
		const evil = "\u001b]52;c;cHduZWQ=\u0007伪造\u001b[2J行";
		stack.server.simulatePrivmsg("Alice", "omp", evil);
		await stack.gate.until(() => stack.delivered.length >= 1, "主会话收到入站投递");

		expect(stack.delivered[0]?.body).toBe("[私聊] Alice: 伪造行");
		expect(stack.delivered[0]?.body.includes("\u001b")).toBe(false);
		// 转录是数据源（/irc log 之后再净化渲染），落盘保留原文。
		expect(stack.transcripts.tail("irc-alice", 1)[0]?.text).toBe(`Alice: ${evil}`);
	});

	test("出站：peer 替身 deliverIrcMessage → server 收到 PRIVMSG <target> :<text>", async () => {
		const stack = await buildStack();
		stack.server.simulatePrivmsg("Alice", "omp", "在吗");
		await stack.gate.until(() => stack.delivered.length >= 1, "先建立一次会话");

		expect(await deliverTo(stack.refs.get("irc-alice"), "pong from omp")).toBe("injected");
		expect(await stack.server.waitForLine(/^PRIVMSG Alice :pong from omp$/)).toBe("PRIVMSG Alice :pong from omp");
		// 出站也落转录（assistant）→ header + 入站 + 出站 = 3 行
		const lines = (await Bun.file(stack.transcripts.pathFor("irc-alice")).text()).trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[2] ?? "").message.role).toBe("assistant");
	});

	test("出站到频道 peer 发的是频道 PRIVMSG（不是私聊 nick）", async () => {
		const stack = await buildStack();
		stack.server.simulatePrivmsg("Bob", "#omp", "hi");
		await stack.gate.until(() => stack.delivered.length >= 1, "建立频道会话");

		await deliverTo(stack.refs.get("irc-chan--omp"), "ack");
		expect(await stack.server.waitForLine(/^PRIVMSG #omp :ack$/)).toBe("PRIVMSG #omp :ack");
	});

	test("encodePeerId 的两种 scope 与 decode 的形状", () => {
		expect(encodePeerId("query", "SomeNick")).toBe("irc-somenick");
		expect(encodePeerId("channel", "#omp")).toBe("irc-chan--omp");
		expect(encodePeerId("query", "a b")).toBe("irc-a-b");
	});
});
