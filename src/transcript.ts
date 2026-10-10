/**
 * 每个 IRC 会话一份「宿主会话文件格式」的 jsonl 转录。
 *
 * 目的：注入主会话的卡片一次只承载一条消息（RFC1459 单行 ≤512 字节），出站长文还会被切成
 * 多条 PRIVMSG；这份文件保留**正文与顺序**（入账剥控制序列，见 {@link sanitizeForLedger}），
 * 供 `/irc log`（人）与 `irc log`（模型）读完整来往。渠道自己写、自己读，不依赖宿主的任何
 * 会话视图（IRC 会话不是 omp 子会话，见 src/conversations.ts）。
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
 * - 单条正文超过 {@link MAX_ENTRY_BYTES} 按 UTF-8 边界截断 + 标注：单条无界时「先查大小再写」的
 *   轮转判断会被一条巨行绕过。
 * - 目录级回收（{@link IrcTranscriptsOptions.limits}，默认 64 MiB / 500 文件）：`record()` 里节流
 *   扫目录，超限按 mtime 最旧先删**整个会话文件**，保证长跑实例的转录总量有界。
 * - `tail()` 只从文件尾读一段，不做全量 `readFileSync`。
 * - 落盘**不切分、不改顺序**（全量账本；唯一的例外是单条超过 {@link MAX_ENTRY_BYTES} 的截断），
 *   入账前过 {@link sanitizeForLedger}：
 *   剥掉终端控制序列、把「伪换行」压成空格。这份文件是宿主会直接渲染的目标
 *   （`omp render`、Agent Hub 的转录视图），把对端的 ESC/OSC 原样写进去等于给对端
 *   开了一条「正文 → 运维者终端」的通道；控制序列对账本的可读性也零价值。
 * - **显示**（卡片、digest、list、status）另过 {@link sanitizeSingleLine}，多一步 harness 标签转义。
 * - 文件名直接由会话 id 派生（会话 id 已收敛为 `[a-z0-9_-]`，天然是安全文件名）。
 */
import {
	appendFileSync,
	mkdirSync,
	openSync,
	closeSync,
	readSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { IrcLogger } from "./config";

/** 一条要进转录的消息（IRC 收到的正文 / 我们发出去的回话）。 */
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

/**
 * 单条正文（含署名）上限：1 MiB，远高于任何 IRC 行（RFC1459 单行 ≤512 字节，出站长文在线上被切成多条）。
 * 存在的理由是**让「文件大小检查在 append 之前」不能被一条巨行绕过**：`record()` 里先看大小再写真，
 * 一次写入远大于 {@link MAX_TRANSCRIPT_BYTES} 的正文，轮转永远追不上（写完才发现超限）。超限按
 * UTF-8 边界截断并加标注（见 {@link truncateUtf8}），不切碎多字节字符。
 */
const MAX_ENTRY_BYTES = 1 * 1024 * 1024;
/** 单条被截断时追加的标注（只加一次，字节数从上限里预留，见 {@link truncateUtf8}）。 */
const TRUNCATION_MARK = "…[已截断]";

/** 转录目录总字节上限默认值：64 MiB。 */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 转录文件数上限默认值：500 个会话文件。 */
const DEFAULT_MAX_FILES = 500;
/** 目录级回收的节流间隔：`record()` 每 30 s 至多扫一次目录。 */
const RECLAIM_INTERVAL_MS = 30_000;

/** `record()` 里做目录级回收时用的上限（超限按 mtime 最旧先删）。 */
export interface TranscriptLimits {
	/** 转录目录总字节上限；默认 {@link DEFAULT_MAX_TOTAL_BYTES}。 */
	maxBytes?: number;
	/** `.jsonl` 文件数上限；默认 {@link DEFAULT_MAX_FILES}。 */
	maxFiles?: number;
}

/** {@link IrcTranscripts} 的可注入项（测试用）。 */
export interface IrcTranscriptsOptions {
	limits?: TranscriptLimits;
	/** 回收节流用的时钟；默认 `Date.now`。 */
	now?: () => number;
}

/**
 * 按 **UTF-8 字节**上限截断，且不切碎多字节字符（代理对按一个字符处理）。
 * 超限时从上限里预留标注自身的字节，保证结果总长 ≤ `maxBytes`。
 */
function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARK, "utf8"));
	let bytes = 0;
	let end = 0;
	while (end < text.length) {
		const code = text.codePointAt(end) ?? 0;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > budget) break;
		bytes += size;
		end += code > 0xffff ? 2 : 1;
	}
	return text.slice(0, end) + TRUNCATION_MARK;
}

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
	/** 目录级回收上限（见 {@link IrcTranscripts.#reclaim}）。 */
	readonly #limits: Required<TranscriptLimits>;
	/** 回收节流用时钟（可注入，测试用）。 */
	readonly #now: () => number;
	/** 上次回收检查的时间戳；初值 -∞ 让第一次 `record()` 就检查一次。 */
	#lastReclaim = Number.NEGATIVE_INFINITY;

	constructor(dir: string, logger?: IrcLogger, options: IrcTranscriptsOptions = {}) {
		this.#dir = dir;
		this.#logger = logger;
		this.#limits = {
			maxBytes: options.limits?.maxBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			maxFiles: options.limits?.maxFiles ?? DEFAULT_MAX_FILES,
		};
		this.#now = options.now ?? Date.now;
	}

	/** 该会话的转录文件路径（`irc log` 与 `/irc log` 都读它）。 */
	pathFor(conversationId: string): string {
		return path.join(this.#dir, `${conversationId}.jsonl`);
	}

	/**
	 * 追加一条；文件为空时先落 header；超过上限则先轮转；结尾做一次节流的目录级回收。
	 * 写失败只记日志（收发不能因为转录失败而中断）。
	 */
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
			// 入账净化（见 sanitizeForLedger）：署名与正文都是 IRC 来的不可信输入，而这份文件
			// 会被宿主渲染到终端上。
			// 再按 MAX_ENTRY_BYTES 截断（署名与正文合一后算）：单条无界时上面的文件大小检查
			// 追不上写入（写完才发现超限），一张巨卡片/一条巨行就能把账本撑到任意大小。
			const text = truncateUtf8(
				entry.senderName
					? `${sanitizeForLedger(entry.senderName)}: ${sanitizeForLedger(entry.text)}`
					: sanitizeForLedger(entry.text),
				MAX_ENTRY_BYTES,
			);
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
			// 目录级回收（节流，见 #reclaim）：转录总量与文件数有界，长跑实例不会把磁盘写满。
			this.#reclaim(conversationId);
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

	/**
	 * 目录级回收：`record()` 里**节流**调用（每 {@link RECLAIM_INTERVAL_MS} 至多一次，避免每条消息都扫目录）。
	 * 超过 {@link TranscriptLimits} 就按 **mtime 最旧优先**删整个会话文件，直到总量与文件数都回到上限内。
	 *
	 * 两条硬约束：
	 * - **不删当前正在写的这一个文件**（刚 append 完，删了等于消息凭空消失）。
	 * - 删掉别的会话后同步 `#lastEntry`：那条 parentId 链的锚点已经不在盘上了，下次写要从 header 重接。
	 *
	 * 回收是纯清理动作，任何失败只记日志（含目录还不存在），绝不影响收发。
	 */
	#reclaim(current: string): void {
		const now = this.#now();
		if (now - this.#lastReclaim < RECLAIM_INTERVAL_MS) return;
		this.#lastReclaim = now;
		try {
			const currentFile = path.basename(this.pathFor(current));
			const files: { name: string; size: number; mtime: number }[] = [];
			let total = 0;
			for (const name of readdirSync(this.#dir)) {
				if (!name.endsWith(".jsonl")) continue;
				// 目录里可能有正在被别的进程删的文件：缺了就当没看见。
				const info = statSync(path.join(this.#dir, name), { throwIfNoEntry: false });
				if (!info?.isFile()) continue;
				files.push({ name, size: info.size, mtime: info.mtimeMs });
				total += info.size;
			}
			if (files.length <= this.#limits.maxFiles && total <= this.#limits.maxBytes) return;
			// mtime 越小越旧；同一毫秒（同批创建）时按文件名定序，保证行为可复现。
			files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
			let count = files.length;
			for (const file of files) {
				if (count <= this.#limits.maxFiles && total <= this.#limits.maxBytes) break;
				if (file.name === currentFile) continue;
				try {
					unlinkSync(path.join(this.#dir, file.name));
					count--;
					total -= file.size;
					this.#lastEntry.delete(file.name.slice(0, -".jsonl".length));
					this.#logger?.debug?.("IRC 转录回收：删除最旧的会话文件", { file: file.name, bytes: file.size });
				} catch (error) {
					this.#logger?.warn("IRC 转录回收删除失败", {
						file: file.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} catch (error) {
			this.#logger?.warn("IRC 转录回收失败", {
				dir: this.#dir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** 超过上限：保留尾部完整行 + 重写 header（滚动窗口）。 */
	#rotate(file: string, conversationId: string, ts: number): void {
		const size = this.#size(file);
		const offset = Math.max(0, size - KEEP_TRANSCRIPT_BYTES);
		const length = size - offset;
		const buffer = Buffer.allocUnsafe(length);
		const handle = openSync(file, "r");
		let bytesRead = 0;
		try {
			// 短读是可能的（文件被并发删除/截断，或读到 EOF 之前就返回）：**只认真正读到的字节**。
			// 丢掉 bytesRead 就会把 `allocUnsafe` 的未初始化内存（可能是别的进程/会话的残留数据，
			// 也可能是 NUL）写进账本——账本是要给宿主渲染的，等于往里面注入任意字节。
			bytesRead = readSync(handle, buffer, 0, length, offset);
		} finally {
			closeSync(handle);
		}
		// subarray(0, bytesRead) 保证只碰真实读到的字节；半行由下面的 indexOf("\n") 丢掉
		// （找不到 \n 时 indexOf 为 -1，slice(0) 保留全部，与旧行为一致）。
		let keep = buffer.subarray(0, bytesRead).toString("utf8");
		if (offset > 0) keep = keep.slice(keep.indexOf("\n") + 1);
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
 * 不可见格式字符（Cf）：`\p{Bidi_Control}`（U+061C ALM、U+200E/200F LRM/RLM、U+202A-202E
 * LRE/RLE/PDF/LRO/RLO、U+2066-2069 LRI/RLI/FSI/PDI，即 Trojan Source 那类**双向重排**控制）
 * 加三个同样不可见、对正文零价值的字符：U+200B（ZWSP）、U+FEFF（BOM/零宽不换行空格）、
 * U+00AD（软连字符，能被渲染成连字符来伪装 URL/域名）。
 *
 * 为什么**不是**剥掉整个 `\p{Cf}`：U+200C（ZWNJ）与 U+200D（ZWJ）也在 Cf 里，但它们是
 * emoji ZWJ 序列（👨‍👩‍👧）与印度语系连字（क्‌ष）必需的**字形连接符**——剥掉会把正文里的
 * 可见字形拆坏（多出一个孤立字符），而它们本身**不是双向控制字符**，不给对端任何视觉重排
 * 能力（ZWNJ/ZWJ 只影响相邻字形的连接，不改变字符顺序）。所以这里按「能力」而不是按
 * Unicode 类别划界：能重排/隐藏视觉的一律剥，纯粹连接字形的保留。
 */
const INVISIBLE_FORMAT = /[\u00ad\u200b\ufeff\p{Bidi_Control}]/u;

/**
 * 终端显示的净化：IRC 消息是**不可信输入**（对方可以用 ESC/OSC 序列、双向控制字符操纵运维者的终端）。
 * 这是最底层的一道（显示与落盘两层都建在它上面）：{@link sanitizeForLedger} 用它剥控制序列，
 * {@link sanitizeForDisplay} 再叠 harness 标签转义。
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
		// 不可见格式字符（见 INVISIBLE_FORMAT）：正文里没有任何可见信息，但能操纵渲染顺序
		// 或藏起混淆字符，一律剥掉。注意 U+200C/U+200D **不**在这个集合里（emoji/连字要用）。
		if (INVISIBLE_FORMAT.test(text[index] ?? "")) continue;
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
 *
 * ⚠️ **本函数不做单行化**：换行原样保留（含对端用 U+2028/U+2029 造出的伪换行，见 {@link stripControl}）。
 * 因此「一行 = 一条 IRC 消息」的显示/注入出口（卡片、日志、工具结果、digest）**不能直接用它**——
 * 那些地方一律走 {@link sanitizeSingleLine}（= 本函数 + 行终止符压成空格），否则对端能在自己正文里
 * 凭空多造一行来伪造别人（例如 `[omp] …`）的发言。落盘走 {@link sanitizeForLedger}
 * （同样剥控制序列 + 压掉伪换行，但不转义 harness 标签）。
 */
export function sanitizeForDisplay(text: string): string {
	return escapeHarnessTags(stripControl(text));
}

/**
 * 不可信输入 → 可安全入账的文本：剥控制序列 + 把「伪换行」压成空格。
 *
 * 为什么入账也要净化：转录文件是**宿主会直接渲染的目标**（`omp render`、
 * Agent Hub 的 fullscreen 转录视图），对端在 PRIVMSG 正文里塞的 ESC/OSC
 * （OSC 52 写剪贴板、OSC 8 伪造链接、清屏…）会被宿主原样打到运维者终端上——
 * 实测 `omp render <转录音>` 逐字节透出对端的 `ESC[31m`。控制序列对「全量账本」
 * 没有任何信息价值，剥掉不损失正文。
 *
 * 换行只保留 **LF**：协议正文里的 LF 只可能来自我们自己的出站多行文本（入站一行
 * 一条 PRIVMSG，服务端 CRLF 分帧，正文里不可能有裸 CR/LF）。裸 CR 与 U+2028/U+2029
 * 对端能塞进正文，被渲染器当换行就会凭空多出一行冒充别人发言，这里压成空格。
 *
 * 与 {@link sanitizeForDisplay} 的区别：这里**不转义 harness 标签**（转录是账本，
 * 要留原文；模型读它时走 display 那一层再转义）。
 */
export function sanitizeForLedger(text: string): string {
	// 先把「伪换行」压成空格（CR / CRLF / U+2028 / U+2029），LF 保持不动。
	return stripControl(text.replace(/\r\n?|[\u2028\u2029]/g, " "));
}

/**
 * 不可信输入 → **单行**文本：净化 + 把所有行终止符压成空格。
 *
 * 为什么必须单行化：一张卡片/一行日志就是一条 IRC 消息。压行之前，对端用 U+2028/U+2029
 * （经 {@link stripControl} 归一成 `\n`）就能在正文里造出**第二行**，伪造「另一个人发言」
 * ——卡片末尾的回复指引、digest 的 `[omp] …` 行都能被仿出来。控制字符对显示没有任何
 * 价值，压掉不损信息（要原文的去读转录文件）。
 */
export function sanitizeSingleLine(text: string): string {
	return sanitizeForDisplay(text).replace(/\n+/g, " ");
}

/** 逐行渲染最近若干条；**整套净化 + 单行化**（消息原文是不可信输入，见 {@link sanitizeSingleLine}）。 */
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
		const text = sanitizeSingleLine(entry.text);
		const trimmed = text.length > perEntry ? `${text.slice(0, perEntry)}…（本条见文件）` : text;
		return `[${who}] ${trimmed}`;
	});
	const output = [header, ...body].join("\n");
	return output.length > total ? `${output.slice(0, total)}\n…（输出过长已截断，完整内容见文件：${file}）` : output;
}
