/**
 * 出站投递：会话 + 正文 → 一条 PRIVMSG + 一条转录 + 刷新活跃时间。
 *
 * 工具（`irc send`）、命令（`/irc send`）与 e2e 走的是**同一份**实现（而不是各自抄一遍）：
 * 抄出来的副本会让「测试通过」只证明副本对。调用方负责**先确认已注册**（`status().registered`）
 * ——这里不再查一次，也不排队（客户端只在 socket 已连上时写出，注册态归调用方把关）。
 */
import type { ConversationRecord } from "./conversations";
import type { TranscriptEntry } from "./transcript";

export interface OutboundSenderDeps {
	client: { privmsg(target: string, text: string): void };
	transcripts: { record(id: string, entry: TranscriptEntry): void };
	/** 会话目录：出站也算一次活跃。 */
	touch: (id: string) => void;
}

export function createOutboundSender(deps: OutboundSenderDeps): (record: ConversationRecord, text: string) => Promise<void> {
	return async (record, text) => {
		// 出站正文原样落转录（转录是全量账本与原文），再按 512 字节上限切成 PRIVMSG。
		deps.client.privmsg(record.targetId, text);
		deps.transcripts.record(record.id, { role: "assistant", text });
		deps.touch(record.id);
	};
}
