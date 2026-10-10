/**
 * 昵称推导（实例专属昵称）的单元测试。
 *
 * 同一台机器上的多个 omp 实例各自连一条 IRC 连接，最终昵称 = `nick` + `-` + 实例后缀，
 * 后缀来源是宿主传进来的 `ctx.cwd`。这里只测配置层（纯函数 + 文件/env 解析）；
 * 线路上的最终昵称在 `test/e2e-mock.ts` 的扩展装配段验（真 socket）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { expandNickSuffix, loadConfig, NICK_MAX_LENGTH, shortPathHash, workspaceTag } from "../src/config";

/** 干净的 agentDir：没有 irc.json，因此不读本机真实配置。 */
function freshDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "irc-cfg-"));
}

function load(dir: string, env: Record<string, string>, cwd?: string) {
	return loadConfig(dir, { env, cwd, notes: [] });
}

describe("workspaceTag", () => {
	test("目录名小写化并收敛成 [a-z0-9_-]，首尾分隔符去掉", () => {
		expect(workspaceTag("D:/JXAI")).toBe("jxai");
		expect(workspaceTag("C:/Users/K/proj/My App")).toBe("my-app");
		expect(workspaceTag("C:/Users/K/.omp")).toBe("omp");
		expect(workspaceTag("D:/JXAI/")).toBe("jxai");
	});

	test("目录名收敛后为空（全非 ASCII / 盘根）时退化为 4 位短哈希", () => {
		const cwd = "D:/项目";
		const tag = workspaceTag(cwd);
		expect(tag).toBe(shortPathHash(cwd));
		expect(tag).toMatch(/^[0-9a-f]{4}$/);
	});

	test("标签截断到 16 字符，没有工作区路径时为空", () => {
		expect(workspaceTag(`D:/${"a".repeat(40)}`)).toBe("a".repeat(16));
		expect(workspaceTag(undefined)).toBe("");
	});
});

describe("expandNickSuffix", () => {
	test("{workspace} 与 {hash} 都展开，其余字面量按昵称字符集收敛", () => {
		expect(expandNickSuffix("{workspace}", "D:/JXAI")).toBe("jxai");
		expect(expandNickSuffix("{workspace}-{hash}", "D:/JXAI")).toBe(`jxai-${shortPathHash("D:/JXAI")}`);
		expect(expandNickSuffix("My Bot", "D:/JXAI")).toBe("my-bot");
	});

	test("没有工作区路径时展开为空串（= 不加后缀）", () => {
		expect(expandNickSuffix("{workspace}", undefined)).toBe("");
		expect(expandNickSuffix("{hash}", undefined)).toBe("");
	});
});

describe("loadConfig 的最终昵称", () => {
	test("缺省 = nick + 工作区标签", () => {
		const config = load(freshDir(), { IRC_SERVER: "irc.example.org" }, "D:/JXAI").config;
		expect(config.nick).toBe("omp-jxai");
	});

	test("显式 nick 是基础名，实例后缀照加（两个实例同 server 才分得开）", () => {
		expect(load(freshDir(), { IRC_SERVER: "irc.example.org", IRC_NICK: "bot" }, "D:/JXAI").config.nick).toBe("bot-jxai");
	});

	test("没有工作区路径时不加后缀（直连 loadConfig 的场景）", () => {
		const { config, notes } = loadConfig(freshDir(), { env: { IRC_SERVER: "irc.example.org" }, notes: [] });
		expect(config.nick).toBe("omp");
		expect(notes.some(note => note.includes("实例后缀未生效"))).toBe(true);
	});

	test("nickSuffix 文件值（含 {hash}）生效，env 覆盖文件", () => {
		const dir = freshDir();
		writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ nickSuffix: "{workspace}-{hash}" }), "utf8");
		expect(load(dir, {}, "D:/JXAI").config.nick).toBe(`omp-jxai-${shortPathHash("D:/JXAI")}`);
		expect(load(dir, { IRC_NICK_SUFFIX: "dev-{workspace}" }, "D:/JXAI").config.nick).toBe("omp-dev-jxai");
	});

	test("关闭后缀：文件里 false / 空串 / off 都关（空串有语义，不算「没写」）", () => {
		for (const value of [false, "", "off"] as const) {
			const dir = freshDir();
			writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ nickSuffix: value }), "utf8");
			expect(load(dir, {}, "D:/JXAI").config.nick).toBe("omp");
		}
		const dir = freshDir();
		writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ nickSuffix: "" }), "utf8");
		const notes = loadConfig(dir, { env: {}, cwd: "D:/JXAI", notes: [] }).notes;
		expect(notes.some(note => note.includes("实例后缀已关闭"))).toBe(true);
	});

	test("关闭后缀：env 里空串 / off 都关，非字符串（true）视为没写", () => {
		const dir = freshDir();
		expect(load(dir, { IRC_NICK_SUFFIX: "" }, "D:/JXAI").config.nick).toBe("omp");
		expect(load(dir, { IRC_NICK_SUFFIX: "off" }, "D:/JXAI").config.nick).toBe("omp");
		expect(load(dir, { IRC_NICK_SUFFIX: "none" }, "D:/JXAI").config.nick).toBe("omp");
		writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ nickSuffix: true }), "utf8");
		expect(load(dir, {}, "D:/JXAI").config.nick).toBe("omp-jxai");
	});

	test("模板展开后不含合法昵称字符：不加后缀，并说清是模板的问题", () => {
		const dir = freshDir();
		writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ nickSuffix: "汉字" }), "utf8");
		const { config, notes } = loadConfig(dir, { env: {}, cwd: "D:/JXAI", notes: [] });
		expect(config.nick).toBe("omp");
		expect(notes.some(note => note.includes("不含合法昵称字符"))).toBe(true);
	});

	test("昵称总长不超过上限：后缀至少留 4 字符，放不下就不加", () => {
		const cwd = "D:/JXAI";
		const roomy = load(freshDir(), { IRC_NICK: "o".repeat(25) }, cwd).config.nick;
		expect(roomy).toBe(`${"o".repeat(25)}-jxai`);
		expect(roomy.length).toBe(NICK_MAX_LENGTH);
		const tight = load(freshDir(), { IRC_NICK: "o".repeat(26) }, cwd).config.nick;
		expect(tight).toBe("o".repeat(26));
		const notes = loadConfig(freshDir(), { env: { IRC_NICK: "o".repeat(26) }, cwd, notes: [] }).notes;
		expect(notes.some(note => note.includes(`已占满 ${NICK_MAX_LENGTH} 字符`))).toBe(true);
	});
});

describe("keepalive 缺省", () => {
	test("缺省开启：60s 发一次 PING，30s 内无任何入站就判死重连", () => {
		// 回归（线上实测）：Ergo 以 `Ping timeout: 2m30s` 把客户端踢掉，但 FIN 没到达本机
		// （netstat 一直 ESTABLISHED、close 事件永不触发）→ 缺省关心跳时永远不会重连。
		const { config, notes } = load(freshDir(), { IRC_SERVER: "irc.example.org" });
		expect(config.keepaliveSeconds).toBe(60);
		expect(config.keepaliveTimeoutSeconds).toBe(30);
		expect(notes.some(note => note.includes("心跳：每 60s 发 PING，30s 内无任何入站则判死重连"))).toBe(true);
	});

	test("keepaliveSeconds=0 关闭心跳（不再写心跳说明）", () => {
		const { config, notes } = load(freshDir(), { IRC_SERVER: "irc.example.org", IRC_KEEPALIVE_SECONDS: "0" });
		expect(config.keepaliveSeconds).toBe(0);
		expect(notes.some(note => note.includes("心跳"))).toBe(false);
	});

	test("判死截止缺省固定 30s，不随间隔放大（间隔拉到 300s 也一样）", () => {
		const { config } = load(freshDir(), { IRC_SERVER: "irc.example.org", IRC_KEEPALIVE_SECONDS: "300" });
		expect(config.keepaliveSeconds).toBe(300);
		expect(config.keepaliveTimeoutSeconds).toBe(30);
	});
});

describe("转录回收上限", () => {
	test("缺省不覆盖 IrcTranscripts 的默认（undefined = 用 64 MiB / 500 文件），也不写 notes", () => {
		// 默认值只在 IrcTranscripts 里写一份：config 这里的 undefined 是「没说」而不是「0 或某个默认值」。
		const { config, notes } = load(freshDir(), { IRC_SERVER: "irc.example.org" });
		expect(config.transcriptMaxBytes).toBeUndefined();
		expect(config.transcriptMaxFiles).toBeUndefined();
		expect(notes.some(note => note.includes("转录上限"))).toBe(false);
	});

	test("文件值与 env 覆盖都生效，并写一条 notes（含未配置那一侧显示为默认）", () => {
		const dir = freshDir();
		writeFileSync(path.join(dir, "irc.json"), JSON.stringify({ transcriptMaxFiles: 7 }), "utf8");
		const fromFile = loadConfig(dir, { env: { IRC_SERVER: "irc.example.org" }, notes: [] });
		expect(fromFile.config.transcriptMaxFiles).toBe(7);
		expect(fromFile.config.transcriptMaxBytes).toBeUndefined();
		expect(fromFile.notes.some(note => note.includes("默认 64 MiB / 7 文件"))).toBe(true);

		const overridden = load(dir, {
			IRC_SERVER: "irc.example.org",
			IRC_TRANSCRIPT_MAX_BYTES: String(16 * 1024 * 1024),
			IRC_TRANSCRIPT_MAX_FILES: "20",
		});
		expect(overridden.config.transcriptMaxBytes).toBe(16 * 1024 * 1024);
		expect(overridden.config.transcriptMaxFiles).toBe(20);
		expect(overridden.notes.some(note => note.includes("16 MiB / 20 文件"))).toBe(true);
	});

	test("非法值（0 / 负数 / 小数 / 非数字）忽略并写 notes，不静默变成某个默认", () => {
		for (const raw of ["0", "-1", "1.5", "abc"]) {
			const { config, notes } = load(freshDir(), { IRC_SERVER: "irc.example.org", IRC_TRANSCRIPT_MAX_FILES: raw });
			expect(config.transcriptMaxFiles).toBeUndefined();
			expect(notes.some(note => note.includes("IRC_TRANSCRIPT_MAX_FILES 值非法，已忽略"))).toBe(true);
		}
	});
});
