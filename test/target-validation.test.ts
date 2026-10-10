/**
 * 出站目标校验（`assertIrcTarget`）+ 「校验在 `privmsg` 之前」的回归。
 *
 * 目标（nick/频道名）是模型/命令层给的，会被直接拼进 `PRIVMSG <target> :<text>`：`a,b` 是 IRC 的
 * 多目标语法（一条命令扇出给多个人）、`victim :pwned` 让服务端把后半段当成新参数（目标/正文混淆）、
 * 目标里的空白/CR/LF 能改写整条消息结构、无长度上限则顶穿 512 字节行上限。这里把接受/拒绝矩阵
 * 与「拒绝发生在 `privmsg` 之前」都钉住。
 */
import { describe, expect, test } from "bun:test";
import type { ConversationRecord } from "../src/conversations";
import { assertIrcTarget, createOutboundSender, type OutboundSenderDeps } from "../src/outbound";
import type { TranscriptEntry } from "../src/transcript";

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
	return {
		id: "irc-alice",
		scope: "query",
		targetId: "alice",
		displayName: "IRC私聊 alice",
		lastSeen: 1,
		...overrides,
	};
}

describe("assertIrcTarget：接受的合法目标", () => {
	test("普通 nick / #与& 频道 / 带方括号的 nick / 会话语柄原样放行", () => {
		for (const target of ["alice", "#omp", "&local", "bot[1]", "irc-chan-~homp", "a-b_c9"]) {
			expect(() => assertIrcTarget(target)).not.toThrow();
		}
	});

	test("长度按 UTF-8 字节算：64 字节边界放行，多字节字符不按码点算", () => {
		expect(() => assertIrcTarget("a".repeat(64))).not.toThrow();
		// 32 个 3 字节汉字 = 96 字节……超出 → 拒；#你 重复 15 次 = 60 字节 ≤ 64 → 放行。
		expect(() => assertIrcTarget("你".repeat(22))).toThrow();
		expect(() => assertIrcTarget("#你".repeat(15))).not.toThrow();
	});
});

describe("assertIrcTarget：拒绝非法目标（逐条给出为什么）", () => {
	const rejected: [string, string][] = [
		["", "空串"],
		["a,b", "逗号多目标扇出"],
		["a,b,c", "多个逗号"],
		["a b", "空格"],
		["a\tb", "制表符"],
		["a\rb", "CR（能造出第二条 IRC 消息）"],
		["a\nb", "LF（能造出第二条 IRC 消息）"],
		["victim :pwned", "目标/正文混淆"],
		[":pwned", "前导冒号（prefix 分隔符）"],
		["a".repeat(65), "超 64 字节"],
		["你".repeat(32), "多字节超长（32 个 3 字节 = 96 字节）"],
	];

	for (const [target, why] of rejected) {
		test(`拒绝 ${why}：${JSON.stringify(target)}`, () => {
			expect(() => assertIrcTarget(target)).toThrow();
		});
	}

	test("错误文案说清为什么不合法（模型/用户要看懂，不是裸的 throw）", () => {
		expect(() => assertIrcTarget("a,b")).toThrow(/逗号/);
		expect(() => assertIrcTarget("victim :pwned")).toThrow(/空格/);
		expect(() => assertIrcTarget(":pwned")).toThrow(/":"/);
		expect(() => assertIrcTarget("a".repeat(65))).toThrow(/64 字节/);
	});

	test("不做「宽容修正」：两侧空白的目标照样拒（trim 也不行）", () => {
		expect(() => assertIrcTarget(" alice ")).toThrow();
		expect(() => assertIrcTarget("alice ")).toThrow();
	});
});

describe("createOutboundSender：非法目标在 privmsg 之前就被拒", () => {
	function spyDeps() {
		const privmsgs: { target: string; text: string }[] = [];
		const records: { id: string; entry: TranscriptEntry }[] = [];
		const touched: string[] = [];
		const deps: OutboundSenderDeps = {
			client: {
				privmsg: (target, text) => {
					privmsgs.push({ target, text });
				},
			},
			transcripts: {
				record: (id, entry) => {
					records.push({ id, entry });
				},
			},
			touch: id => {
				touched.push(id);
			},
		};
		return { deps, privmsgs, records, touched };
	}

	test("非法 targetId → 抛错，privmsg / 转录 / touch 一个都没发生", async () => {
		for (const targetId of ["a,b", "victim :pwned", "#omp ", ":pwned", ""]) {
			const { deps, privmsgs, records, touched } = spyDeps();
			const send = createOutboundSender(deps);
			let caught: unknown;
			try {
				await send(record({ targetId }), "hi");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(privmsgs).toHaveLength(0);
			expect(records).toHaveLength(0);
			expect(touched).toHaveLength(0);
		}
	});

	test("合法 targetId 照常走完整路径（校验不误伤）", async () => {
		const { deps, privmsgs, records, touched } = spyDeps();
		const send = createOutboundSender(deps);
		await send(record(), "你好");
		expect(privmsgs).toEqual([{ target: "alice", text: "你好" }]);
		expect(records).toEqual([{ id: "irc-alice", entry: { role: "assistant", text: "你好" } }]);
		expect(touched).toEqual(["irc-alice"]);
	});
});
