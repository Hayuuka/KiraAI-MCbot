# 给 codex 的修复提示词（阶段 0–4 审查后）

把下面这段整体粘给 codex。动工前让它先读 `审查报告-阶段0至4.md`。

---

```
项目根目录：D:\work\初小雪\mc
先读：审查报告-阶段0至4.md（尤其是 §1、§2、§6、§8）

阶段 0–4 已验收。34 个测试全过，但审查发现 6 个测试覆盖不到的问题，
其中 2 个必须先修，否则接上新行为层后她会比现在还呆。
修完后先不要进阶段 5。

============================================================
0. 铁律（违反就不要提交）
============================================================
- 不要关 brain.shadowMode。阶段 6（LLM 契约）完成前必须保持 true。
  新行为层目前完全没有接 LLM，关掉 shadow 等于让她失去"问模型接下来做什么"的能力。
- 每修一项必须配至少一个测试，测试名用下面每项的"验收测试"原文。
- 不要用字符串匹配错误信息做分支，失败原因继续走 FAILURE_REASONS。
- 不要为了通过测试而放宽断言。测试要能真的抓住"她站着不动"。

============================================================
1. 需求抢占（报告 §1.1）
============================================================
现状：brain.js:309 的 _arbitrate 第一行是
    if (this.agenda.top()) return null;
栈顶有任务时永远不会再仲裁，饥饿/天黑插不进来。

改动：
a) tasks/base.js
   - TASK_STATE 增加 PAUSED: 'paused'
   - 增加 get isPaused() { return this.state === TASK_STATE.PAUSED; }
   - 新增 Task.pause()：
       if (this.isTerminal || this.isFrozen || this.isPaused) return false;
       this._prePauseState = this.state;
       this.state = TASK_STATE.PAUSED;
       return true;
   - 新增 Task.resume()：
       if (!this.isPaused) return false;
       this.state = this._prePauseState || TASK_STATE.RUNNING;
       this._prePauseState = null;
       return true;
   - 注意：pause 和 freeze 是两回事，不能互相覆盖。
     freeze 时如果 state 是 PAUSED，thaw 要回到 PAUSED 而不是 RUNNING
     （用 _preFreezeState 已经存了原状态，确认它被正确恢复即可）。
   - toJSON() 里补 state 即可，无需其他字段。

b) body/agenda.js
   - push(task, options)：入栈后若新任务是新的 top，且它下面那个任务
     处于 RUNNING，调用那个任务的 pause()。
   - _settle(task)：出栈后，取新的 top，如果是 isPaused，调 resume()
     并调它的 onResume(ctx)。
     注意：_settle(task) 当前**没有 ctx 参数**（agenda.js:109），
     有三处调用（52 / 60 / 65 行）。需要把 ctx 一路传进去，
     或者让 Agenda 在 tick(ctx) 时把 ctx 存到 this._ctx 供 _settle 使用。
     推荐后者，改动面小。
   - tick(ctx)：跳过 isPaused 的任务——
       如果 top 是 paused，说明抢占关系被破坏，直接 resume 它再继续，
       不要静默 return（静默 return 正是审查里反复出现的问题模式）。

c) body/brain.js _arbitrate(ctx)
   - 去掉 "栈顶非空就 return"。
   - 改为：先跑 this.arbiter.step(ctx) 拿到 choice；
     若栈顶存在，只有 choice.priority > top.priority 才 push，
     否则忽略这次 choice（记录 'preempt_rejected'）。
   - 记录 'preempt' 事件，带 { from: top.kind, to: choice.kind, reason }。

验收测试（放进 test/stage5-fixes.test.js）：
  「栈顶非空时，饥饿需求能否插入」
    - 栈里放一个 priority 30 的 goto（RUNNING）
    - 让 drives 的 hunger 变成 urgent
    - 调 _arbitrate
    - 断言 agenda.size === 2，top 是 eat，下面的 goto 是 paused
  「高优先级任务结束后，被暂停的任务恢复」
    - 接着上一步，让 eat 完成（直接 task.succeed() + agenda.tick）
    - 断言 top 是 goto 且 state === 'running'

============================================================
2. lease 修正（报告 §1.2）
============================================================
现状：brain.js:327 给所有本地任务统一套 localLeaseMs = 120000（2 分钟），
但 collectBlock 默认 maxMinutes = 5。挖矿两分钟就被 lease_expired 打断。

改动：
a) 在 tasks/base.js 或 tasks/index.js 加一个静态字段约定：
     每个 TaskClass 可以声明 selfTimed（注意本仓库的静态字段是
     **赋值式**，不是 class 体内的 static 语法）：
        CollectBlockTask.selfTimed = true;
   已有时长上限的任务都标上：collectBlock / goto / guard / assist / fight /
   flee / sleep / shelter / heal / eat / digIn。
   （也就是目前全部任务——它们都有 maxMinutes 或 durationMs 或 timeoutSec。）
   没标的任务才吃 lease。base.js 的 Task 类里给一个默认
   `Task.selfTimed = false;` 以免 undefined 判断散落各处。

b) brain.js _arbitrate 里：
      const TaskClass = this.tasks.get(choice.kind);
      const leaseMs = TaskClass && TaskClass.selfTimed ? null : this.config.local.localLeaseMs;
      this.agenda.push(task, { now: ctx.now, leaseMs });
   Agenda.push 里 leaseMs 为 null 时不要写 leaseExpiresAt（保持 null），
   现有的 tick 已经判断 `leaseExpiresAt !== null`，无需改。

c) 保留 lease 机制本身：source === 'user' | 'mind' 的任务仍然需要租约，
   这条留给阶段 6 的 mc_do 用。现在只要别让它误伤本地任务。

验收测试：
  「本地 collectBlock 任务能否活过 localLeaseMs」
    - 建一个 collectBlock 任务（source='local'，priority 40）
    - 用 _arbitrate 入栈（配置里 localLeaseMs = 1000）
    - 把 ctx.now 推进 5000ms，多次 agenda.tick
    - 断言任务仍然在栈里、state 不是 failed、failure 不是 lease_expired

============================================================
3. 有怪时打架或逃跑，不要 idle（报告 §2.3）
============================================================
现状：arbiter.js:74
    const dangerous = perception.threats.find(t => t.dist <= local.dangerRadius);
    if (dangerous) return idle('threat_nearby');
实测 8 格一只僵尸 → {"kind":"idle","priority":10,"reason":"threat_nearby"}
满血面对一只僵尸她什么都不做。这是"不会反击"的直接来源。

改动：
a) body/perception.js
   - 计算完 threats 后，补一个 canWin 字段：
       threat.canWin = threat.threat <= myPower(bot, inventory.armor)
   - myPower 读的是 bot.heldItem。实测（20 血、无甲）：
       手持面包   myPower = 6.80
       手持铁剑   myPower = 15.80
     单只僵尸（含贴脸）threat 约 2.7–3.9，所以**手持面包也能赢单只僵尸**，
     不用担心她变成见谁都跑。
     但差距在 2.3 倍，遇到骷髅/女巫/末影人或多只时就会误判成打不过。
   - 因此 canWin 要按**背包里最好的武器**评估，而不是手上那把：
     在 skills/inventory.js 加
       function bestWeaponScore(bot)   // 复用 weaponScore 排序，但不 equip
     再按"最佳武器的伤害"重算一次 power。fight 任务的 prepare 本来就会
     调 equipBestWeapon（已实现），所以这个判断和执行是自洽的。
   - 顺便在 perception 顶层加 myPower 数值，方便 arbiter 用。

b) body/arbiter.js _chooseLocal
   - 删掉 threat_nearby -> idle 这条。
   - 改为：
       const threat = perception.threats.find(t => t.dist <= local.dangerRadius);
       if (threat) {
         if (!threat.canWin) {
           return { kind: 'flee', args: {}, priority: 70, reason: 'threat_too_strong' };
         }
         return {
           kind: 'fight',
           args: { targetId: threat.id, type: threat.type },
           priority: 50,
           reason: 'engage_threat',
         };
       }
   - DRIVE_TASKS 不动（flee/fight 不走 drive，走本地决策）。

c) 确认 flee 和 fight 的 feasible 在此时返回非 null；
   如果 fight.feasible 因为找不到目标返回 null，退回到 flee。

   注意：fight.feasible 用 ctx.args.targetId / ctx.args.type 去找实体
   （fight.js:36），而 arbiter 调用它时会传 `{ ...ctx, args: {} }`（照
   _chooseDrive 的写法）。所以你**必须把 threat.id / threat.type 放进 args**
   再调 feasible，否则它会退化成"找最近的敌对生物"，可能选到另一只。
   perception 里 threats 已经带 id 和 type 字段，直接用。

   如果 perception 里没有 id（实体 id 缺失），feasible 仍能按 type 找到目标，
   这时不要求 id 精确匹配。

验收测试：
  「8 格内有僵尸时，仲裁器产出 fight 而不是 idle」
    - perception.threats = [{ type:'zombie', dist:5, threat:2, canWin:true }]
    - 断言 arbiter.step(ctx).kind === 'fight'
  「打不过的威胁产出 flee」
    - threat 改成 warden（canWin:false）
    - 断言 kind === 'flee'
  「手持面包但背包里有铁剑时，单只僵尸仍判为可打」
    - bot.heldItem = bread，inventory.items() 含 iron_sword
    - 断言 perception 算出的 canWin === true
      （这条专门防止"按手持物算 power"造成的误判回归）

============================================================
4. 夜间兜底链（报告 §2.4）
============================================================
现状：夜晚 + 无床 + 背包无方块 + 8 格无山壁 → idle，整夜发呆。
实测：{"kind":"idle","reason":"night_without_stage1_shelter"}

改动：
a) 新增 src/tasks/digIn.js
   - kind = 'digIn'，priority = 58，selfTimed = true
   - 语义：原地竖直向下挖 1 格，然后把自己埋起来（可选），蹲到天亮。
     不做阶梯，不做长隧道——这是最后一档兜底，越简单越好。
   - feasible(ctx)：
       * 必须是夜晚（world.isDay === false）
       * 必须在地表（!world.underground）
       * 脚下那格必须是可挖的实心方块（不是 bedrock / 不是水 / 不是岩浆）
       * 不要求背包有方块，不要求有工具，不要求有山壁
       * 满足则返回 { args: {}, etaSec: 30, note: '原地挖 1 格蹲到天亮' }
   - prepare(ctx)：记录起始 y、记录天亮时间；shadow 下直接 return true
   - progressMetric：dugOnce ? 1 : 0
   - isDone：world.isDay === true（天亮）
   - isFailed：
       * 当前时间超过 maxMinutes（默认 12 分钟）
       * 尝试下挖 3 次都没成功 → DIG_FAILED（在 FAILURE_REASONS 里补这个枚举）
   - _tick：
       * 关键：**不能用 perception.world.underground 判断"已经躲好了"**。
         它看的是头顶 8 格内有没有实体方块（perception.js:93-102），
         只挖 1 格的话头顶仍然露天，underground 依旧是 false，
         会无限重复"挖脚下"。
       * 正确判据用任务自己记的两个值：
           this.startY  —— prepare 时的 y
           this.dugOnce —— 是否已经成功挖下去过
         第一次 tick 挖脚下那格；挖成功后 dugOnce = true。
         之后 dugOnce 为 true 就只等天亮，不再挖。
       * 挖法：skills.mine.mineBlock(bot, 脚下那格, { timeoutMs: digTimeoutMs })
         注意 mineBlock 内部会先 equipBestTool，也会拒绝距离 > 6.5 的方块，
         脚下那格距离约 1.6，满足。
       * 挖完检查 bot.entity.position.y < this.startY - 0.5；
         没下降说明没挖成功，this.attempts += 1，可重试。
       * 挖开后如果背包里正好有方块（非必需），可以调
         skills.place.placeBuildingBlockAt(bot, 头顶那格) 把自己封起来；没有就跳过。
         它内部会自己找方块，没方块会返回 {ok:false}，直接忽略这个结果即可。
       * shadow 模式下只 markShadowPlan，不挖、不计数

   注意：这里不要复刻 shelter 那套「找山壁 + 找方块」，那正是它可行性太窄的原因。
   digIn 是门槛最低的一档，任何有脚下方块的地方都能用；没有方块也照样能挖下去。

b) body/arbiter.js 的夜间分支
   - 现在是：isDay === false && !underground && !workAtNight → idle(...)
   - 改为按顺序尝试，第一个 feasible 的就用：
       sleep → shelter → digIn
     三个都不行才 idle（并且 reason 要写清楚三个各自为什么不行，
     例如 'night_no_option:sleep=no_bed,shelter=no_material+no_wall,digIn=no_solid_ground'）
   - 实现建议：把这段抽成 _chooseNight(ctx)，内部依次调
       this.tasks.get('sleep').feasible(ctx) 等，拿到 spec 就返回。
   - 注意 workAtNight 这个开关：它现在的含义是"夜里也干活"（返回 idle 之前
     那条判断）。改成兜底链之后，含义要重新定义清楚：
       workAtNight === true  → 跳过整个夜间分支，直接走白天的 collectBlock / goto
       workAtNight === false → 走 sleep → shelter → digIn → idle
     保持配置语义不变，不要引入新开关。

c) tasks/index.js
   - 注册 DigInTask
   - 导出 DigInTask

d) config.js DEFAULTS.brain.tasks 增加：
       digIn: { maxMinutes: 12, maxAttempts: 3, digTimeoutMs: 15000 }
   同时在 FAILURE_REASONS 里补两个枚举：
       DIG_FAILED: 'dig_failed'
       NO_SOLID_GROUND: 'no_solid_ground'

验收测试：
  「夜间无床、背包无方块、无山壁时，产出非 idle 的兜底任务」
    - perception: 夜晚、地表、无 threats
    - bot 背包空、findBlock 全部返回 null（没有床、没有山壁）
    - bot.blockAt 返回脚下的泥土、上方空气
    - 断言 arbiter.step(ctx).kind === 'digIn'
  「digIn 在天亮后完成」
    - 任务跑着的时候把 perception.world.isDay 改成 true
    - 断言 isDone() === true
  「digIn 挖成功后不再重复挖」
    - 第一次 tick 挖成功（fake bot 的 y 下降 1）
    - 再 tick 5 次，断言 mineBlock 只被调用过一次
    - 这条专门防止"用 underground 判断"导致的无限挖掘回归

============================================================
5. 中断期间冻结计时（报告 §2.2）
============================================================
现状：Task.freeze() 只改 state，startedAt 不动。
一个 5 分钟的任务被 30 秒低血反射打断，回来 elapsedSec 多算了 30 秒，
更容易撞 maxMinutes 超时。

改动（tasks/base.js）：
- freeze(ctx)：记 this._frozenAt = nowOf(ctx)
- thaw(ctx)：
    if (this._frozenAt != null) {
      const delta = nowOf(ctx) - this._frozenAt;
      if (this.startedAt != null) this.startedAt += delta;
      if (this._lastProgressAt != null) this._lastProgressAt += delta;
      this._frozenAt = null;
    }
  然后按原逻辑恢复 state。

注意：startedAt 用的是注入时钟（nowOf(ctx)），这里不能直接用 Date.now()，
否则测试里注入的 fake now 会失效。
当前签名链是：brain.tick 里 `this.agenda.freezeTop()`（brain.js:207）
→ agenda.freezeTop() 无参（agenda.js:69）→ task.freeze() 无参。
需要把 ctx 传下去：`freezeTop(ctx)` / `thawTop(ctx)` / `freeze(ctx)` / `thaw(ctx)`，
brain 调用处（brain.js:207 和 219）补上 ctx。thaw 里用 nowOf(ctx) 计算 delta。

同时注意 pause 的情况：如果任务在 freeze 之前已经是 PAUSED，
_frozenAt 依然要记录（因为它确实被"时间"穿过了），
thaw 之后 state 回到 PAUSED，计时同样要后移。
两者互不干扰，可以同时存在。

验收测试：
  「反射打断 30 秒后，任务 elapsedSec 是否跳过了这 30 秒」
    - 建 goto 任务，用注入的 now 推进到 elapsedSec = 10
    - freeze(ctx)，把 now 推进 30000，thaw(ctx)
    - 断言 elapsedSec 仍然是 10（误差 < 1s）

============================================================
6. goto 的 y 为 null 时用 GoalXZ（报告 §3.1）
============================================================
现状：moveTo 永远用 goals.GoalNear(x,y,z,range)，到达判定也用 3D positionDistance。
arbiter._strollTarget 生成 y: null，goto._tick 用当前 y 兜底，
目标在坡上差 3 格时永远判定不到。

改动：
a) skills/move.js moveTo(bot, target, options)
   - 新增 options.horizontalOnly（默认 false）
   - horizontalOnly 为 true 时：
       const goal = new goals.GoalXZ(destination.x, destination.z);
     到达判定改用水平距离：
       const distance = Math.hypot(pos.x - destination.x, pos.z - destination.z);
   - GoalXZ 已确认存在于 mineflayer-pathfinder 2.4.5。

b) tasks/goto.js
   - args.y 为 null 时，_tick 里 moveTo 传 { horizontalOnly: true }
   - 注意 goto.js:117 现在做的是 `y = Number.isFinite(this.args.y) ? this.args.y : position.y`，
     保留这个兜底给"目标是同高度"的场景，但**寻路时不要传这个 y**。
     即：目标 y 为 null → 一定走 horizontalOnly。

c) 相应地，moveTo 返回结果里的 dist 在 horizontalOnly 下是水平距离，
   collectBlock 等调用方用的是不传 horizontalOnly 的默认路径，不受影响。
   确认这两处没有被误改：
      src/tasks/collect.js:155  skills.move.moveTo(bot, {...}, { range, timeoutMs })
      src/body/interrupts.js:174  skills.move.moveTo(bot, spot, { range, timeoutMs })

c) 保留 y 有值时的原行为（GoalNear + 3D 判定）。

验收测试：
  「goto 的目标 y 与实际地形差 3 格时能否判定到达」
    - fake bot 站在 (0,64,0)，目标 { x:0, y:67, z:0 }，y 传 null
    - pathfinder.setGoal 记录收到的 goal 类型
    - 断言 goal 构造用的是 GoalXZ（可以断言 goal 上只有 x/z 约束，
      或者打桩 goals.GoalXZ 计数）
    - 让 bot 位置在 x/z 上到达，断言 isDone() === false→true 过程正常

============================================================
7. 提交与验收
============================================================
- 每项一个 commit，commit message 用：
    fix: 需求抢占（§1.1）
    fix: 本地任务 lease（§1.2）
    fix: 有怪时战斗或撤离（§2.3）
    feat: digIn 夜间兜底（§2.4）
    fix: 中断期间冻结计时（§2.2）
    fix: goto 水平寻路（§3.1）
- 全部做完跑 npm test，把完整输出贴出来。
- 然后额外做一次"假世界快照"验收（不连服务器）：
    用一个有树、有僵尸、背包有石斧和石镐的 fake bot，
    在白天跑 60 秒 brain tick，打印 agenda 的变化序列，
    确认她至少做过：collectBlock / fight 各一次。
  这个脚本放 test/manual/day-soak.js，不纳入 npm test。
  注意：fake bot 的 pathfinder 要能"假装走到"目标，否则 collectBlock
  会一直卡在 move 阶段。参考现有 test/stage4.test.js 里 makeBot 的写法。
  如果 60 秒内没跑出两个任务，不要改断言放水——把 agenda 变化序列贴出来，
  说明是哪一环卡住了，我来判断是测试写法问题还是代码问题。

============================================================
8. 明确不要做的事
============================================================
- 不要动 shadowMode。
- 不要顺手改 autonomy.js 或 intent.js（那是阶段 8 才删的）。
- 不要在 arbiter 里新增"字符串 reason 判断"。
- 不要把 digIn 做成第二个 shelter（不要加找山壁、找方块的约束）。
- 不要为了"看起来更聪明"增加新的任务种类，先把这 6 项做扎实。
- 不要顺手把 arbiter._chooseLocal 里其他 reason 也一起重构，
  只改 threat_nearby 和夜间分支这两处。

============================================================
9. 做完之后停在这里
============================================================
这 6 项修完、测试全过、假世界快照能看到 collectBlock 和 fight，
就停下来等我确认。**不要自动开始阶段 5（digDown / mineOre）。**
阶段 5 会依赖这次的 digIn 和 collectBlock，我要先看它们在假世界里的
实际表现，再决定挖掘任务的参数。
```
