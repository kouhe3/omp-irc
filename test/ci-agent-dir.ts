/**
 * 准备一个**干净**的 omp agentDir —— CI 跑 `e2e:host` 用，本地也能用。做两件事：
 *
 * 1. 把本 checkout 挂成 `<agentDir>/extensions/irc`。宿主只从 `<agentDir>/extensions/<name>/`
 *    发现扩展（目录扫描），CI 上 checkout 在别处，不挂进去宿主就起来但**扩展没加载**。
 *    链接用 symlink（POSIX）/ junction（Windows，不需要管理员权限或开发者模式）；宿主的
 *    `discoverExtensionModulePaths` 明确支持链接目录（native glob 的 follow_links=false 只
 *    影响 `<目录>/index.ts` 这类子目录模式，链接目录由它自己补匹配）。
 * 2. 装上 `ci-models.yml` → `<agentDir>/models.yml`：宿主在非交互模式下没有可解析的会话模型
 *    就**直接退出**（`src/main.ts`：`No models available.` / `Set an API key environment variable…`），
 *    e2e 会以「ready 帧都没有」的形式全挂。CI 上没有也不该有真凭据，用免鉴权的假 provider 顶上。
 *
 * 干净的 agentDir 同时保证 CI 机器上的用户配置/凭据不参与。目标位置已存在且**不是本脚本生成的
 * 链接/内容**时直接报错退出：这是「一次性目录」，不去猜用户的东西能不能覆盖。
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

const modelsFixture = path.join(import.meta.dir, "ci-models.yml");
const modelsPath = path.join(agentDir, "models.yml");
const modelsContent = fs.readFileSync(modelsFixture, "utf8");
const existingModels = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, "utf8") : null;
if (existingModels !== null && existingModels !== modelsContent) {
	throw new Error(`${modelsPath} 已存在且内容不是 CI 夹具（${modelsFixture}），拒绝覆盖——请换一个 PI_CODING_AGENT_DIR`);
}
if (existingModels === null) fs.writeFileSync(modelsPath, modelsContent);

console.log(`agentDir：${agentDir}`);
console.log(`扩展入口：${linkPath} → ${repoRoot}`);
console.log(`模型配置：${modelsPath}（免鉴权假 provider，宿主非交互启动必需）`);
