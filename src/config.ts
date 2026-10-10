/**
 * 扩展配置：`<agentDir>/irc.json`（可选） + 环境变量 `IRC_*` 覆盖。
 *
 * 默认值刻意宽松：不配任何东西时扩展照样加载（工具/命令/会话目录都在），只是不会去连
 * IRC server，`/irc status` 会逐条说明缺什么、怎么补。
 *
 * 只支持一个 server（多网络并行不在 v1 范围，见 README）；SASL 不做，`password` 只是
 * 连接密码（IRC `PASS`，配给需要 server password 的私网/网关）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 扩展自己用的最小日志面，避免核心模块依赖宿主 `pi.logger` 的具体类型。
 * 放在 config.ts（本扩展最底层、无内部依赖的模块）里，供 client/conversations/transcript/inbound 共用。
 */
export interface IrcLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	debug?(message: string, meta?: Record<string, unknown>): void;
}

/** 测试与无 logger 场景的兜底。 */
export const silentLogger: IrcLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

export interface IrcConfig {
	/** IRC server 主机名/IP；未配置时不知道连哪里。 */
	server?: string;
	/** 端口；缺省 6667（明文） / 6697（TLS）。 */
	port: number;
	/** 是否 TLS（`tls.connect`，默认按系统 CA 校验）。 */
	tls: boolean;
	/** 连接用的最终昵称 = `nick` + `-` + 展开后的实例后缀；也是私聊的目标名。 */
	nick: string;
	/** 启动即 JOIN 的频道（缺省为空：只收私聊）。 */
	channels: string[];
	/** IRC 连接密码（`PASS`，配给需要 server password 的网关）；不是 SASL。 */
	password?: string;
	/** 每个会话的 jsonl 转录落脚目录。 */
	transcriptDir: string;
	/** 心跳间隔（秒）：>0 启用（静默这么久就发 `PING`）；0 = 关闭。缺省 60。 */
	keepaliveSeconds: number;
	/** 发出 `PING` 后多久没有任何入站行就判定连接已死（秒）。缺省 30：这只是等一个 PONG 的预算，与间隔无关。 */
	keepaliveTimeoutSeconds?: number;
	configPath: string;
	/** 能连 server 的前提：server + nick 齐备。 */
	configured: boolean;
}

export interface IrcConfigLoad {
	config: IrcConfig;
	/** 配置来源/忽略项说明，启动日志与 `/irc status` 共用。 */
	notes: string[];
}

/** 环境变量解析结果；未设置的字段为 undefined，不覆盖文件值。 */
interface EnvOverrides {
	server?: string;
	port?: number;
	tls?: boolean;
	nick?: string;
	nickSuffix?: string;
	channels?: string[];
	password?: string;
	transcriptDir?: string;
	keepaliveSeconds?: number;
	keepaliveTimeoutSeconds?: number;
}

const CONFIG_FILENAME = "irc.json";
const MAX_PORT = 65_535;
/** 心跳秒数上限（一天）：再大就没意义了，多半是写错。 */
const MAX_SECONDS = 24 * 60 * 60;

/**
 * 心跳默认开：半开连接（对端已把我们踢掉、FIN 却没到达本机）不会产生任何 socket 事件，
 * 只靠 `close` 驱动的重连永远不会触发，状态栏会一直显示「已连接」。60s 也小于常见 ircd
 * 的 idle ping 阈值，顺带避免服务端以 ping timeout 踢人。
 */
export const DEFAULT_KEEPALIVE_SECONDS = 60;
/** 判死预算（等一个 PONG 的时间）：不随间隔放大，间隔拉长也不该更晚发现断线。 */
export const DEFAULT_KEEPALIVE_TIMEOUT_SECONDS = 30;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPort(value: unknown): number | undefined {
	const raw = typeof value === "number" ? value : asString(value) === undefined ? undefined : Number(asString(value));
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_PORT) return undefined;
	return raw;
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	const raw = asString(value)?.toLowerCase();
	if (raw === undefined) return undefined;
	return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function asSeconds(value: unknown): number | undefined {
	const raw = typeof value === "number" ? value : asString(value) === undefined ? undefined : Number(asString(value));
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_SECONDS) return undefined;
	return raw;
}

/** 心跳间隔：口径同 {@link asSeconds}，但 **0 合法**（= 关闭心跳；这一档必须能写出来）。 */
function asKeepaliveSeconds(value: unknown): number | undefined {
	const raw = typeof value === "number" ? value : asString(value) === undefined ? undefined : Number(asString(value));
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_SECONDS) return undefined;
	return raw;
}

/** 逗号分隔字符串（env）或数组（文件）都接受，返回频道列表。 */
function parseChannels(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim());
	}
	const raw = asString(value);
	if (raw === undefined) return undefined;
	return raw
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

/**
 * 工作区标签 / 实例后缀。
 *
 * QQ 渠道是单例，IRC 不是：**同一个 IRC server 上，本机的每个 omp 实例都是一条独立连接**。
 * 因此最终昵称默认带上工作区标签（`ctx.cwd` 的目录名）——`D:/JXAI` → `omp-jxai`，
 * 同一频道里的多个实例一眼可分，也不会互相抢昵称。`nickSuffix` 可换模板或置空关闭。
 */

/** 昵称总长度上限（RFC2812 要求服务端至少支持 30 字符）。 */
export const NICK_MAX_LENGTH = 30;
/** 工作区标签长度上限：够区分，又不至于把昵称顶到服务端上限。 */
const WORKSPACE_TAG_MAX = 16;
/** 后缀模板的缺省值：工作区目录名。 */
const DEFAULT_NICK_SUFFIX = "{workspace}";
/** 声明「关闭实例后缀」的写法（文件里也可以直接用布尔 `false`）。 */
const NICK_SUFFIX_OFF: Record<string, true> = { "": true, "0": true, false: true, no: true, off: true, none: true, "-": true };

/** 收敛成 IRC 昵称里最保守的一档字符集（`[a-z0-9_-]`），并去掉首尾的 `-`/`_`。 */
function sanitizeNickPart(raw: string, limit: number): string {
	const collapsed = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	return collapsed.slice(0, Math.max(0, limit));
}

/** 工作区路径的 4 位短哈希：目录同名（不同父路径）时还能区分。 */
export function shortPathHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 4);
}

/**
 * 工作区的昵称标签：`D:/JXAI` → `jxai`。目录名收敛后为空（全非 ASCII 的目录名、盘根）
 * 时退化为 4 位短哈希，保证非空；没有工作区路径时为 `""`（= 不加后缀）。
 */
export function workspaceTag(cwd: string | undefined): string {
	if (!cwd) return "";
	const tag = sanitizeNickPart(path.basename(path.resolve(cwd)), WORKSPACE_TAG_MAX);
	return tag || shortPathHash(cwd);
}

/** 展开 `nickSuffix` 模板：`{workspace}` → 工作区标签，`{hash}` → 4 位短哈希。 */
export function expandNickSuffix(template: string, cwd: string | undefined): string {
	if (!cwd) return "";
	const tag = workspaceTag(cwd);
	const expanded = template.replaceAll("{workspace}", tag).replaceAll("{hash}", shortPathHash(cwd));
	return sanitizeNickPart(expanded, NICK_MAX_LENGTH);
}

/**
 * `nickSuffix` 取值：字符串按模板处理，空串与 `false`/`off` 类写法 = 关闭（返回空串）；
 * 其它类型（`true`、数字…）视为没写，回退默认模板。
 * **注意**空串在这里有语义（关闭），所以不能用 {@link asString} 判空。
 */
function parseNickSuffix(value: unknown): string | undefined {
	if (typeof value === "string") {
		const raw = value.trim();
		return NICK_SUFFIX_OFF[raw.toLowerCase()] ? "" : raw;
	}
	return value === false ? "" : undefined;
}

interface ConfigFile {
	server?: unknown;
	port?: unknown;
	tls?: unknown;
	nick?: unknown;
	nickSuffix?: unknown;
	channels?: unknown;
	password?: unknown;
	transcriptDir?: unknown;
	keepaliveSeconds?: unknown;
	keepaliveTimeoutSeconds?: unknown;
}

function readConfigFile(filePath: string, notes: string[]): ConfigFile {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		// 缺文件是正常情况：全部走默认值。
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			notes.push(`读取 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`);
		}
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		notes.push(`${filePath} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），已忽略`);
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		notes.push(`${filePath} 顶层必须是对象，已忽略`);
		return {};
	}
	notes.push(`配置文件：${filePath}`);
	return parsed as ConfigFile;
}

/** 环境变量优先于文件；记录每个实际生效的覆盖，避免“改了 env 没反应”的困惑。 */
function readEnv(env: Record<string, string | undefined>, notes: string[]): EnvOverrides {
	const out: EnvOverrides = {};
	const take = <K extends keyof EnvOverrides>(key: K, raw: string | undefined, parse: (v: string) => EnvOverrides[K]) => {
		if (raw === undefined || raw.trim() === "") return;
		const parsed = parse(raw);
		if (parsed === undefined) {
			notes.push(`env ${envName(key)} 值非法，已忽略`);
			return;
		}
		out[key] = parsed;
		notes.push(`env ${envName(key)} 生效`);
	};
	take("server", env.IRC_SERVER, asString as (v: string) => string | undefined);
	take("port", env.IRC_PORT, asPort as (v: string) => number | undefined);
	take("tls", env.IRC_TLS, asBoolean as (v: string) => boolean | undefined);
	take("nick", env.IRC_NICK, asString as (v: string) => string | undefined);
	take("channels", env.IRC_CHANNELS, parseChannels);
	take("password", env.IRC_PASSWORD, asString as (v: string) => string | undefined);
	take("transcriptDir", env.IRC_TRANSCRIPT_DIR, asString as (v: string) => string | undefined);
	take("keepaliveSeconds", env.IRC_KEEPALIVE_SECONDS, asKeepaliveSeconds as (v: string) => number | undefined);
	take("keepaliveTimeoutSeconds", env.IRC_KEEPALIVE_TIMEOUT_SECONDS, asSeconds as (v: string) => number | undefined);
	// 不走 take：空串对 nickSuffix 有语义（关闭后缀），而 take 把空串当「未设置」跳过。
	if (env.IRC_NICK_SUFFIX !== undefined) {
		const parsed = parseNickSuffix(env.IRC_NICK_SUFFIX);
		if (parsed === undefined) notes.push(`env ${envName("nickSuffix")} 值非法，已忽略`);
		else {
			out.nickSuffix = parsed;
			notes.push(`env ${envName("nickSuffix")} 生效`);
		}
	}
	return out;
}

/** server ← IRC_SERVER；只在报错信息里用。 */
function envName(key: keyof EnvOverrides): string {
	return `IRC_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
}

export interface IrcConfigOptions {
	env?: Record<string, string | undefined>;
	/**
	 * 会话工作区（宿主 `ctx.cwd`）：实例后缀 `{workspace}` / `{hash}` 的来源。
	 * 不传（直连 loadConfig 的测试/嵌入场景）时不加实例后缀，昵称就是 `nick`。
	 */
	cwd?: string;
	/** 追加说明的输出，便于测试断言。 */
	notes?: string[];
}

export function loadConfig(agentDir: string, options: IrcConfigOptions = {}): IrcConfigLoad {
	const notes = options.notes ?? [];
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const cwd = options.cwd;
	// 配置文件位置可被 `IRC_CONFIG_PATH` 改写：跑测试/第二份实例时与机器上真实的 irc.json 隔离
	// （指向一个不存在的路径 = 全默认）。
	const configFile = asString(env.IRC_CONFIG_PATH) ?? path.join(agentDir, CONFIG_FILENAME);
	const file = readConfigFile(configFile, notes);
	const overrides = readEnv(env, notes);

	const server = overrides.server ?? asString(file.server);
	const tls = overrides.tls ?? asBoolean(file.tls) ?? false;
	const port = overrides.port ?? asPort(file.port) ?? (tls ? 6697 : 6667);
	const baseNick = overrides.nick ?? asString(file.nick) ?? "omp";
	const nickSuffixTemplate = overrides.nickSuffix ?? parseNickSuffix(file.nickSuffix) ?? DEFAULT_NICK_SUFFIX;
	// 昵称总长有上限：后缀留给 `-` + 至少 4 个字符，否则不如不加（加一两个字符也区分不了实例）。
	const suffixRoom = NICK_MAX_LENGTH - baseNick.length - 1;
	const nickSuffix = suffixRoom >= 4 ? expandNickSuffix(nickSuffixTemplate, cwd).slice(0, suffixRoom) : "";
	const nick = nickSuffix ? `${baseNick}-${nickSuffix}` : baseNick;
	const channels = overrides.channels ?? parseChannels(file.channels) ?? [];
	const transcriptDir = overrides.transcriptDir ?? asString(file.transcriptDir) ?? path.join(agentDir, "irc-transcripts");
	const keepaliveSeconds =
		overrides.keepaliveSeconds ?? asKeepaliveSeconds(file.keepaliveSeconds) ?? DEFAULT_KEEPALIVE_SECONDS;
	const keepaliveTimeoutSeconds =
		overrides.keepaliveTimeoutSeconds ?? asSeconds(file.keepaliveTimeoutSeconds) ?? DEFAULT_KEEPALIVE_TIMEOUT_SECONDS;

	const config: IrcConfig = {
		server,
		port,
		tls,
		nick,
		channels,
		password: overrides.password ?? asString(file.password),
		transcriptDir,
		keepaliveSeconds,
		keepaliveTimeoutSeconds,
		configPath: configFile,
		configured: Boolean(server),
	};

	if (!config.configured) {
		notes.push(`未配置 server：写入 ${config.configPath}（{"server":"irc.example.org","nick":"omp"}）或设置 IRC_SERVER`);
	} else {
		notes.push(`连接目标：${config.server}:${config.port}${config.tls ? "（TLS）" : "（明文）"}，昵称 ${config.nick}`);
	}
	if (nickSuffixTemplate === "") {
		notes.push('实例后缀已关闭（nickSuffix=""）：同一 server 上多个实例会同名，撞名时服务端改名加 "_"');
	} else if (nickSuffix) {
		notes.push(
			`实例后缀 ${nickSuffixTemplate} → -${nickSuffix}（本机多实例/多工作区据此区分昵称；nickSuffix 置 "" 或 off 可关闭）`,
		);
	} else if (!cwd) {
		notes.push("实例后缀未生效（未提供工作区路径）");
	} else if (suffixRoom < 4) {
		notes.push(`实例后缀未生效（昵称 ${baseNick} 已占满 ${NICK_MAX_LENGTH} 字符）`);
	} else {
		notes.push(`实例后缀未生效（${nickSuffixTemplate} 展开后不含合法昵称字符）`);
	}
	if (config.channels.length > 0) notes.push(`启动即 JOIN：${config.channels.join("、")}`);
	else notes.push("未配置频道：只收私聊（可用 /irc join #频道 加入）");
	if (keepaliveSeconds > 0) {
		notes.push(
			`心跳：每 ${keepaliveSeconds}s 发 PING，${keepaliveTimeoutSeconds}s 内无任何入站则判死重连（keepaliveSeconds=0 关闭）`,
		);
	}
	if (config.password) notes.push("已配置连接密码（PASS；SASL 不支持）");

	return { config, notes };
}
