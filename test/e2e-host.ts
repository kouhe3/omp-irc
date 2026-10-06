/**
 * 宿主级 e2e：真 omp 进程 + IRC 服务，证明「扩展在真宿主里连上 IRC、JOIN 频道，
 * 入站消息落进 peer 转录（Agent Hub `⏎` 与 `history://` 读的就是这份）」。
 *
 * 默认起扩展自带的 mock IRC server；`IRC_E2E_SERVER=host:port` 时改连**外部 ircd**
 * （此时用一根裸 TCP socket 当"人类"客户端发言），用来验证真实 ircd 的互操作。
 * 连外部 ircd 时 bot 昵称会带随机后缀，避免和已在线客户端撞名。
 *
 * 宿主默认取 PATH 上的 `omp`；**注意** `Bun.spawn(["omp"])` 会先命中本扩展
 * `node_modules/.bin/omp`（devDependency 钉的发行版），要验证 fork/源码宿主必须覆盖：
 *   IRC_E2E_OMP=<fork>/packages/coding-agent/src/cli.ts bun run e2e:host
 *   IRC_E2E_SERVER=jiaoxing.xin:6667 IRC_KEEPALIVE_SECONDS=2 bun run e2e:host   # 真 ircd + 心跳
 */
import { spawn } from "bun";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceTag } from "../src/config";
import { startMockIrcServer, type MockIrcServer } from "./mock-irc-server";

const CHANNEL = process.env.IRC_E2E_CHANNEL ?? "#omp";
const EXTERNAL = process.env.IRC_E2E_SERVER;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irc-host-e2e-"));
const transcriptDir = path.join(tmp, "transcripts");
const MARKERS = ["hello-from-real-host", "dm-from-real-host"];

const mock: MockIrcServer | undefined = EXTERNAL ? undefined : await startMockIrcServer();
const [serverHost, serverPort] = EXTERNAL
	? (EXTERNAL.split(":", 2) as [string, string])
	: [mock?.host ?? "127.0.0.1", String(mock?.port ?? 0)];
// 外部 ircd 上 `omp` 可能已被占用（撞名会被 433 改名，私聊就打偏了）：带随机后缀。
const botNickBase = EXTERNAL ? `omp-e2e-${Date.now().toString(36).slice(-4)}` : "omp";
// 宿主进程的 cwd 是 tmp，扩展默认给昵称加工作区后缀（实例专属昵称）：按同一规则算出期望值，
// 于是这条断言等于在验「真宿主把 ctx.cwd 传给了扩展」——传丢了就会退化成 botNickBase 而 FAIL。
const botNick = `${botNickBase}-${workspaceTag(tmp)}`;

// 外部 ircd：裸 socket 当"人类"——先注册（等到 001 再 JOIN，很多 ircd 会先做 hostname 查询）。
let human: net.Socket | undefined;
const humanFrames: string[] = [];
if (EXTERNAL) {
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
	human.write(`NICK kouhe3\r\nUSER kouhe3 0 * :human\r\n`);
	for (let i = 0; i < 40 && !humanFrames.some(line => line.split(" ")[1] === "001"); i++) await Bun.sleep(250);
	human.write(`JOIN ${CHANNEL}\r\n`);
	await Bun.sleep(400);
}

const ompOverride = process.env.IRC_E2E_OMP;
const hostCommand = ompOverride
	? ompOverride.endsWith(".ts")
		? [process.execPath, ompOverride]
		: [ompOverride]
	: ["omp"];
const host = spawn([...hostCommand, "--mode", "rpc"], {
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
		IRC_KEEPALIVE_SECONDS: process.env.IRC_KEEPALIVE_SECONDS ?? "0",
	},
});
void (async () => {
	for await (const _ of host.stdout as ReadableStream<Uint8Array>) void _;
})();
const stderr: string[] = [];
void (async () => {
	const decoder = new TextDecoder();
	for await (const chunk of host.stderr as ReadableStream<Uint8Array>) {
		stderr.push(decoder.decode(chunk));
		if (stderr.length > 40) stderr.shift();
	}
})();

const botJoined = (): boolean =>
	mock
		? mock.channelsOf(botNick).includes(CHANNEL)
		: humanFrames.some(line => line.includes(" JOIN ") && line.includes(botNick));
let joined = false;
for (let i = 0; i < 80 && !joined; i++) {
	await Bun.sleep(250);
	joined = botJoined();
}
if (joined) {
	if (mock) {
		mock.simulatePrivmsg("Alice", CHANNEL, MARKERS[0] as string);
		mock.simulatePrivmsg("Bob", botNick, MARKERS[1] as string);
	} else {
		human?.write(`PRIVMSG ${CHANNEL} :${MARKERS[0]}\r\n`);
		human?.write(`PRIVMSG ${botNick} :${MARKERS[1]}\r\n`);
	}
}

let hit = "";
for (let i = 0; i < 60 && !hit; i++) {
	await Bun.sleep(250);
	for (const name of fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir) : []) {
		const text = fs.readFileSync(path.join(transcriptDir, name), "utf8");
		const marker = MARKERS.find(m => text.includes(m));
		if (marker) hit = `${name} ← ${marker}`;
	}
}
host.kill();
human?.destroy();
await Bun.sleep(200);
await mock?.close();

const wire = mock ? mock.received.filter(line => !line.startsWith("USER ")) : humanFrames.filter(line => line.includes(" PRIVMSG "));
console.log(`PASS/FAIL 目标：${EXTERNAL ?? `mock ${serverHost}:${serverPort}`} | 频道 ${CHANNEL} | bot ${botNick}`);
console.log(`${hit ? "PASS" : "FAIL"} 真宿主 + 真 socket：入站 IRC 消息落进 peer 转录`);
console.log("  JOIN 成功:", joined, "| 线路帧样本:", wire.slice(0, 4).join(" | ").slice(0, 300));
console.log("  转录命中:", hit || "(无)", "| 目录:", fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).join(", ") || "(空)" : "(不存在)");
if (!hit) console.log("  stderr:", stderr.join("").trim().split("\n").slice(-5).join(" ⏎ ").slice(0, 500));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(hit ? 0 : 1);
