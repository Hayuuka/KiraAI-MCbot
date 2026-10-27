# 交给新 codex 窗口的交接文档

> **这份文档是自包含的。** 你（codex）不需要读之前的对话，读完这份就能开工。
> 项目根目录：`D:\work\初小雪\mc`
> 工作目录：`D:\work\初小雪\mc\mc_bot`
> 最后更新：2026-10-27

---

## 〇、先看这三句

1. **这是一个 Minecraft 机器人**，用 mineflayer 跑在本机，通过云端 LLM（KiraAI）决策，用同一份人格和 QQ 记忆。
2. **项目正在从旧状态机迁移到新的行为层**，阶段 0–4 已完成，阶段 5–8 待做。
3. **`brain.shadowMode` 必须保持 `true`，直到阶段 6 完成。** 新行为层还没有接 LLM，关掉 shadow 她就失去"问模型接下来做什么"的能力。

---

# 第一部分：项目背景（新窗口必读）

## 1.1 这套东西是什么

给云端的 QQ 机器人接一个跑在本机的 Minecraft 身体。玩家在游戏里做的事、说的话，会进到同一个 QQ 会话，所以她玩 MC 时用的是同一份人格和记忆。

```
       本机 Windows                              阿里云 120.26.117.155
┌──────────────────────────────┐          ┌────────────────────────────────┐
│ ViaProxy :25568              │          │ KiraAI 容器 :5267              │
│   客户端 26.1 ←→ 服务端 26.2  │          │  └ mc_bridge 插件              │
│                              │          │      ├ GET  /poll   取任务      │
│ mc_bot (mineflayer)          │ HTTP轮询 │      ├ POST /result 回报+事件   │
│   ├ body/    新行为层         │◄────────►│      └ GET  /status            │
│   ├ tasks/   任务             │  SSH隧道 │                                │
│   ├ skills/  动作原语         │          │  LLM + 人格 + 会话记忆          │
│   └ link.js  通信             │          │                                │
└──────────────────────────────┘          └────────────────────────────────┘
```

**为什么必须走 ViaProxy**：服务器是 Paper 26.2（协议 776），mineflayer 4.39 最高只支持 26.1（协议 775）。ViaProxy 做协议翻译。**这套配置已验证可用，不要改。**

**为什么是 HTTP 轮询不是 WebSocket**：KiraAI 的插件 WS 路由全部返回 403（应用层拦截）。HTTP 轮询不需要改 KiraAI 任何代码。

## 1.2 为什么重构

旧的状态机（`autonomy.js` 1130 行 + `intent.js` 469 行）有三个根因问题：

1. **状态散落三处**（`autonomy.mode`、`intent.current`、云端记忆），靠事件同步，对不上就出 bug。
2. **触发源没有优先级**：八个地方都能直接改写 `mode`，低血切了 escape 又被 intent 改回 mine。
3. **模型意图和本地能力之间有裂缝**：模型说"挖点石头"，代码要猜是 `stone` 还是 `stone_bricks`。

实测证据（旧系统）：
- 一整晚 385 次 `mine move failed`（寻路 `canDig=false`，走不到目标）
- 服务器判定 AFK 10 次（站着不动）
- 决策链静默停摆 3 小时（5 条不带日志的 `return`）
- 睡觉 100% 崩溃（TDZ bug）
- 低血量时整个人冻结（`_checkLowHealth` 返回后直接 return，跳过了逃跑逻辑）

## 1.3 新架构的四条原则

| 原则 | 含义 |
|---|---|
| **身体自己会活** | 反射层 + 需求层在本地闭环，断网、LLM 卡住也照常玩 |
| **任务是目标不是模式** | 有明确成功/失败/进度，可暂停、可恢复、可重试 |
| **紧急情况是"打断"不是"切换"** | 危险期间冻结任务，解除后原样恢复 |
| **LLM 当导演不当操作员** | 只在需要"想"时被叫醒，拿到的是**此刻真的做得到**的选项清单 |

---

# 第二部分：当前代码状态

## 2.1 目录结构（行数为当前实际值）

```
mc_bot/
├── src/
│   ├── index.js              234   装配（旧 autonomy + 新 brain 并行）
│   ├── config.js             328   配置，DEFAULTS.brain 下有所有新参数
│   ├── connect.js            268   mineflayer 连接与重连
│   ├── link.js               299   与云端 HTTP 轮询
│   ├── events.js             179   游戏事件采集（聊天/加入/死亡/低血）
│   ├── actions.js            682   工具实现（14 个 handler）
│   ├── state.js              129   旧的状态快照
│   │
│   ├── autonomy.js          1130   ⚠ 旧状态机，阶段 8 才删
│   ├── intent.js             469   ⚠ 旧调度层，阶段 8 才删
│   │
│   ├── body/                       ← 新行为层
│   │   ├── brain.js          471   主循环：tick → 反射 → 仲裁 → 任务 → 看门狗
│   │   ├── perception.js     378   感知快照（纯数据 + deepFreeze）
│   │   ├── agenda.js         153   任务栈（push/pause/resume/freeze/thaw）
│   │   ├── arbiter.js        202   仲裁（需求 → 战斗 → 夜间 → 本地）
│   │   ├── drives.js         140   需求条（hunger/health/night）
│   │   ├── interrupts.js     363   反射（lava/low_hp/hurt/water）
│   │   └── watchdog.js        72   卡死检测
│   │
│   ├── tasks/                      ← 任务
│   │   ├── base.js           437   Task 基类 + TASK_STATE + FAILURE_REASONS
│   │   ├── index.js           98   注册表 + available()
│   │   ├── idle.js            61
│   │   ├── goto.js           171
│   │   ├── collect.js        241   collectBlock
│   │   ├── eat.js            125
│   │   ├── heal.js           116
│   │   ├── flee.js           129
│   │   ├── sleep.js          238
│   │   ├── shelter.js        210
│   │   ├── digIn.js          125   夜间最后兜底：原地挖 1 格蹲到天亮
│   │   ├── fight.js          194
│   │   ├── guard.js          129
│   │   └── assist.js         144
│   │
│   └── skills/                     ← 动作原语（纯函数，不放状态）
│       ├── index.js           33   汇总导出
│       ├── move.js           365   寻路、方块查找、方块标签表
│       ├── mine.js            90   mineBlock（挖前自动换工具）
│       ├── inventory.js      431   装备/工具/食物/丢物品（含中文别名表）
│       ├── combat.js         265   威胁评分、攻击冷却、走位
│       ├── world.js          243   安全点、平地、山壁、岩浆检测
│       ├── place.js          127   放床/方块/火把
│       ├── follow.js          80
│       └── guard.js          150   旧的单目标守卫（新代码基本不用了）
│
├── test/
│   ├── stage0.test.js        173
│   ├── stage1.test.js        323
│   ├── stage2.test.js        311
│   ├── stage3.test.js        314
│   ├── stage4.test.js        203
│   ├── stage5-fixes.test.js  435   最近一次修复的测试
│   └── manual/day-soak.js    201   假世界 60 秒 soak（不进 npm test）
│
└── package.json               scripts.test = "node --test"
```

**当前测试状态：46 个，全部通过。**

## 2.2 已完成的部分

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 五个止血 bug（低血冻结、睡觉 TDZ、allowed 数组、收工原因、intent 看门狗） | ✅ |
| 0.5 | `skills/inventory.js` + `mc_drop` / `mc_equip` / `mc_unequip` 三个工具 | ✅ |
| 1 | `body/` + `tasks/` 骨架，shadow 模式并行 | ✅ |
| 2 | 反射层（lava/low_hp/hurt/water）+ 需求条 + 看门狗 | ✅ |
| 3 | 生存任务（eat/heal/flee/sleep/shelter/digIn） | ✅ |
| 4 | 战斗（威胁评分/攻击冷却/走位/fight/guard/assist） | ✅ |
| 4 修复 | 需求抢占、lease、战斗决策、digIn、计时冻结、水平寻路 | ✅ 已验证 |
| 4 收尾 | digIn 与看门狗冲突、日志洪水 | ❌ **你要做的第一件事** |
| 5 | 挖掘与寻路（digDown/mineOre/火把） | ❌ 待做 |
| 6 | LLM 契约（mind.js/mc_do/can 清单） | ❌ 待做 |
| 7 | 项目、日记、空闲动作、模板台词 | ❌ 待做 |
| 8 | 删除旧状态机 | ❌ 待做 |

## 2.3 每次开工前必须做的事

```bash
cd D:\work\初小雪\mc\mc_bot
npm test          # 应该 46 个全过，先确认基线
```

如果基线不过，**先停下来报告**，不要开始改。

---

# 第三部分：你必须遵守的代码契约

## 3.1 Task 基类的接口

新任务继承 `tasks/base.js` 的 `Task`。以下是可覆写的方法和它们的语义：

```js
class MyTask extends Task {
  // 1. 静态：能否做（现在是模型能力的唯一来源）
  static feasible(ctx) {
    // 返回 null = 现在做不到
    // 返回 { args, etaSec, note } = 可以做，args 是默认参数
  }

  // 2. 参数归一化（可选）
  static normalizeArgs(args) { return {...} }

  // 3. 准备：换装备、记录基线。返回 false 表示失败
  //    可以返回 Promise，会走 pending 轮询
  prepare(ctx) {}

  // 4. 执行一个时间片。必须尽快返回（<50ms）
  //    耗时操作用 this.runPending(label, factory, meta)
  _tick(ctx) {}

  // 5. 成功判定——必须来自世界状态
  isDone(ctx) {}

  // 6. 失败判定——必须返回 FAILURE_REASONS 里的枚举
  isFailed(ctx) {}

  // 7. 进度指标——必须单调递增，供看门狗判断卡死
  progressMetric(ctx) {}

  // 8. 异步动作完成/失败回调
  onPendingSuccess(ctx, result, label, meta) {}
  onPendingError(ctx, error, label, meta) {}

  // 9. 收尾
  onFinish(ctx) {}

  // 10. 被反射打断/恢复
  onResume(ctx) {}

  // 11. 【阶段 4 收尾要加】主动静默时返回 true，看门狗会跳过
  //     目前 digIn 已实现；guard / assist 尚无，阶段 5 视情况补
  expectsQuiet(ctx) { return false; }

  // 12. 【可选】看门狗发现卡住时尝试自救，返回 true 表示救回来了
  recover(ctx) {}
}

// 静态字段用赋值式（不是 class 体内 static 语法）：
MyTask.kind = 'myTask';
MyTask.priority = 50;
MyTask.selfTimed = true;    // 有自己时长上限的任务，不吃 120 秒 lease
```

## 3.2 ctx 的结构

每个 tick 由 `brain._context()` 生成，传给所有任务方法：

```js
{
  now,                 // 注入时钟（测试用假时钟）
  bot,                 // mineflayer bot 对象
  perception,          // 见 3.3
  shadow,              // true = 只记录不执行
  config,              // config.brain
  agenda,              // 任务栈
  tasks,               // 任务注册表
  drives,              // 需求条
  watchdog,
  lastHurtAt,          // 最近被伤害的时间戳
  hurtSourceId,
  record(event, payload),  // 记日志
}
```

## 3.3 perception 的结构

```js
{
  t, ready,
  self: {
    pos: {x,y,z}, dim, hp, food, saturation,
    onGround, inWater, inLava, isSleeping, y, light,
    velocity, held, armor (护甲点数), effects: []
  },
  world: {
    timeOfDay, isDay, ticksToDusk, ticksToDawn,
    weather, underground (头顶 8 格有实体方块), biome,
    light
  },
  threats: [{
    id, type, dist, position,
    threat,           // 威胁分（combat.threatScore 算的）
    canWin,           // threat <= myPower
    hp, aggressive, lineOfSight
  }],
  myPower,            // 按背包最优武器算的战斗力
  nearby: { players: [], animals: [], items: [] },
  inventory: {
    counts: { itemName: count },
    freeSlots,        // 可能为 null
    armor             // 护甲点数
  }
}
```

**注意**：`perception` 是 `deepFreeze` 过的，任务不能改它。

## 3.4 关键常量

```js
// tasks/base.js
TASK_STATE = { PENDING, RUNNING, FROZEN, PAUSED, DONE, FAILED }

// 共 25 个，按字母序（实际使用时用 FAILURE_REASONS.XXX）
FAILURE_REASONS = {
  CANCELLED, CONSUME_FAILED, CONTROL_FAILED, DIG_FAILED,
  INTERNAL_ERROR, INVALID_ARGS, LEASE_EXPIRED, MINE_FAILED,
  NO_BED, NO_FOOD, NO_PROGRESS, NO_SAFE_SPOT, NO_SHELTER_MATERIAL,
  NO_SOLID_GROUND, NO_TARGET, PATH_UNREACHABLE, PLACE_FAILED,
  PLAYER_UNAVAILABLE, PREPARE_FAILED, SILENT_TIMEOUT, SLEEP_REJECTED,
  STACK_OVERFLOW, THREAT_TOO_HIGH, TIMEOUT, TOOL_UNAVAILABLE,
}
```

**新增失败原因时**：在 `FAILURE_REASONS` 里加一个枚举值，
`FAILURE_REASON_VALUES` 会自动包含它（`fail()` 里有白名单校验，
传了不在表里的字符串会被降级成 `INTERNAL_ERROR`）。

## 3.5 优先级表（当前生效的值）

| 优先级 | 来源 | 谁会派 |
|---:|---|---|
| 100 | lava 反射 | interrupts（不占栈） |
| 90 | low_hp 反射 | interrupts（不占栈） |
| 85 | hurt 反射 | interrupts（不占栈） |
| 75 | water 反射 | interrupts（不占栈） |
| 70 | flee | arbiter（打不过时） |
| 60 | sleep | arbiter（night drive） |
| 59 | shelter | arbiter（night drive） |
| 58 | digIn / heal | arbiter |
| 55 | eat | arbiter（hunger drive） |
| 50 | fight / guard / assist | arbiter |
| 45 | （阶段 5 的 digDown / mineOre 放这里） | — |
| 40 | collectBlock | arbiter |
| 30 | goto（闲逛） | arbiter |
| 10 | idle | arbiter |

**抢占规则**：`_arbitrate` 每 500ms 跑一次，只有 `choice.priority > top.priority` 才会入栈，旧的 top 被 `pause()`。任务结束后自动 `resume()` 下层。

## 3.6 铁律（违反会被打回）

1. **不要关 `brain.shadowMode`**（阶段 6 完成前）。
2. **不许新增"当前在做什么"的状态字段**，只能从 `agenda.top()` 读。
3. **任务成功判定必须来自世界状态**（背包增量/坐标/方块/`bot.isSleeping`），不能只看函数没报错。
4. **不许用字符串匹配错误信息做分支**，失败原因一律用 `FAILURE_REASONS` 枚举。
5. **不许 `setInterval` 里 await**，异步操作走 `runPending`，在 tick 里轮询。
6. **不许在 `interrupts` 里改任务状态**，只能 freeze/thaw。
7. **每个任务必须配单元测试**，用 fake bot（参考 `test/stage4.test.js` 的 `makeBot`）。
8. **不想清楚就不要动 `autonomy.js` / `intent.js`**，那是阶段 8 才删的。

---

# 第四部分：你要做的工作

分三次提交，**一次只做一份，做完停下等验收**。

---

## 任务 A：阶段 4 收尾（半天）

### A1. `digIn` 与看门狗的死循环【P0】

**现象**：夜晚、地表、无床、无方块、无山壁（最普通开局）。实测 60 秒派发序列：

```
digIn -> [watchdog回收] -> digIn -> [watchdog回收] -> digIn
```

每 20 秒一轮，整夜反复挖坑。

**原因链**：

```
digIn._tick: dugOnce = true 之后什么都不做（正确，就是蹲到天亮）
    ↓
progressMetric() 恒返回 1（不再变化）
    ↓
Task._updateProgress: 指标不变 → _lastProgressAt 不更新
    ↓
progressStaleSec(ctx) 持续增长
    ↓
watchdog.check: 超过 stuckProgressSec = 20 秒 → recoverStuck()
    ↓
DigInTask 没有 recover() → 直接 dropTop(NO_PROGRESS)
    ↓
下一轮仲裁：栈空 + 夜晚 + 无床 → 又选中 digIn
```

**这是设计冲突**：看门狗认为"进度不动 = 卡住"，但 digIn 的语义是"挖完就该静默到天亮"。

**改法**：

a) `tasks/base.js` 给 Task 加：

```js
// 任务主动选择静默时返回 true，看门狗会跳过它
expectsQuiet() { return false; }
```

b) `tasks/digIn.js` 覆写：

```js
expectsQuiet(ctx) {
  return this.dugOnce && !this.isDone(ctx);
}
```

c) `body/watchdog.js` 的 `check()`，在 `isSleeping` 判断之后加：

```js
if (typeof top.expectsQuiet === 'function' && top.expectsQuiet(ctx)) return false;
```

**为什么选这个方案**（不要用别的）：这是唯一能区分"我主动选择静默"和"我卡住了"的做法。阶段 5 的 `guard`（守着不动）、`assist`（跟着主人但长时间无位移）都会用到。

**验收测试**：

```
「digIn 躲好后不会被看门狗回收」
  - 建 digIn，跑真实 prepare，然后 dugOnce = true
  - 用注入时钟推进 60 秒，每 100ms 调 agenda.tick + watchdog.check
  - 断言 agenda.size 始终为 1，top 仍是原 digIn
  - 断言没有 stuck_recovery 事件

「digIn 挖之前仍然会被看门狗管」
  - dugOnce = false 时，进度 45 秒不动
  - 断言被回收（保证 expectsQuiet 不是无条件放行）
```

### A2. `preempt_rejected` 日志洪水【P1】

**现象**：`_arbitrate` 每 500ms 跑一次，栈顶是 collectBlock(40) 时，本地仲裁仍算出 collectBlock(40)，被 `priority <=` 拒掉，每条都记日志。实测 **60 秒 117 条，每小时约 7000 条**。

**改法**（`body/brain.js` 的 `_arbitrate`）：

```js
if (top && choice.priority <= top.priority) {
  // 同类同优先级的重复选择是正常的，不记
  if (choice.kind !== top.kind) {
    this._record('preempt_rejected', {...});
  }
  return null;
}
```

再加节流：同一对 `(from.kind, to.kind)` 30 秒内只记一次。构造函数里加 `this._lastRejectAt = new Map();`，key 用 `${top.kind}>${choice.kind}`。

**验收测试**：

```
「重复的同类仲裁不会刷日志」
  - 栈顶 collectBlock(40)，连续调 _arbitrate 100 次
  - 断言 preempt_rejected 事件数 <= 1

「不同类的高优先级抢占仍会记录」
  - 栈顶 goto(30)，饥饿触发 eat(55)
  - 断言有一条 preempt 事件，eat 成为栈顶
```

### A3. 两处小修

**a) `test/manual/day-soak.js` 的 fake pathfinder 失真**

现在 `setGoal` 里直接改 position（瞬移），导致 60 秒跑出 66 个 goto，数字完全不可信。

改成：每 tick 朝目标移动 0.5 格，距离 <= 1 时才算到达。

**b) `arbiter._chooseLocal` 低血 reason 改名**

`'low_hp'` → `'low_hp_waiting_regen'`，并在 perception 里带上 food，日志里能看出"她在等回血"。

### A4. 验收

- `npm test` 全过（46 + 新增 4 = 50）
- `node test/manual/day-soak.js` 跑 60 秒，贴出完整 SUMMARY
- 确认 SUMMARY 里 goto 数量合理（不是 66 个），collectBlock 和 fight 各至少一次
- **做完停下，不要开始阶段 5**

---

## 任务 B：阶段 5 挖掘与寻路（1–2 天）

> 这是整个重构里最危险的一阶段——挖错方向会掉岩浆、会被埋、会迷路。

### B0. 本阶段的额外铁律

- **永远不禁用 `neverDigDown`**（脚下那一格只有 `digIn` 里可以挖）。
- **任何"往下"的动作都必须是阶梯式或先探测。**
- 每一格挖掘后都要检查：脚下是不是空的、旁边有没有岩浆。
- 新任务都要标 `selfTimed = true`，需要静默时实现 `expectsQuiet()`。

### B1. 寻路支持挖路【这是 385 次移动失败的根因】

**现状**：`skills/move.js:261` 写死 `movements.canDig = false`，寻路连一格土都挖不开。目标在树后、坡上、水对岸时就走不到。旧日志里 385 次 `mine move failed`。

**改法**：

a) `skills/move.js` 的 `ensureMovements(bot, options)` 增加参数：

```js
{ canDig = false, digCost = 30, allow1by1towers = false }
```

用缓存 key 区分不同配置（不要全局只有一个 `_mcMovements`）：

```js
bot._mcMovementsMap = new Map();
key = `dig:${canDig}:cost:${digCost}`;
```

默认调用仍然是 `canDig = false`（保持现有行为不变）。

b) `moveTo(bot, target, options)` 增加 `options.canDig` 透传给 `ensureMovements`。只有挖矿相关任务才传 `true`。

c) 安全性：`canDig = true` 时
- `movements.dontMineUnderFallingBlock = true`（保持默认）
- `movements.allow1by1towers = false`（禁止搭柱子，避免被自己困住）
- `movements.dontCreateFlow = true`（保持默认，不要挖穿水/岩浆）

**验收测试**：

```
「默认寻路不挖方块」
「挖矿寻路允许挖方块且禁止搭柱」
```

### B2. 新增 `skills/mining.js`（挖掘原语）

不要把这些塞进 `move.js` 或 `mine.js`，单独一个文件。

```js
// a) 往下探测
probeBelow(bot, position, depth = 4)
  -> { ok, hazard, blockName }
  // 逐格检查，返回遇到的第一个危险：
  //   lava/flowing_lava  -> 'lava'
  //   water/flowing_water -> 'water'
  //   连续 3 格以上空气    -> 'fall'
  //   bedrock             -> 'bedrock'

// b) 安全挖掘
async digBlockSafely(bot, block, options)
  -> { ok, error?, hazard? }
  // 挖之前 probeBelow 目标下方；hazard 是 lava/fall 且目标就是脚下，拒绝
  // 挖完复查方块真的消失了

// c) 需要时放火把
async placeTorchIfDark(bot, options)
  -> { ok, placed }
  // 读 bot.blockAt(pos).light，< 8 且背包有火把就放
```

**验收测试**（fake bot）：
```
「probeBelow 识别脚下岩浆」
「probeBelow 识别连续空气（坠落风险）」
「digBlockSafely 拒绝挖穿岩浆上方的方块」
```

### B3. 新增 `tasks/digDown.js`（阶梯下降）

```
kind = 'digDown'，priority = 45，selfTimed = true
参数：{ depth: 10 }
```

算法（**阶梯式，绝不能垂直挖**）：

1. 选一个水平方向 `dir`（优先朝开阔处）
2. 挖掉 `(x+dx, y, z+dz)` 的方块，走进去
3. 挖掉 `(x+dx, y-1, z+dz)`，现在站在低一格
4. 每下降 5 格：`placeTorchIfDark`
5. 每次下降前 `probeBelow` 检查下一格，有 lava 就换方向
6. 连续 3 次换方向都失败 → `DIG_FAILED`

```
isDone: startY - currentY >= depth
isFailed: 超时（默认 5 分钟）/ 尝试次数用尽
progressMetric: startY - currentY
```

**验收测试**：
```
「digDown 每下降 5 格放一次火把」
「digDown 遇到岩浆会换方向而不是继续挖」
「digDown 到达目标深度后完成」
```

### B4. 新增 `tasks/mineOre.js`

```
kind = 'mineOre'，priority = 45，selfTimed = true
参数：{ ore: 'iron_ore', count: 8, searchRadius: 32, maxMinutes: 8 }
```

**推荐先做简化版**，不要复制 `collectBlock` 的全部逻辑：

```
mineOre = collectBlock 的骨架 + 火把 + 委托 digDown
```

具体：
1. `prepare` 里 `equipBestTool`（collectBlock 已有）
2. 每次移动前 `placeTorchIfDark`
3. 如果目标矿在 y 低于当前位置 5 格以上 → **先派一个 digDown 任务下去**，再继续找
   **不要在 mineOre 里自己实现下挖**，复用 digDown。

**验收测试**：
```
「mineOre 在没有目标矿时返回 no_target 而不是卡住」
「mineOre 在暗处会放火把」
```

### B5. 接入仲裁器

`arbiter._chooseLocal` 里加规则（在 collectBlock 之后、goto 之前）：

```
- if (!day)                    走夜间分支（已有）
- if (附近有威胁)               走战斗/撤离（已有）
- if (无石镐及以上 && 附近有石头)  collectBlock '#minecraft:stone'
- if (有石镐 && 无铁锭 && y >= 60) mineOre iron_ore
- if (背包空槽 >= 30 && 白天)     digDown depth 10
- 否则                          collectBlock / goto
```

**不要做"完整的资源规划"**（什么先挖什么后挖）。那是阶段 7 的 projects 干的事。阶段 5 只要让她能挖、能下、能保命。

### B6. 验收

- `npm test` 全过
- 新增 `test/manual/mining-soak.js`：
  - 假世界 y=64 是草地，y=40 以下有铁矿
  - **在 y=50 放一层岩浆做陷阱**
  - 跑 180 秒模拟时间，确认：
    a) 她确实开始 digDown
    b) 每 5 格放了一次火把
    c) **从未挖穿过岩浆**
- 贴出完整 SUMMARY
- **做完停下，不要开始阶段 6**

---

## 任务 C：阶段 6–8（3–4 天）

> 这一阶段的核心：让新行为层接回 LLM，但只把"想"的部分交出去。

### C0. 本阶段的额外铁律

- **这是第一次允许把 `shadowMode` 改成 false**，但必须满足：
  - a) `mind.js` 完成且测试通过
  - b) 有一条"LLM 不可达时本地继续玩"的自动化测试
  - c) 关 shadow 是**配置项**，不是在代码里写死
- 不要删 `autonomy.js` / `intent.js`，那是阶段 8 的最后一个 commit。
- 所有给模型的能力必须来自 `tasks.available()`，**不许在提示词里手写能力清单**。

### C1. 新增 `body/mind.js`（LLM 网关）— 阶段 6 核心

状态机（只有四个状态）：

```
IDLE      -- 不需要模型
ASKING    -- 已经发出请求，等待回复
PENDING   -- 模型回了，本地正在校验/执行
COOLDOWN  -- 刚问过，冷却中
```

关键方法：

```js
maybeAsk(ctx) -> void
  // 触发条件（满足任一，且不在冷却）：
  //   - 任务栈空 且 本地没有可做的事（arbiter 返回 idle 且 reason 不是 low_hp*）
  //   - 同一任务连续失败 2 次
  //   - 用户点名 / 死亡 / 被踢（事件驱动，不走这里）
  //   - 距上次对话超过 10 分钟（社交需求）
  // 节流：最多 12 次/小时（本地计数，云端已有 30 次/小时做二道防线）

buildSituation(ctx) -> object        // 见 C2

async ask(situation) -> { do, args, say } | null
  // 通过 link.sendEvent({ kind: 'intent', data: situation })
  // 超时 20 秒（不是旧代码的 90 秒）
  // 超时返回 null，由调用方降级到本地默认

validate(do_, args, ctx) -> { ok, task?, error?, alternatives? }
  // 1. tasks.get(do_) 不存在 -> { ok:false, error:'unknown_do', alternatives: kinds() }
  // 2. TaskClass.feasible({...ctx, args}) 返回 null
  //    -> { ok:false, error:'not_feasible', alternatives }
  // 3. args 校验失败 -> 返回修正建议（例如 stone_bricks -> #stone）
  // 全部通过才 create 任务

onReply(do_, args) -> void
  // 由 actions.js 的 mc_do 调用，内部走 validate 再 agenda.push
  // 注意：source 必须是 'mind'，不是 'user'，避免被当成人工指令
```

**验收测试**（用 fake link，不连真服务器）：
```
「mind 在栈空时发出 intent」
「mind 20 秒无回复时降级到本地默认」
「mind 在 12 次/小时后停止发问」
「validate 拒绝不存在的任务名并返回 alternatives」
「validate 拒绝 feasible 为 false 的任务」
「mc_do 下发的任务 source 是 mind 不是 user」
```

### C2. 处境快照 `buildSituation`

输出给模型的结构，必须紧凑（≤ 400 token）且**只包含它能用的东西**：

```json
{
  "hp": 14, "food": 17, "pos": [120, 64, -35], "dim": "overworld",
  "time": "night", "ticksToDawn": 7200, "light": 4, "underground": false,
  "threats": [{"type":"zombie","dist":9}],
  "doing": {"kind":"collectBlock","progress":"12/16"},
  "lastResult": {"kind":"collectBlock","outcome":"failed","reason":"no_target"},
  "project": null,
  "can": [
    {"do":"sleep","note":"背包里有红床","eta":40},
    {"do":"shelter","note":"背靠山壁，可以挖洞过夜","eta":30},
    {"do":"collectBlock","args":{"selector":"#logs","count":16},"eta":180},
    {"do":"goto","args":{"x":90,"z":-20},"eta":30},
    {"do":"idle","eta":0}
  ]
}
```

> ⚠ **目前没有 `explore` 任务。** 阶段 6 生成 `can` 时，条目必须全部来自
> `tasks.available()` 的真实返回值。当前注册的任务只有：
> `idle, goto, collectBlock, eat, heal, flee, sleep, shelter, fight, guard, assist, digIn`
> （阶段 5 会再加 `digDown` / `mineOre`）。
> 上面的示例只是格式示意，不要照抄里面的任务名。

**`can` 的生成规则**（这是整个重构最关键的一个契约）：
- 调 `tasks.available(ctx, defaults)`
- 只保留 `feasible` 非 null 的
- 按 priority 降序，最多 6 条
- 每条带一句人类可读的 `note`（来自各任务的 `feasible().note`）

**模型看到的能力 = 本地真的能做的事。做不到的事不会出现在它眼前。**

### C3. 云端工具改造

文件：`D:\work\初小雪\mc\kira_bridge\mc_bridge\main.py`

新增两个工具：

```python
@register.tool("mc_body", "查看我现在的完整状态：在做什么、还能做什么、为什么不做事", ...)
  # 返回 brain.snapshot() 的精简版

@register.tool("mc_do", "让我做一件具体的事。只能做 mc_body 的 can 列表里列出的事。", ...)
  # 参数：{ do: string, args?: object, say?: string }
  # 成功 { ok:true, started:true, do, eta }
  # 失败 { ok:false, error, alternatives: [...] }
  # error 类型：unknown_do / not_feasible / invalid_args / busy
```

保留 `mc_say` / `mc_stop` / `mc_scan` / `mc_inventory` / `mc_recent_chat`。

`mc_mode` / `mc_plan` / `mc_move` / `mc_follow` / `mc_attack` 标 deprecated：内部转成 `mc_do` 的等价调用，描述里注明"建议改用 mc_do"。

本地 `actions.js` 加 handler：
```js
body    -> brain.snapshot() 精简版
doTask  -> mind.onReply(do, args)
```
工具名去掉 `mc_` 前缀转驼峰，沿用现有 `normalizeToolName` 规则。

### C4. 事件分级补充

`main.py` 现有逻辑保留，加两条：

a) 任务失败连续 2 次 → 唤醒模型，带失败原因
   （身体侧在 brain 里检测，通过 `link.sendEvent` 推 `kind: 'task_failed'`）
b) LLM 不可达时不推事件，只在本地记录
   （现在 `_wake` 里有 `is_connected` 判断，确认它覆盖了 `task_failed`）

### C5. 关闭 shadow 的前提

必须全部满足：
- a) `npm test` 全过，包含上面 mind 的 6 个测试
- b) 有一条集成测试：link 断开时，brain 继续跑本地任务 5 分钟，
     且没有 empty agenda 超过 60 秒
- c) 手动跑过 `day-soak` 和 `mining-soak` 都正常

做法：`config.json` 里加 `"brain": { "shadowMode": false }`，代码里不要有"默认 false"的兜底。

**关之前先跑一次 shadow 对比**：日志里 `shadow_decision` 和 `local_decision` 应该在 90% 以上一致（`stage1Equivalent` 字段已经在记了）。

### C6. 阶段 7：项目与人格

（可以单独一次提交，与阶段 6 解耦）

**a) `mc_bot/data/projects.json`**

```json
{
  "active": {
    "id": "cabin",
    "title": "在出生点东边盖个小木屋",
    "steps": [
      {"task":{"do":"collectBlock","args":{"selector":"#logs","count":32}}, "done":true},
      {"task":{"do":"craft","args":{"item":"oak_planks","count":64}}, "done":false},
      {"task":{"do":"build","args":{"blueprint":"small_cabin","at":[110,64,-40]}}, "done":false}
    ]
  },
  "backlog": [{"title":"弄一套铁甲","note":"需要铁 24 个"}]
}
```

新增 `tasks/build.js`（第一版只支持"放方块搭一个 3×3×3 盒子"）
新增 `tasks/craft.js`（只支持简单配方：木板、木棍、工作台、火把、箱子）

**b) `mc_bot/data/diary.jsonl`**

每行：`{ ts, goal, outcome, reason, durationSec, deaths }`
在 `brain._onAgendaEvent` 的 `agenda_settle` 里写。

**c) 空闲动作（`body/human.js`）—— 优先级很高**

- 动作前 80–220ms 随机延迟
- 转头用插值（每 tick ≤ 25 度，不要瞬移视角）
- `idle` 时每 3–6 秒环顾，每 20–40 秒做一个小动作（跳一下/蹲一下/挥空/走到旁边再回来）

**这是"不再像雕像"的直接来源。如果时间紧，它的优先级高于项目系统和台词。**

**d) 模板台词（不经过 LLM）**

天亮 / 找到矿 / 被打 / 逃离成功 / 要睡了
通过 `eventHub.report('chat')` + `bot.chat` 发，每次至少 60 秒冷却。

### C7. 阶段 8：清理

**最后一个 commit 才做**：

- 删除 `src/autonomy.js`、`src/intent.js`
- 删除 `index.js` 里的 legacy 装配和 `setMode` 包装
- 删除 `stage0.test.js` 里针对旧代码的部分
- 保留 `stage1`–`stage5` 的所有测试
- `config.js` 里删掉旧 autonomy 用的配置项

**删之前先跑 24 小时 soak**：
- 死亡 ≤ 4 次
- 没有超过 5 分钟的 agenda 空转
- `brain.jsonl` 能完整复盘

### C8. 验收

| 阶段 | 验收标准 |
|---|---|
| 6 | `npm test` 全过 + 集成测试（断网 5 分钟继续玩）+ 手动 `mc_do` 三种场景 |
| 7 | 项目能跨会话继续、空闲时有动作、模板台词不刷屏 |
| 8 | 24 小时 soak 通过 + 删除旧代码后测试仍全过 |

---

# 第五部分：环境与坑

## 5.1 环境信息

```
MC 服务器    mc.catnest.fun:25565
版本         Paper 26.2（协议 776）
模式         正版（online-mode），装了 Grim 反作弊
反作弊       账号 ChuXiaoxue 已获豁免
云端         root@120.26.117.155
账号         ChuXiaoxue（UUID c4deff35-d924-4f6b-ad13-735267677162）
令牌位置     runtime/viaproxy/saves.json（⚠ 可直接登录，切勿外传）
```

## 5.2 必须知道的坑（实测踩出来的）

**ViaProxy**
1. CLI 参数 `--auth-method ACCOUNT` **不生效**，必须 `java -jar ViaProxy.jar config viaproxy.yml`
2. **必须 `fake-accept-resource-packs: true`**，否则 mineflayer 永远卡在 configuration 状态
3. Java 读不了中文绝对路径的 jar，`cwd` 必须是 jar 所在目录且只传相对文件名

**游戏**
4. `bot.dig()` 在 adventure 模式返回成功但方块没破，要用 `blockAt()` 复查
5. `spawn` 后约 4 秒 `health`/`food` 才有效
6. 同一账号不能同时在官方客户端和 bot 上线，会互相踢
7. **深水里 pathfinder 会原地挣扎**（`isMoving()` 恒真但坐标不动）
8. `findNearestBlock` 每轮返回同一块，挖不动会无限重试

**mineflayer API（已核实 4.39.0）**
9. `bot.equip(item, 'head'|'torso'|'legs'|'feet'|'hand')`，护甲槽位 head=5 torso=6 legs=7 feet=8
10. `bot.toss(itemType, metadata, count)` / `bot.tossStack(item)`
11. `bot.sleep(bed)` **内部自己处理床的两格头尾**，传任意一半即可
12. `bot.dig()` **不会自动换工具**，必须先 `equipBestTool`
13. `goals.GoalXZ(x, z)` 存在（用于水平寻路），`goals.GoalNear(x,y,z,range)` 是 3D 的
14. `Movements` 默认 `canDig = true`，项目里显式设成了 `false`
15. `entityHurt` 事件的第二个参数就是攻击者（`damage_event.sourceCauseId`）

## 5.3 启动方式

```bash
cd D:\work\初小雪\mc
node start-all.js        # 或双击 启动.bat
```

三个进程：ViaProxy → SSH 隧道 → mc_bot。Ctrl-C 一起停。

## 5.4 日志

| 文件 | 内容 |
|---|---|
| `mc_bot/logs/brain-shadow.jsonl` | 新行为层的决策脉络（JSON 每行一条） |
| `mc_bot/logs/decisions.log` | 旧调度层的决策 |
| `mc_bot/logs/audit.log` | 每次工具调用 |

新行为层的事件类型：`brain_start` / `local_decision` / `shadow_decision` /
`preempt` / `preempt_rejected` / `interrupt_active` / `interrupt_clear` /
`task_done` / `task_failed` / `agenda_push` / `agenda_settle` /
`stuck_recovery` / `brain_error`。

---

# 第六部分：怎么判断自己做对了

## 6.1 每个任务的 checklist

- [ ] `npm test` 全过，新增测试覆盖了你改的东西
- [ ] 新任务的 `isDone` / `isFailed` 来自世界状态，不是"函数没报错"
- [ ] 新任务的 `progressMetric` 单调
- [ ] 如果任务会主动静默，实现了 `expectsQuiet()`
- [ ] 新任务标了 `selfTimed`（如果它有自己时长上限）
- [ ] shadow 模式下不发出任何游戏动作（`ctx.shadow` 判断）
- [ ] 失败原因用 `FAILURE_REASONS` 枚举，不是字符串

## 6.2 判断"她是不是又在发呆"

跑 `node test/manual/day-soak.js`，看 SUMMARY：
- `seenKinds` 里至少要有两类不同任务
- 不能出现同一种任务连续派发几十次
- `recordEvents` 里不应该全是 `preempt_rejected`

## 6.3 拿不准的时候

**不要自己发明新架构。** 停下来，把问题写清楚，交给维护者判断。

这个项目已经因为"在一个错误的分层上不断打补丁"失败过一次。
宁可少做一件事，也不要加一层新的状态。

---

# 附：参考文档（维护者手里有，你不需要读）

| 文档 | 内容 |
|---|---|
| `真人化重构方案.md` | 完整架构设计，1250 行 |
| `能力清单与指令支持.md` | 能力边界与具体实现 |
| `审查报告-阶段0至4.md` | 上一次审查 |
| `审查报告-阶段4修复.md` | 最近一次审查（digIn 死循环就是这里发现的） |

如果你需要理解某个设计的"为什么"，并且能在项目根目录读到这些文件，可以查。
但它们比这份文档长得多，**优先看这份**。
