# 给 codex 的提示词：阶段 4 收尾修复 + 阶段 5–8

分三份，按顺序交给 codex。**一次只交一份，上一份验收通过再交下一份。**

| 文件 | 内容 | 工程量 |
|---|---|---|
| **A. 阶段 4 收尾** | 修 digIn 死循环、日志洪水，把阶段 4 真正做完 | 半天 |
| **B. 阶段 5** | 挖掘与寻路：digDown / digTunnel / mineOre / 火把 | 1–2 天 |
| **C. 阶段 6–8** | LLM 契约（mind.js / mc_do / can 清单）、项目与人格、清理旧状态机 | 3–4 天 |

---

# A. 阶段 4 收尾（先交这份）

```
项目根目录：D:\work\初小雪\mc
先读：审查报告-阶段4修复.md

阶段 0–4 的 6 项修复都做对了，46 个测试全过。但实测发现两个必须修的问题，
修完才算阶段 4 真正完成。

============================================================
1. digIn 与看门狗的死循环（报告 §1，P0）
============================================================
现象：夜晚无床无方块无山壁时，实测 60 秒序列：
    digIn -> [watchdog回收] -> digIn -> [watchdog回收] -> digIn
每 20 秒一轮，整夜反复挖坑。

原因：digIn 挖完后 dugOnce=true，progressMetric 恒为 1 不再变化，
      progressStaleSec 涨到 20 秒，看门狗判定"卡住"并 dropTop，
      下一轮仲裁又选中 digIn。

这是设计冲突，不是实现 bug：看门狗认为"进度不动=卡住"，
但 digIn 的语义恰恰是"挖完就该什么都不做，等到天亮"。

修法（用 A 方案，不要用 B/C）：
a) tasks/base.js 给 Task 加：
       // 任务主动选择静默时返回 true，看门狗会跳过它
       expectsQuiet() { return false; }

b) tasks/digIn.js 覆写：
       expectsQuiet(ctx) {
         return this.dugOnce && !this.isDone(ctx);
       }

c) body/watchdog.js 的 check() 里，在取到 top 之后加：
       if (typeof top.expectsQuiet === 'function' && top.expectsQuiet(ctx)) return false;
   位置：在 isSleeping 判断之后、progressStaleSec 判断之前。

d) 顺便确认阶段 5 会用到这个机制：
   guard（守着不动）、assist（跟着主人但可能长时间无位移）
   都应该在合适的时候返回 expectsQuiet() === true。
   现在先把方法留给它们，实际覆写放到阶段 5。

验收测试（加进 test/stage5-fixes.test.js 或新建 stage4-final.test.js）：
  「digIn 躲好后不会被看门狗回收」
    - 建 digIn，跑真实 prepare，然后让 dugOnce = true
    - 用注入时钟推进 60 秒，每 100ms 调 agenda.tick + watchdog.check
    - 断言 agenda.size 始终为 1，top 仍是原 digIn
    - 断言没有 stuck_recovery 事件
  「digIn 挖之前仍然会被看门狗管」
    - dugOnce = false 时，进度 45 秒不动
    - 断言被回收（这条保证 expectsQuiet 不是无条件放行）

============================================================
2. preempt_rejected 日志洪水（报告 §2，P1）
============================================================
现象：_arbitrate 每 500ms 跑一次，栈顶是 collectBlock(40) 时，
_chooseLocal 仍算出 collectBlock(40)，被 priority <= 拒掉，每条都记日志。
实测 60 秒 117 条 => 每小时约 7000 条。

修法（brain.js _arbitrate）：
a) 同类同优先级的重复选择不记：
       if (top && choice.priority <= top.priority) {
         if (choice.kind !== top.kind) {
           this._record('preempt_rejected', {...});
         }
         return null;
       }

b) 再加节流：同一对 (from.kind, to.kind) 30 秒内只记一次。
   构造函数里加 this._lastRejectAt = new Map();
   用 `${top.kind}>${choice.kind}` 做 key。

验收测试：
  「重复的同类仲裁不会刷日志」
    - 栈顶 collectBlock(40)，连续调 _arbitrate 100 次
    - 断言 preempt_rejected 事件数 <= 1
  「不同类的高优先级抢占仍会记录」
    - 栈顶 goto(30)，饥饿触发 eat(55)
    - 断言有一条 preempt 事件，eat 成为栈顶

============================================================
3. 顺带两处小修（报告 §3.3、§4）
============================================================
a) test/manual/day-soak.js 的 fake pathfinder 现在一设目标就瞬移
   （setGoal 里直接改 position），导致 60 秒跑出 66 个 goto，数字完全失真。
   改成：每 tick 朝目标移动 0.5 格，距离 <= 1 时才算到达。
   这样 soak 的 collectBlock / fight / goto 数字才有参考价值。

b) arbiter._chooseLocal 里低血返回 idle 时，reason 从 'low_hp' 改成
   'low_hp_waiting_regen'，并在 perception 里带上 food，
   日志里能看出"她在等回血"。

============================================================
4. 验收
============================================================
- npm test 全过（现有 46 + 新增 4 = 50）
- node test/manual/day-soak.js 跑 60 秒，贴出完整 SUMMARY
- 确认 SUMMARY 里 goto 数量合理（不是 66 个），collectBlock 和 fight 各至少一次
- 做完停下，不要开始阶段 5。
```

---

# B. 阶段 5：挖掘与寻路

```
项目根目录：D:\work\初小雪\mc
阶段 4 已完成并验收。

目标：让她能真的挖下去、挖到矿、并在过程中保命。
这是整个重构里最危险的一阶段——挖错方向会掉岩浆、会被埋、会迷路。

============================================================
0. 铁律
============================================================
- 永远不禁用 neverDigDown（脚下那一格只有在 digIn 里可以挖）。
- 任何"往下"的动作都必须是阶梯式或先探测。
- 每一格挖掘后都要检查：脚下是不是空的、旁边有没有岩浆。
- shadowMode 仍然保持 true。阶段 6 才关。
- 新任务都要标 selfTimed = true，需要静默时实现 expectsQuiet()。

============================================================
1. 寻路支持挖路（这是目前 385 次移动失败的根因）
============================================================
现状：skills/move.js:261 写死 movements.canDig = false，
      寻路连一格土都挖不开，目标在树后/坡上就走不到。

改动：
a) skills/move.js ensureMovements(bot, options)
   - 增加参数 { canDig = false, digCost = 30, allow1by1towers = false }
   - 用缓存 key 区分不同配置，不要全局只有一个 _mcMovements：
       bot._mcMovementsMap = new Map();
       key = `dig:${canDig}:cost:${digCost}`
   - 默认调用仍然是 canDig = false（保持现有行为不变）

b) moveTo(bot, target, options) 增加 options.canDig 透传给 ensureMovements。
   只有挖矿相关任务才传 true。

c) 安全性：canDig = true 时，
   movements.dontMineUnderFallingBlock = true（保持默认）
   movements.allow1by1towers = false（禁止搭柱子，避免被自己困住）
   movements.dontCreateFlow = true（保持默认，不要挖穿水/岩浆）

验收测试：
  「默认寻路不挖方块」
    - 调 moveTo 不传 canDig
    - 断言 Movements.canDig === false
  「挖矿寻路允许挖方块且禁止搭柱」
    - 传 canDig: true
    - 断言 canDig === true, allow1by1towers === false

============================================================
2. 新增 skills/mining.js（挖掘原语）
============================================================
不要把这些塞进 move.js 或 mine.js，单独一个文件。

a) probeBelow(bot, position, depth = 4) -> { ok, hazard, blockName }
   从上往下逐格检查，返回遇到的第一个危险：
   - lava / flowing_lava  -> hazard: 'lava'
   - water / flowing_water -> hazard: 'water'
   - air（连续 3 格以上）   -> hazard: 'fall'
   - bedrock                -> hazard: 'bedrock'
   没有危险返回 { ok: true }

b) digBlockSafely(bot, block, options) -> { ok, error? }
   在 skills/mine.mineBlock 外面包一层安全检查：
   - 挖之前 probeBelow 目标方块下方
   - 如果 hazard 是 lava 或 fall 且目标就是脚下，拒绝并返回 { ok:false, hazard }
   - 挖完复查方块真的消失了（现有 mineBlock 已经做了）

c) placeTorchIfDark(bot, options) -> { ok, placed }
   - 读当前方块光（bot.blockAt(pos).light）
   - < threshold（默认 8）且背包有火把 -> skills.place.placeTorchAt 到脚下
   - 没有火把返回 { ok: true, placed: false }

验收测试（用 fake bot，不需要真服务器）：
  「probeBelow 识别脚下岩浆」
  「probeBelow 识别连续空气（坠落风险）」
  「digBlockSafely 拒绝挖穿岩浆上方的方块」

============================================================
3. 新增 tasks/digDown.js（阶梯下降）
============================================================
kind = 'digDown'，priority = 45，selfTimed = true

参数：{ depth: 10 }  // 目标下降格数
算法（阶梯式，绝不能垂直挖）：
  1. 选一个水平方向 dir（优先朝开阔处）
  2. 挖掉 (x+dx, y, z+dz) 的方块，走进去
  3. 挖掉 (x+dx, y-1, z+dz)，现在站在低一格
  4. 每下降 5 格：placeTorchIfDark
  5. 每次下降前 probeBelow 检查下一格，有 lava 就换方向
  6. 连续 3 次换方向都失败 -> 任务失败 DIG_FAILED

isDone: startY - currentY >= depth
isFailed: 超时（默认 5 分钟）/ 尝试次数用尽
progressMetric: startY - currentY

验收测试：
  「digDown 每下降 5 格放一次火把」
  「digDown 遇到岩浆会换方向而不是继续挖」
  「digDown 到达目标深度后完成」

============================================================
4. 新增 tasks/mineOre.js（找矿并挖）
============================================================
kind = 'mineOre'，priority = 45，selfTimed = true

参数：{ ore: 'iron_ore', count: 8, searchRadius: 32, maxMinutes: 8 }

实现建议：
  - 直接用现有 collectBlock 的骨架，但加三件事：
    1. prepare 里 equipBestTool（collectBlock 已有）
    2. 每次移动前 placeTorchIfDark
    3. _findTarget 支持深层搜索（现有 findNearestBlock 只找同层附近）

  - 如果目标矿在 y 低于当前位置 5 格以上，先派一个 digDown 任务下去，
    再继续找。**不要在 mineOre 里自己实现下挖**，复用 digDown。

  简化方案（推荐先做这个）：
    mineOre = collectBlock + 火把 + 调用 digDown 的委托。
    不要复制 collectBlock 的全部逻辑。

验收测试：
  「mineOre 在没有目标矿时返回 no_target 而不是卡住」
  「mineOre 在暗处会放火把」

============================================================
5. 接入仲裁器
============================================================
arbiter._chooseLocal 里加优先级（在 collectBlock 之后、goto 之前）：

  // 白天、有镐、背包里没有铁/煤、附近没有矿 -> 派 mineOre
  // 白天、地表、想探索但附近没资源 -> 派 digDown（下到 y-10 附近）
  // 这两种情况要克制：不要她一闲下来就派挖矿任务

建议的具体规则：
  - if (!day) 走夜间分支（已有）
  - if (附近有威胁) 走战斗/撤离（已有）
  - if (背包里没有石镐及以上 && 附近有石头) -> collectBlock '#minecraft:stone'
  - if (背包里有石镐 && 没有铁锭 && 深度 >= 60) -> mineOre iron_ore
  - if (背包最多空槽 >= 30 && 白天) -> digDown depth 10
  - 否则 collectBlock / goto

不要做"完整的资源规划"（什么先挖什么后挖）。那是阶段 7 的 projects 干的事。
阶段 5 只要让她能挖、能下、能保命。

============================================================
6. 验收
============================================================
- npm test 全过
- 新增一个 test/manual/mining-soak.js：
    假世界里 y=64 是草地，y=40 以下有铁矿，
    跑 3 分钟（180 秒模拟时间），确认：
      a) 她确实开始 digDown
      b) 每 5 格放了一次火把
      c) 从未挖穿过岩浆（假世界里在 y=50 放一层岩浆做陷阱）
- 贴出完整 SUMMARY
- 做完停下，不要开始阶段 6。
```

---

# C. 阶段 6–8：LLM 契约、项目、清理

```
项目根目录：D:\work\初小雪\mc
阶段 5 已完成并验收。

这一阶段的核心是：让新行为层接回 LLM，但只把"想"的部分交出去。
另外两个阶段（项目、清理）可以拆成两次提交。

============================================================
0. 铁律
============================================================
- 这是第一次允许把 shadowMode 改成 false。但必须满足：
    a) mind.js 完成且测试通过
    b) 有一条"LLM 不可达时本地继续玩"的自动化测试
    c) 关 shadow 是**配置项**，不是在代码里写死
- 不要删 autonomy.js / intent.js，那是阶段 8 的最后一个 commit。
- 所有给模型的能力必须来自 tasks.available()，不许在提示词里手写能力清单。

============================================================
1. 新增 body/mind.js（LLM 网关）
============================================================
这是阶段 6 的核心。它负责三件事：什么时候问、问什么、怎么验证答案。

状态机（只有四个状态）：
  IDLE      -- 不需要模型
  ASKING    -- 已经发出请求，等待回复
  PENDING   -- 模型回了，本地正在校验/执行
  COOLDOWN  -- 刚问过，冷却中

关键方法：
  maybeAsk(ctx) -> void
    触发条件（满足任一，且不在冷却）：
      - 任务栈空 且 本地没有可做的事（arbiter 返回 idle 且 reason 不是 low_hp）
      - 同一任务连续失败 2 次
      - 用户点名 / 死亡 / 被踢（由事件驱动，不走这里）
      - 距上次对话超过 10 分钟（社交需求）
    节流：最多 12 次/小时（本地计数，云端已有 30 次/小时做二道防线）

  buildSituation(ctx) -> object
    见 §2

  async ask(situation) -> { do, args, say } | null
    通过 link.sendEvent({ kind: 'intent', data: situation })
    超时 20 秒（不是原来的 90 秒）
    超时后返回 null，由调用方降级到本地默认

  validate(do_, args, ctx) -> { ok, task?, error?, alternatives? }
    1. tasks.get(do_) 不存在 -> { ok:false, error:'unknown_do', alternatives: availableKinds }
    2. TaskClass.feasible({...ctx, args}) 返回 null -> { ok:false, error:'not_feasible', alternatives }
    3. args 校验失败 -> 返回修正建议（例如 stone_bricks -> #stone）
    全部通过才 create 任务

  onReply(do_, args) -> void
    由 actions.js 的 mc_do 调用，内部走 validate 再 agenda.push。
    注意：来源必须是 source='mind'，不是 'user'，避免被当成人工指令。

验收测试（全部用 fake link，不连真服务器）：
  「mind 在栈空时发出 intent」
  「mind 20 秒无回复时降级到本地默认」
  「mind 在 12 次/小时后停止发问」
  「validate 拒绝不存在的任务名并返回 alternatives」
  「validate 拒绝 feasible 为 false 的任务」
  「mc_do 下发的任务 source 是 mind 不是 user」

============================================================
2. 处境快照（buildSituation）
============================================================
输出给模型的结构，必须紧凑（<= 400 token）且只包含它能用的东西：

{
  hp, food, pos, dim, time: 'day'|'night',
  ticksToDawn, light, underground,
  threats: [{type, dist}],           // 最多 3 个
  doing: { kind, progress } | null,
  lastResult: { kind, outcome, reason } | null,
  project: { title, next, done, total } | null,   // 阶段 7 才有
  can: [ { do, args?, note, eta } ]   // 由 tasks.available() 生成
}

can 的生成规则：
  - 调 tasks.available(ctx, defaults)
  - 只保留 feasible 非 null 的
  - 按 priority 降序，最多 6 条
  - 每条带一句人类可读的 note（来自各任务的 feasible().note）

**这是整个重构最关键的一个契约**：模型看到的能力 = 本地真的能做的事。
做不到的事不会出现在它眼前。

============================================================
3. 云端工具改造（kira_bridge/mc_bridge/main.py）
============================================================
新增两个工具：

a) mc_body
   描述："查看我现在的完整状态：在做什么、还能做什么、为什么不做事"
   返回 brain.snapshot() 的精简版（本地 actions.js 里加对应 handler）

b) mc_do
   描述："让我做一件具体的事。只能做 mc_body 的 can 列表里列出的事。"
   参数：{ do: string, args?: object, say?: string }
   返回：
     成功 { ok:true, started:true, do, eta }
     失败 { ok:false, error, alternatives: [...] }
   error 的类型：
     unknown_do        -- 没这个任务
     not_feasible      -- 现在做不到（附原因）
     invalid_args      -- 参数不对（附修正建议）
     busy              -- 正在做优先级更高的事

保留 mc_say / mc_stop / mc_scan / mc_inventory / mc_recent_chat。
mc_mode / mc_plan / mc_move / mc_follow / mc_attack 标 deprecated：
  - 内部转成 mc_do 的等价调用
  - 描述里注明"建议改用 mc_do"

c) 本地 actions.js 加 handler：
     body    -> brain.snapshot() 精简版
     doTask  -> mind.onReply(do, args)
   工具名去掉 mc_ 前缀转驼峰，沿用现有 normalizeToolName 规则。

============================================================
4. 事件分级（云端 main.py）
============================================================
现有逻辑保留，但要加两条：

a) 任务失败连续 2 次 -> 唤醒模型，带失败原因
   （身体侧在 brain 里检测，通过 link.sendEvent 推 kind: 'task_failed'）
b) LLM 不可达时不推事件，只在本地记录
   （现在 _wake 里有 is_connected 判断，确认它覆盖了 task_failed）

============================================================
5. 关闭 shadow 的前提与做法
============================================================
必须全部满足才能关：
  a) npm test 全过，包含上面 mind 的 6 个测试
  b) 有一条集成测试：link 断开时，brain 继续跑本地任务 5 分钟，
     且没有 empty agenda 超过 60 秒
  c) 手动跑过 day-soak 和 mining-soak 都正常

做法：
  - config.json 里加 "brain": { "shadowMode": false }
  - 代码里不要有"默认 false"的兜底
  - 关之前先跑一次 shadow 对比：日志里 shadow_decision 和 local_decision
    应该在 90% 以上一致（stage1Equivalent 字段已经在记了）

============================================================
6. 阶段 7：项目与人格
============================================================
（可以单独一次提交，与阶段 6 解耦）

a) mc_bot/data/projects.json
   结构见 真人化重构方案.md §12.4
   新增 tasks/build.js（第一版只支持"放方块搭一个 3x3x3 盒子"）
   新增 tasks/craft.js（只支持简单配方：木板、木棍、工作台、火把、箱子）
   项目步骤完成时写 diary.jsonl

b) mc_bot/data/diary.jsonl
   每行：{ ts, goal, outcome, reason, durationSec, deaths }
   brain._onAgendaEvent 的 agenda_settle 里写

c) 空闲动作（human.js）
   - 动作前 80–220ms 随机延迟
   - 转头用插值（每 tick <= 25 度）
   - idle 时每 3–6 秒环顾，每 20–40 秒做一个小动作
   这是"不再像雕像"的直接来源，优先级不低于任何功能

d) 模板台词（不经过 LLM）
   天亮 / 找到矿 / 被打 / 逃离成功 / 要睡了
   通过 eventHub.report('chat') + bot.chat 发
   每次至少 60 秒冷却

============================================================
7. 阶段 8：清理
============================================================
最后一个 commit 才做：
  - 删除 src/autonomy.js、src/intent.js
  - 删除 index.js 里的 legacy 装配和 setMode 包装
  - 删除 autonomy 相关的测试（stage0.test.js 里针对旧代码的部分）
  - 保留 stage1–5 的所有测试
  - config.js 里删掉旧 autonomy 用的配置项

删之前先跑 24 小时 soak：
  - 死亡 <= 4 次
  - 没有超过 5 分钟的 agenda 空转
  - brain.jsonl 能完整复盘

============================================================
8. 每一阶段的验收
============================================================
阶段 6：npm test 全过 + 集成测试（断网 5 分钟继续玩）+ 手动 mc_do 三种场景
阶段 7：项目能跨会话继续、空闲时有动作、模板台词不刷屏
阶段 8：24 小时 soak 通过 + 删除旧代码后测试仍全过
```

---

## 给维护者的提醒

阶段 6 完成后，**这是整个项目第一次真正"关掉 shadow"**。建议在关之前做三件事：

1. 先开着 shadow 跑一晚，对比 `brain-shadow.jsonl` 里 `local_decision` 和
   `shadow_decision` 的一致率。低于 90% 说明两条路径行为差异大，要查。
2. 关 shadow 后第一晚人在旁边看着。她第一次自主玩整晚，一定会出现
   假世界测不出来的情况。
3. 保留一键回退：`config.json` 里改回 `"shadowMode": true` 就回到旧行为。

阶段 7 的"空闲动作"看起来最不起眼，但它是最直接解决"整个人呆呆的"的部分。
如果时间紧，它的优先级应该高于项目系统和台词。
