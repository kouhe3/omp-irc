# IRC 渠道扩展（omp-irc-channel）

把 omp 作为 **IRC 客户端**接入任意 IRC server（RFC1459 子集），让 omp 与 IRC 上的其它
agent 对等通话：

- **入站**：IRC 私聊/频道消息 → 主会话的 `irc:incoming` 卡片（与 peer 之间的 IRC 消息同一条路径）。
- **出站**：IRC 会话注册成 omp 的 peer 替身，模型直接 `write agent://irc-<nick>` 回话。
- **转录**：每个会话一份宿主格式的 jsonl，Agent Hub 里 `⏎` 打开转录（`transcriptOnly: true`），`history://<peer>` 也读它。

设计与 QQ 扩展（`tencent_qq_bot`）同构：peer 注册面、替身会话、转录格式、bridge 入站注入
全部照搬同一套契约，只有传输层换成了本扩展自己的 IRC 客户端。

## 安装与加载

扩展目录就是本仓库根目录，omp 的扩展发现机制会自动加载它（`package.json` 的
`omp.extensions: ["."]`）。开发/测试：

```bash
bun install
bun x tsc --noEmit          # 类型检查
bun test                    # 单元 + 本机 mock IRC server 的集成测试
bun run test/e2e-mock.ts    # 端到端（真 TCP + mock server + 真实扩展装配），打印 E2E PASS
```

## 配置

配置文件：`<agentDir>/irc.json`（可选；`agentDir` 通常是 `~/.omp/agent`）。
**不配任何东西扩展也能加载**：工具/命令/peer 目录都在，只是不连 server，`/irc status` 会说明缺什么。

```json
{
	"server": "irc.example.org",
	"port": 6697,
	"tls": true,
	"nick": "omp",
	"channels": ["#agents", "#dev"],
	"password": "server-password",
	"transcriptDir": "/path/to/transcripts"
}
```

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `server` | 无（必填才算配好） | IRC server 主机名/IP |
| `port` | `6667`（明文）/ `6697`（TLS） | 端口 |
| `tls` | `false` | 走 `tls.connect`，按系统 CA 校验 |
| `nick` | `"omp"` | 昵称；被占用会自动加 `_` 重试（433） |
| `channels` | `[]` | 启动即 JOIN 的频道；空则只收私聊 |
| `password` | 无 | **连接密码**（IRC `PASS`），不是 SASL |
| `transcriptDir` | `<agentDir>/irc-transcripts` | 每个 peer 的 jsonl 转录目录 |
| `keepaliveSeconds` | `0`（关闭） | 心跳：静默这么久就主动 `PING :token`。真实 ircd 上的半开连接（看着在线、实际已死）靠它发现 |
| `keepaliveTimeoutSeconds` | = `keepaliveSeconds` | 发出 `PING` 后这么久内**没有任何入站行**（服务端 PING、别人的消息都算）就判死：断开并走既有退避重连 |

同名环境变量可覆盖（优先级高于文件，逐条日志会说明哪个生效）：

`IRC_SERVER`、`IRC_PORT`、`IRC_TLS`、`IRC_NICK`、`IRC_CHANNELS`（逗号分隔）、
`IRC_PASSWORD`、`IRC_TRANSCRIPT_DIR`、`IRC_KEEPALIVE_SECONDS`、`IRC_KEEPALIVE_TIMEOUT_SECONDS`、
`IRC_CONFIG_PATH`（改配置文件位置，测试/多实例隔离用）。

## 用法

回消息的默认通道是 **IRC peer**：

```
write path: agent://irc-alice        # 私聊 alice → PRIVMSG alice :…
write path: agent://irc-chan--omp    # 频道 #omp → PRIVMSG #omp :…
```

peer id 规则：

| 会话 | peer id |
| --- | --- |
| 私聊 `Alice` | `irc-alice`（`irc-<nick小写化>`） |
| 频道 `#omp` | `irc-chan--omp`（`#` 收敛成 `-`） |

工具 `irc` 与斜杠命令 `/irc` 补 `write` 覆盖不到的部分：

| 用法 | 作用 |
| --- | --- |
| `/irc status`（或 `irc status`） | 连接/注册/留驻频道/已登记 peer + 配置说明 |
| `/irc connect` | 连接 IRC server（主会话 `session_start` 已自动连；断开后用这条重连） |
| `/irc disconnect` | 断开并停止自动重连。只停传输层：peer 登记与转录保留，`/irc connect` 回来即可继续 |
| `/irc list`（或 `irc list`） | 已知会话（id / 别名 / 最近活跃） |
| `/irc log <peer> [条数]`（或 `irc log`） | 最近的**完整**消息记录（主会话卡片正文会被截断，长文看这里） |
| `/irc say <peer> <正文>`（或 `irc say`） | 主动发一条 PRIVMSG；引用支持 peer id / nick / 频道 / 别名。**还没聊过的 nick 会当场登记**，不必等对方先开口 |
| `/irc join <#频道>`（或 `irc join`） | JOIN 并记为**留驻频道**（断线重连后自动重新 JOIN）；缺 `#` 自动补 |
| `/irc part <#频道>` | PART 并取消留驻 |

频道里的入站消息在卡片里带频道名（`[#omp] alice: 你好`），私聊是 `[私聊] alice: 你好`。

连接由**主会话**持有（进程级单例，子会话不重复连）。状态栏那一格一眼看出当前状态：
`IRC ● 已连接（N 会话）` / `IRC ◌ 连接中…` / `IRC ◌ 注册中…` / `IRC ◌ 重连中（第 N 次）` /
`IRC ○ 未连接（/irc connect）` / `IRC ⨯ 未配置`。要换手就在目标会话里 `/irc disconnect`，
再在另一个会话里 `/irc connect`——`peers` 是进程内的登记表，换掉的是传输层，不是会话上下文。

`/irc disconnect` 之后：

- 不接收入站（server 侧连接已断），状态栏变 `○ 未连接（/irc connect）`；
- 已登记的 peer 与转录**照旧**，`/irc log`、Hub 转录视图都还能看；
- 这段时间里 `write agent://<peer>` / 工具发的内容会**排队**（最多 64 条），`/irc connect` 注册成功后按序补发；
  想在断开期间就让发送失败（而不是排队），先在模型侧别发——`/irc say` 会直接拒绝（`未连接/未注册`）。

## 协议子集（RFC1459）

已实现：`NICK`/`USER`（+ 可选 `PASS`）注册、`PING`→`PONG`、`JOIN`/`PART`、
`PRIVMSG`/`NOTICE` 收发、`001`（RPL_WELCOME，据此触发重连后的重新 JOIN）、
`433`（昵称占用自动换名）、CRLF 逐行分帧（容忍半行与一次多行）、
**正文按 512 字节上限切分**（不切碎 UTF-8 字符，优先在空格/换行处断开）、
**断线指数退避重连**（`base * 2^n`，上限 30s）并在重连成功后重新 JOIN 留驻频道。
`host` 按 63 字节上限预留，因此切分长度是保守但安全的。

未连上（首次连接中/断线重连中/`/irc disconnect` 之后）时发出的正文会**排队**（最多 64 条，超出丢最旧的），
注册成功后与重新 JOIN 一起按序补发——不会静默丢消息，`deliverIrcMessage` 回的
`"injected"` 因此是诚实的。

**不做**（有意留白）：

- **SASL 认证**（`AUTHENTICATE`）；需要认证的网络请用 `password`（连接密码）或网关。
- IRCv3 扩展能力：`CAP` 协商、`message-tags`、`account-tag`、`chathistory`、`batch`、`echo-message` 等。
- 多网络并行：只连一个 `server`（要接多个网络就起多份配置不同的 omp 实例，用 `IRC_CONFIG_PATH` 隔离）。
- 昵称注册（NickServ）、频道钥匙（`+k`）、CTCP 应答（CTCP 消息直接忽略，不进模型上下文）。
- 服务端主机名发来的 `NOTICE`（注册期的 `*** Looking up your hostname` 之类）会被过滤，不进模型上下文。

## peer 契约（与 QQ 扩展一致）

入站消息为每个会话注册一个 peer 替身：

```ts
{
  id: "irc-alice", kind: "sub", status: "idle",
  displayName: "IRC私聊 Alice", activity: "IRC 私聊 Alice",
  parentId: <mainAgentId>,
  session: <替身：deliverIrcMessage / drainPendingIrcInboxMessages / dispose / 故意抛错的 subscribe 与 agent.*>,
  sessionFile: "<transcriptDir>/irc-alice.jsonl",
  transcriptOnly: true,       // Hub 的 ⏎ 打开转录，而不是 attach 替身
  createdAt, lastActivity
}
```

- `deliverIrcMessage` 是唯一真实入口：宿主 `write agent://<peer>` 的内容会走它 → `PRIVMSG` → 回执 `"injected"`。
- `subscribe()` / `agent.getPendingToolResults()` / `agent.n()` **故意抛错**：替身不是真实
  AgentSession，Hub 一旦把它当实时会话聚焦就会崩，抛可读错误让宿主退回主会话。
- 转录是**宿主会话文件格式**（首行 session header，之后每行 message），Hub 转录视图与
  `history://<peer>` 直接读它；assistant 条目写全零成本 `usage`（缺字段会让宿主渲染管线抛错）。
- 退出时注销 peer 替身并清掉状态栏那一格。
- **宿主前提**：`transcriptOnly` 是 fork 补丁（上游 issue [#13843](https://github.com/can1357/oh-my-pi/issues/13843) 未合并）。宿主支持时 Hub `⏎` 打开转录视图，
  不支持时（stock omp ≤ 18.6.1）`⏎` 会落到聚焦路径，得到可读拒绝
  `IRC 会话 <peer> 是外部渠道端点，不是可查看的 omp 子会话`。收发、`/irc log`、`write agent://<peer>`
  这三条**不依赖**该能力，在 stock omp 上照常工作。

## 排障

| 现象 | 处理 |
| --- | --- |
| `/irc status` 说「未配置 server」 | 写 `<agentDir>/irc.json` 或设 `IRC_SERVER` |
| 状态栏 `IRC ○ 未连接（/irc connect）` | 有人执行过 `/irc disconnect`（或本次会话还没连接）：`/irc connect` 重连 |
| 状态栏 `IRC ◌ 重连中（第 N 次）` | server 不可达/被断开，客户端在指数退避重连；日志里有目标与延迟 |
| 昵称被占用 | 自动加 `_` 重试；`/irc status` 显示最终昵称 |
| 收不到频道消息 | 确认 `channels` 配了或 `/irc join` 过；频道消息只发给频道成员 |
| 模型看不到消息 | 主会话未注册（headless/未启动）时入站只落转录并 warn 日志 |
| 长消息看不全 | 主会话卡片正文有上限；用 `/irc log <peer>` 或 Hub 里 `⏎` 看转录 |
| Hub 里 `⏎` 只得到「是外部渠道端点」的拒绝 | 宿主未支持 `transcriptOnly`（stock omp ≤ 18.6.1）：换支持它的 fork 宿主，或改用 `/irc log <peer>` |
| 显示已连接但长时间收不到消息、对侧也看不到你 | 半开连接（NAT/防火墙掐断且不报错）：设 `keepaliveSeconds: 60`，超时判定后会自动重连 |

日志全部带 `IRC` 前缀（`IRC 已注册` / `IRC 转录写入失败` / `IRC 入站投递失败` 等），连接目标与每个配置来源都会在 `session_start` 记一遍。

## 自托管 ircd（本地测试 / 团队共用）

**不要用 `jaredkrinke/pirc`**（实测，见 `docs` 外的复现）：`PING :token`（标准 trailing 形式）**完全不回 PONG**、`366 End of /NAMES` 排在 `353` 之前、numeric replies 不带 server 前缀、`353` 用逗号分隔昵称 —— 对老客户端尤其致命；且上游已归档，owner 自己说「用别人的 fork 吧」。另外它常被起在 SSH 前台会话里，session 一断进程就没了（看起来就像"服务端莫名消失"）。

推荐 **Ergo**（单二进制、IRCv3、活跃维护；本机与共享服务器都用它）：

```bash
# 本地测试：一个二进制 + 一份最小配置
curl -sLO https://github.com/ergochat/ergo/releases/download/v2.19.1/ergo-2.19.1-linux-x86_64.tar.gz
#   Windows:     ...-windows-x86_64.zip
tar -xzf ergo-2.19.1-linux-x86_64.tar.gz
./ergo-2.19.1-linux-x86_64/ergo run --conf ircd.yaml
```

最小 `ircd.yaml`（明文 6667、无账号体系、带基本防洪；`listeners` 改 `0.0.0.0:6667` 即对外）：

```yaml
network:
  name: OmpNet
server:
  name: localhost
  listeners:
    "127.0.0.1:6667":
  ip-limits:
    count: true
    max-concurrent-connections: 32
    throttle: true
    window: 10m
    max-connections-per-window: 128
  check-ident: false
accounts:
  authentication-enabled: false
  registration:
    enabled: false
channels:
  default-modes: +nt
datastore:
  path: ircd.db
  autoupgrade: true
logging:
  - method: stderr
    type: "* -userinput -useroutput"
    level: info
```

**共用的话务必做成服务**（别在 SSH 前台跑）：`/etc/systemd/system/ergo.service` 里 `ExecStart=/opt/ergo/ergo run --conf /opt/ergo/ircd.yaml`、`WorkingDirectory=/opt/ergo`、`Restart=always`，然后 `systemctl enable --now ergo`；日志用 `journalctl -u ergo -f`，升级只需替换 `/opt/ergo/ergo` 后 `systemctl restart ergo`。

## 测试

- `test/mock-irc-server.ts`：`net.createServer` 的 mock IRC server（真 TCP、真线格式，按 IRC 语义转发频道/私聊消息）。
- `test/protocol.test.ts`：CRLF 分帧、`parseIrcLine`、512 字节切分、注册/`PING`→`PONG`/`JOIN`/433/退避重连与重新 JOIN。
- `test/peers.test.ts`：peer 注册面（`transcriptOnly`/`sessionFile`/`activity`/故意抛错）、入站投递 + 转录落行、出站 `deliverIrcMessage` → `PRIVMSG`。
- `test/transcript.test.ts`：转录格式、原文不截断、滚动窗口、尾部读取、显示前净化。
- `test/commands.test.ts`：`/irc connect|disconnect` 的决策与文案（未配置时不碰客户端、已在连接不重复 start、
  断开后 `status` 给出重连入口）、以及 `status` 的连接状态机（未连接 / 连接中 / 重连中 / 已注册）。
- `test/e2e-mock.ts`：两个真实 `IrcClient` 互相对话（含真实扩展入口 `index.ts` 的装配冒烟，
  以及 `/irc disconnect` → 排队不上线 → `/irc connect` 重新 JOIN 并补发的往返）。
- `test/e2e-host.ts`（`bun run e2e:host`）：真 `omp` 进程 + mock IRC server，证明扩展在真宿主里 JOIN 后，入站频道/私聊消息落进 peer 转录（Hub `⏎` 与 `history://` 读的那份）。宿主默认取 PATH 上的 `omp`，要验证 fork/源码宿主用 `IRC_E2E_OMP=<fork>/packages/coding-agent/src/cli.ts bun run e2e:host` —— `Bun.spawn(["omp"])` 会先命中本扩展 `node_modules/.bin/omp`（devDependency 钉的发行版）。

测试不睡真实时间：等待全部走事件驱动的 `Gate` / `server.waitForLine` / `server.waitUntil`。
