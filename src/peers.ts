/**
 * IRC 会话在 omp AgentRegistry 里的 peer 替身。
 *
 * 设计要点（照抄 QQ 扩展的同一套契约，见 README）：
 * - 每个 IRC 会话（频道 / 私聊对象）注册一个 `kind: "sub"`、`status: "idle"` 的 ref，
 *   于是它出现在模型可见的 `history://` roster 里，模型可以 `write agent://<id>`
 *   直接回话（宿主 IrcBus 会调用 ref.session.deliverIrcMessage）。
 * - `deliverIrcMessage` 是唯一真实入口：收到内容就发 PRIVMSG/NOTICE，并回 "injected"。
 * - `transcriptOnly: true` 声明「这是外部渠道端点」：Hub 里 `⏎` 打开 sessionFile 转录
 *   而不是 attach 替身，`history://<id>` 也读转录文件。
 * - 系统对 ref.session 的其它访问要么可选链，要么被 `status === "running"` 挡住，
 *   idle + 下面这个替身面足够。
 */
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent";

/** 会话类型：IRC 频道（#/&）或私聊。 */
export type PeerScope = "channel" | "query";

/** 一条已归一化的入站 IRC 消息（PRIVMSG/NOTICE）。 */
export interface InboundEvent {
	scope: PeerScope;
	/** channel → 频道名（含 #）；query → 对方 nick。 */
	targetId: string;
	/** IRC 消息 id（RFC1459 没有，由扩展用 `irc-<ts>-<序号>` 合成）。 */
	messageId: string;
	/** epoch ms。 */
	timestamp: number;
	/** 频道里发言的成员 nick（写进转录署名）。 */
	senderNick?: string;
}

export const PEER_ID_PREFIX = "irc";

/** 非 `[a-z0-9_-]` 一律收敛成 `-`（peer id 会进 URL 与卡片渲染）。 */
const ID_SAFE = /[^a-z0-9_-]/g;

/** 把 nick/频道名收敛为 id 安全形式（PeerRecord 里仍保留原始 targetId）。 */
export function sanitizeIdPart(raw: string): string {
	return raw.trim().toLowerCase().replace(ID_SAFE, "-");
}

/**
 * 会话 → peer id：
 * - 私聊 `alice` → `irc-alice`（规范要求的 `irc-<nick小写化>`）；
 * - 频道 `#omp` → `irc-chan--omp`（频道带前缀，避免与同名 nick 撞车）。
 */
export function encodePeerId(scope: PeerScope, targetId: string): string {
	return scope === "query" ? `${PEER_ID_PREFIX}-${sanitizeIdPart(targetId)}` : `${PEER_ID_PREFIX}-chan-${sanitizeIdPart(targetId)}`;
}

/** 日志/显示用的短 id（nick 太长时卡片里放不下）。 */
export function shortenId(targetId: string, length = 8): string {
	return targetId.length <= length ? targetId : `${targetId.slice(0, length)}…`;
}

export function defaultDisplayName(scope: PeerScope, targetId: string): string {
	return scope === "channel" ? `IRC频道 ${targetId}` : `IRC私聊 ${shortenId(targetId)}`;
}

/** 宿主对 peer 会话替身实际会触碰的面。 */
export interface PeerSessionAdapter {
	/** 宿主用它判断 peer 是否在跑（`AgentRegistry.isRunning`）——IRC peer 恒为 false。 */
	readonly isStreaming: false;
	/** `history://<id>` 读 transcript 时取它（transcriptOnly 时宿主改读 sessionFile）。 */
	readonly messages: readonly unknown[];
	/** IrcBus 出站投递入口。 */
	deliverIrcMessage(message: { from: string; to: string; body: string }): Promise<"injected">;
	/** `wait`/`inbox` 的缓冲区；IRC 消息直接进上下文，不留缓冲。 */
	drainPendingIrcInboxMessages(): never[];
	/** 显式 kill（proc://）时的收尾：注销 peer。 */
	dispose(): Promise<void>;
	/**
	 * Hub 聚焦入口（`session-focus-controller#attach` 第一件事就是 `target.subscribe()`）。
	 *
	 * 这里是**故意抛错**的：替身不是真实 AgentSession，而聚焦路径会一路读
	 * `statusLine.setSession`、`agent.getPendingToolResults` 等一大票真实成员——
	 * 放过去就是 `undefined is not an object` 崩溃。抛可读错误让宿主退回主会话并把
	 * 这句话显示出来（`input-controller#focusResolvedAgent` 的 catch）。
	 */
	subscribe(): () => void;
	/**
	 * 聚焦路径在 `target.subscribe()` **之前**就会走这段：
	 * `#attach` → `resetTranscriptAnchors()` → `#seedHeldCompletionsFromPendingResults()`
	 * → `viewSession.agent.getPendingToolResults()`。所以这里也要挡住——两个成员名都留着：
	 * HEAD 叫 `n()`，发布的 18.4.x/18.6.x 叫 `getPendingToolResults()`。
	 */
	agent: Record<string, () => never>;
}

/** Hub 聚焦 IRC peer 时的统一说明（替身不是真实 AgentSession）。 */
function refusal(peerId: string): Error {
	return new Error(`IRC 会话 ${peerId} 是外部渠道端点，不是可查看的 omp 子会话（用 /irc status 看连接状态）`);
}

/** AgentRegistry 的结构子集，便于测试注入假实现。 */
export interface PeerRegistry {
	get(id: string): { id: string; displayName?: string; status?: string; session?: unknown } | undefined;
	register(input: {
		id: string;
		displayName: string;
		kind: "sub";
		parentId?: string;
		status?: "idle";
		session: unknown;
		sessionFile?: string | null;
		/**
		 * 声明「这是外部渠道端点，无可聚焦的实时会话」。
		 * 不认识这个键的宿主会逐字段拷贝并直接丢弃 → 旧宿主上无副作用；支持的宿主会把
		 * Hub 的 `⏎` 走转录视图而不是 attach 替身。
		 */
		transcriptOnly?: boolean;
		activity?: string;
		createdAt?: number;
		lastActivity?: number;
	}): unknown;
	unregister(id: string, expected?: unknown): boolean;
}

/** 真实 AgentRegistry 满足上面的结构（构造处一次带注释的断言）。 */
export type RealPeerRegistry = AgentRegistry;

export interface PeerRecord {
	id: string;
	scope: PeerScope;
	/** 原始目标：频道名（含 #）或对方 nick。 */
	targetId: string;
	displayName: string;
	/** 用户/模型设置的别名，覆盖 displayName 显示。 */
	alias?: string;
	/** epoch ms，最后一次收发。 */
	lastSeen: number;
	/** 最近一条入站消息 id（回复时带上，便于对端串联）。 */
	lastMsgId?: string;
}

/** peer 的一行人话。`/irc list`、`irc list` 共用这一份。 */
export function describePeer(peer: PeerRecord): string {
	const scope = peer.scope === "query" ? "私聊" : "频道";
	const alias = peer.alias ? `（${peer.alias}）` : "";
	const when = new Date(peer.lastSeen).toISOString().replace("T", " ").slice(0, 16);
	return `${peer.id} ${scope}${alias} · 最近活跃 ${when}`;
}

export interface PeerDirectoryOptions {
	registry: PeerRegistry;
	/**
	 * 该 peer 的转录文件路径（挂到 `sessionFile`，Agent Hub 的转录视图据此加载）。
	 * 缺省时 `sessionFile: null`——Hub 里就只看得到「没有会话文件」。
	 */
	transcriptPath?: (peerId: string) => string;
	/** 主 agent id（peer 的 parentId）。 */
	mainAgentId: string;
	/** 出站投递实现：把正文发成 IRC PRIVMSG。 */
	send: (peer: PeerRecord, text: string) => Promise<void>;
	/** peer 上限，超出按 lastSeen 淘汰。 */
	limit: number;
	/** 目录变化（新增/淘汰/别名）时回调，用于持久化。 */
	onChange?: () => void;
	now?: () => number;
}

export class PeerDirectory {
	readonly #options: PeerDirectoryOptions;
	readonly #peers = new Map<string, PeerRecord>();

	constructor(options: PeerDirectoryOptions) {
		this.#options = options;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	#register(record: PeerRecord): void {
		const adapter: PeerSessionAdapter = {
			isStreaming: false,
			messages: [],
			deliverIrcMessage: async message => {
				// 宿主 IrcBus 已 await 这里：抛错会变成 "Failed: … <error>" 回执。
				await this.#options.send(record, message.body);
				record.lastSeen = this.#now();
				return "injected";
			},
			drainPendingIrcInboxMessages: () => [],
			dispose: async () => {
				this.forget(record.id);
			},
			subscribe: () => {
				throw refusal(record.id);
			},
			agent: {
				getPendingToolResults: () => {
					throw refusal(record.id);
				},
				n: () => {
					throw refusal(record.id);
				},
			},
		};
		this.#options.registry.register({
			id: record.id,
			displayName: record.alias ?? record.displayName,
			kind: "sub",
			parentId: this.#options.mainAgentId,
			status: "idle",
			// 鸭子类型：宿主只按 PeerSessionAdapter 的面使用这个替身（PeerRegistry 的
			// session 字段声明为 unknown，因此这里不需要断言）。
			session: adapter,
			sessionFile: this.#options.transcriptPath?.(record.id) ?? null,
			// 替身只是出站投递端点：Hub 里 `⏎` 应当打开 sessionFile 转录视图，
			// 而不是把替身当实时会话去 attach（那必然抛 refusal，见 PeerSessionAdapter）。
			transcriptOnly: true,
			activity: record.scope === "channel" ? `IRC 频道 ${record.targetId}` : `IRC 私聊 ${record.targetId}`,
			createdAt: record.lastSeen,
			lastActivity: record.lastSeen,
		});
	}

	/** 入站消息带来的会话：不存在就注册成 peer，存在就刷新活跃时间。 */
	ensure(event: Pick<InboundEvent, "scope" | "targetId" | "messageId" | "timestamp">): PeerRecord {
		const id = encodePeerId(event.scope, event.targetId);
		const existing = this.#peers.get(id);
		if (existing) {
			existing.targetId = event.targetId;
			existing.lastSeen = event.timestamp;
			existing.lastMsgId = event.messageId;
			this.#evictOverflow(existing);
			this.#changed();
			return existing;
		}
		const record: PeerRecord = {
			id,
			scope: event.scope,
			targetId: event.targetId,
			displayName: defaultDisplayName(event.scope, event.targetId),
			lastSeen: event.timestamp,
			lastMsgId: event.messageId,
		};
		this.#peers.set(id, record);
		this.#register(record);
		this.#evictOverflow(record);
		this.#changed();
		return record;
	}

	/** 持久化恢复/测试注入：直接登记一条已知 peer。 */
	remember(record: PeerRecord): void {
		if (this.#peers.has(record.id)) return;
		this.#peers.set(record.id, record);
		this.#register(record);
		this.#evictOverflow(record);
	}

	/**
	 * 还没会话过的目标 → 立即登记一个 peer（首次主动开口用）：
	 * `/irc say <nick> 你好` 不必等对方先发消息。频道名带 #/& 前缀即频道会话。
	 */
	ensureTarget(reference: string, messageId: string, timestamp: number): PeerRecord {
		const targetId = reference.trim();
		return this.ensure({
			scope: targetId.startsWith("#") || targetId.startsWith("&") ? "channel" : "query",
			targetId,
			messageId,
			timestamp,
		});
	}

	#evictOverflow(keep: PeerRecord): void {
		const limit = Math.max(1, this.#options.limit);
		if (this.#peers.size <= limit) return;
		const victims = [...this.#peers.values()]
			.filter(peer => peer.id !== keep.id)
			.sort((a, b) => a.lastSeen - b.lastSeen)
			.slice(0, this.#peers.size - limit);
		for (const victim of victims) this.forget(victim.id, false);
	}

	/** 注销并移除一个 peer；`notify=false` 用于批量清理。 */
	forget(id: string, notify = true): boolean {
		if (!this.#peers.delete(id)) return false;
		this.#options.registry.unregister(id);
		if (notify) this.#changed();
		return true;
	}

	#changed(): void {
		this.#options.onChange?.();
	}

	get(id: string): PeerRecord | undefined {
		return this.#peers.get(id);
	}

	/**
	 * 模型/用户给的引用 → peer：支持 peer id、别名、显示名、原始 nick/频道名，
	 * 全部大小写不敏感。
	 */
	resolve(reference: string): PeerRecord | undefined {
		const needle = reference.trim().toLowerCase();
		if (!needle) return undefined;
		for (const record of this.#peers.values()) {
			if (record.id === needle || record.targetId.toLowerCase() === needle) return record;
			if (record.alias?.toLowerCase() === needle || record.displayName.toLowerCase() === needle) return record;
		}
		return undefined;
	}

	alias(id: string, name: string): boolean {
		const record = this.#peers.get(id);
		if (!record) return false;
		record.alias = name.trim() || undefined;
		this.#options.registry.unregister(id);
		this.#register(record);
		this.#changed();
		return true;
	}

	list(): PeerRecord[] {
		return [...this.#peers.values()].sort((a, b) => b.lastSeen - a.lastSeen);
	}

	/**
	 * 全部注销（shutdown / restart 用），不触发 onChange：注销会把 peer 从 registry 摘掉，
	 * 但持久化快照应当保留它们——调用方先 `serialize()` 再 `clear()`，否则最后一次落盘会写成空表。
	 */
	clear(): void {
		for (const id of [...this.#peers.keys()]) this.forget(id, false);
	}

	/** 持久化快照：按最近活跃排序并裁剪到上限。 */
	serialize(): { version: 1; peers: PeerRecord[] } {
		return { version: 1, peers: this.list().slice(0, Math.max(1, this.#options.limit)) };
	}

	/** 读取持久化快照；字段缺失/类型不符的条目直接丢弃。 */
	restore(data: unknown): number {
		if (!data || typeof data !== "object" || !("peers" in data)) return 0;
		const peers = data.peers;
		if (!Array.isArray(peers)) return 0;
		let restored = 0;
		for (const entry of peers) {
			const record = readPersistedPeer(entry, this.#now());
			if (!record) continue;
			this.remember(record);
			restored += 1;
		}
		return restored;
	}
}

/** 引用 → peer：已登记的直接用；没有的按引用当场登记（主动开口，不必等对方先发消息）。 */
export function resolveOrCreatePeer(peers: PeerDirectory, reference: string, now: number): PeerRecord {
	return peers.resolve(reference) ?? peers.ensureTarget(reference, `irc-local-${now}`, now);
}

/** 持久化条目 → PeerRecord；任何字段不符就整条丢弃（nick 丢了也没法回消息）。 */
function readPersistedPeer(entry: unknown, now: number): PeerRecord | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	if (!("id" in entry) || typeof entry.id !== "string") return undefined;
	if (!("targetId" in entry) || typeof entry.targetId !== "string") return undefined;
	if (!("scope" in entry) || (entry.scope !== "channel" && entry.scope !== "query")) return undefined;
	// id 必须与 targetId/scope 自洽，否则回消息会打到错的会话。
	if (encodePeerId(entry.scope, entry.targetId) !== entry.id) return undefined;
	const displayName = "displayName" in entry && typeof entry.displayName === "string" ? entry.displayName : undefined;
	const alias = "alias" in entry && typeof entry.alias === "string" ? entry.alias : undefined;
	const lastSeen = "lastSeen" in entry && typeof entry.lastSeen === "number" ? entry.lastSeen : now;
	return {
		id: entry.id,
		scope: entry.scope,
		targetId: entry.targetId,
		displayName: displayName ?? defaultDisplayName(entry.scope, entry.targetId),
		alias,
		lastSeen,
	};
}
