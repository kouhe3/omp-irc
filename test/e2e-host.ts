/**
 * 宿主级 e2e：真 omp 进程（`--mode rpc`）+ IRC 服务，证明「扩展在真宿主里连上 IRC、
 * JOIN 频道，入站消息进了**真宿主的会话上下文**（`irc:message` 卡片），渠道自己的
 * 转录留了原文账本；出站走 `/irc send` 命令，PRIVMSG 真的上线路」。
 *
 * 入站断言不再看 peer 转录，而是轮询**真宿主的会话 jsonl**
 * （`<agentDir>/sessions/<cwd-slug>/**.jsonl`；agentDir 取 `PI_CODING_AGENT_DIR`，
 * 缺省 `~/.omp/agent`）：按「目录名含本次运行前缀 + 文件 mtime > 测试开始时间」过滤，
 * 要求出现 `irc:message` 的 custom 条目、且正文含 marker（频道一条、私聊一条）。
 *
 * 默认起扩展自带的 mock IRC server；`IRC_E2E_SERVER=host:port` 时改连**外部 ircd**
 * （此时用一根裸 TCP socket 当"人类"客户端：发频道/私聊消息、收 bot 的私聊回复），
 * 用来验证真实 ircd 的互操作。连外部 ircd 时 bot 与人类昵称都带随机后缀，避免撞名。
 * 心跳不设走扩展缺省（60s/30s）；调低（`IRC_KEEPALIVE_SECONDS=2 IRC_KEEPALIVE_TIMEOUT_SECONDS=1`）
 * 可以在几秒内顺带覆盖心跳路径（真 ircd 会回我们的 PONG）。
 *
 * 宿主默认取 PATH 上的 `omp`；**注意** `Bun.spawn(["omp"])` 会先命中本扩展
 * `node_modules/.bin/omp`（devDependency 钉的发行版），要验证 fork/源码宿主必须覆盖：
 *   IRC_E2E_OMP=<fork>/packages/coding-agent/src/cli.ts bun run e2e:host
 *   IRC_E2E_SERVER=jiaoxing.xin:6667 bun run e2e:host   # 真 ircd（缺省心跳）
 * 外部 ircd 下人类昵称是测试自己起的（`human-e2e-xxxx`，见日志首行），出站目标就是它。
 */
import { spawn } from "bun";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceTag } from "../src/config";
import { IRC_INCOMING_TYPE } from "../src/inbound";
import { startMockIrcServer, type MockIrcServer } from "./mock-irc-server";

const CHANNEL = process.env.IRC_E2E_CHANNEL ?? "#omp";
const EXTERNAL = process.env.IRC_E2E_SERVER;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irc-host-e2e-"));
const transcriptDir = path.join(tmp, "transcripts");
/**
 * marker 带本次运行后缀：会话 jsonl 是「按目录名 + mtime」扫的，静态 marker 会让**并发**的
 * 另一次运行（或上次运行残留的会话文件）把断言凑成假通过。后缀让每个 marker 只可能来自本次运行。
 */
const RUN_TAG = Date.now().toString(36).slice(-4);
/** 入站 marker：第一条走频道、第二条私聊给 bot。 */
const MARKERS = [`hello-from-real-host-${RUN_TAG}`, `dm-from-real-host-${RUN_TAG}`];
/** 出站 marker：`/irc send` 的正文。 */
const OUT_MARKER = `out-from-real-host-${RUN_TAG}`;
/** 会话目录按 cwd slug 命名；本次 tmp 目录名带这个前缀，用来定位本次运行的会话文件。 */
const SESSION_DIR_PREFIX = "irc-host-e2e";
const startedAt = Date.now();

/** 真宿主的 sessions 根（agentDir 受 PI_CODING_AGENT_DIR 覆盖，与子进程环境一致）。 */
const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
const sessionsRoot = path.join(agentDir, "sessions");

const mock: MockIrcServer | undefined = EXTERNAL ? undefined : await startMockIrcServer();
const [serverHost, serverPort] = EXTERNAL
	? (EXTERNAL.split(":", 2) as [string, string])
	: [mock?.host ?? "127.0.0.1", String(mock?.port ?? 0)];
// 外部 ircd 上 `omp` 可能已被占用（撞名会被 433 改名，私聊就打偏了）：带随机后缀。
const botNickBase = EXTERNAL ? `omp-e2e-${Date.now().toString(36).slice(-4)}` : "omp";
// 宿主进程的 cwd 是 tmp，扩展默认给昵称加工作区后缀（实例专属昵称）：按同一规则算出期望值，
// 于是这条断言等于在验「真宿主把 ctx.cwd 传给了扩展」——传丢了就会退化成 botNickBase 而 FAIL。
const botNick = `${botNickBase}-${workspaceTag(tmp)}`;

// 「人类」客户端昵称：mock 模式下没有真连接，用固定的 Alice（服务端只记录 bot 写出的帧）；
// 外部 ircd 模式下是真 socket，人收得到 bot 的私聊，就用它当出站目标。
const humanNick = EXTERNAL ? `human-e2e-${Date.now().toString(36).slice(-4)}` : "Alice";

// 外部 ircd：裸 socket 当"人类"——先注册（等到 001 再 JOIN，很多 ircd 会先做 hostname 查询）。
let human: net.Socket | undefined;
const humanFrames: string[] = [];
if (EXTERNAL) {
	// 外部 ircd 是共享服务：硬编码的人类昵称随时可能已经在线，撞名 → 433 → 这一侧永远
	// 注册不上、JOIN 也发不出去，于是断言全挂而看不出原因。人类侧同样用随机昵称。
	human = net.createConnection({ host: serverHost, port: Number(serverPort) });
	human.setEncoding("utf8");
	let buf = "";
	human.on("data", chunk => {
		buf += chunk;
		const lines = buf.split("\r\n");
		buf = lines.pop() ?? "";
		humanFrames.push(...lines);
	});
	await new Promise<void>(resolve => human?.once("connect", () => resolve()));
	human.write(`NICK ${humanNick}\r\nUSER ${humanNick} 0 * :human\r\n`);
	for (let i = 0; i < 40 && !humanFrames.some(line => line.split(" ")[1] === "001"); i++) await Bun.sleep(250);
	if (!humanFrames.some(line => line.split(" ")[1] === "001")) {
		console.log(`human（${humanNick}）未注册成功：`, humanFrames.slice(-3).join(" ⏎ "));
	}
	human.write(`JOIN ${CHANNEL}\r\n`);
	await Bun.sleep(400);
}

const ompOverride = process.env.IRC_E2E_OMP;
const hostCommand = ompOverride
	? ompOverride.endsWith(".ts")
		? [process.execPath, ompOverride]
		: [ompOverride]
	: ["omp"];
const host = spawn([...hostCommand, "--mode", "rpc", "--auto-approve"], {
	cwd: tmp,
	// RPC 模式把 stdin EOF 当退出信号：给一根不关的管道，否则宿主会提前收摊。
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: {
		...process.env,
		IRC_CONFIG_PATH: path.join(tmp, "missing-irc.json"),
		IRC_SERVER: serverHost,
		IRC_PORT: serverPort,
		IRC_TLS: "false",
		// IRC_NICK 是**基础**昵称：期望的最终昵称是它 + `-` + 工作区标签（见 botNick）。
		IRC_NICK: botNickBase,
		// 钉住后缀模板：本测试的期望昵称按 {workspace} 算，别让机器上的 IRC_NICK_SUFFIX 影响结果。
		IRC_NICK_SUFFIX: "{workspace}",
		IRC_CHANNELS: CHANNEL,
		IRC_TRANSCRIPT_DIR: transcriptDir,
		// 不设就走扩展缺省心跳（60s/30s）：真 ircd 上这条路径本身也要被覆盖。
		// 调低（如 IRC_KEEPALIVE_SECONDS=2）可以顺带验真 ircd 会回 PONG。
		...(process.env.IRC_KEEPALIVE_SECONDS ? { IRC_KEEPALIVE_SECONDS: process.env.IRC_KEEPALIVE_SECONDS } : {}),
		...(process.env.IRC_KEEPALIVE_TIMEOUT_SECONDS
			? { IRC_KEEPALIVE_TIMEOUT_SECONDS: process.env.IRC_KEEPALIVE_TIMEOUT_SECONDS }
			: {}),
	},
});

// ── RPC 帧泵：把 stdout 行解析成帧（`ready`/`prompt_result`/`notify`…），并支持「等某帧」 ──
interface RpcFrame {
	id?: string;
	type?: string;
	method?: string;
	agentInvoked?: boolean;
	[key: string]: unknown;
}

const frames: RpcFrame[] = [];
const frameWaiters: { pred: (frame: RpcFrame) => boolean; resolve: (frame: RpcFrame) => void }[] = [];
let frameBuffer = "";
void (async () => {
	const decoder = new TextDecoder();
	for await (const chunk of host.stdout as ReadableStream<Uint8Array>) {
		frameBuffer += decoder.decode(chunk, { stream: true });
		let index = frameBuffer.indexOf("\n");
		while (index !== -1) {
			const line = frameBuffer.slice(0, index);
			frameBuffer = frameBuffer.slice(index + 1);
			index = frameBuffer.indexOf("\n");
			if (!line.trim()) continue;
			let frame: RpcFrame;
			try {
				frame = JSON.parse(line) as RpcFrame;
			} catch {
				continue;
			}
			if (typeof frame !== "object" || frame === null || typeof frame.type !== "string") continue;
			frames.push(frame);
			for (const waiter of [...frameWaiters]) {
				if (!waiter.pred(frame)) continue;
				frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			}
		}
	}
})();

/** 等一个 RPC 帧（进程没起或形状不符就会超时，让断言以失败收场）。 */
function waitFrame(pred: (frame: RpcFrame) => boolean, label: string, timeoutMs = 60_000): Promise<RpcFrame> {
	const seen = frames.find(pred);
	if (seen) return Promise.resolve(seen);
	const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
	const waiter = { pred, resolve };
	frameWaiters.push(waiter);
	setTimeout(() => {
		const index = frameWaiters.indexOf(waiter);
		if (index >= 0) frameWaiters.splice(index, 1);
		reject(new Error(`等待 ${label} 超时（${timeoutMs}ms）`));
	}, timeoutMs);
	return promise;
}

/** 把一帧写进宿主 stdin（RPC 帧是逐行 JSON）。 */
function sendFrame(frame: Record<string, unknown>): void {
	host.stdin.write(`${JSON.stringify(frame)}\n`);
	host.stdin.flush();
}

const stderr: string[] = [];
void (async () => {
	const decoder = new TextDecoder();
	for await (const chunk of host.stderr as ReadableStream<Uint8Array>) {
		stderr.push(decoder.decode(chunk));
		if (stderr.length > 40) stderr.shift();
	}
})();

const failures: string[] = [];
function check(ok: boolean, description: string, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${description}${!ok && detail ? `\n  ${detail}` : ""}`);
	if (!ok) failures.push(description);
}

let readyError = "";
try {
	await waitFrame(frame => frame.type === "ready", "ready 帧", 90_000);
} catch (error) {
	readyError = error instanceof Error ? error.message : String(error);
}

let joined = false;
for (let i = 0; i < 80 && !joined; i++) {
	await Bun.sleep(250);
	joined = mock
		? mock.channelsOf(botNick).includes(CHANNEL)
		: humanFrames.some(line => line.includes(" JOIN ") && line.includes(botNick));
}

// ── 出站断言：趁会话空闲用 stdin 提交 `/irc send <人类昵称> <marker>` ──────────
// 放在入站之前：入站会触发模型轮次；轮次流式中再提交 prompt 会被当成 steer 排队，
// 命令的确定性就没了。这里先发命令，再看线路。
let outboundSeen = false;
let outboundDetail = "bot 未 JOIN，未提交命令";
const outboundChecks: { ok: boolean; description: string; detail: string }[] = [];
if (!joined) {
	outboundChecks.push({ ok: false, description: "出站 /irc send 上线", detail: outboundDetail });
} else {
	sendFrame({ id: "irc-send", type: "prompt", message: `/irc send ${humanNick} ${OUT_MARKER}` });
	try {
		const result = await waitFrame(frame => frame.id === "irc-send" && frame.type === "prompt_result", "出站 prompt_result", 30_000);
		outboundChecks.push({
			ok: result.agentInvoked === false,
			description: "出站命令不起模型轮次（prompt_result.agentInvoked=false）",
			detail: JSON.stringify(result).slice(0, 200),
		});
	} catch (error) {
		outboundChecks.push({ ok: false, description: "出站命令被 RPC 接受", detail: error instanceof Error ? error.message : String(error) });
	}
	// 线路帧：bot 写出的 `PRIVMSG <人类昵称> :<marker>`（mock 记服务端收到的帧；外部 ircd 看人类收帧）。
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !outboundSeen) {
		outboundSeen = mock
			? mock.received.some(line => line.startsWith(`PRIVMSG ${humanNick} :`) && line.includes(OUT_MARKER))
			: humanFrames.some(line => line.includes(` PRIVMSG ${humanNick} :`) && line.includes(OUT_MARKER));
		if (!outboundSeen) await Bun.sleep(100);
	}
	const notify = frames.find(frame => frame.method === "notify" && JSON.stringify(frame).includes("已发送到"));
	outboundDetail = `回执帧：${notify ? JSON.stringify(notify).slice(0, 200) : "(无)"}`;
	outboundChecks.push({ ok: outboundSeen, description: `出站 /irc send 上线（PRIVMSG ${humanNick} :${OUT_MARKER}）`, detail: outboundDetail });
}

// ── 入站：频道一条 + 私聊一条 ────────────────────────────────────────────────
if (joined) {
	if (mock) {
		mock.simulatePrivmsg("Alice", CHANNEL, MARKERS[0] as string);
	} else {
		human?.write(`PRIVMSG ${CHANNEL} :${MARKERS[0]}\r\n`);
	}
	// 等首轮跑完再发私聊：两条紧挨着发时，第二条会落进第一条唤起的模型轮次（宿主 aside 路径），
	// 而注入的落盘发生在轮次边界而非调用点——真 ircd 上实测过「渠道账本有、宿主会话卡片没有」。
	// 断言的是渠道语义（入站进真宿主上下文），不该被宿主轮次时序左右，这里就串行投递。
	try {
		await waitFrame(frame => frame.type === "agent_end" || frame.type === "session_settled", "首轮结束", 90_000);
	} catch (error) {
		console.log(`  …    等首轮结束超时（继续发私聊）：${error instanceof Error ? error.message : String(error)}`);
	}
	if (mock) mock.simulatePrivmsg("Bob", botNick, MARKERS[1] as string);
	else human?.write(`PRIVMSG ${botNick} :${MARKERS[1]}\r\n`);
}

/** 本次运行的会话 jsonl（cwd slug 目录 + 文件 mtime > 测试开始时间）。 */
function sessionFiles(): string[] {
	const out: string[] = [];
	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsRoot);
	} catch {
		return out;
	}
	for (const dir of dirs) {
		if (!dir.includes(SESSION_DIR_PREFIX)) continue;
		const full = path.join(sessionsRoot, dir);
		let entries: string[];
		try {
			entries = fs.readdirSync(full);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const file = path.join(full, entry);
			try {
				if (fs.statSync(file).mtimeMs < startedAt) continue;
			} catch {
				continue; // 竞态：跳过
			}
			out.push(file);
		}
	}
	return out;
}

/** 会话 jsonl 里的 `irc:message` custom 条目（扩展注入的入站卡片）。 */
function scanCards(): { file: string; content: string }[] {
	const cards: { file: string; content: string }[] = [];
	for (const file of sessionFiles()) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue; // 竞态：跳过
		}
		for (const line of text.split("\n")) {
			if (!line.includes(IRC_INCOMING_TYPE)) continue;
			let entry: { type?: string; customType?: string; content?: unknown };
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			if (entry.type !== "custom_message" || entry.customType !== IRC_INCOMING_TYPE) continue;
			const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? "");
			cards.push({ file, content });
		}
	}
	return cards;
}

/** 渠道侧账本：IRC_TRANSCRIPT_DIR 下有原文 marker 的转录文件，以及跨文件命中的 marker 集合。 */
function scanLedger(): { files: string[]; markers: string[] } | undefined {
	const files: string[] = [];
	const contents: string[] = [];
	const names = fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir) : [];
	for (const name of names) {
		const file = path.join(transcriptDir, name);
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (!MARKERS.some(marker => content.includes(marker))) continue;
		files.push(file);
		contents.push(content);
	}
	if (files.length === 0) return undefined;
	const joined = contents.join("\n");
	return { files, markers: MARKERS.filter(marker => joined.includes(marker)) };
}

// 卡片是模型轮次落盘的一部分（宿主在 prompt 时 appendCustomMessageEntry）：给足时间。
const cardDeadline = Date.now() + 120_000;
let cards: { file: string; content: string }[] = [];
// 没 JOIN 就没发入站，别在原地干等两分钟（失败会由断言暴露）。
while (joined && Date.now() < cardDeadline) {
	cards = scanCards();
	if (MARKERS.every(marker => cards.some(card => card.content.includes(marker)))) break;
	await Bun.sleep(250);
}
cards = scanCards();
// 账本必须在卡片齐了之后再扫：转录与注入在同一 handler 里先后发生，缓存早先的扫描会漏掉后到的消息。
const ledger = scanLedger();

host.kill();
human?.destroy();
// Windows 上被杀的子进程要一点时间才放手：不等它，TEMP 目录会被 cwd 句柄锁住删不掉。
await Promise.race([host.exited, Bun.sleep(5_000)]);
await mock?.close();

// ── 断言 ────────────────────────────────────────────────────────────────────
const channelCard = cards.find(card => card.content.includes(MARKERS[0] as string));
const dmCard = cards.find(card => card.content.includes(MARKERS[1] as string));
const wire = mock ? mock.received.filter(line => !line.startsWith("USER ")) : humanFrames.filter(line => line.includes(" PRIVMSG "));
const frameTypeCounts: Record<string, number> = {};
for (const frame of frames) {
	const type = frame.type ?? "(无 type)";
	frameTypeCounts[type] = (frameTypeCounts[type] ?? 0) + 1;
}

console.log(`PASS/FAIL 目标：${EXTERNAL ?? `mock ${serverHost}:${serverPort}`} | 频道 ${CHANNEL} | bot ${botNick} | human ${humanNick}`);
console.log(`  宿主：${readyError ? "RPC 未 ready" : "RPC ready"} | JOIN 成功: ${joined} | 线路帧样本: ${wire.slice(0, 6).join(" | ").slice(0, 300)}`);
console.log(`  RPC 帧：${frames.length} 条（${Object.entries(frameTypeCounts).map(([type, count]) => `${type}×${count}`).join(",")}）| 会话卡片：${cards.length} 条 irc:message`);
if (EXTERNAL) console.log(`  人类收帧（末 8 条）：${humanFrames.slice(-8).join(" | ").slice(0, 600)}`);
check(readyError === "", "宿主进入 RPC 循环（ready 帧）", readyError);
if (!joined) check(false, "bot JOIN 频道", `目标 ${CHANNEL}`);
for (const item of outboundChecks) check(item.ok, item.description, item.detail);

check(Boolean(channelCard), `入站频道消息进了真宿主会话上下文（irc:message 卡片 · ${MARKERS[0]}）`, channelCard ? `${channelCard.file} ← ${MARKERS[0]}` : `(无卡片命中 ${MARKERS[0]})`);
check(Boolean(dmCard), `入站私聊进了真宿主会话上下文（irc:message 卡片 · ${MARKERS[1]}）`, dmCard ? `${dmCard.file} ← ${MARKERS[1]}` : `(无卡片命中 ${MARKERS[1]})`);
if (channelCard) console.log(`  频道卡片：${channelCard.file}\n    ${channelCard.content.split("\n").slice(0, 2).join(" ⏎ ").slice(0, 200)}`);
if (dmCard) console.log(`  私聊卡片：${dmCard.file}\n    ${dmCard.content.split("\n").slice(0, 2).join(" ⏎ ").slice(0, 200)}`);
console.log(`  会话扫描：${sessionsRoot} → ${sessionFiles().length} 个本次运行文件`);
const transcriptNames = fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir) : [];
console.log(`  转录目录：${transcriptDir} → ${transcriptNames.join(", ") || "(空)"}`);
console.log(`  线路帧：${OUT_MARKER} ${outboundSeen ? "命中" : "未命中"}${outboundDetail ? ` | ${outboundDetail}` : ""}`);
check(
	ledger !== undefined && ledger.markers.length === MARKERS.length,
	"渠道侧转录留了入站原文（IRC_TRANSCRIPT_DIR）",
	ledger
		? `${ledger.files.join("、")} ← 命中 ${ledger.markers.join("、") || "(无)"}（应含 ${MARKERS.join("、")}）`
		: `(无命中转录) 目录：${fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).join(", ") || "(空)" : "(不存在)"}`,
);
if (ledger === undefined || ledger.markers.length !== MARKERS.length) {
	for (const name of transcriptNames) {
		try {
			const text = fs.readFileSync(path.join(transcriptDir, name), "utf8");
			console.log(`    ${name}（${Buffer.byteLength(text)} 字节）：${text.replace(/\s+/g, " ").slice(0, 200)}`);
		} catch {
			// 竞态：文件刚被换掉
		}
	}
}
if (failures.length > 0) console.log(`  stderr: ${stderr.join("").trim().split("\n").slice(-5).join(" ⏎ ").slice(0, 500)}`);
for (let i = 0; i < 5; i++) {
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
		break;
	} catch {
		// 句柄释放有延迟：重试几次；仍失败就放着（TEMP 目录，且不影响断言）。
		await Bun.sleep(200);
	}
}
console.log(failures.length === 0 ? "E2E(host) PASS" : `E2E(host) FAIL（${failures.length}）：${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
