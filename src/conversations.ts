/**
 * 已知 IRC 会话目录（内存表）。
 *
 * IRC 会话（私聊对象 / 频道）**不是** omp 的子会话，也不注册进 AgentRegistry：上游 omp 的
 * IRC 面（`IrcBus` / peer 替身 / `deliverIrcMessage` / `irc:incoming` 卡片）是给 omp 内部
 * agent 之间通信（子代理编排）设计的，不是给外部渠道准备的。渠道进出全部走自己的门面：
 * 入站 → 主会话 `pi.sendMessage`（src/inbound.ts），出站 → `irc` 工具 / `/irc send` 命令。
 *
 * 于是这个目录只做两件事：
 * - 记住「见过哪些会话」（昵称/频道、最近活跃）；
 * - 把引用（会话 id / nick / 频道名）解析回会话，供工具与命令使用；会话 id 也是模型在入站
 *   卡片里拿到的**唯一回复句柄**，所以它必须只指向一个目标（见 {@link ConversationDirectory}）。
 *
 * 不做持久化：id 由 nick/频道名直接派生，重启后按需重建（内存表本身也不落盘）。
 */
import { createHash } from "node:crypto";
import { sanitizeForDisplay } from "./transcript";

/** 会话类型：IRC 频道（#/&）或私聊。 */
export type ConversationScope = "channel" | "query";

/** 一条入站消息带来的会话登记信息（PRIVMSG/NOTICE 共用）。 */
export interface InboundEvent {
	scope: ConversationScope;
	/** channel → 频道名（含 #）；query → 对方 nick。 */
	targetId: string;
	/** epoch ms。 */
	timestamp: number;
}

export const CONVERSATION_ID_PREFIX = "irc";

/** 非 `[a-z0-9_-]` 一律收敛成 `-`（会话 id 会进工具参数、命令与转录文件名）。 */
const ID_SAFE = /[^a-z0-9_-]/g;

/** 把 nick/频道名收敛为 id 安全形式（ConversationRecord 里仍保留原始 targetId）。 */
export function sanitizeIdPart(raw: string): string {
	return raw.trim().toLowerCase().replace(ID_SAFE, "-");
}

/**
 * 频道名前缀 → id 令牌（`#omp` 与 `&omp` 是不同频道）。
 *
 * 令牌必须以 `~` 起头，且字母不是十六进制字符：
 * - `~` 进不了任何 base（`sanitizeIdPart` 的输出只含 `[a-z0-9_-]`），所以频道 id 与
 *   私聊 id（普通 base / 有损名的 `~<16 位哈希>`）永不同形——否则 nick `chan--omp`
 *   就能顶掉频道 `#omp` 的句柄；
 * - `h`/`l` 不是十六进制字符，所以 `#<X>`（`~h<X>`）也不会与 `&<Y>` 或
 *   「有损名的 `~<哈希>`」同形——否则频道 `#local-dev` 会被频道 `&dev` 顶掉。
 */
const CHANNEL_TOKEN: Record<string, string> = { "#": "~h", "&": "~l" };

/**
 * 有损名后缀与 base 之间的分隔符。`sanitizeIdPart` 的输出只可能含 `[a-z0-9_-]`，所以 `~`
 * 不可能出现在任何 base 里——于是「带哈希的 id」不可能被对端起个像它的 nick 顶掉
 * （否则对端把自己改成 `bot-1-<别人的哈希>` 就能劫持别人的回复句柄）。`~` 是合法文件名。
 */
const LOSSY_SEPARATOR = "~";

/** 原始目标的 16 位短哈希（64 位）：收敛有损时用它把两个名字彻底分开。 */
function targetHash(scope: ConversationScope, targetId: string): string {
	return createHash("sha256").update(`${scope}\u0000${targetId}`).digest("hex").slice(0, 16);
}

/**
 * 会话 → 会话 id。**是 (scope, targetId) 的纯函数**——不随收发/淘汰顺序变化，
 * 所以会话被淘汰后重建拿到的还是同一个 id，旧卡片里给模型的句柄不会漂到别人身上。
 *
 * 三类 id 两两不同形（都靠 `~` 锚定，`~` 不可能出现在任何 base 里）：
 * - 私聊安全名：`irc-<名字>`，如 `Alice` → `irc-alice`；
 * - 频道：`irc-chan-<令牌><名字>`，`#omp` → `irc-chan-~homp`、`&omp` → `irc-chan-~lomp`
 *   （见 {@link CHANNEL_TOKEN}）；
 * - 有损名（或异常的无前缀「频道」）：上面两种再追加 `~<16 位十六进制哈希>`，如
 *   `bot[1]` → `irc-bot-1-~<哈希>`。
 *
 * 为什么要有哈希（第三类）：`sanitizeIdPart` 把 `[`、`{`、空格 等一律压成 `-`，而这些
 * 都是 RFC2812 的合法 nick 字符——`bot[1]` 与 `bot{1}` 会收敛成同一个 `bot-1`，不加哈希
 * 两个目标就共用一条记录（回复静默发给另一个人、转录混在一起）。
 */
export function encodeConversationId(scope: ConversationScope, targetId: string): string {
	const raw = targetId.trim();
	if (scope === "channel") {
		const token = raw ? CHANNEL_TOKEN[raw[0] as string] : undefined;
		// 无 `#`/`&` 前缀的「频道」是异常输入：base 照旧，但一定带哈希（保持单射）。
		const rest = raw.replace(/^[#&]/, "");
		const base =
			token === undefined
				? `${CONVERSATION_ID_PREFIX}-chan-${sanitizeIdPart(raw)}`
				: `${CONVERSATION_ID_PREFIX}-chan-${token}${sanitizeIdPart(rest)}`;
		const lossless = token !== undefined && rest.toLowerCase() === sanitizeIdPart(rest);
		return lossless ? base : `${base}${LOSSY_SEPARATOR}${targetHash(scope, raw)}`;
	}
	// 私聊 base 永不可能是频道 id：频道 id 里必有 `~`（令牌起头），而 base 里不可能有 `~`。
	const base = `${CONVERSATION_ID_PREFIX}-${sanitizeIdPart(raw)}`;
	return raw.toLowerCase() === sanitizeIdPart(raw) ? base : `${base}${LOSSY_SEPARATOR}${targetHash(scope, raw)}`;
}

/** 日志/显示用的短 id（nick 太长时卡片里放不下）。 */
export function shortenId(targetId: string, length = 8): string {
	return targetId.length <= length ? targetId : `${targetId.slice(0, length)}…`;
}

export function defaultDisplayName(scope: ConversationScope, targetId: string): string {
	return scope === "channel" ? `IRC频道 ${targetId}` : `IRC私聊 ${shortenId(targetId)}`;
}

export interface ConversationRecord {
	id: string;
	scope: ConversationScope;
	/** 原始目标：频道名（含 #）或对方 nick。 */
	targetId: string;
	displayName: string;
	/** epoch ms，最后一次收发。 */
	lastSeen: number;
}

/** 会话的一行人话。`/irc list`、`irc list` 共用这一份；nick/频道名是不可信输入，出口净化。 */
export function describeConversation(record: ConversationRecord): string {
	const scope = record.scope === "query" ? "私聊" : "频道";
	const when = new Date(record.lastSeen).toISOString().replace("T", " ").slice(0, 16);
	return sanitizeForDisplay(`${record.id} ${scope} · 最近活跃 ${when}（${record.targetId}）`);
}

export interface ConversationDirectoryOptions {
	/** 会话上限，超出按 lastSeen 淘汰（转录文件不受影响）。 */
	limit: number;
	/** 目录变化（新增/淘汰）时回调，用于刷新状态栏。 */
	onChange?: () => void;
	now?: () => number;
}

export class ConversationDirectory {
	readonly #options: ConversationDirectoryOptions;
	readonly #conversations = new Map<string, ConversationRecord>();

	constructor(options: ConversationDirectoryOptions) {
		this.#options = options;
	}

	#changed(): void {
		this.#options.onChange?.();
	}

	/** 入站消息带来的会话：不存在就登记，存在就刷新活跃时间。 */
	ensure(event: InboundEvent): ConversationRecord {
		// id 是 (scope, targetId) 的纯函数：同一目标永远同一个 id，不需要「撞车时另开一条」的状态。
		const id = encodeConversationId(event.scope, event.targetId);
		const existing = this.#conversations.get(id);
		if (existing) {
			existing.lastSeen = event.timestamp;
			this.#evictOverflow(existing);
			this.#changed();
			return existing;
		}
		const record: ConversationRecord = {
			id,
			scope: event.scope,
			targetId: event.targetId,
			displayName: defaultDisplayName(event.scope, event.targetId),
			lastSeen: event.timestamp,
		};
		this.#conversations.set(id, record);
		this.#evictOverflow(record);
		this.#changed();
		return record;
	}

	/**
	 * 还没会话过的目标 → 立即登记一个会话（首次主动开口用）：
	 * `irc send <nick> 你好` 不必等对方先发消息。频道名带 #/& 前缀即频道会话。
	 */
	ensureTarget(reference: string, timestamp: number): ConversationRecord {
		const targetId = reference.trim();
		return this.ensure({
			scope: targetId.startsWith("#") || targetId.startsWith("&") ? "channel" : "query",
			targetId,
			timestamp,
		});
	}

	#evictOverflow(keep: ConversationRecord): void {
		const limit = Math.max(1, this.#options.limit);
		if (this.#conversations.size <= limit) return;
		const victims = [...this.#conversations.values()]
			.filter(record => record.id !== keep.id)
			.sort((a, b) => a.lastSeen - b.lastSeen)
			.slice(0, this.#conversations.size - limit);
		for (const victim of victims) this.#conversations.delete(victim.id);
	}

	/** 刷新活跃时间（收发都算一次活跃）。 */
	touch(id: string): void {
		const record = this.#conversations.get(id);
		if (!record) return;
		record.lastSeen = this.#options.now?.() ?? Date.now();
		this.#changed();
	}

	/**
	 * 模型/用户给的引用 → 会话：支持会话 id、显示名、原始 nick/频道名，
	 * 全部大小写不敏感。
	 */
	resolve(reference: string): ConversationRecord | undefined {
		const needle = reference.trim().toLowerCase();
		if (!needle) return undefined;
		for (const record of this.#conversations.values()) {
			if (record.id === needle || record.targetId.toLowerCase() === needle) return record;
			if (record.displayName.toLowerCase() === needle) return record;
		}
		return undefined;
	}

	list(): ConversationRecord[] {
		return [...this.#conversations.values()].sort((a, b) => b.lastSeen - a.lastSeen);
	}

	/** 全部移除（shutdown 用）。 */
	clear(): void {
		this.#conversations.clear();
	}
}

/** 引用 → 会话：已登记的直接用；没有的按引用当场登记（主动开口，不必等对方先发消息）。 */
export function resolveOrCreateConversation(
	conversations: ConversationDirectory,
	reference: string,
	now: number,
): ConversationRecord {
	return conversations.resolve(reference) ?? conversations.ensureTarget(reference, now);
}
