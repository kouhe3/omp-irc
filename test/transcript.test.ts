/**
 * 转录文件测试：宿主会话文件格式（Hub 转录视图 / `history://<peer>` 都读它）、
 * 原文不截断、滚动窗口、尾部读取、显示前净化。
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_DIGEST, formatTranscriptDigest, PeerTranscripts, stripControl } from "../src/transcript";

function transcripts(): PeerTranscripts {
	return new PeerTranscripts(path.join(mkdtempSync(path.join(os.tmpdir(), "irc-transcript-")), "irc-transcripts"));
}

const PEER = "irc-alice";

describe("PeerTranscripts", () => {
	test("首行是宿主认的 header，其后是 message 条目（Hub 转录视图与 history:// 都读它）", async () => {
		const store = transcripts();
		store.record(PEER, { role: "user", text: "第一条", ts: 1_700_000_000_000 });
		store.record(PEER, { role: "assistant", text: "回复", ts: 1_700_000_001_000 });

		const lines = (await Bun.file(store.pathFor(PEER)).text()).trim().split("\n");
		expect(lines).toHaveLength(3);
		const header = JSON.parse(lines[0] ?? "");
		// 宿主的 isValidSessionHeader 只认 type==="session" + string id；不合法时它会
		// 把整个文件的 entries 丢掉，history:// 就空了。
		expect(header.type).toBe("session");
		expect(typeof header.id).toBe("string");

		const first = JSON.parse(lines[1] ?? "");
		expect(first.type).toBe("message");
		expect(first.parentId).toBe(header.id);
		expect(first.message.role).toBe("user");
		expect(first.message.content[0].text).toBe("第一条");
		const second = JSON.parse(lines[2] ?? "");
		expect(second.parentId).toBe(first.id); // parentId 串成链
		expect(second.message.role).toBe("assistant");
	});

	test("assistant 条目的 usage 写全（含 cost）：缺失或缺 cost 都会让宿主转录视图抛错", async () => {
		const store = transcripts();
		store.record(PEER, { role: "assistant", text: "回出去的正文" });

		const line = (await Bun.file(store.pathFor(PEER)).text()).trim().split("\n")[1] ?? "";
		const entry = JSON.parse(line);
		// 实测两种崩溃：省略 usage → Hub 视图读 `message.usage.cacheRead`；
		// usage 缺 cost → 读 `usage.cost.total`。渠道转录只能写「零成本 + 全字段」这一种形状。
		expect(entry.message.usage.cost.total).toBe(0);
		expect(typeof entry.message.usage.input).toBe("number");
		expect(typeof entry.message.usage.totalTokens).toBe("number");
		expect(entry.message.stopReason).toBe("stop");
	});

	test("进程重启后不再重复写 header；parentId 仍接得上（header id 由 peerId 决定）", async () => {
		const store = transcripts();
		store.record(PEER, { role: "user", text: "第一个进程" });
		const restarted = new PeerTranscripts(path.dirname(store.pathFor(PEER)));
		restarted.record(PEER, { role: "user", text: "重启后" });

		const lines = (await Bun.file(store.pathFor(PEER)).text()).trim().split("\n");
		expect(lines.filter(line => JSON.parse(line).type === "session")).toHaveLength(1);
		expect(JSON.parse(lines.at(-1) ?? "").parentId).toBe(`irc-${PEER}`);
	});

	test("超长正文原样落盘（卡片正文会截断，转录不截断）", async () => {
		const store = transcripts();
		const long = "字".repeat(9_000);
		store.record(PEER, { role: "user", text: long });
		expect(await Bun.file(store.pathFor(PEER)).text()).toContain(long);
		expect(store.tail(PEER, 1)[0]?.text).toBe(long);
	});

	test("频道成员 nick 进正文署名", async () => {
		const store = transcripts();
		store.record(PEER, { role: "user", text: "在吗", senderName: "老王" });
		expect(store.tail(PEER, 1)[0]?.text).toBe("老王: 在吗");
	});

	test("tail 只取最近 N 条且保持旧→新顺序；坏行跳过", async () => {
		const store = transcripts();
		for (const text of ["一", "二", "三", "四"]) store.record(PEER, { role: "user", text });
		await Bun.write(store.pathFor(PEER), `${await Bun.file(store.pathFor(PEER)).text()}{半行坏掉\n`);
		expect(store.tail(PEER, 2).map(entry => entry.text)).toEqual(["三", "四"]);
	});

	test("没有文件时 tail 返回空数组（不抛）", () => {
		expect(transcripts().tail("irc-没写过", 5)).toEqual([]);
	});

	test("文件很大时 tail 只读尾部（不全量读入）且仍取到最新几条", async () => {
		const store = transcripts();
		const file = store.pathFor(PEER);
		mkdirSync(path.dirname(file), { recursive: true });
		const filler = "x".repeat(2_000);
		let body = "";
		for (let index = 0; index < 1_500; index++) {
			body += `${JSON.stringify({ type: "message", id: `id${index}`, parentId: "p", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `${filler}-${index}` }] } })}\n`;
		}
		writeFileSync(file, body);
		expect(statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
		const tail = store.tail(PEER, 3);
		expect(tail).toHaveLength(3);
		expect(tail.at(-1)?.text.endsWith("-1499")).toBe(true);
	});

	test("超过上限自动轮转：保留最新内容、文件回到有界大小", async () => {
		const store = transcripts();
		const file = store.pathFor(PEER);
		mkdirSync(path.dirname(file), { recursive: true });
		const filler = "y".repeat(2_000);
		let body = `${JSON.stringify({ type: "session", version: 3, id: `irc-${PEER}`, timestamp: new Date().toISOString(), cwd: "." })}\n`;
		for (let index = 0; index < 2_200; index++) {
			body += `${JSON.stringify({ type: "message", id: `id${index}`, parentId: "p", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `${filler}-${index}` }] } })}\n`;
		}
		writeFileSync(file, body);
		store.record(PEER, { role: "user", text: "轮转后的新消息" });

		expect(statSync(file).size).toBeLessThan(1024 * 1024);
		expect(JSON.parse((await Bun.file(file).text()).trim().split("\n")[0] ?? "").type).toBe("session");
		expect(store.tail(PEER, 1)[0]?.text).toBe("轮转后的新消息");
	});
});

describe("stripControl（显示前净化：消息原文是不可信输入）", () => {
	test("剥掉 CSI/OSC 与控制字符，保留正文与换行", () => {
		expect(stripControl("好\u001b[31m红\u001b[0m色")).toBe("好红色");
		expect(stripControl("标题\u001b]0;pwned\u0007后文")).toBe("标题后文");
		expect(stripControl("a\u0007b\u0008c")).toBe("abc");
		expect(stripControl("第一行\r\n第二行")).toBe("第一行\n第二行");
		expect(stripControl("正常文本，含中文与 emoji 🎯")).toBe("正常文本，含中文与 emoji 🎯");
	});

	test("digest 渲染过净化且受总预算约束", () => {
		const file = "/tmp/x.jsonl";
		const evil = [{ role: "user" as const, text: "\u001b]52;c;cHduZWQ=\u0007伪造\u001b[2J行" }];
		const rendered = formatTranscriptDigest(evil, file);
		expect(rendered).toContain("[irc] 伪造行");
		expect(rendered.includes("\u001b")).toBe(false);

		const many = Array.from({ length: 20 }, () => ({ role: "user" as const, text: "z".repeat(500) }));
		const big = formatTranscriptDigest(many, file);
		expect(big.length).toBeLessThanOrEqual(DEFAULT_DIGEST.total + 200);
		expect(big).toContain("完整内容见文件");
	});

	test("没有记录时给出文件路径而不是空串", () => {
		expect(formatTranscriptDigest([], "/tmp/x.jsonl")).toBe("还没有消息记录（文件：/tmp/x.jsonl）");
	});
});
