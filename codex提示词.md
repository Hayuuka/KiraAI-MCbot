# 给 codex 的启动提示词

把下面这段直接粘给 codex。开工前让它先读 `真人化重构方案.md`。

---

```
项目根目录：D:\work\初小雪\mc
方案文档：真人化重构方案.md（先完整读一遍，再动手）
能力清单：能力清单与指令支持.md（装备/物品/容器/指定床这些缺失能力在这里）

任务：按方案文档重构 mc_bot 的行为层，目标是让她在没有人工指令时也能像真人一样玩 MC。

请严格按文档的"§15 迁移计划"分阶段提交，不要一次全改完：

第 0 阶段（先做，半天）——只修 bug，不改架构：
  1. src/autonomy.js 的 _tick() 里，_checkLowHealth 返回 true 时直接 return，
     导致 switch 里的 _escapeTick 永远执行不到，血量 <8 时整个人冻结。
     改成：低血时仍然执行逃跑逻辑（临时方案：直接调用 this._escapeTick(bot, now)）。
  2. src/autonomy.js 的 _sleepTick() 里 `const distance = distance(...)`
     因 TDZ 抛 ReferenceError，睡觉从未成功过。把变量改名为 gap。
  3. src/actions.js 的 mode() 里 allowed 数组缺 sleep / escape，补上。
  4. _finishMode() 无条件写 mineDoneReason，导致 wander 的结束原因显示成
     "已挖够 8 个"。按 mode 分开记录。
  5. src/intent.js 加临时看门狗：mode 为 idle、current 为空、距上次决策超过 3 分钟
     时强制走一次 FALLBACK_ROTATION 并打日志。日志里她曾因决策链静默停摆 3 小时，
     因为 _tick() 有 5 条不带日志的提前 return，其中 isCloudReady 那条在云端
     不可达时永远为假，兜底轮转永远轮不到。

第 0.5 阶段（半天，可立即上线，不依赖重构）——补上"用工具/穿装备"：
  6. 新建 src/skills/inventory.js，实现：
       count(bot, name) / findFood(bot) / equipBestTool(bot, block)
       equipBestWeapon(bot) / equipBestArmor(bot) / dropItem(bot, name, count)
     护甲槽位固定 head=5 torso=6 legs=7 feet=8；也可以用 bot.entity.equipment。
  7. src/skills/mine.js 的 mineBlock() 在 bot.dig() 之前调用 equipBestTool(bot, block)。
     现在 she 是空手挖石头、拿镐砍树，日志里有 8 次 dig timed out，
     改这一条就能立刻见效。
  8. src/actions.js + kira_bridge/mc_bridge/main.py 各加三个工具：
       mc_drop   {item, count}      -> bot.toss / bot.tossStack，丢完回读背包
       mc_equip  {item}             -> bot.equip，穿完回读护甲槽
       mc_unequip{slot}             -> bot.unequip
     具体实现与坑见 能力清单与指令支持.md §3.2。

第 0 阶段做完先自测再继续：
  - node -c 语法检查全部改动文件
  - 写 5 个 fake-bot 单元测试覆盖：低血触发撤离、睡觉成功路径、低血打断后能恢复、
    isCloudReady=false 时兜底轮转会执行、equipBestTool 会选择正确工具
  - 把自测结果贴给我，我确认后再进第 1 阶段

第 1 阶段起按文档实现 body/ 与 tasks/ 目录。硬性约束见文档 §17「编码约束」，
其中最容易违反的三条重申：
  - 不许新增"当前在做什么"的状态字段，只能从 agenda.top() 读
  - 任务成功判定必须来自世界状态（背包增量/坐标/方块/bot.isSleeping），不能只看函数没报错
  - 不许用字符串匹配错误信息做分支，失败原因一律用枚举

不确定的地方先按文档，不要自己发明新架构；文档里明确说"不做"的事（§18.3）不要做。
```

---

## 给维护者的验收建议

阶段 0 / 0.5 之后先跑一次真实环境，确认这四件事：

1. **把血量压到 5 并放一只僵尸在旁边** → 她应该立刻跑开，而不是站着不动。
2. **夜里背包里有床** → 日志出现"睡下了"，且 `bot.isSleeping === true`。
3. **断开 SSH 隧道（或停掉云端插件）30 分钟** → 日志里每 3 分钟出现一次 `fallback`，她仍在砍树/闲逛。
4. **让她挖石头** → 会先切到镐子；**QQ 里说"把泥土丢了"** → 真的少了，且回读背包确认。

这四条过了，再让 codex 开始第 1 阶段。否则新架构会重复踩同样的坑。
