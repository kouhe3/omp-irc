/**
 * `/irc connect` / `/irc disconnect` 的命令层测试。
 *
 * 命令层不碰宿主也不碰网络：连接控制面是注入的（`IrcConnectionControl`），因此这里断言的是
 * 「什么情况下该调 connect/disconnect、文案说什么、status 的连接状态怎么变」。
 * 真实 TCP 上的断开 → 重连 → 重新 JOIN 往返在 `test/e2e-mock.ts` 里验。
 */
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	runIrcCommand,
	type IrcCommandChannel,
	type IrcCommandDeps,
	type IrcConnectionControl,
} from "../src/commands";
import { loadConfig, silentLogger } from "../src/config";
import { ConversationDirectory, type ConversationRecord } from "../src/conversations";
import { IrcTranscripts } from "../src/transcript";

interface Harness {
	deps: IrcCommandDeps;
	/** 调过的连接控制动作（connect/disconnect/join/part），断言「该不该调」。 */
	calls: string[];
	/** `deps.send` 收到的出站投递（会话 id + 正文）。 */
	sends: { id: string; text: string }[];
	/** 命令层操作的会话目录（测试可预置会话）。 */
	conversations: ConversationDirectory;
	/** 客户端状态的可变替身：命令只读，控制面只改。 */
	state: { started: boolean; connected: boolean; registered: boolean; attempts: number };
}

/** 配置就绪（给了 server）→ 可连接；不给 server → 未配置。 */
function createHarness(options: { server?: string } = {}): Harness {
	const dir = mkdtempSync(path.join(os.tmpdir(), "irc-cmd-"));
	const notes: string[] = [];
	// 显式传 env：不读本机 process.env，测试与机器上真实的 irc.json / IRC_* 隔离。
	const { config } = loadConfig(dir, {
		env: options.server ? { IRC_SERVER: options.server, IRC_NICK: "omp" } : {},
		notes,
	});
	const transcripts = new IrcTranscripts(config.transcriptDir);
	const conversations = new ConversationDirectory({ limit: 10 });
	const sends: Harness["sends"] = [];

	const calls: string[] = [];
	const state = { started: false, connected: false, registered: false, attempts: 0 };
	const client: IrcCommandChannel = {
		join: channel => calls.push(`join ${channel}`),
		part: channel => calls.push(`part ${channel}`),
		status: () => ({
			server: config.server ?? "",
			port: config.port,
			tls: config.tls,
			nick: config.nick,
			connected: state.connected,
			registered: state.registered,
			channels: [...config.channels],
			attempts: state.attempts,
		}),
	};
	const connection: IrcConnectionControl = {
		isStarted: () => state.started,
		connect: () => {
			calls.push("connect");
			state.started = true;
		},
		disconnect: () => {
			calls.push("disconnect");
			state.started = false;
			state.connected = false;
			state.registered = false;
		},
	};

	return {
		deps: {
			config,
			notes,
			conversations,
			client,
			connection,
			send: async (record: ConversationRecord, text: string) => {
				sends.push({ id: record.id, text });
			},
			transcripts,
			logger: silentLogger,
		},
		calls,
		sends,
		conversations,
		state,
	};
}

/** 客户端处于「已连接并注册」的稳态。 */
function markRegistered(harness: Harness): void {
	harness.state.started = true;
	harness.state.connected = true;
	harness.state.registered = true;
}

describe("/irc connect", () => {
	test("未配置 server：不发起连接，并说明缺什么", async () => {
		const harness = createHarness();
		const result = await runIrcCommand(harness.deps, "connect");
		expect(result.level).toBe("warning");
		expect(result.text).toContain("未配置 IRC server");
		expect(result.text).toContain("IRC_SERVER");
		expect(harness.calls).toEqual([]);
	});

	test("配置就绪：发起连接，报出目标与昵称", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		const result = await runIrcCommand(harness.deps, "connect");
		expect(harness.calls).toEqual(["connect"]);
		expect(harness.state.started).toBe(true);
		expect(result.level).toBe("info");
		expect(result.text).toContain("irc.example.org:6667");
		expect(result.text).toContain("昵称 omp");
	});

	test("已在连接：不重复 start，报告当前状态", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		const result = await runIrcCommand(harness.deps, "connect");
		expect(harness.calls).toEqual([]);
		expect(result.text).toContain("已经在连接");
		expect(result.text).toContain("已连接 · 已注册");
	});

	test("断开后再 connect：重新发起连接", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		await runIrcCommand(harness.deps, "disconnect");
		const result = await runIrcCommand(harness.deps, "connect");
		expect(harness.calls).toEqual(["disconnect", "connect"]);
		expect(harness.state.started).toBe(true);
		expect(result.text).toContain("已发起连接");
	});
});

describe("/irc disconnect", () => {
	test("连接中：停传输层，说明会话登记与转录保留", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		const result = await runIrcCommand(harness.deps, "disconnect");
		expect(harness.calls).toEqual(["disconnect"]);
		expect(harness.state.started).toBe(false);
		expect(result.level).toBe("info");
		expect(result.text).toContain("已断开 IRC");
		expect(result.text).toContain("/irc connect");
	});

	test("本来就没连：不调 disconnect", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		const result = await runIrcCommand(harness.deps, "disconnect");
		expect(harness.calls).toEqual([]);
		expect(result.text).toContain("未在连接");
	});
});

describe("/irc status 的连接状态", () => {
	test("配置就绪但未连接：提示 /irc connect", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		const result = await runIrcCommand(harness.deps, "status");
		expect(result.text).toContain("IRC：未连接（/irc connect 可连接）");
	});

	test("已发起但没连上：报重连次数", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		harness.state.started = true;
		harness.state.attempts = 3;
		const result = await runIrcCommand(harness.deps, "status");
		expect(result.text).toContain("重连中（第 3 次）");
	});

	test("首次握手（attempts=0）说连接中，不是重连中", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		await runIrcCommand(harness.deps, "connect");
		const result = await runIrcCommand(harness.deps, "status");
		expect(result.text).toContain("IRC：连接中…");
		expect(result.text).not.toContain("重连中");
	});

	test("断开后回到未连接（不再是重连中）", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		harness.state.started = true;
		harness.state.attempts = 2;
		await runIrcCommand(harness.deps, "disconnect");
		const result = await runIrcCommand(harness.deps, "status");
		expect(result.text).toContain("IRC：未连接（/irc connect 可连接）");
		expect(result.text).not.toContain("重连中");
	});

	test("help 列出 connect / disconnect", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		const result = await runIrcCommand(harness.deps, "help");
		expect(result.text).toContain("- connect：");
		expect(result.text).toContain("- disconnect：");
	});
});

describe("/irc status / list 的已知会话", () => {
	test("status 报出已知会话数；list 逐条列出 id/类型/最近活跃", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		harness.conversations.ensure({
			scope: "query",
			targetId: "Alice",
			timestamp: Date.UTC(2024, 0, 2, 3, 4),
		});
		const status = await runIrcCommand(harness.deps, "status");
		expect(status.text).toContain("已知会话：1");
		expect(status.text).toContain("留驻频道：(无)");

		const list = await runIrcCommand(harness.deps, "list");
		expect(list.text).toContain("已知 IRC 会话 1 个：");
		expect(list.text).toContain("irc-alice 私聊 · 最近活跃 2024-01-02 03:04（Alice）");
	});

	test("没有会话时 status 报 0、list 给出空目录文案", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		expect((await runIrcCommand(harness.deps, "status")).text).toContain("已知会话：0");
		expect((await runIrcCommand(harness.deps, "list")).text).toBe("还没有 IRC 会话");
	});
});

describe("/irc send", () => {
	test("已注册：引用已登记的会话，按解析结果发出", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		harness.conversations.ensure({ scope: "query", targetId: "Alice", timestamp: 1 });

		// 按会话 id 引用；正文保留内部空白。
		const byId = await runIrcCommand(harness.deps, "send irc-alice 你好 世界");
		expect(byId.level).toBe("info");
		expect(harness.sends).toEqual([{ id: "irc-alice", text: "你好 世界" }]);
		expect(byId.text).toBe("已发送到 irc-alice（5 字符）");
	});

	test("已注册：没会话过的引用当场登记后发出（主动开口）", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		const result = await runIrcCommand(harness.deps, "send #omp hi");
		expect(result.level).toBe("info");
		expect(harness.sends).toEqual([{ id: "irc-chan-~homp", text: "hi" }]);
		expect(harness.conversations.resolve("irc-chan-~homp")?.scope).toBe("channel");
	});

	test("缺正文：只给用法，不发出", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		markRegistered(harness);
		const result = await runIrcCommand(harness.deps, "send alice");
		expect(result.level).toBe("warning");
		// 未登记的引用原样回显（此时还没有会话可解析成 id）。
		expect(result.text).toContain("用法：/irc send alice <正文>");
		expect(harness.sends).toEqual([]);
		// 正文缺失在登记之前就拒绝：不留幽灵会话。
		expect(harness.conversations.list()).toEqual([]);
	});

	test("未注册：不发出、不登记（不留幽灵会话），返回警告", async () => {
		const harness = createHarness({ server: "irc.example.org" });
		harness.state.started = true;
		harness.state.connected = true;
		const result = await runIrcCommand(harness.deps, "send alice hi");
		expect(result.level).toBe("warning");
		expect(result.text).toContain("IRC 未连接/未注册，消息未发出");
		expect(harness.sends).toEqual([]);
		expect(harness.conversations.list()).toEqual([]);
	});
});
