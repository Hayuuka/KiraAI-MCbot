# mc_bot 实现规格

> 交给 codex 的落地文档。架构与所有技术风险已由 Claude 验证完毕，**按本文档实现即可，不要重新探索协议层**。
> 最后更新：2026-10-25

---

## 0. 当前状态：无阻塞，可以全量实现

**此前记录的 Grim 反作弊阻塞已经解除，不要再按"只能做不能动的功能"来设计。**

背景：服务器 `mc.catnest.fun` 装了 Grim 反作弊，最初用 `Hayuuka` 号测试时，所有经由 ViaProxy 翻译层发出的移动包都被拒绝（`TickTimer` / `GroundSpoof` / `Timer` 告警，角色位移恒为 0）。

现在已切换到新账号 **`ChuXiaoxue`**（UUID `c4deff35-d924-4f6b-ad13-735267677162`），并由服主授予了 Grim 豁免权限。实测结果：

| 能力 | 结果 |
|---|---|
| 连接进服 | ✅ |
| 原始按键移动 | ✅ 2.5 秒移动 11 格 |
| pathfinder 寻路 | ✅ 8 格距离成功抵达 |
| 跳跃 / 物理同步 | ✅ |
| 挖掘方块 | ✅ `bot.dig()` 成功 |
| 读方块 / 扫描 | ✅ |
| 读玩家列表 / 延迟 | ✅ 5 人在线 |
| 聊天收发 | ✅ |
| Grim 告警 | ✅ 0 条 |

因此 **`features.movement` 默认开启**，寻路、跟随、挖矿、守家、闲逛全部可以实现。

### 0.1 一个需要留意的限制：adventure 模式

该账号当前处于 **adventure（冒险）模式**，未获得 op 或 worldedit 权限：
- 走路、寻路、跳跃、读方块、聊天、读玩家 —— 全部正常
- `bot.dig()` 在测试中曾返回成功，但 adventure 模式下通常**无法真正破坏方块**，落地实现时需以 `mc_inventory` / 方块变化实际验证，不要只信返回值
- 不能用 `/gamemode` 等管理命令

如果后续发现挖掘、放置、使用物品受限，需要请服主把该号切成 survival，或补上相应权限。**这属于权限问题，不是代码 bug，codex 不要在代码里绕过。**



---

## 1. 架构决定（已定，不要再讨论）

**不用 MCP 做事件回传。** MCP 是请求-响应模型，无法把游戏事件主动推给 KiraAI；而且 MCP Server 必须能被云端访问，而本机在家用 NAT 后面。

采用：**PC 主动连云 WebSocket → KiraAI 插件把动作注册成原生工具 + 用 `publish_notice()` 把事件注入指定会话。**

人格和记忆不需要复制或同步——游戏事件注入到同一个 QQ 会话，模型读到的就是同一份 `memory/core.txt` 和同一份该会话的 `chat_memory.json`。

```
        这台 Windows 电脑                          阿里云 120.26.117.155
 ┌──────────────────────────────┐          ┌────────────────────────────────┐
 │ ViaProxy (127.0.0.1:25568)   │          │ KiraAI 容器 (5267)             │
 │   ↑ 26.1        ↓ 26.2 正版  │          │  ├ mc_bridge 插件（新写）      │
 │ mc_bot (Node, mineflayer)    │          │  │   ├ WS 服务端                │
 │   ├ 本地技能                  │  WS      │  │   ├ register.tool × N         │
 │   └ link.js ─────────────────┼─────────►│  │   └ publish_notice()          │
 └──────────────────────────────┘  隧道     │  ├ 人格 core.txt    （不改）   │
                                            │  └ 记忆 chat_memory（不改）    │
                                            └────────────────────────────────┘
                                                          │
                                              Naocat-QQ:dm:2276753440
                                                （专门会话，不打扰猫群）
```

---

## 2. 已验证的环境事实

| 项 | 值 |
|---|---|
| MC 服务器 | `mc.catnest.fun:25565` → `39.108.88.81` |
| 服务端 | Paper 26.2，协议 **776**，正版模式（online-mode） |
| ViaProxy | 3.4.14，内置 ViaVersion 支持到 26.3(777)，含 `v26_2to26_1` 翻译器 |
| 正版账号 | **`ChuXiaoxue`**（UUID `c4deff35-d924-4f6b-ad13-735267677162`），已获 Grim 豁免 |
| 账号在 accounts 列表的索引 | **1**（`minecraft-account-index: 1`）；索引 0 是旧号 Hayuuka |
| mineflayer | 4.39.0 / minecraft-protocol 1.68.0，最高 26.1(775)，npm 上无 26.2 |
| 本机 | Node v24.22.1、Java 26.0.2.1、npm 11.19.1 |
| 服务器反作弊 | **Grim**（这是移动阻塞的根因） |
| 服务器其它插件（聊天可见） | TPA、CustomDiscs、AxGraves、猫窝保险(KeepInventory) |

### 2.1 三个必须照抄的坑（已踩完，不要重试）

**坑 1：ViaProxy 的 CLI 参数 `--auth-method ACCOUNT` 不生效。**
必须用配置文件启动：
```
java -jar ViaProxy.jar config viaproxy.yml
```
且 yml 里 `auth-method: ACCOUNT`（大写）、`minecraft-account-index: 1`（指向 ChuXiaoxue）。

**坑 2：不设资源包自动接受，mineflayer 会卡在 configuration 状态。**
yml 里必须：
```yaml
fake-accept-resource-packs: true
```
服务器会发 `add_resource_pack`，mineflayer 不回应就一直停在 configuration。

**坑 3：Java 读不了中文绝对路径下的 jar。**
`"D:\work\初小雪\mc\..."` 这种路径传给 `java -jar` 会报"找不到 Java 运行时"。
必须把 `cwd` 设为 jar 所在目录，只传相对文件名 `ViaProxy.jar`。

现成可用的启动器见 `runtime/viaproxy/run.js`。

**坑 4：同一账号不能同时在官方客户端和 bot 上在线。**
服务器会踢掉其中一个。测试 bot 前先把游戏客户端里那个号退出来。

### 2.2 已验证可用的 viaproxy.yml 关键项

```yaml
bind-address: 127.0.0.1:25568
target-address: mc.catnest.fun:25565
target-version: '26.2'
auth-method: ACCOUNT
minecraft-account-index: 1      # 1 = ChuXiaoxue（0 = Hayuuka）
proxy-online-mode: false
fake-accept-resource-packs: true
```

### 2.3 mineflayer 连接参数

```js
createBot({
  host: '127.0.0.1', port: 25568,
  username: 'ChuXiaoxue',
  version: '26.1',      // 必须显式指定！autoVersion 会 ping 到 776 然后报 Unsupported
  auth: 'offline',      // 正版认证由 ViaProxy 完成
})
```

实测的延迟：本机 → 服务器约 24ms，无需额外优化。

---

## 3. 目录结构

```
D:\work\初小雪\mc\
├── README.md                      # 交接说明
├── SPEC.md                        # 本文档
├── vendor\
│   └── ViaProxy.jar
├── runtime\
│   └── viaproxy\
│       ├── ViaProxy.jar
│       ├── run.js                 # 启动器（cwd 必须在这里）
│       ├── viaproxy.yml           # 已验证配置
│       ├── saves.json             # ⚠ 正版令牌，保密，勿进仓库
│       ├── viaversion.yml 等       # Via 各模块配置（自动生成，勿手改）
│       └── logs\                  # ViaProxy 日志
└── mc_bot\                        # ← codex 要写的 Node 项目
    ├── package.json
    ├── config.json
    ├── src\
    │   ├── index.js
    │   ├── config.js
    │   ├── connect.js
    │   ├── state.js
    │   ├── actions.js
    │   ├── events.js
    │   ├── link.js
    │   ├── autonomy.js
    │   └── skills\
    │       ├── index.js
    │       ├── move.js
    │       ├── follow.js
    │       ├── mine.js
    │       └── guard.js
    └── start.bat
```

云端插件放在：
```
/opt/qq-stack/kiraai/data/plugins/mc_bridge/
├── manifest.json
├── main.py
└── schema.json
```

---

## 4. 本地 mc_bot 规格

### 4.1 package.json

依赖：`mineflayer@4.39.0`、`mineflayer-pathfinder@2.4.5`、`ws`。

### 4.2 config.json

```json
{
  "bot": {
    "username": "ChuXiaoxue",
    "host": "127.0.0.1",
    "port": 25568,
    "version": "26.1",
    "auth": "offline"
  },
  "link": {
    "url": "ws://127.0.0.1:5267/ws/plugin/mc_bridge/agent",
    "token": "从云端插件配置里复制",
    "reconnectMinMs": 2000,
    "reconnectMaxMs": 60000,
    "heartbeatMs": 20000
  },
  "events": {
    "chatBufferSize": 200,
    "selfNameFilter": true
  },
  "limits": {
    "maxSayChars": 200
  },
  "features": {
    "movement": true
  }
}
```

`features.movement` 已确认可开启（Grim 豁免生效）。保留这个开关是为了将来换号或环境变化时能快速降级——关掉时 `mc_move` / `mc_follow` / `mc_mode` 应返回明确的不可用错误，而不是超时。

### 4.3 src/connect.js

职责：创建 bot、指数退避重连、状态广播。

- 固定 `version: '26.1'`
- 重连退避：2s 起，每次 ×2，上限 60s；连接成功后重置
- 监听：`spawn`、`end`、`kicked`、`error`、`death`、`health`
- 暴露 `getBot()` 与 `isReady()`

**注意**：`spawn` 事件触发时实体属性可能还没同步完（实测 `hp`/`food` 为 `undefined`，约 4 秒后才正常）。`isReady()` 应额外要求 `bot.entity.position` 有效且已收到 `update_health`。

### 4.4 src/state.js

输出紧凑状态（一条 JSON，控制在 300 字以内）：

```js
{
  ok: true, online: true,
  pos: [1362.5, 63, 2013.5],
  dim: "minecraft:overworld",
  hp: 20, food: 20,
  held: "iron_pickaxe",
  players: [{name:"erdgsa", dist:12.3}],   // 只列 32 格内，最多 8 个
  mode: "idle",
  moving: false
}
```

**不要**输出完整背包、完整方块列表。

### 4.5 src/actions.js

按工具名一一对应。全部返回 `{ok, ...}`，失败返回 `{ok:false, error:"..."}`，**不要抛异常到上层**。

| 动作 | 签名 | 备注 |
|---|---|---|
| `say` | `(text)` | 截断到 200 字，过滤换行 |
| `status` | `()` | 见 4.4 |
| `inventory` | `()` | 总数 + 前 15 种 + 空位数 |
| `recentChat` | `(limit)` | 从本地 ring buffer 取 |
| `scan` | `(radius)` | 方块 top10 + 实体 + 矿物坐标前 10；**半径上限 16** |
| `attack` | `(target)` | 16 格内，PVP 默认关 |
| `move` | `(target)` | `player:名字` / `block:方块id` / `xyz:x,y,z` |
| `follow` | `(player)` | 持续跟随，交给本地循环 |
| `stop` | `()` | 停止一切动作 |
| `mode` | `(mode, args)` | `idle/follow/guard/mine/wander` |

**`scan` 的坑**：旧实现一次吐出 1.5 万字符，把模型上下文打爆。必须严格限制在下面这个形状：

```js
{
  ok: true,
  radius: 16,
  blocks: [{type:"minecraft:stone", count:9370}, ...],   // top 10
  entities: [{type:"minecraft:zombie", dist:4.2}, ...],  // ≤10
  notable: [{type:"minecraft:coal_ore", pos:[136,69,-138]}, ...]  // ≤10
}
```

### 4.6 src/events.js

本地 ring buffer + 事件上报。

- `chat`：过滤自己说的话（`username === bot.username`）
- `join` / `leave`：从 `playerJoined` / `playerLeft` 事件
- `death`：bot 自身死亡
- `health`：血量变化且 `< 6` 时上报，60 秒冷却
- `system`：服务器系统消息、Grim 告警（用于诊断）
- 每条截断 200 字，30 秒内相同文本去重

### 4.7 src/link.js

WebSocket 客户端。

**协议**（JSON 行，或 WS 帧，二选一，建议直接用 WS 帧）：

连接后第一帧：
```json
{"type":"auth","token":"<共享密钥>","name":"Hayuuka","version":"0.1.0"}
```

心跳（每 20s）：
```json
{"type":"ping","ts":1234567890}
```

工具调用（云 → PC）：
```json
{"type":"call","id":42,"tool":"mc_status","args":{}}
```

响应（PC → 云）：
```json
{"type":"result","id":42,"ok":true,"data":{...}}
```
或
```json
{"type":"result","id":42,"ok":false,"error":"bot offline"}
```

事件（PC → 云）：
```json
{"type":"event","kind":"chat","data":{"player":"erdgsa","text":"hello","ts":1234567890}}
```

- 重连：2s 起指数退避，上限 60s
- 无连接时 `call` 直接返回 `{ok:false, error:"link down"}`，**不要挂起等待**

### 4.8 src/autonomy.js

本地自治循环，只在 `features.movement: true` 时启用：

- 自动进食（饥饿 < 18 且有食物）
- 卡住自救（3 秒无位移 → 跳 + 侧移）
- 掉岩浆前撤离
- `mode=follow` 时每秒追目标
- `mode=guard` 时攻击 6 格内敌对生物
- 血量 < 6 时后撤

**不要**让 LLM 参与每一帧操作。

---

## 5. 云端插件 mc_bridge 规格

### 5.1 manifest.json

```json
{
  "plugin_id": "mc_bridge",
  "display_name": "Minecraft Bridge",
  "version": "0.1.0",
  "author": "",
  "core_version": ">=2.34.6",
  "description": "把本地 mineflayer 身体接入 KiraAI：动作注册为工具，游戏事件注入会话。"
}
```

### 5.2 schema.json

至少包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | switch | 总开关 |
| `token` | string | 与 PC 端 `link.token` 一致 |
| `session` | string | 目标会话，默认 `Naocat-QQ:dm:2276753440` |
| `wake_on_chat_mention` | switch | 点名唤醒，默认开 |
| `wake_on_self_event` | switch | 自身事件唤醒，默认开 |
| `passive_whitelist` | string | 只进缓冲不唤醒的白名单玩家，逗号分隔 |
| `max_wakes_per_hour` | number | 每小时唤醒上限，默认 30 |
| `group_summary_seconds` | number | 闲聊摘要合并窗口，默认 45 |

### 5.3 main.py 关键实现

**WebSocket 端点**：
```python
@register.ws("/agent", auth=False)
async def agent_ws(self, ws):
    # 首帧必须校验 token
    # 维护 self.pending: dict[int, asyncio.Future]
    # 收 result 帧 → 完成对应 future
    # 收 event 帧 → 走事件分级
```

**工具注册**（10 个，与 4.5 一一对应）：
```python
@register.tool("mc_status", "查看 MC 身体状态：坐标、维度、血量、饥饿、主手、附近玩家。", {...})
async def mc_status(self, event, **_):
    return await self.rpc("mc_status", {}, timeout=5)
```

超时一律 ≤12s，即使 KiraAI 的 `tool_call_timeout` 是 60s。

**事件注入**（人格与记忆继承的核心）：
```python
await self.ctx.publish_notice(
    self.session,
    MessageChain([Text(f"[MC游戏内] {who}: {text}")]),
    is_mentioned=wake,
)
```

`publish_notice` 产生 `is_notice=True` 的事件；`DefaultChatPlugin` 只处理 `is_mentioned=True` 的，**所以 `is_mentioned` 就是防刷屏开关**。

### 5.4 事件分级策略

| 事件 | 唤醒 | 说明 |
|---|---|---|
| 聊天提到 bot 名 / 私聊 / @ | ✅ | 立即 |
| 白名单玩家普通发言 | ❌ | 进缓冲，等点名时一起看到 |
| 其他玩家闲聊 | ❌ | 45 秒合并成一条摘要 |
| 上下线 | ✅ | 每人 5 分钟冷却 |
| 死亡 / 被踢 | ✅ | 立即 |
| 血量 < 6 / 掉线 | ✅ | 60 秒冷却 |
| bot 自己说的话 | — | 丢弃 |

额外硬约束：每小时唤醒 ≤ 30 次；单条 ≤ 200 字；相同文本 30 秒去重。

### 5.5 必须同时做的配置改动

`/opt/qq-stack/kiraai/data/config/mcp.json` 里把旧的 `Minecraft Body` 条目 `enabled` 改为 `false`，避免 `mc_*` 工具重名。备份文件 `mcp.json.bak_enable_mc` 已存在，可用于回滚。

---

## 6. 实施顺序

按这个顺序做，每步都能独立验收：

1. **本地 bot 骨架** — 能连上、`mc_status` 返回正确坐标、`mc_say` 游戏内可见
2. **本地动作** — `inventory` / `scan` / `recent_chat` / `attack`
3. **移动与技能** — `move` / `follow` / `stop` / `mode`，pathfinder 寻路已验证可用
4. **WS 链路** — 本地起一个假云端（几十行 Node）验证 RPC 与重连
5. **云端插件** — 部署 `mc_bridge`，群里问"你在哪"能拿到坐标
6. **事件回路** — 游戏里说话，QQ 私聊收到；验证同一份记忆
7. **自治层** — 自动进食、卡住自救、跟随/守家循环

---

## 7. 验收清单

每一步完成后逐条打勾：

- [ ] bot 出现在游戏内，`/list` 可见
- [ ] `mc_status` 返回的坐标与游戏内一致
- [ ] `mc_say` 说的话游戏内其他玩家能看到
- [ ] `mc_scan` 输出 < 4000 字符且信息可用
- [ ] 私聊说"报下坐标"，收到正确回复
- [ ] 游戏里对 bot 说"我埋了钻石在北边云杉下"，10 分钟后私聊问，能答上来（证明记忆共享）
- [ ] 手动关掉 bot，私聊问"你在游戏里吗"，得到"身体不在"而非胡编
- [ ] 断网 30 秒后恢复，bot 自动重连
- [ ] `mc_move` 在 `features.movement:false` 时返回明确错误，而不是超时

---

## 8. 安全要求

- `runtime/viaproxy/saves.json` 含微软账号完整令牌，**不得提交到任何仓库、不得截图外传**，文件权限设为仅当前用户
- WS 建议走 SSH 本地转发，不直接暴露到公网：
  ```
  ssh -N -L 15267:127.0.0.1:5267 root@120.26.117.155
  ```
  此时 `link.url` 用 `ws://127.0.0.1:15267/...`
- `attack` 的 PVP 默认关闭，需显式开启
- 所有动作写审计日志（谁、何时、调了什么）
- 不要实现任意命令执行类工具（旧栈里的 `mc_fpp`、`mc_rcon` 不要移植）

---

## 9. 已知遗留问题

1. **adventure 模式限制**：该账号是 adventure，未获 op。走路/寻路/读方块/聊天正常，但挖掘、放置、使用物品可能受限，需以实际游戏内效果验证。若确需这些能力，请服主切成 survival。
2. **`teleportId` 解析异常**：ViaProxy 翻译后出现随机负数 id（正常应为递增小整数）。实测不影响移动，但说明翻译层在某些包上有字段错位，出现诡异问题时值得复查。
3. **物理同步延迟**：`spawn` 后约 4~6 秒 `health`/`food` 才可用，`isReady()` 需要额外判断。
4. **旧栈待下线**：`/opt/mc-body-stack`（mc-body / mc-agent / Paper FPP 插件）仍在运行，且 `mc-agent` 的 8766 端口暴露在公网（日志里已有境外 IP 扫描）。新链路稳定后应执行 `docker compose stop` 并关闭该端口映射。
5. **旧号 Hayuuka**：仍留在 ViaProxy 的 accounts 列表（索引 0），无 Grim 豁免。如需切回记得改 `minecraft-account-index`。
