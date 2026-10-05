/**
 * 扩展配置：`<agentDir>/irc.json`（可选） + 环境变量 `IRC_*` 覆盖。
 *
 * 默认值刻意宽松：不配任何东西时扩展照样加载（工具/命令/peer 目录都在），只是不会去连
 * IRC server，`/irc status` 会逐条说明缺什么、怎么补。
 *
 * 只支持一个 server（多网络并行不在 v1 范围，见 README）；SASL 不做，`password` 只是
 * 连接密码（IRC `PASS`，配给需要 server password 的私网/网关）。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 扩展自己用的最小日志面，避免核心模块依赖宿主 `pi.logger` 的具体类型。
 * 放在 config.ts（本扩展最底层、无内部依赖的模块）里，供 client/peers/transcript/bridge 共用。
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
	/** 昵称；也是私聊 peer 的目标名。 */
	nick: string;
	/** 启动即 JOIN 的频道（缺省为空：只收私聊）。 */
	channels: string[];
	/** IRC 连接密码（`PASS`，配给需要 server password 的网关）；不是 SASL。 */
	password?: string;
	/** 每个 peer 的 jsonl 转录落脚目录。 */
	transcriptDir: string;
	/** 心跳间隔（秒）：>0 启用（静默这么久就发 `PING`）；0 = 关闭（缺省）。 */
	keepaliveSeconds: number;
	/** 发出 `PING` 后多久没有任何入站行就判定连接已死（秒）；缺省 = `keepaliveSeconds`。 */
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

interface ConfigFile {
	server?: unknown;
	port?: unknown;
	tls?: unknown;
	nick?: unknown;
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
	take("keepaliveSeconds", env.IRC_KEEPALIVE_SECONDS, asSeconds as (v: string) => number | undefined);
	take("keepaliveTimeoutSeconds", env.IRC_KEEPALIVE_TIMEOUT_SECONDS, asSeconds as (v: string) => number | undefined);
	return out;
}

/** server ← IRC_SERVER；只在报错信息里用。 */
function envName(key: keyof EnvOverrides): string {
	return `IRC_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
}

export interface IrcConfigOptions {
	env?: Record<string, string | undefined>;
	/** 追加说明的输出，便于测试断言。 */
	notes?: string[];
}

export function loadConfig(agentDir: string, options: IrcConfigOptions = {}): IrcConfigLoad {
	const notes = options.notes ?? [];
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	// 配置文件位置可被 `IRC_CONFIG_PATH` 改写：跑测试/第二份实例时与机器上真实的 irc.json 隔离
	// （指向一个不存在的路径 = 全默认）。
	const configFile = asString(env.IRC_CONFIG_PATH) ?? path.join(agentDir, CONFIG_FILENAME);
	const file = readConfigFile(configFile, notes);
	const overrides = readEnv(env, notes);

	const server = overrides.server ?? asString(file.server);
	const tls = overrides.tls ?? asBoolean(file.tls) ?? false;
	const port = overrides.port ?? asPort(file.port) ?? (tls ? 6697 : 6667);
	const nick = overrides.nick ?? asString(file.nick) ?? "omp";
	const channels = overrides.channels ?? parseChannels(file.channels) ?? [];
	const transcriptDir = overrides.transcriptDir ?? asString(file.transcriptDir) ?? path.join(agentDir, "irc-transcripts");
	const keepaliveSeconds = overrides.keepaliveSeconds ?? asSeconds(file.keepaliveSeconds) ?? 0;
	const keepaliveTimeoutSeconds = overrides.keepaliveTimeoutSeconds ?? asSeconds(file.keepaliveTimeoutSeconds);

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
	if (config.channels.length > 0) notes.push(`启动即 JOIN：${config.channels.join("、")}`);
	else notes.push("未配置频道：只收私聊（可用 /irc join #频道 加入）");
	if (keepaliveSeconds > 0) {
		notes.push(
			`心跳：每 ${keepaliveSeconds}s 发 PING，${keepaliveTimeoutSeconds ?? keepaliveSeconds}s 内无任何入站则判死重连`,
		);
	}
	if (config.password) notes.push("已配置连接密码（PASS；SASL 不支持）");

	return { config, notes };
}
