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

/**
 * IRC 目标的 UTF-8 字节上限：RFC 2812 整行上限 512 字节（含 `PRIVMSG `、目标、` :`、正文
 * 与 CRLF），留出余量后目标最多 64 字节——够装 RFC1459 的 30 字符 nick 与常见频道名。
 */
const MAX_IRC_TARGET_BYTES = 64;

/** 目标里禁止出现的字符：空白切断参数、逗号是多目标扇出、CR/LF 能凭空造出第二条 IRC 消息。 */
const FORBIDDEN_TARGET_CHARS: Record<string, true> = {
	" ": true,
	"\t": true,
	",": true,
	"\r": true,
	"\n": true,
};

/** 把被拒的字符写成看得见的形式（错误文案要面向模型/用户说清为什么不合法）。 */
function showTargetChar(char: string): string {
	if (char === " ") return "空格";
	if (char === "\t") return "制表符 \\t";
	if (char === "\r") return "CR \\r";
	if (char === "\n") return "LF \\n";
	return "逗号 ,";
}

/**
 * IRC 目标（nick 或频道）的合法性与长度检查；非法直接抛错，**不做「宽容修正」**。
 *
 * 目标不会被 trim、也不会被改写：`a,b` 是 IRC 的多目标语法（一条命令发给多个人）、
 * `victim :pwned` 会让服务端把后半段当成新的参数（目标/正文混淆）、目标里的空白或 CR/LF
 * 能改写整条消息结构，没有长度上限则能顶穿 512 字节的行上限。这些都不是「模型手滑」，
 * 一律拒（要发多个目标请逐条发）。
 */
export function assertIrcTarget(target: string): void {
	if (target.length === 0) throw new Error("IRC 目标为空：需要 nick、#频道 或已知会话 id。");
	if (target.startsWith(":")) {
		throw new Error(`IRC 目标不能以 ":" 开头（那是消息的 prefix 分隔符，会把目标与正文混淆）：${target}`);
	}
	const bytes = Buffer.byteLength(target, "utf8");
	if (bytes > MAX_IRC_TARGET_BYTES) {
		throw new Error(
			`IRC 目标过长（${bytes} 字节，上限 ${MAX_IRC_TARGET_BYTES} 字节）；太长会顶穿 512 字节的整行上限：${target.slice(0, 32)}…`,
		);
	}
	for (const char of target) {
		if (FORBIDDEN_TARGET_CHARS[char]) {
			throw new Error(
				`IRC 目标不能含 ${showTargetChar(char)}；它会被服务端当成参数分隔符（逗号还会扇出成多个目标）：${target}`,
			);
		}
	}
}

export function createOutboundSender(deps: OutboundSenderDeps): (record: ConversationRecord, text: string) => Promise<void> {
	return async (record, text) => {
		// 目标先校验再发：`privmsg` 只把（目标, 正文）拼进一条 IRC 命令，目标非法就等于让对端
		// 或模型改写命令结构（扇出/混淆/超长行）。工具与命令两条路都经过这里，一处即可覆盖。
		assertIrcTarget(record.targetId);
		// 出站正文落转录（全量账本；入账会剥控制序列，见 sanitizeForLedger），再按 512 字节
		// 上限切成 PRIVMSG。
		deps.client.privmsg(record.targetId, text);
		deps.transcripts.record(record.id, { role: "assistant", text });
		deps.touch(record.id);
	};
}
