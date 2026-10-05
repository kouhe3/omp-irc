/**
 * 宿主级 e2e：真 omp 进程 + 扩展自带 mock IRC server，证明「扩展在真宿主里
 * 连上 IRC、JOIN 频道，入站消息落进 peer 转录（Agent Hub `⏎` 与 `history://`
 * 读的就是这份）」。
 *
 * 宿主默认取 PATH 上的 `omp`；**注意** `Bun.spawn(["omp"])` 会先命中本扩展
 * `node_modules/.bin/omp`（devDependency 钉的发行版），要验证 fork/源码宿主必须覆盖：
 *   IRC_E2E_OMP=<fork>/packages/coding-agent/src/cli.ts bun run e2e:host
 */
import { spawn } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startMockIrcServer } from "./mock-irc-server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irc-host-smoke-"));
const transcriptDir = path.join(tmp, "transcripts");
const server = await startMockIrcServer();
const ompOverride = process.env.IRC_E2E_OMP;
const hostCommand = ompOverride
	? ompOverride.endsWith(".ts")
		? [process.execPath, ompOverride]
		: [ompOverride]
	: ["omp"];

const host = spawn(
	[...hostCommand, "--mode", "rpc"],
	{
		cwd: tmp,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			IRC_CONFIG_PATH: path.join(tmp, "missing-irc.json"),
			IRC_SERVER: server.host,
			IRC_PORT: String(server.port),
			IRC_TLS: "false",
			IRC_NICK: "omp",
			IRC_CHANNELS: "#omp",
			IRC_TRANSCRIPT_DIR: transcriptDir,
		},
	},
);
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

let joined = false;
try {
	await server.waitForJoin("#omp", 20_000);
	joined = true;
} catch {}
if (joined) {
	server.simulatePrivmsg("Alice", "#omp", "hello-from-real-host");
	server.simulatePrivmsg("Bob", "omp", "dm-from-real-host");
}

let hit = "";
for (let i = 0; i < 60 && !hit; i++) {
	await Bun.sleep(250);
	for (const name of fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir) : []) {
		const text = fs.readFileSync(path.join(transcriptDir, name), "utf8");
		const marker = ["hello-from-real-host", "dm-from-real-host"].find(m => text.includes(m));
		if (marker) hit = `${name} ← ${marker}`;
	}
}
host.kill();
await Bun.sleep(200);
await server.close();

console.log(`${hit ? "PASS" : "FAIL"} 真宿主 + 真 socket：入站 IRC 消息落进 peer 转录`);
console.log("  JOIN 成功:", joined, "| 服务端收到的行:", server.received.filter(l => !l.startsWith("USER ")).slice(0, 6).join(" | "));
console.log("  转录命中:", hit || "(无)", "| 目录:", fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).join(", ") || "(空)" : "(不存在)");
if (!hit) console.log("  stderr:", stderr.join("").trim().split("\n").slice(-5).join(" ⏎ ").slice(0, 500));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(hit ? 0 : 1);
