/**
 * 准备一个**干净**的 omp agentDir，只把本扩展挂进去——CI 跑 `e2e:host` 用，本地也能用。
 *
 * 为什么需要：`test/e2e-host.ts` 起真 `omp` 宿主，而宿主只从 `<agentDir>/extensions/<name>/`
 * 发现扩展（目录扫描）。CI 上仓库 checkout 在别处，不挂进去宿主就起来但**扩展没加载**，
 * e2e 会以「bot 未 JOIN」的形式全挂；干净的 agentDir 同时保证 CI 机器上的用户配置/凭据
 * 不会参与（真 ircd、模型轮次都不依赖它们）。
 *
 * 链接用 symlink（POSIX）/ junction（Windows，不需要管理员权限或开发者模式）。宿主的
 * `discoverExtensionModulePaths` 明确支持链接目录（native glob 的 follow_links=false 只
 * 影响 `<目录>/index.ts` 这类子目录模式，链接目录由它自己补匹配）。
 *
 * 用法：`PI_CODING_AGENT_DIR=/tmp/omp-agent bun run test/ci-agent-dir.ts`
 * 缺省 agentDir 与宿主一致（`PI_CODING_AGENT_DIR`，否则 `~/.omp/agent`）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 扩展在 agentDir 里的目录名：本机开发布局就是 `extensions/irc`，保持一致。 */
const EXT_ENTRY_NAME = "irc";

const repoRoot = path.resolve(import.meta.dir, "..");
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"));
const extensionsDir = path.join(agentDir, "extensions");
const linkPath = path.join(extensionsDir, EXT_ENTRY_NAME);

if (!fs.existsSync(path.join(repoRoot, "package.json"))) {
	throw new Error(`仓库根目录不像扩展包（缺 package.json）：${repoRoot}`);
}

fs.mkdirSync(extensionsDir, { recursive: true });

const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
if (existing) {
	if (!existing.isSymbolicLink()) {
		throw new Error(
			`${linkPath} 已存在且不是链接（是真实目录/文件），拒绝覆盖——请换一个 PI_CODING_AGENT_DIR 或手动清理`,
		);
	}
	// 只删链接本身（POSIX 符号链接 / Windows junction），不会跟到目标里删东西。
	fs.unlinkSync(linkPath);
}
fs.symlinkSync(repoRoot, linkPath, process.platform === "win32" ? "junction" : "dir");

console.log(`agentDir：${agentDir}`);
console.log(`扩展入口：${linkPath} → ${repoRoot}`);
