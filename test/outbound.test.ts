/**
 * `createOutboundSender` 的直测：工具（`irc send`）、命令（`/irc send`）与 e2e 都走这一份实现，
 * 但 tool/commands 测试把 `send` 整个 stub 掉了，所以「三件事真的都发生」只有这里钉。
 *
 * 契约（见 src/outbound.ts 头注释）：调用方先确认已注册，这里**不做网络判断**——
 * 只负责把 `(record, text)` 落成 `PRIVMSG record.targetId`、一条 `assistant` 转录、一次活跃刷新。
 */
import { describe, expect, test } from "bun:test";
import type { ConversationRecord } from "../src/conversations";
import { createOutboundSender, type OutboundSenderDeps } from "../src/outbound";
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

/** 记录调用的三件假依赖：`client.privmsg` / `transcripts.record` / `touch`。 */
function makeDeps() {
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

describe("createOutboundSender：一次出站 = PRIVMSG + 转录 + 活跃刷新", () => {
	test("三件效果都发生，且各自拿到正确的参数", async () => {
		const { deps, privmsgs, records, touched } = makeDeps();
		const send = createOutboundSender(deps);
		const target = record();

		await send(target, "你好，世界");

		// 1) 线上：发到 record.targetId（原始目标），不是净化过的会话 id。
		expect(privmsgs).toEqual([{ target: "alice", text: "你好，世界" }]);
		// 2) 转录：落 record.id，角色固定 assistant，正文原样。
		expect(records).toEqual([{ id: "irc-alice", entry: { role: "assistant", text: "你好，世界" } }]);
		// 3) 活跃刷新：refresh 的是会话登记里的那一条。
		expect(touched).toEqual(["irc-alice"]);
	});

	test("不做连接判断：client 面只暴露 privmsg（没有 status/connected）也照样做三件事", async () => {
		// 「未连接不投递」归调用方（工具/命令先查 status().registered）；此处再挡一层会
		// 变成两处各自判断、迟早对不上。这里只证明它拿到什么就忠实地投出去。
		const { deps, privmsgs, records, touched } = makeDeps();
		const send = createOutboundSender(deps);
		const target = record({
			id: "irc-~homp",
			scope: "channel",
			targetId: "#omp",
			displayName: "IRC频道 #omp",
		});

		await send(target, "hi\r\nQUIT :bye");

		// PRIVMSG 目标是 targetId（含 #），压平/切分是 src/client.ts 的职责，不在这层。
		expect(privmsgs).toEqual([{ target: "#omp", text: "hi\r\nQUIT :bye" }]);
		expect(records).toEqual([{ id: "irc-~homp", entry: { role: "assistant", text: "hi\r\nQUIT :bye" } }]);
		expect(touched).toEqual(["irc-~homp"]);
	});
});
