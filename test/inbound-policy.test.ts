/**
 * 入站鉴权（白/黑名单）测试：`isInboundAllowed` 纯函数 + `createInboundHandler` 的真实管线。
 *
 * 语义基准（README「入站鉴权（白/黑名单）」）：
 * - 黑名单优先于白名单；
 * - 该维度白名单非空即白名单模式（未命中拒收）；白名单为空则放行；
 * - 匹配大小写不敏感（nick 走 RFC1459 casemapping，频道名先小写）；
 * - 被拒的消息**仍落转录**（账本全量），只是不 `deliver`。
 *
 * 管线用真 `ConversationDirectory` + 捕获型 `deliver` / `transcripts`（不落盘、不注入宿主）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { IrcInboundMessage } from "../src/client";
import { loadConfig } from "../src/config";
import { ConversationDirectory } from "../src/conversations";
import {
	createInboundHandler,
	DEFAULT_INBOUND_POLICY,
	type InboundDeniedEvent,
	type InboundPolicy,
	isInboundAllowed,
} from "../src/inbound";
import type { TranscriptEntry } from "../src/transcript";

interface Harness {
	delivered: string[];
	recorded: { id: string; entry: TranscriptEntry }[];
	denied: InboundDeniedEvent[];
	conversations: ConversationDirectory;
	onInbound: (message: IrcInboundMessage) => void;
}

/** 装配入站管线：真会话目录 + 捕获型 deliver/transcripts（policy 缺省 = 全放行）。 */
function build(policy?: InboundPolicy): Harness {
	const delivered: string[] = [];
	const recorded: { id: string; entry: TranscriptEntry }[] = [];
	const denied: InboundDeniedEvent[] = [];
	const conversations = new ConversationDirectory({ limit: 10 });
	const onInbound = createInboundHandler({
		conversations,
		transcripts: { record: (id, entry) => recorded.push({ id, entry }) },
		deliver: body => delivered.push(body),
		selfNick: () => "omp",
		policy,
		onDenied: event => denied.push(event),
	});
	return { delivered, recorded, denied, conversations, onInbound };
}

/** 一条归一化的入站消息（缺省是发给我们的私聊 PRIVMSG）。 */
function inbound(overrides: Partial<IrcInboundMessage> & { from: string; text: string }): IrcInboundMessage {
	return { target: "omp", channel: false, notice: false, raw: "", ...overrides };
}

describe("isInboundAllowed", () => {
	test("默认策略四个数组都空 → 两个维度都放行", () => {
		expect(isInboundAllowed(DEFAULT_INBOUND_POLICY, { scope: "query", targetId: "alice", senderNick: "alice" })).toBe(
			true,
		);
		expect(
			isInboundAllowed(DEFAULT_INBOUND_POLICY, { scope: "channel", targetId: "#ops", senderNick: "alice" }),
		).toBe(true);
	});

	test("黑名单优先：同在一个白名单里的 nick 只要命中黑名单就拒收", () => {
		const policy: InboundPolicy = { ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"], blockUsers: ["Alice"] };
		expect(isInboundAllowed(policy, { scope: "query", targetId: "alice", senderNick: "ALICE" })).toBe(false);
		// 黑名单命中的频道同样优先于白名单
		const channels: InboundPolicy = {
			...DEFAULT_INBOUND_POLICY,
			allowChannels: ["#ops"],
			blockChannels: ["#OPS"],
		};
		expect(isInboundAllowed(channels, { scope: "channel", targetId: "#ops", senderNick: "x" })).toBe(false);
	});

	test("白名单模式：未命中拒收；该维度白名单为空则放行", () => {
		const policy: InboundPolicy = { ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"] };
		expect(isInboundAllowed(policy, { scope: "query", targetId: "bob", senderNick: "bob" })).toBe(false);
		expect(isInboundAllowed(policy, { scope: "query", targetId: "Alice", senderNick: "Alice" })).toBe(true);
		// 频道维度没配白名单 → 放行（维度各自独立）
		expect(isInboundAllowed(policy, { scope: "channel", targetId: "#dev", senderNick: "bob" })).toBe(true);
	});

	test("nick 匹配大小写不敏感 + RFC1459 casemapping 折叠（[] {}\|~^）", () => {
		const policy: InboundPolicy = { ...DEFAULT_INBOUND_POLICY, allowUsers: ["[Alice]"] };
		expect(isInboundAllowed(policy, { scope: "query", targetId: "{alice}", senderNick: "{alice}" })).toBe(true);
		const tilde: InboundPolicy = { ...DEFAULT_INBOUND_POLICY, blockUsers: ["a~b"] };
		expect(isInboundAllowed(tilde, { scope: "query", targetId: "A^B", senderNick: "A^B" })).toBe(false);
	});

	test("频道名匹配：比较前小写，但 #/& 前缀必须显式（不同前缀不互相命中）", () => {
		const policy: InboundPolicy = { ...DEFAULT_INBOUND_POLICY, blockChannels: ["#Ops"] };
		expect(isInboundAllowed(policy, { scope: "channel", targetId: "#OPS", senderNick: "x" })).toBe(false);
		expect(isInboundAllowed(policy, { scope: "channel", targetId: "&ops", senderNick: "x" })).toBe(true);
	});
});

describe("createInboundHandler 入站鉴权", () => {
	test("默认策略（不传 policy）：私聊照常投递", () => {
		const h = build();
		h.onInbound(inbound({ from: "alice", text: "hi" }));
		expect(h.delivered).toHaveLength(1);
		expect(h.denied).toHaveLength(0);
		expect(h.recorded).toHaveLength(1);
	});

	test("黑名单优先：白名单也含该 nick 时不投递，但转录已落、onDenied 被调", () => {
		const h = build({ ...DEFAULT_INBOUND_POLICY, allowUsers: ["Alice"], blockUsers: ["alice"] });
		h.onInbound(inbound({ from: "ALICE", text: "hi" }));
		expect(h.delivered).toHaveLength(0);
		expect(h.recorded).toHaveLength(1);
		expect(h.denied).toHaveLength(1);
		expect(h.denied[0]).toMatchObject({ scope: "query", targetId: "ALICE", senderNick: "ALICE", content: "hi" });
	});

	test("白名单模式下非白名单来源不投递，但转录仍记（账本全量）", () => {
		const h = build({ ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"] });
		h.onInbound(inbound({ from: "bob", text: "spam" }));
		expect(h.delivered).toHaveLength(0);
		expect(h.recorded).toHaveLength(1);
		expect(h.recorded[0]?.entry.text).toBe("spam");
		expect(h.recorded[0]?.entry.role).toBe("user");
		expect(h.recorded[0]?.entry.senderName).toBe("bob");
		// 拒收的消息也登记了会话（id 与名字同口径）
		expect(h.recorded[0]?.id).toBe("irc-bob");
	});

	test("白名单命中即投递（大小写不敏感）", () => {
		const h = build({ ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"] });
		h.onInbound(inbound({ from: "Alice", text: "hello" }));
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain("Alice: hello");
	});

	test("未配白名单的维度放行：只配私聊白名单时频道消息照常投递（黑名单频道仍拒）", () => {
		const h = build({ ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"], blockChannels: ["#spam"] });
		h.onInbound(inbound({ from: "bob", text: "hello", channel: true, target: "#dev" }));
		expect(h.delivered).toHaveLength(1);
		// 大小写不同的黑名单频道命中 → 拒收；转录两条都在。
		h.onInbound(inbound({ from: "bob", text: "spam", channel: true, target: "#SPAM" }));
		expect(h.delivered).toHaveLength(1);
		expect(h.denied).toHaveLength(1);
		expect(h.recorded).toHaveLength(2);
	});

	test("自己的回声（RFC1459 折叠）不投递、不落转录（策略判定之前就返回）", () => {
		const h = build({ ...DEFAULT_INBOUND_POLICY, allowUsers: ["alice"] });
		h.onInbound(inbound({ from: "OMP", text: "echo" }));
		expect(h.delivered).toHaveLength(0);
		expect(h.recorded).toHaveLength(0);
	});
});

describe("loadConfig 入站策略解析", () => {
	function load(env: Record<string, string | undefined>, file?: unknown) {
		const dir = mkdtempSync(path.join(os.tmpdir(), "irc-policy-"));
		if (file !== undefined) writeFileSync(path.join(dir, "irc.json"), JSON.stringify(file), "utf8");
		return loadConfig(dir, { env, notes: [] });
	}

	test("缺省：四个数组都空（默认放行），notes 有策略摘要", () => {
		const { config, notes } = load({});
		expect(config.inboundPolicy).toEqual({
			allowUsers: [],
			blockUsers: [],
			allowChannels: [],
			blockChannels: [],
		});
		expect(
			notes.some(note => note.includes("入站策略：私聊白名单 0 / 黑名单 0；频道白名单 0 / 黑名单 0（未配白名单的维度放行）")),
		).toBe(true);
	});

	test("文件：字符串数组或逗号分隔字符串都接受；频道补 # 前缀；trim、丢空项", () => {
		const { config } = load({}, { allowUsers: [" Alice ", "", "bob"], blockChannels: "#spam,Ops ,&local" });
		expect(config.inboundPolicy.allowUsers).toEqual(["Alice", "bob"]);
		expect(config.inboundPolicy.blockChannels).toEqual(["#spam", "#Ops", "&local"]);
	});

	test("env 同名键覆盖文件（IRC_ALLOW_USERS / IRC_BLOCK_CHANNELS，逗号分隔）", () => {
		const { config, notes } = load(
			{ IRC_ALLOW_USERS: "alice,Bob", IRC_BLOCK_CHANNELS: "spam" },
			{ allowUsers: ["zzz"] },
		);
		expect(config.inboundPolicy.allowUsers).toEqual(["alice", "Bob"]);
		expect(config.inboundPolicy.blockChannels).toEqual(["#spam"]);
		expect(notes.some(note => note.includes("env IRC_ALLOW_USERS 生效"))).toBe(true);
		expect(notes.some(note => note.includes("入站策略：私聊白名单 2 / 黑名单 0；频道白名单 0 / 黑名单 1"))).toBe(true);
	});

	test("非法值忽略并写 notes（数字 / 对象）", () => {
		const { config, notes } = load({}, { blockUsers: 42, allowChannels: { a: 1 } });
		expect(config.inboundPolicy.blockUsers).toEqual([]);
		expect(config.inboundPolicy.allowChannels).toEqual([]);
		expect(notes.some(note => note.includes("blockUsers 值非法"))).toBe(true);
		expect(notes.some(note => note.includes("allowChannels 值非法"))).toBe(true);
	});
});
