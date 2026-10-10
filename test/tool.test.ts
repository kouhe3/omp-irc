/**
 * `irc` 工具的装配与行为测试：直接调 `defineIrcTool` 返回对象上的 `execute`。
 *
 * 不注册进宿主、也不联网：`pi` 只提供链式 zod schema（工具只做 `z.enum(...).describe()` 这类
 * 链式构造，真校验不在本层），出站面全是替身（客户端、send 回调），只有转录用真的
 * `IrcTranscripts`（mkdtemp 目录）。关键回归：send **先校验参数与连接、最后才登记会话**——
 * 未注册时不许投递，也不许留下幽灵会话。
 */
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { IrcClientStatus } from "../src/client";
import { silentLogger } from "../src/config";
import { ConversationDirectory, type ConversationRecord } from "../src/conversations";
import { defineIrcTool, type IrcToolDetails, type IrcToolDeps, type IrcToolParams } from "../src/tool";
import { IrcTranscripts } from "../src/transcript";

type ToolResult = AgentToolResult<IrcToolDetails>;

/** 只提供链式 schema 面的 `pi.zod` 替身（与 e2e-mock 同一口径）。 */
function stubPi(): ExtensionAPI {
	const schema = (): Record<string, unknown> => {
		const node: Record<string, unknown> = {};
		node.describe = () => node;
		node.optional = () => node;
		return node;
	};
	return {
		zod: { string: schema, number: schema, boolean: schema, enum: schema, object: (shape: unknown) => shape },
	} as unknown as ExtensionAPI;
}

/** 文本结果 → 纯文本（工具只用 text 块）。 */
function text(result: ToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

interface Harness {
	execute(params: IrcToolParams): Promise<ToolResult>;
	/** 真实的会话目录（纯内存、无 I/O）：直接断言「有没有留下幽灵会话」。 */
	conversations: ConversationDirectory;
	/** 真实的转录（mkdtemp 目录）：`log` 走的真实现。 */
	transcripts: IrcTranscripts;
	/** 假 send 回调收到的投递（一次都没调 = 空数组）。 */
	sends: { record: ConversationRecord; text: string }[];
	/** 交给假客户端的 join 参数（原样，客户端自己归一）。 */
	joins: string[];
	/** 假转录收到的 tail 请求（断言 limit 夹取）。 */
	tailCalls: { id: string; limit: number }[];
	/** 客户端状态的可变替身（默认已连接、未注册）。 */
	state: { connected: boolean; registered: boolean; channels: string[] };
}

function createHarness(): Harness {
	const dir = mkdtempSync(path.join(os.tmpdir(), "irc-tool-"));
	const transcripts = new IrcTranscripts(dir, silentLogger);
	const conversations = new ConversationDirectory({ limit: 10 });
	const sends: Harness["sends"] = [];
	const joins: string[] = [];
	const tailCalls: Harness["tailCalls"] = [];
	const state = { connected: true, registered: false, channels: [] as string[] };

	const client = {
		join: (channel: string) => {
			joins.push(channel);
			const name = channel.trim();
			const normalized = /^[#&]/.test(name) ? name : `#${name}`;
			if (!state.channels.includes(normalized)) state.channels.push(normalized);
		},
		status: (): IrcClientStatus => ({
			server: "irc.example.org",
			port: 6667,
			tls: false,
			nick: "omp",
			connected: state.connected,
			registered: state.registered,
			channels: [...state.channels],
			attempts: 0,
		}),
	};
	// 真转录 + 记下 `tail` 实际收到的 limit（夹取断言需要看到传下去的值）。
	const transcriptSpy: IrcToolDeps["transcripts"] = {
		tail: (id, limit) => {
			tailCalls.push({ id, limit });
			return transcripts.tail(id, limit);
		},
		pathFor: id => transcripts.pathFor(id),
	};
	const deps: IrcToolDeps = {
		conversations,
		client,
		send: async (record, value) => {
			sends.push({ record, text: value });
		},
		transcripts: transcriptSpy,
		logger: silentLogger,
		notes: [],
	};
	const tool = defineIrcTool(stubPi(), () => deps);
	const ctx = {} as unknown as ExtensionContext;
	return {
		execute: params => tool.execute("call", params, undefined, undefined, ctx),
		conversations,
		transcripts,
		sends,
		joins,
		tailCalls,
		state,
	};
}

describe("irc 工具：未初始化", () => {
	test("getDeps 返 undefined → isError 且提示渠道未初始化", async () => {
		const tool = defineIrcTool(stubPi(), () => undefined);
		const result = await tool.execute("call", { action: "list" }, undefined, undefined, {} as ExtensionContext);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("IRC 渠道未初始化");
	});
});

describe("irc 工具：send", () => {
	test("未注册 → 拒绝发送、不调 send 回调、也不登记会话（不留幽灵会话）", async () => {
		const harness = createHarness();
		const before = harness.conversations.list().length;
		const result = await harness.execute({ action: "send", peer: "alice", text: "hi" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("未连接/未注册，消息未发出");
		expect(harness.sends).toHaveLength(0);
		expect(harness.conversations.list().length).toBe(before);
	});

	test("缺 peer / 缺 text 各自报错，且先于连接检查（未注册也报参数错）", async () => {
		const harness = createHarness();
		const noPeer = await harness.execute({ action: "send", text: "hi" });
		expect(noPeer.isError).toBe(true);
		expect(text(noPeer)).toContain("send 需要 peer");
		const noText = await harness.execute({ action: "send", peer: "alice" });
		expect(noText.isError).toBe(true);
		expect(text(noText)).toContain("send 需要 text");
		expect(harness.sends).toHaveLength(0);
		expect(harness.conversations.list()).toHaveLength(0);
	});

	test("注册后正常发送：send 回调收到 (record, text)，record.targetId 正确", async () => {
		const harness = createHarness();
		harness.state.registered = true;
		const result = await harness.execute({ action: "send", peer: "alice", text: "你好" });
		expect(result.isError).toBeUndefined();
		expect(harness.sends).toHaveLength(1);
		const sent = harness.sends[0];
		expect(sent?.record.targetId).toBe("alice");
		expect(sent?.record.scope).toBe("query");
		expect(sent?.text).toBe("你好");
		expect(text(result)).toContain(sent?.record.id ?? "");
	});

	test("频道目标（#omp）登记为频道会话并投递到 #omp", async () => {
		const harness = createHarness();
		harness.state.registered = true;
		const result = await harness.execute({ action: "send", peer: "#omp", text: "hello" });
		expect(result.isError).toBeUndefined();
		expect(harness.sends[0]?.record.scope).toBe("channel");
		expect(harness.sends[0]?.record.targetId).toBe("#omp");
	});
});

describe("irc 工具：log", () => {
	test("引用不存在 → isError「找不到 IRC 会话」", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "log", peer: "ghost" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("找不到 IRC 会话");
	});

	test("没有 peer 且会话不唯一时也报错（提示未提供 peer）", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "log" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("找不到 IRC 会话");
		expect(text(result)).toContain("(未提供 peer)");
	});

	test("只有一个会话时省略 peer 自动选中它（默认 limit 6）", async () => {
		const harness = createHarness();
		const record = harness.conversations.ensure({ scope: "query", targetId: "alice", timestamp: Date.now() });
		harness.transcripts.record(record.id, { role: "assistant", text: "hi alice" });
		const result = await harness.execute({ action: "log" });
		expect(result.isError).toBeUndefined();
		expect(harness.tailCalls).toEqual([{ id: record.id, limit: 6 }]);
		expect(text(result)).toContain("hi alice");
	});

	test("limit 夹到 [1,50]：999 → 50，0 → 1", async () => {
		const harness = createHarness();
		const record = harness.conversations.ensure({ scope: "query", targetId: "alice", timestamp: Date.now() });
		await harness.execute({ action: "log", limit: 999 });
		await harness.execute({ action: "log", limit: 0 });
		expect(harness.tailCalls).toEqual([
			{ id: record.id, limit: 50 },
			{ id: record.id, limit: 1 },
		]);
	});
});

describe("irc 工具：list / join / status", () => {
	test("list：空目录提示还没有任何会话；有会话时列出描述", async () => {
		const harness = createHarness();
		const empty = await harness.execute({ action: "list" });
		expect(empty.isError).toBeUndefined();
		expect(text(empty)).toContain("还没有任何 IRC 会话");
		const record = harness.conversations.ensure({ scope: "channel", targetId: "#omp", timestamp: Date.now() });
		const listed = await harness.execute({ action: "list" });
		expect(listed.isError).toBeUndefined();
		expect(text(listed)).toContain(record.id);
		expect(text(listed)).toContain("#omp");
	});

	test("join：频道透给客户端，文案写明留驻频道", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "join", channel: "#omp" });
		expect(harness.joins).toEqual(["#omp"]);
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("留驻频道");
		expect(text(result)).toContain("#omp");
	});

	test("join 缺 channel → isError「join 需要 channel」，不碰客户端", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "join" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("join 需要 channel");
		expect(harness.joins).toEqual([]);
	});

	test("未注册时 join 也登记留驻频道（连上后自动 JOIN 的语义）", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "join", channel: "omp" });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("连接注册后自动 JOIN");
		expect(text(result)).toContain("#omp");
	});

	test("未知 action → isError「未知 action」", async () => {
		const harness = createHarness();
		const result = await harness.execute({ action: "frobnicate" } as unknown as IrcToolParams);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("未知 action");
	});
});
