/**
 * 每个 IRC 会话一份「宿主会话文件格式」的 jsonl 转录。
 *
 * 目的：注入主会话的卡片一次只承载一条消息（RFC1459 单行 ≤512 字节），出站长文还会被切成
 * 多条 PRIVMSG；这份文件保留**原文与顺序**，供 `/irc log`（人）与 `irc log`（模型）读完整
 * 来往。渠道自己写、自己读，不依赖宿主的任何会话视图（IRC 会话不是 omp 子会话，
 * 见 src/conversations.ts）。
 *
 * 格式（对着真实会话文件抄的）：
 *   {"type":"session","version":3,"id":"…","timestamp":"…","cwd":"…"}      ← 首行必须是合法 header
 *   {"type":"message","id":"…","parentId":"…","timestamp":"…","message":{…}}
 * 首行 header 不能省：宿主的 `loadWithKnownSize` 对 header 非法的文件会把 entries 当空，
 * 保持这个格式才能用 `omp render` 之类的宿主工具直接看。
 *
 * 取舍：
 * - 单文件超过 {@link MAX_TRANSCRIPT_BYTES} 就轮转：保留最后 {@link KEEP_TRANSCRIPT_BYTES}
 *   字节内的完整行 + 重写 header（滚动窗口，磁盘与读取成本有界）。
 * - `tail()` 只从文件尾读一段，不做全量 `readFileSync`。
 * - 落盘的是原文；**显示**前必须过 `stripControl`。
 * - 文件名直接由会话 id 派生（会话 id 已收敛为 `[a-z0-9_-]`，天然是安全文件名）。
 */
import { appendFileSync, mkdirSync, openSync, closeSync, readSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { IrcLogger } from "./config";

/** 一条要进转录的消息（IRC 收到的原文 / 我们发出去的回话）。 */
export interface TranscriptEntry {
	role: "user" | "assistant";
	/** 完整正文：**不要**传截断过的卡片正文。 */
	text: string;
	/** epoch ms；缺省取当前时间。 */
	ts?: number;
	/** 频道里发言的成员 nick（写进署名，与卡片口径一致）。 */
	senderName?: string;
}

/** 单文件上限：超过就轮转成「最后 KEEP 字节」的滚动窗口。 */
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** 轮转后保留的尾部字节数。 */
const KEEP_TRANSCRIPT_BYTES = 512 * 1024;
/** `tail()` 一次最多从文件尾读多少字节。 */
const TAIL_READ_BYTES = 256 * 1024;

/** 生成短 id（宿主用 8 位十六进制；这里够区分即可）。 */
function entryId(): string {
	return Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");
}

/** header 的 id 由会话 id 决定：进程重启后 parentId 链依然接得上。 */
function headerId(conversationId: string): string {
	return `irc-${conversationId}`;
}

function headerLine(conversationId: string, dir: string, ts: number): string {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id: headerId(conversationId),
		timestamp: new Date(ts).toISOString(),
		cwd: dir,
		title: `IRC ${conversationId}`,
	})}\n`;
}

export class IrcTranscripts {
	readonly #dir: string;
	readonly #logger?: IrcLogger;
	/** 会话 id → 上一条条目 id，用来串 parentId 链（进程内记忆，重启后退回 header id）。 */
	readonly #lastEntry = new Map<string, string>();

	constructor(dir: string, logger?: IrcLogger) {
		this.#dir = dir;
		this.#logger = logger;
	}

	/** 该会话的转录文件路径（`irc log` 与 `/irc log` 都读它）。 */
	pathFor(conversationId: string): string {
		return path.join(this.#dir, `${conversationId}.jsonl`);
	}

	/** 追加一条；文件为空时先落 header；超过上限则先轮转。写失败只记日志。 */
	record(conversationId: string, entry: TranscriptEntry): void {
		const file = this.pathFor(conversationId);
		const ts = entry.ts ?? Date.now();
		try {
			// POSIX：目录 0700 / 文件 0600（转录含频道里他人发言）；Windows 忽略 mode。
			mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
			// header 是否存在按**文件状态**判断，不按进程内记忆：重启后不能往文件中间再插一行 header。
			const empty = this.#size(file) === 0;
			if (empty) appendFileSync(file, headerLine(conversationId, this.#dir, ts), { encoding: "utf8", mode: 0o600 });
			else if (this.#size(file) > MAX_TRANSCRIPT_BYTES) this.#rotate(file, conversationId, ts);

			const parentId = this.#lastEntry.get(conversationId) ?? headerId(conversationId);
			const id = entryId();
			const text = entry.senderName ? `${entry.senderName}: ${entry.text}` : entry.text;
			const message =
				entry.role === "user"
					? { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: ts }
					: {
							role: "assistant",
							content: [{ type: "text", text }],
							model: "irc",
							provider: "irc",
							// usage 必须**写全**（含 cost）：宿主转录渲染管线（`omp render` 与 Agent Hub 的
							// fullscreen 转录视图共用 ChatTranscriptBuilder）不兼容别的形状——实测
							// ① 省略 usage → Hub 视图读 `message.usage.cacheRead` 抛错；
							// ② usage 存在但缺 cost → 读 `usage.cost.total` 抛
							//    `TypeError: undefined is not an object`，视图起不来。
							// 渠道正文没有 token 计费口径，所以写零成本 usage。
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: ts,
						};
			appendFileSync(
				file,
				`${JSON.stringify({ type: "message", id, parentId, timestamp: new Date(ts).toISOString(), message })}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
			this.#lastEntry.set(conversationId, id);
		} catch (error) {
			// 落盘失败不影响收发；但必须留下线索，否则会跟「真没消息」混淆。
			this.#logger?.warn("IRC 转录写入失败", {
				conversation: conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * 读最近 `limit` 条（旧 → 新），给 `/irc log` 与 `irc log` 用；没有文件时返回空数组。
	 * 只从文件尾读 {@link TAIL_READ_BYTES}：与文件体积无关，够覆盖 limit ≤ 50 的请求。
	 */
	tail(conversationId: string, limit: number): TranscriptEntry[] {
		const file = this.pathFor(conversationId);
		let text: string;
		try {
			const size = this.#size(file);
			if (size === 0) return [];
			const offset = Math.max(0, size - TAIL_READ_BYTES);
			const length = size - offset;
			const buffer = Buffer.allocUnsafe(length);
			const handle = openSync(file, "r");
			try {
				readSync(handle, buffer, 0, length, offset);
			} finally {
				closeSync(handle);
			}
			text = buffer.toString("utf8");
			// 从中间切进来的那半行丢掉（offset>0 时第一行不完整）。
			if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
		} catch (error) {
			this.#logger?.warn("IRC 转录读取失败", {
				conversation: conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		const out: TranscriptEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // 半写坏掉的行跳过
			}
			if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "message") continue;
			const message = "message" in parsed ? parsed.message : undefined;
			if (!message || typeof message !== "object") continue;
			const role = "role" in message && message.role === "assistant" ? "assistant" : "user";
			const content = "content" in message && Array.isArray(message.content) ? message.content : [];
			const block = content.find(
				(entry: unknown) => entry !== null && typeof entry === "object" && "type" in entry && entry.type === "text",
			);
			const body =
				block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "";
			if (!body) continue;
			const ts =
				"timestamp" in message && typeof message.timestamp === "number"
					? message.timestamp
					: "timestamp" in parsed && typeof parsed.timestamp === "string"
						? Date.parse(parsed.timestamp)
						: undefined;
			out.push({ role, text: body, ...(ts !== undefined && Number.isFinite(ts) ? { ts } : {}) });
		}
		return out.slice(-Math.max(1, limit));
	}

	#size(file: string): number {
		// 每次取新实例：`Bun.file().size` 按实例缓存（复用会读到旧值），缺文件天然为 0。
		return Bun.file(file).size;
	}

	/** 超过上限：保留尾部完整行 + 重写 header（滚动窗口）。 */
	#rotate(file: string, conversationId: string, ts: number): void {
		const size = this.#size(file);
		const offset = Math.max(0, size - KEEP_TRANSCRIPT_BYTES);
		const length = size - offset;
		const buffer = Buffer.allocUnsafe(length);
		const handle = openSync(file, "r");
		try {
			readSync(handle, buffer, 0, length, offset);
		} finally {
			closeSync(handle);
		}
		let keep = buffer.toString("utf8");
		keep = keep.slice(keep.indexOf("\n") + 1);
		writeFileSync(file, headerLine(conversationId, this.#dir, ts) + keep, { encoding: "utf8", mode: 0o600 });
		this.#lastEntry.delete(conversationId);
	}
}

/** 展示用：把转录条目渲染成一段文本（人看 TUI / 模型看工具结果共用一份格式）。 */
export interface TranscriptDigestOptions {
	/** 每条正文上限；超出只留头部并注明看文件。 */
	perEntry: number;
	/** 整段输出上限；超出只留文件路径。 */
	total: number;
}

export const DEFAULT_DIGEST: TranscriptDigestOptions = { perEntry: 2_000, total: 6_000 };

/**
 * 终端显示的净化：IRC 消息是**不可信输入**（对方可以用 ESC/OSC 序列操纵运维者的终端）。
 * 落盘的转录仍保留原文（那是数据）；只有「要显示给人/模型看」的文本过这里。
 */
export function stripControl(text: string): string {
	const ESC = "\u001b";
	let out = "";
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (text[index] === ESC) {
			const next = text[index + 1];
			if (next === "[") {
				// CSI：ESC [ 参数/中间字节 终止字节（@-~）
				let cursor = index + 2;
				while (cursor < text.length) {
					const c = text.charCodeAt(cursor);
					if (c >= 0x40 && c <= 0x7e) break;
					cursor++;
				}
				index = cursor;
				continue;
			}
			if (next === "]") {
				// OSC：ESC ] … (BEL | ESC \)
				let cursor = index + 2;
				while (cursor < text.length && text.charCodeAt(cursor) !== 0x07) {
					if (text.charCodeAt(cursor) === 0x1b && text[cursor + 1] === "\\") {
						cursor++;
						break;
					}
					cursor++;
				}
				index = cursor;
				continue;
			}
			index++; // 其它 ESC-x 两字节序列
			continue;
		}
		if (code === 0x0d) {
			out += "\n";
			// CRLF 只算一个换行；单独的 CR 也当换行。
			if (text.charCodeAt(index + 1) === 0x0a) index++;
			continue;
		}
		// U+2028/U+2029 也是行终止符（Markdown 组件按 `[\n\r\u2028\u2029]` 断行）：
		// 归一成 \n，让「换行」在字节层面显式可见，而不是渲染时才冒出来。
		if (code === 0x2028 || code === 0x2029) {
			out += "\n";
			continue;
		}
		// C0（保留 \n \t）、DEL、C1（含单字节 CSI）剥掉。
		if (code === 0x0a || code === 0x09) out += text[index];
		else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += text[index];
	}
	return out;
}

/**
 * `<` 后面跟 harness 标签名（`irc` 或 `system-*`，开/闭标签都算）。
 * 与宿主 `session/harness-tags.ts` 同一份正则：系统提示声明这些块是 harness 自己写的
 * （`<system-reminder>` 之类被当成 system-authored），所以外部来的一律不能原样带进去。
 */
const HARNESS_TAG_START = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;

/**
 * 把 `<` 转义成 `&lt;`，只动 harness 标签名（代码、占位符、`<task-result>` 信封原样保留）。
 * 宿主自己的 IRC 面在把对端正文投给模型前就做这一步；而扩展禁止运行时 import 宿主包，
 * 所以这里照抄同一份规则——**只要是把外部输入送进模型上下文/终端的地方都要过它**。
 */
export function escapeHarnessTags(text: string): string {
	return text.replace(HARNESS_TAG_START, "&lt;");
}

/**
 * 不可信输入 → 要显示给终端或送进模型上下文的文本：剥控制序列 + 转义 harness 标签。
 * 落盘的转录仍保留原文；**显示/注入边界**必须走这里。
 */
export function sanitizeForDisplay(text: string): string {
	return escapeHarnessTags(stripControl(text));
}

/** 逐行渲染最近若干条；**过 stripControl**（消息原文是不可信输入）。 */
export function formatTranscriptDigest(
	entries: readonly TranscriptEntry[],
	file: string,
	options: Partial<TranscriptDigestOptions> = {},
): string {
	const { perEntry, total } = { ...DEFAULT_DIGEST, ...options };
	const header = `最近 ${entries.length} 条（完整转录：${file}）`;
	if (entries.length === 0) return `还没有消息记录（文件：${file}）`;
	const body = entries.map(entry => {
		const who = entry.role === "assistant" ? "omp" : "irc";
		const text = sanitizeForDisplay(entry.text);
		const trimmed = text.length > perEntry ? `${text.slice(0, perEntry)}…（本条见文件）` : text;
		return `[${who}] ${trimmed}`;
	});
	const output = [header, ...body].join("\n");
	return output.length > total ? `${output.slice(0, total)}\n…（输出过长已截断，完整内容见文件：${file}）` : output;
}
