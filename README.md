# IRC 渠道扩展（omp-irc-channel）

把 omp 作为 **IRC 客户端**接入任意 IRC server（RFC1459 子集），让 omp 与 IRC 上的其它
agent 对等通话：

- **入站**：IRC 私聊/频道消息 → 主会话的 `irc:message` 卡片（走宿主公开扩展 API `pi.sendMessage`，
  `deliverAs: "steer"`；卡片末尾带回复指引）。
- **出站**：模型调 `irc` 工具 `send`，人用 `/irc send` 命令——出站只有这两条路。
- **转录**：每个会话一份**宿主会话文件格式**的 jsonl（首行是合法 session header，`omp render`
  之类宿主工具能直接看；入账剥控制序列，见「与宿主的接口面」）；`irc log` / `/irc log`
  读的是**正文**。
- **实例专属昵称**：昵称默认带工作区后缀（`D:/JXAI` → `omp-jxai`），本机多个 omp 实例连同一频道也分得清。

渠道是**独立**的：不注册 AgentRegistry、不建 peer 替身，也不走 `IrcBus` / `deliverIrcMessage` /
`irc:incoming` 卡片 / `write agent://irc-<nick>`。那套是给 omp **内部** agent 之间通信
（子代理编排）设计的：`kind: "sub"` 替身、广播扇出、Agent Hub 聚焦、`history://` 都是 peer 面
语义，不属于外部渠道。渠道只需要「收得进来、发得出去」——入站 `pi.sendMessage`、出站 `irc` 工具；
中间多一层替身，只会多一份与宿主内部实现耦合的状态。

代价（有意取舍）：宿主不会替模型代发，模型必须**显式**调用 `irc` 工具回话，所以入站卡片正文
末尾直接印出用法。

## 安装与加载

扩展目录就是本仓库根目录，omp 的扩展发现机制会自动加载它（`package.json` 的
`omp.extensions: ["."]`）。开发/测试：

```bash
bun install
bun x tsc --noEmit          # 类型检查
bun test                    # 单元测试（会话目录 / 命令 / 转录 / 协议）
bun run e2e                 # 端到端（真 TCP + mock server + 假注入面），打印 E2E PASS
bun run e2e:host            # 宿主级端到端（真 omp 进程 + mock ircd），打印 E2E PASS
```

## 配置

配置文件：`<agentDir>/irc.json`（可选；`agentDir` 通常是 `~/.omp/agent`）。
**不配任何东西扩展也能加载**：工具/命令/会话目录都在，只是不连 server，`/irc status` 会说明缺什么。

```json
{
	"server": "irc.example.org",
	"port": 6697,
	"tls": true,
	"nick": "omp",
	"nickSuffix": "{workspace}",
	"channels": ["#agents", "#dev"],
	"allowUsers": ["alice", "bob"],
	"blockChannels": ["#noisy"],
	"password": "server-password",
	"transcriptDir": "/path/to/transcripts"
}
```

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `server` | 无（必填才算配好） | IRC server 主机名/IP |
| `port` | `6667`（明文）/ `6697`（TLS） | 端口 |
| `tls` | `false` | 走 `tls.connect`，按系统 CA 校验 |
| `nick` | `"omp"` | **基础**昵称；最终昵称 = `nick` + `-` + 展开后的 `nickSuffix`（见下） |
| `nickSuffix` | `"{workspace}"` | **实例后缀**模板：`{workspace}` → 工作区目录名（`ctx.cwd` 的 basename），`{hash}` → 工作区路径的 4 位短哈希；置 `""`/`false`/`"off"` 关闭 |
| `channels` | `[]` | 启动即 JOIN 的频道；空则只收私聊 |
| `allowUsers` | `[]` | 私聊**白名单**（nick）：非空 = 只收这些人的私聊。见「入站鉴权（白/黑名单）」 |
| `blockUsers` | `[]` | 私聊**黑名单**（nick）：命中即拒，**优先于白名单** |
| `allowChannels` | `[]` | 频道**白名单**：非空 = 只收这些频道的消息 |
| `blockChannels` | `[]` | 频道**黑名单**：命中即拒，**优先于白名单** |
| `password` | 无 | **连接密码**（IRC `PASS`），不是 SASL |
| `transcriptDir` | `<agentDir>/irc-transcripts` | 每个会话一份 jsonl 转录的目录（文件名 = 会话 id） |
| `transcriptMaxBytes` | 64 MiB | 转录目录**总字节**上限：超出按 mtime **删最旧**的转录文件（远端换个 nick 就多一份文件，所以必须有回收；每 30s 至多扫一次目录） |
| `transcriptMaxFiles` | 500 | 转录目录**文件数**上限：同一套回收机制 |
| `keepaliveSeconds` | `60`（`0` 关闭心跳） | 心跳：每这么久主动发一次 `PING :token`。**半开连接只能靠它发现**——对端把我们踢掉、FIN 却没到达本机时不会产生任何 socket 事件（`netstat` 一直 ESTABLISHED，`close` 永不触发），只靠 `close` 驱动的重连永远不会触发。60s 也小于常见 ircd 的 idle ping 阈值，顺带让服务端的 `Ping timeout` 等不到超时 |
| `keepaliveTimeoutSeconds` | `30` | 发出 `PING` 后这么久内**没有任何入站行**（PONG、服务端 PING、别人的消息都算）就判死：断开并走既有退避重连。这只是**等一个 PONG 的预算**，与间隔无关——间隔拉长不会让断线更晚被发现 |

同名环境变量可覆盖（优先级高于文件，逐条日志会说明哪个生效）：

`IRC_SERVER`、`IRC_PORT`、`IRC_TLS`、`IRC_NICK`、`IRC_NICK_SUFFIX`、`IRC_CHANNELS`（逗号分隔）、
`IRC_PASSWORD`、`IRC_TRANSCRIPT_DIR`、`IRC_KEEPALIVE_SECONDS`、`IRC_KEEPALIVE_TIMEOUT_SECONDS`、
`IRC_ALLOW_USERS`、`IRC_BLOCK_USERS`、`IRC_ALLOW_CHANNELS`、`IRC_BLOCK_CHANNELS`（逗号分隔）、
`IRC_TRANSCRIPT_MAX_BYTES`、`IRC_TRANSCRIPT_MAX_FILES`、
`IRC_CONFIG_PATH`（改配置文件位置，测试/多实例隔离用）。

### 多实例：实例专属昵称

QQ 渠道是单例，IRC 不是：**同一台机器上的每个 omp 进程都是一条独立连接**。所以昵称默认带
实例后缀——最终昵称 = `nick` + `-` + 工作区标签：

| 工作区（`ctx.cwd`） | 昵称 |
| --- | --- |
| `D:/JXAI` | `omp-jxai` |
| `C:/Users/K/proj/My App` | `omp-my-app` |
| `D:/项目`（目录名收敛后为空） | `omp-<4 位短哈希>` |

于是多个实例进同一个频道时互相可分，也不会抢同一个昵称。要更保险（不同父路径下同名目录）用
`"nickSuffix": "{workspace}-{hash}"`；要钉死一个昵称（例如接外部 ircd 的机器人账号）用
`"nickSuffix": ""`（env 里用 `IRC_NICK_SUFFIX=off`，空串同样算关闭）——此时多实例同名，
撞名的那一个会被服务端改名加 `_`（433 自愈）。
昵称总长按 30 字符截断（后缀至少留 4 字符，放不下就不加）。

`/irc status` 与 `irc status` 都显示最终昵称，状态栏连上后也显示它（`IRC ● omp-jxai（2 会话）`），
多个实例并排开着时一眼看出哪个窗口是哪个实例。

### 入站鉴权（白/黑名单）

默认**全放行**（不配任何白/黑名单 = 现状行为）。要收紧时按两个维度控制：**私聊**按发送者
nick 判，**频道**按频道名判。四个键（`irc.json` 字段名 = env 名去掉 `IRC_` 后缀）：

| 键 | env | 维度 | 作用 |
| --- | --- | --- | --- |
| `allowUsers` | `IRC_ALLOW_USERS` | 私聊 | 白名单（nick）；非空 = 只收这些人的私聊 |
| `blockUsers` | `IRC_BLOCK_USERS` | 私聊 | 黑名单（nick）；命中即拒 |
| `allowChannels` | `IRC_ALLOW_CHANNELS` | 频道 | 白名单（频道名）；非空 = 只收这些频道的消息 |
| `blockChannels` | `IRC_BLOCK_CHANNELS` | 频道 | 黑名单（频道名）；命中即拒 |

取值可以是 `irc.json` 里的字符串数组，也可以是 env 里的英文逗号分隔字符串
（`IRC_ALLOW_USERS=alice,bob`）；两侧都会 trim、丢掉空项，env 同名键覆盖文件。匹配规则：

- **黑名单优先**：先看黑名单，命中即拒（即使它也在白名单里）；
- **该维度白名单非空即进入白名单模式**：未命中就拒；白名单为空则放行（只受黑名单约束）；
- **大小写不敏感**：nick 按 RFC1459 casemapping 折叠（大小写 + `[]{}\|~^`），频道名比较前先小写；
- 频道名要显式写 `#`/`&` 前缀；没写前缀按 `#<名字>` 补（口径同 `/irc join`）。

被拒的消息**仍会落转录**（转录是全量账本，`irc log` 读得到），只是不注入主会话、不唤起
agent，并记一条 debug 日志（`IRC 入站被策略拒绝`）。改配置后重启（或 `/irc connect` 重载）生效。

**这不是密码学身份**：IRC 的 nick 可以被伪造（尤其敌对 ircd 能随便用别人的 nick 发消息），
白名单只是「按名字过滤」，挡不住能控制链路/服务端的人。见下节。

## 用法

**IRC 会话不是 omp 子会话**：`write agent://…` 到不了它。出站只有两条路——模型侧的 `irc`
工具，人侧的 `/irc` 命令；会话 id 只在这两处的参数/引用、以及转录文件名里使用。
工具侧参数是命名的（`action` 取 `list|send|join|status|log`），例如
`{"action":"send","peer":"irc-alice","text":"…"}`；命令侧是位置参数。`peer` 与命令里的
`<peer>` 都支持会话 id / nick / 频道（大小写不敏感）。

| 用法 | 作用 |
| --- | --- |
| `irc send` / `/irc send <peer> <正文>` | 发一条 PRIVMSG；引用支持会话 id / nick / 频道。**还没聊过的 nick 会当场登记**，不必等对方先开口 |
| `irc list` / `/irc list` | 已知会话（id / 类型 / 最近活跃 / 原始目标） |
| `irc log` / `/irc log <peer> [条数]` | 某个会话的收发账本（正文；出站长文会在 512 字节处切成多条 PRIVMSG，这里能看到完整正文与顺序）；省略 `<peer>` 且只有一个会话时自动选它 |
| `irc join` / `/irc join <#频道>` | JOIN 并记为**留驻频道**（断线重连后自动重新 JOIN）；缺 `#` 自动补 |
| `irc status` / `/irc status` | 连接/注册/留驻频道/已知会话数 + 配置说明 |
| `/irc connect` | 连接 IRC server（主会话 `session_start` 已自动连；断开后用这条重连） |
| `/irc disconnect` | 断开并停止自动重连。只停传输层：会话登记与转录保留，`/irc connect` 回来即可继续 |
| `/irc part <#频道>` | PART 并取消留驻 |
| `/irc help` | 全部子命令（`/irc` 无参数等同 `/irc status`） |

会话 id 由 nick/频道名直接派生（无持久化，重启后按需重建）：

| 会话 | 会话 id |
| --- | --- |
| 私聊 `Alice` | `irc-alice`（`irc-<nick小写化>`） |
| 频道 `#omp` | `irc-chan-~homp`（`#` 收敛成令牌 `~h`） |
| 频道 `&omp` | `irc-chan-~lomp`（`&` 收敛成令牌 `~l`；与 `#` 是不同频道） |
| 私聊 `bot[1]` | `irc-bot-1-~<16 位短哈希>`（名字里有会被收敛掉的字符时一律带哈希） |

规则：`sanitizeIdPart` 会把 `[`、`{`、空格 等一律收敛成 `-`，而这些都是 RFC2812 的合法 nick
字符——所以**名字里有这类字符时 id 带上原始目标的 16 位短哈希**，否则 `bot[1]` 与 `bot{1}`
会共用一条记录（给一个的回复静默发给另一个，转录也混在一起）。哈希用 `~` 分隔：安全名的
base 只可能含 `[a-z0-9_-]`，所以**「带哈希的 id」不可能被对端起个像它的 nick 顶掉**。
id 是 `(类型, 原始目标)` 的**纯函数**：不随收发/淘汰顺序变化，会话被淘汰后重建还是同一个 id，
旧卡片里的句柄不会漂到别人身上。

频道里的入站消息在卡片里带频道名（`[#omp] alice: 你好`），私聊是 `[私聊] alice: 你好`（NOTICE
带 `NOTICE` 前缀）；卡片正文末尾固定跟一行回复指引
（`回复：irc 工具 {"action":"send","peer":"irc-alice","text":"<正文>"}`）——单独一行，照抄即可。

连接由**主会话**持有（进程级单例，子会话不重复连）。状态栏那一格一眼看出当前状态：
`IRC ● omp-jxai（N 会话）` / `IRC ◌ 连接中…` / `IRC ◌ 注册中…` / `IRC ◌ 重连中（第 N 次）` /
`IRC ○ 未连接（/irc connect）` / `IRC ⨯ 未配置`。要换手就在目标会话里 `/irc disconnect`，
再在另一个会话里 `/irc connect`——换掉的是传输层；会话登记（进程内的内存表）与转录留在原地。

`/irc disconnect` 之后：

- 不接收入站（server 侧连接已断），状态栏变 `○ 未连接（/irc connect）`；
- 已登记的会话与转录**照旧**，`irc log` / `/irc log` 都还能看；
- 发不出去：`irc send` 与 `/irc send` 都返回 `IRC 未连接/未注册，消息未发出`（不排队、不补发），
  `/irc connect` 回来才能继续发。

## 协议子集（RFC1459）

已实现：`NICK`/`USER`（+ 可选 `PASS`）注册、`PING`→`PONG`、`JOIN`/`PART`、
`PRIVMSG`/`NOTICE` 收发、`001`（RPL_WELCOME，据此触发重连后的重新 JOIN）、
`433`（昵称占用自动换名）、CRLF 逐行分帧（容忍半行与一次多行）、
**正文按 512 字节上限切分**（不切碎 UTF-8 字符，优先在空格/换行处断开）、
**断线指数退避重连**（`base * 2^n`，上限 30s）并在重连成功后重新 JOIN 留驻频道；
**底层心跳**（缺省 60s 发 `PING`、30s 无任何入站就判死走同一条重连路径）——`close`/`error` 事件
在半开连接上根本不会到，重连不能只靠它们驱动。
`host` 按 63 字节上限预留，因此切分长度是保守但安全的。

**出站不做排队**：未注册时（首次连接中/断线重连中/`/irc disconnect` 之后）工具与命令在调用前
就检查 `status().registered` 并**直接报错**（`IRC 未连接/未注册，消息未发出`），不会先写进 socket；
客户端本身只在 socket 已连上时写出（它不排「未注册就补发」的队列）。写不出去就是写不出去
——没有「稍后替你补发」的隐式语义，模型拿到的是失败而不是被吞掉的发送。

**不做**（有意留白）：

- **SASL 认证**（`AUTHENTICATE`）；需要认证的网络请用 `password`（连接密码）或网关。
- IRCv3 扩展能力：`CAP` 协商、`message-tags`、`account-tag`、`chathistory`、`batch`、`echo-message` 等。
- 多网络并行：只连一个 `server`（要接多个网络就起多份配置不同的 omp 实例，用 `IRC_CONFIG_PATH` 隔离；
  同一 server 上的多实例靠默认打开的实例后缀区分昵称）。
- 昵称注册（NickServ）、频道钥匙（`+k`）、CTCP 应答（CTCP 消息直接忽略，不进模型上下文）。
- 服务端主机名发来的 `NOTICE`（注册期的 `*** Looking up your hostname` 之类）会被过滤，不进模型上下文。

## 与宿主的接口面

扩展只用两个宿主**公开** API，都不涉及 agent 编排（`AgentRegistry` 完全不碰）：

| 方向 | API | 说明 |
| --- | --- | --- |
| 入站 | `pi.sendMessage({ customType: "irc:message", content, display: true, attribution: "agent" }, { deliverAs: "steer", triggerTurn: true })` | 每条 PRIVMSG/NOTICE 一次调用：会话空闲时按带 `triggerTurn` 的注入唤起一轮；模型正忙时作为 steering 注入当前这一轮（下个 step 边界生效）。宿主把 `sendMessage` 的错误收进自己的错误通道，扩展侧拿不到返回值也没有失败回调——一次调用就是一次投递 |
| 出站 | `irc` 工具 + `/irc send` 命令 | 宿主不代发（没有 `deliverIrcMessage` 那样的回路）；模型/人显式调用才发得出去 |

**投递方式（四种都实测过）**：宿主对 `sendMessage` 的四种 `deliverAs` 在「模型正忙」时走完全
不同的队列，实测（真 `omp`：真 TUI 按 Esc + mock ircd 连喷 3 条）：

| 方式 | 消息连喷（模型忙时到达） | 用户按 Esc 打断 | 卡片浮现时机 |
| --- | --- | --- | --- |
| **`steer`（当前）** | 全绿（连喷 3 条共 11 次：3/3、3/3、6/6。另有一次 0/3 是宿主没起来的抖动——时间线里一个 turn 帧都没有，与投递无关） | **保住**（实测：注入 3s 后已进当前轮，按 Esc 后卡片仍在、补轮后仍在） | 下个 step 边界（立刻把当前轮导向这条消息，与 omp 自己给子代理发 IRC 同一语义） |
| `followUp` | 4/4（2 轮各 4 条） | **会丢**：TUI 的 Esc 走 `clearQueue({ forInterrupt: true })`，只保留 advisor 卡片，排队的 followUp 被丢掉（真 TUI 实测：Esc 后卡片再不出现） | 当前轮结束之后 |
| `aside` | **会丢**：约 1/6（宿主轮次收尾竞态，见下） | 保住（宿主把 stranded aside 折进上下文） | 当前轮的 step 边界 |
| `nextTurn` | **会丢**：2/4（突发合并时只把最后一条当 prompt） | 未测（同一 `clearQueue` 路径，预期同 `followUp`） | 当前轮结束之后 |

`steer` 的残留窗口（未实测命中）：主循环取走 steering 之前按 Esc，`clearQueue({ forInterrupt: true })`
同样会把非 advisor 的 steer 丢掉——但这条窗口只有一个 step 边界宽（消息立刻被当前轮消费），
不像 `followUp` 那样要 park 到整轮结束。

`aside` 的丢法（在 `pi-agent-core` 里）：记录被取进轮次的 `pendingMessages` 后若本轮以
非 abort 的方式收尾（deadline/提前结束），`discardAsides()`（`agent-loop.ts:1817-1822`）直接丢弃；
扩展注入的是裸 custom 记录，没有 `[ASIDE_MESSAGE_DISCARD]`/`COMMIT` 钩子，所以丢弃是静默的、
扩展侧拿不到回调去补投（宿主自己的 `irc:incoming` 同样如此，属上游问题）。

**兜底**：无论走哪条路，入站**正文永远先落渠道账本**（`transcriptDir` 下每个会话一份 jsonl，
不截断、不切分、不改顺序），所以被宿主丢掉的入站消息不会真的消失——`irc log` /
`/irc log <peer>` 能读回正文，模型也可以据此补看（代价是它当时没被唤起）。
- **注入净化**：卡片正文由扩展渲染（`[#omp] alice: hi` + 末尾回复指引），整串过 `stripControl`
  ——nick 与正文都是 IRC 来的不可信输入，对端不该能靠 ESC/OSC 序列操纵运维者的终端。
  同时过 `escapeHarnessTags`（与宿主 `session/harness-tags.ts` 同一份规则）：扩展注入的自定义
  消息是 developer 角色内容，系统提示声明 `<system-*>` / `<irc …>` 这类块由 harness 自己写，
  对端不该能借这条通道伪造 harness 指令。
  唯一的例外是**服务端给的昵称**（`001` 的第一个参数，服务端可任意改）：它既进状态栏（宿主
  自己净化那一格）又进 `irc status` / `/irc status` 文案，后者在 `src/tool.ts` / `src/commands.ts`
  的出口过 `sanitizeSingleLine`。
- **落盘也净化（`sanitizeForLedger`）**：转录是宿主**直接渲染**的目标（`omp render`、
  Agent Hub 的 fullscreen 转录视图），实测 `omp render` 会把正文里的 ESC 逐字节打到终端上
  （OSC 52 写剪贴板 / OSC 8 伪造链接 / 清屏）。所以入账前剥掉 ESC/CSI/OSC 等控制序列，并把
  「伪换行」（裸 CR、U+2028/U+2029）压成空格；**LF 保留**（只可能来自我们自己的出站多行正文），
  harness 标签**不转义**（账本留正文，模型读日志时由 display 那一层转义）。
- **单行化（所有显示/注入出口，不只卡片）**：正文里的行终止符（`\r`、`\n`、U+2028/U+2029）
  一律压成空格——一张卡片/一行日志 = 一条 IRC 消息。否则对端能在卡片里伪造「另一个人发言」
  或那行回复指引，也能在 `irc log` 的 digest 里伪造一行 `[omp] …`（模型会把 digest 当账本读）。
  出口共用 `sanitizeSingleLine`（`src/transcript.ts`）：入站卡片、`irc log`/`/irc log` 的 digest、
  `irc list`/`/irc list` 的会话行、`status` 里的昵称。
- **入站长度上限**：单条 IRC 行超过 `MAX_INBOUND_LINE_BYTES`（8 KiB）直接丢弃（不进模型上下文）；
  分帧缓冲里长时间没有完整行、累计超过 `MAX_INBOUND_BUFFER_BYTES`（64 KiB）就判错并断开（走既有退避重连）
  ——对端只要一直发不带 `\n` 的字节，没有这道闸口就能把宿主内存撑爆。出站长文由客户端按 512 字节切成
  多条 PRIVMSG，对端看到的是分段。转录与 `irc log` 保留正文与顺序（单条正文超 1 MiB 会截断并标注）。
- **注册超时**：TCP 连上后 `REGISTER_TIMEOUT_MS`（15s）内没等到 `001` 就断开重连——对端「接受连接
  但不完成握手」不会再让渠道永久静默；指数退避只在**注册成功后**归零，所以 accept-then-close 循环
  不会退化成固定 500ms 重试。
- **回复指引**：卡片正文末尾固定跟一行 `回复：irc 工具 {...}`——放在正文之后，正文再长也不会被埋在开头。
- **清理**：`session_shutdown` 时停客户端、清空会话目录、清掉状态栏那一格；子会话
  （`kind: "sub"`）不连接也不清理——IRC 连接是进程级单例，只归主会话。

## 排障

| 现象 | 处理 |
| --- | --- |
| `/irc status` 说「未配置 server」 | 写 `<agentDir>/irc.json` 或设 `IRC_SERVER` |
| 状态栏 `IRC ○ 未连接（/irc connect）` | 有人执行过 `/irc disconnect`（或本次会话还没连接）：`/irc connect` 重连 |
| 状态栏 `IRC ◌ 重连中（第 N 次）` | server 不可达/被断开，客户端在指数退避重连；日志里有目标与延迟 |
| 昵称被占用 | 自动加 `_` 重试；`/irc status` 显示最终昵称 |
| 两个实例昵称一样（如 `omp-jxai` 与 `omp-jxai_`） | 同一个工作区（或不同父路径下的同名目录）里的实例：后者是 433 自愈的结果。用 `"nickSuffix": "{workspace}-{hash}"` 或 `"nickSuffix": ""` 加显式 `nick` 钉住 |
| 收不到频道消息 | 确认 `channels` 配了或 `/irc join` 过；频道消息只发给频道成员 |
| 模型看到卡片但没回话 | 渠道没有代发：模型要显式调 `irc` 工具 `action=send`；卡片正文末尾印了用法 |
| 模型想回话却报「消息未发出」 | 客户端未注册（`/irc status` 看状态）；`/irc connect` 重连后重发——出站不排队、不补发 |
| 发的长文在对端显示成好几条 | RFC1459 单行 ≤512 字节：客户端按字节切分（不切碎 UTF-8、优先在空格/换行处断开），对端会收到多条 PRIVMSG。用 `irc log` / `transcriptDir` 下的 jsonl 看完整正文与顺序 |
| 状态栏显示已连接，但对侧看到你「退出: Ping timeout」，且你收不到消息 | 半开连接（NAT/防火墙掐断且不报错：对端的 `ERROR`/FIN 到不了本机）。缺省心跳（60s/30s）会在 ≤90s 内判死并自动重连；若把 `keepaliveSeconds` 设成 `0` 就永远不会重连——改回缺省即可。日志里出现 `IRC 心跳超时，判定连接已死` 就是这条路径 |
| 日志里反复出现 `IRC 心跳超时` | 链路真的收不到任何入站（代理/防火墙只放行出站）：换线路，或按需调大 `keepaliveTimeoutSeconds` |

日志全部带 `IRC` 前缀（`IRC 已注册` / `IRC 转录写入失败` / `IRC 心跳超时，判定连接已死` 等），连接目标与每个配置来源都会在 `session_start` 记一遍。

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

## 接入公共 IRC 服务器的风险

这是一个把**不可信外部输入直接喂给能调用 shell 的 agent** 的渠道。接公共 ircd 前先认清下面几条：

- **明文链路**：`tls` 默认关（明文 6667）。配了 `password` 也只是明文 `PASS`——线上任何人抓包
  就能拿到，且整条会话内容可被中继方读取/篡改。公共网络务必 `"tls": true`。
- **没有端到端认证**：IRC 的消息不签名、不加密到对端；服务端（以及链路上的任何中间人）能改、能插、
  能重放。
- **nick 可以伪造**：尤其敌对 ircd 能拿别人的 nick 发消息，也能给我们塞 `NICK`/`PRIVMSG` 里的任意
  身份串。**白名单是按名字过滤，不是密码学身份**——它能挡走路过的陌生人，挡不住控制链路或服务端的人。
- **默认放行 = 谁都能唤起 agent**：不配白/黑名单时，任何能给本实例发私聊、或在共享频道里发言的人，
  都能让我们的主会话起一轮，而 agent 手握 shell。**接公共服务器就该配白名单/专用频道。**
- **prompt injection**：对端正文是不可信输入。虽然入站正文已剥离控制序列、转义 harness 标签、
  压平换行（见 `src/inbound.ts`），但仍足以诱导 agent 去读/发本地文件（`irc send` 能外发任意内容）、
  执行命令。不要让它替你去碰不信任的频道。
- **没有速率限制**：本扩展不做限流（设计如此），对端可以刷屏——既刷屏你的 TUI，也刷 token/账单。
  只能在服务端（ircd 防洪、`+m`/`+i` 等频道模式）或网络层挡。
- **第三方可见**：服务器管理员、以及频道里的其它成员都能看到收发内容（频道不是私密信道）。
- **终端视觉欺骗仍有残余风险**：显示前会剥 ESC/OSC 等控制序列与大部分 Cf 字符（防 ANSI 注入），
  但 Unicode 双向文本/同形字这类纯文本层面的伪装不可能完全消除——别把 TUI 里看到的名字当成身份。

**推荐做法**：自建或私有 ircd（见上节）；开 `tls`；配白名单（或专用频道 + 频道模式 `+i`/`+k`）；
给机器人开专用频道并只在受控网络里放行；不要把能唤起 agent 的实例暴露在公共 ircd 上。

## 测试

- `test/mock-irc-server.ts`：`net.createServer` 的 mock IRC server（真 TCP、真线格式，按 IRC 语义转发频道/私聊消息）。
- `test/protocol.test.ts`：CRLF 分帧、`parseIrcLine`、512 字节切分、注册/`PING`→`PONG`/`JOIN`/433/退避重连（**注册成功才归零**）与重新 JOIN、心跳（半开连接判死）。
- `test/client-limits.test.ts`：传输层加固：`nickEquals` 的 RFC1459 折叠、入站单行/缓冲上限与 warn-once、001/433 与 `NICK` 的服务端可控 nick 校验、accept-then-close 退避序列、注册超时（武装/001 清/close 清/未 connect 不武装）。
- `test/conversations.test.ts`：会话 id 编解码（纯函数：安全名拿基 id，有损名带 16 位哈希、与 scope 绑定、**前后空白变体不再同 id**）+ 会话目录（登记/解析**只认 id 与原始目标名**/淘汰/淘汰后重建仍同 id）+ 入站注入管线（假 `InboundInjector` 断言 `irc:message` 卡片、`deliverAs: "steer"`、回复指引、净化、harness 标签转义）。
- `test/transcript.test.ts`：转录格式、入账净化（剥控制序列+Cf 格式字符但**保留 ZWJ/ZWNJ** / 伪换行压空格）、单条超限截断、滚动窗口不留未初始化字节、目录级回收（超 maxBytes/maxFiles 删最旧、不删当前文件、30s 节流）、尾部读取、显示前净化。
- `test/tool.test.ts`：`irc` 工具的五个 action（send 的未注册拒绝与不留幽灵会话、log 的解析与条数上限、list、join、status），以及 `details` 出口与 `content` 同口径净化。
- `test/target-validation.test.ts`：出站目标校验（`assertIrcTarget`：`a,b` 扇出 / `victim :pwned` 混淆 / 超 64 字节 / 前导 `:` 全部拒绝，且在 `privmsg` 之前就抛，转录与 touch 不动作）。
- `test/extension.test.ts`：`index.ts` 的装配与生命周期（真 socket + stub `ExtensionAPI`）：主会话连接/注册/JOIN、子会话不连接也不改编注入目标、退出清理。
- `test/commands.test.ts`：`/irc connect|disconnect` 的决策与文案（未配置时不碰客户端、已在连接不重复 start、
  断开后 `status` 给出重连入口）、`status` 的连接状态机（未连接 / 连接中 / 重连中 / 已注册）、
  `send` 的引用解析与未注册时的拒绝。
- `test/config.test.ts`：实例专属昵称的推导（工作区标签收敛与哈希退化、`nickSuffix` 模板/关闭/长度上限、
  env 覆盖、notes 文案）。
- `test/inbound-policy.test.ts`：入站白/黑名单（`isInboundAllowed` 纯函数 + 真实入站管线）：黑名单优先、
  白名单模式下拒收但仍落转录、未配白名单的维度放行、频道名大小写/前缀归一、nick RFC1459 折叠、
  配置解析（文件数组 / env 逗号分隔 / 非法值忽略 + notes 摘要）。
- `test/e2e-mock.ts`（`bun run e2e`）：真 TCP + mock server + 假注入面：入站注入断言、工具/命令出站 PRIVMSG 上线、512 切分、断线重连后重新 JOIN、`/irc disconnect` 期间 `/irc send` 拒绝；另含 `index.ts` 的装配冒烟（stub `ExtensionAPI`，不需要 `AgentRegistry`）。
- `test/e2e-host.ts`（`bun run e2e:host`）：真 `omp` 进程 + mock ircd（`IRC_E2E_SERVER=host:port` 可改连外部 ircd），证明扩展在真宿主里 JOIN 后，入站频道/私聊消息以 `irc:message` 卡片落进真宿主会话 jsonl（扩展自己的转录里同样有正文），`/irc send` 出站上线。宿主默认取 PATH 上的 `omp`，要验证 fork/源码宿主用 `IRC_E2E_OMP=<fork>/packages/coding-agent/src/cli.ts bun run e2e:host` —— `Bun.spawn(["omp"])` 会先命中本扩展 `node_modules/.bin/omp`（devDependency 钉的发行版）。

测试不睡真实时间：等待全部走事件驱动的 `Gate` / `server.waitForLine` / `server.waitUntil`。
