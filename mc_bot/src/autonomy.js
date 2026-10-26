'use strict';

const skills = require('./skills');

const MODES = new Set(['idle', 'follow', 'guard', 'mine', 'wander', 'sleep', 'escape']);
const FOOD_NAMES = new Set([
  'apple',
  'golden_apple',
  'enchanted_golden_apple',
  'bread',
  'carrot',
  'golden_carrot',
  'potato',
  'baked_potato',
  'poisonous_potato',
  'beetroot',
  'beetroot_soup',
  'cooked_beef',
  'beef',
  'cooked_porkchop',
  'porkchop',
  'cooked_chicken',
  'chicken',
  'cooked_mutton',
  'mutton',
  'cooked_rabbit',
  'rabbit',
  'rabbit_stew',
  'cooked_cod',
  'cod',
  'cooked_salmon',
  'salmon',
  'tropical_fish',
  'pufferfish',
  'melon_slice',
  'sweet_berries',
  'glow_berries',
  'dried_kelp',
  'cookie',
  'pumpkin_pie',
  'mushroom_stew',
  'suspicious_stew',
  'honey_bottle',
]);

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function distance(a, b) {
  return skills.positionDistance(a, b);
}

class Autonomy {
  constructor(options = {}) {
    this.config = options.config || {};
    this.connection = options.connection || {};
    this.eventHub = options.eventHub || null;
    this.log = options.log || console;
    this.mode = 'idle';
    this.modeArgs = {};
    this.running = false;
    this.timer = null;
    this.busy = null;
    this.lastPosition = null;
    this.lastMoveAt = Date.now();
    this.lastEatAt = 0;
    this.lastRetreatAt = 0;
    this.lastLavaAt = 0;
    this.lastGuardAt = 0;
    this.lastFollowAt = 0;
    this.lastMineAt = 0;
    this.lastWanderAt = 0;
    this.lastFollowWarnAt = 0;
    this.lastMineWarnAt = 0;
    this.guardState = { lastAttackAt: 0 };

    // mine 模式的停止条件：目标数量 / 时长 / 背包剩余空间
    this.minedCount = 0;
    this.mineStartedAt = 0;
    this.lastDangerWarnAt = 0;
    this.mineDoneReason = '';
    this.modeDoneReasons = Object.create(null);
    this.lastSleepAt = 0;
    this.lastSleepWarnAt = 0;
    this.sleeping = false;
    this.waterTicks = 0;
    this.deathsThisSession = 0;
    this.lastDeathAt = 0;
    this.pendingEscape = false;
    this.lastEscapeAt = 0;
    this._deathBound = false;
    this.badBlocks = new Map();

    // 自主调度（intent）：为 null 时表示没有自动计划
    this.intent = null;
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.warn || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[autonomy] ' + message);
    } catch (_) {
      return;
    }
  }

  _notice(text, extra) {
    if (!this.eventHub || typeof this.eventHub.reportSystem !== 'function') return;
    try {
      this.eventHub.reportSystem(text, extra);
    } catch (_) {
      return;
    }
  }

  _getBot() {
    return typeof this.connection.getBot === 'function' ? this.connection.getBot() : null;
  }

  _isReady() {
    return typeof this.connection.isReady === 'function' ? this.connection.isReady() : Boolean(this._getBot());
  }

  /**
   * 死亡计数与撤离。
   *
   * 实测过的问题：出生点旁边有溺尸，复活→被咬死→复活→被咬死循环五次。
   * 复活后没有"离开这个危险位置"的逻辑，光靠后退两步没用。
   */
  _onDeath() {
    this.deathsThisSession = (this.deathsThisSession || 0) + 1;
    this.lastDeathAt = Date.now();
    this.pendingEscape = true;
    this._stopMotion(this._getBot(), true);
    this._notice(`死亡（本次会话第 ${this.deathsThisSession} 次）`, {
      deaths: this.deathsThisSession,
    });
    if (this.recordEvent) {
      this.recordEvent({ event: 'death', count: this.deathsThisSession });
    }
  }

  _onRespawn() {
    if (!this.pendingEscape) return;
    this.pendingEscape = false;
    // 重生后不要立刻干活，先离开危险区
    this.mode = 'escape';
    this.modeArgs = { until: Date.now() + 20000 };
    this._notice('刚死过，先跑远一点');
  }

  /** 撤离模式：朝随机方向持续跑，跑到安全或超时为止。 */
  _escapeTick(bot, now) {
    if (this.busy) return;
    const until = Number(this.modeArgs.until) || 0;
    if (now > until) {
      this._notice('撤离结束，恢复行动');
      this.mode = 'idle';
      this.modeArgs = {};
      return;
    }
    if (now - (this.lastEscapeAt || 0) < 3000) return;
    this.lastEscapeAt = now;

    // 朝背离最近敌对生物的方向跑；附近没怪就随机一个方向
    let yaw;
    const nearest = this._nearestHostileEntity(bot, 16);
    if (nearest) {
      const me = bot.entity.position;
      const dx = me.x - nearest.position.x;
      const dz = me.z - nearest.position.z;
      yaw = Math.atan2(dz, dx) - Math.PI / 2;
    } else {
      yaw = Math.random() * Math.PI * 2;
    }

    try {
      bot.entity.yaw = yaw;
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      if (bot.jumpTicks !== undefined) bot.jumpTicks = 0;
      bot.setControlState('jump', Math.random() < 0.3);
      setTimeout(() => {
        try {
          const b = this._getBot();
          if (b) {
            b.setControlState('forward', false);
            b.setControlState('sprint', false);
            b.setControlState('jump', false);
          }
        } catch (_) {}
      }, 2500);
    } catch (_) {
      // 跑不动就算了
    }
  }

  /**
   * 被攻击时还手。
   *
   * 之前完全没有这个响应——挨打了继续干手里的事，被僵尸活活咬死。
   * 规则很简单：谁打我我打谁；打不过（血太少或对方太强）就跑。
   */
  _onHurt(source) {
    const now = Date.now();
    if (now - (this.lastHurtAt || 0) < 700) return;   // 避免连击刷屏
    this.lastHurtAt = now;

    const bot = this._getBot();
    if (!bot || !bot.entity) return;

    const hp = Number(bot.health);
    this.hurtCount = (this.hurtCount || 0) + 1;

    // 血少了先跑，别硬拼
    if (Number.isFinite(hp) && hp < 8) {
      if (this.mode !== 'escape') {
        this._notice(`血量 ${Math.round(hp)}，被打就跑`);
        this.mode = 'escape';
        this.modeArgs = { until: now + 12000 };
      }
      return;
    }

    // 找攻击者。mineflayer 的 entityHurt 事件给的是被打的实体，
    // 攻击者要用最近的敌对生物推断。
    const attacker = source && source.position && source !== bot.entity
      ? source
      : this._nearestHostileEntity(bot, 6);

    if (!attacker || !attacker.position) {
      // 找不到攻击者，先跑
      this.mode = 'escape';
      this.modeArgs = { until: now + 6000 };
      return;
    }

    // 还手：转身打回去
    try {
      const dist = attacker.position.distanceTo(bot.entity.position);
      if (dist <= 3.2) {
        if (typeof bot.lookAt === 'function') {
          Promise.resolve(bot.lookAt(attacker.position.offset(0, 1.2, 0), true)).catch(() => {});
        }
        bot.attack(attacker);
        // 边打边跳，减少被连击
        try {
          bot.setControlState('jump', true);
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 200);
        } catch (_) {}
        this._log(`还手：${String(attacker.name || attacker.type || '?')} 距离 ${dist.toFixed(1)}`);
      } else {
        // 够不着就走过去打
        if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
          try {
            const { goals } = require('mineflayer-pathfinder');
            bot.pathfinder.setGoal(new goals.GoalNear(
              attacker.position.x, attacker.position.y, attacker.position.z, 2
            ));
          } catch (_) {}
        }
        this._log(`被攻击，追上去：距离 ${dist.toFixed(1)}`);
      }
    } catch (_) {
      // 还手失败就当作没反应，下一轮再来
    }

    if (this.recordEvent) {
      this.recordEvent({
        event: 'hurt',
        hp: Number.isFinite(hp) ? Math.round(hp) : null,
        attacker: String((attacker && (attacker.name || attacker.type)) || 'unknown'),
      });
    }
  }

  _nearestHostileEntity(bot, radius) {
    try {
      for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity === bot.entity || !entity.position) continue;
        const name = String(entity.name || entity.type || '').split(':').pop();
        const HOSTILE = ['zombie', 'drowned', 'skeleton', 'creeper', 'spider',
          'husk', 'stray', 'witch', 'enderman', 'slime', 'phantom'];
        if (!HOSTILE.includes(name)) continue;
        if (entity.position.distanceTo(bot.entity.position) <= radius) return entity;
      }
    } catch (_) {}
    return null;
  }

  _movementEnabled() {
    return Boolean(this.config.features && this.config.features.movement);
  }

  start() {
    if (!this._movementEnabled()) {
      this._log('movement disabled; autonomy loop not started');
      return false;
    }
    if (this.running) return true;
    this.running = true;
    this.lastMoveAt = Date.now();

    // 订阅死亡事件：连续死亡的判断要在这里做，
    // 否则复活后只会原地继续挨打。
    if (this.connection && typeof this.connection.on === 'function' && !this._deathBound) {
      this._deathBound = true;
      this.connection.on('death', () => this._onDeath());
      this.connection.on('spawn', () => this._onRespawn());
    }

    this.timer = setInterval(() => {
      void this._tick().catch((error) => this._log('tick failed: ' + errorText(error)));
    }, 500);
    return true;
  }

  /**
   * 绑定 bot 上的受伤/被攻击事件。bot 对象在重连后会换，所以要按实例判断。
   */
  _bindBotEvents(bot) {
    if (!bot || this._boundBot === bot) return;
    this._boundBot = bot;

    // entityHurt 在 bot 自己被打时触发，参数是被打的实体（就是 bot 自己）
    try {
      bot.on('entityHurt', (entity) => {
        if (entity === bot.entity) this._onHurt(null);
      });
    } catch (_) {}

    // 有些版本用 'hurt' 或者 health 掉得很快，兜底用 health 变化检测
    try {
      bot.on('health', () => {
        const hp = Number(bot.health);
        if (!Number.isFinite(hp)) return;
        const prev = this._lastHp;
        this._lastHp = hp;
        if (Number.isFinite(prev) && prev - hp >= 2 && Date.now() - (this.lastHurtAt || 0) > 800) {
          this._onHurt(null);   // 掉了 2 点以上当作被攻击
        }
      });
    } catch (_) {}
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getMode() {
    return this.mode;
  }

  _stopMotion(bot, stopDigging) {
    try {
      skills.stopFollow(bot);
      skills.stopMove(bot);
      if (bot && typeof bot.clearControlStates === 'function') bot.clearControlStates();
      if (stopDigging && bot && typeof bot.stopDigging === 'function') bot.stopDigging();
    } catch (_) {
      return;
    }
  }

  setMode(mode, args = {}) {
    try {
      const requested = String(mode || '').trim().toLowerCase();
      if (!MODES.has(requested)) return { ok: false, error: 'unknown mode: ' + requested };
      if (requested !== 'idle' && !this._movementEnabled()) {
        return { ok: false, error: 'movement disabled by config (features.movement=false)' };
      }

      const bot = this._getBot();
      if (requested !== 'idle' && (!bot || !this._isReady())) {
        return { ok: false, error: 'bot offline or not ready' };
      }

      const nextArgs = args && typeof args === 'object' ? { ...args } : {};
      if (requested === 'follow') {
        const name = String(nextArgs.player ?? nextArgs.target ?? nextArgs.name ?? '').trim();
        if (!name) return { ok: false, error: 'follow mode requires a player' };
        if (!skills.follow.isPlayerVisible(bot, name)) {
          return { ok: false, error: 'player not visible: ' + name };
        }
        nextArgs.player = name;
      }
      if (requested === 'mine') {
        const blockId = String(nextArgs.block ?? nextArgs.id ?? nextArgs.type ?? '').trim();
        if (!blockId) return { ok: false, error: 'mine mode requires a block id' };
        nextArgs.block = blockId;
        // 计数从 0 开始，开始时间用于 maxMinutes
        this.minedCount = 0;
        this.mineStartedAt = Date.now();
        this.mineDoneReason = '';
        this.modeDoneReasons.mine = '';
      }

      if (requested === 'sleep') {
        // 白天睡觉会立刻判定"天亮了"然后秒退，白跑一趟，直接拒绝
        if (!this._isNight(bot)) {
          return { ok: false, error: '现在是白天，不用睡。想休息可以选 idle，或者去挖矿/探索。' };
        }
      }

      this.mode = requested;
      this.modeDoneReasons[requested] = '';
      if (requested === 'mine') this.mineDoneReason = '';
      this.modeArgs = nextArgs;
      this.busy = null;
      this.lastPosition = null;
      this.lastMoveAt = Date.now();
      this.lastFollowAt = 0;
      this.lastMineAt = 0;
      this.lastWanderAt = 0;
      this.guardState = { lastAttackAt: 0 };

      if (requested === 'idle') {
        this._stopMotion(bot, true);
      } else if (requested === 'guard') {
        this._stopMotion(bot, false);
      } else if (requested === 'follow') {
        const result = skills.startFollow(bot, nextArgs.player);
        if (!result.ok) {
          this.mode = 'idle';
          return result;
        }
      } else {
        this._stopMotion(bot, false);
      }

      return { ok: true, mode: requested };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  _needsMovement(bot) {
    try {
      if (bot && bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) {
        return true;
      }
    } catch (_) {
      return false;
    }

    if (this.mode === 'follow') {
      const player = skills.findPlayer(bot, this.modeArgs.player);
      if (player && player.entity && player.entity.position) {
        return distance(bot.entity.position, player.entity.position) > 3.2;
      }
    }
    if (this.mode === 'mine' && this.modeArgs.block) {
      const radius = Math.max(1, Math.min(64, Number(this.modeArgs.radius) || 32));
      const block = skills.findNearestBlock(bot, this.modeArgs.block, radius);
      if (block) return distance(bot.entity.position, block.position) > 4.5;
    }
    return false;
  }

  _checkStuck(bot) {
    if (this.busy) return;
    if (!this._needsMovement(bot)) {
      this.lastPosition = null;
      this.lastMoveAt = Date.now();
      return;
    }

    const position = bot.entity && bot.entity.position;
    if (!position) return;
    const now = Date.now();
    if (!this.lastPosition) {
      this.lastPosition = { x: position.x, y: position.y, z: position.z };
      this.lastMoveAt = now;
      return;
    }

    const moved = distance(position, this.lastPosition);
    this.lastPosition = { x: position.x, y: position.y, z: position.z };
    if (moved > 0.25) {
      this.lastMoveAt = now;
      return;
    }

    if (now - this.lastMoveAt < 3000) return;
    this.lastMoveAt = now;
    this.busy = 'stuck';
    const side = Math.random() < 0.5 ? 'left' : 'right';
    try {
      bot.setControlState('jump', true);
      bot.setControlState(side, true);
    } catch (_) {
      this.busy = null;
      return;
    }
    setTimeout(() => {
      try {
        bot.setControlState('jump', false);
        bot.setControlState(side, false);
      } catch (_) {
        this.busy = null;
        return;
      }
      if (this.busy === 'stuck') this.busy = null;
    }, 500);
  }

  _blockNameAt(bot, position) {
    try {
      const block = bot.blockAt(position);
      return block && block.name ? String(block.name).toLowerCase().split(':').pop() : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 落水自救。mineflayer 的寻路在水里会原地挣扎（isMoving 恒真但坐标不动），
   * 之前表现为"挖矿 200 秒一个都没挖到"，全耗在水中超时上。
   *
   * 这里用最原始的办法：持续 jumps + 朝岸边方向前进，直到踩到实地。
   */
  _checkWater(bot) {
    try {
      const entity = bot.entity;
      if (!entity || !entity.position) return false;

      const inWater = entity.isInWater === true
        || (bot.blockAt(entity.position) || {}).name === 'water'
        || (bot.blockAt(entity.position.offset(0, 1, 0)) || {}).name === 'water';

      if (!inWater) {
        if (this.busy === 'water') this.busy = null;
        this.waterTicks = 0;
        return false;
      }

      // 已经在处理就继续推，别被上层模式打断
      this.waterTicks = (this.waterTicks || 0) + 1;

      // 泡太久（>40 秒）就放弃机械挣扎，交给上层决策
      if (this.waterTicks > 40) {
        if (this.mode === 'mine') this._finishMode('mine', '在水里出不来');
        this.waterTicks = 0;
        return false;
      }

      if (this.waterTicks === 1) {
        this._notice('掉水里了，往岸上游');
      }

      // 朝当前朝向前进 + 持续跳跃，跳出水面后就有机会踩到岸
      try {
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        // 每隔几秒换个方向，避免一直顶墙
        if (this.waterTicks % 12 === 0) {
          entity.yaw += Math.PI / 2;
        }
      } catch (_) {
        return false;
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  _checkLava(bot) {
    const position = bot.entity && bot.entity.position;
    if (!position) return false;
    const now = Date.now();
    if (now - this.lastLavaAt < 3000) return true;

    const Vec3 = position.constructor;
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    const z = Math.floor(position.z);
    const aheadX = Math.floor(position.x - Math.sin(bot.entity.yaw || 0) * 1.5);
    const aheadZ = Math.floor(position.z + Math.cos(bot.entity.yaw || 0) * 1.5);
    const names = [
      this._blockNameAt(bot, new Vec3(x, y, z)),
      this._blockNameAt(bot, new Vec3(x, y - 1, z)),
      this._blockNameAt(bot, new Vec3(aheadX, y, aheadZ)),
      this._blockNameAt(bot, new Vec3(aheadX, y - 1, aheadZ)),
    ];
    if (!names.some((name) => name === 'lava' || name === 'flowing_lava')) return false;

    this.lastLavaAt = now;
    this.busy = 'lava';
    this._stopMotion(bot, false);
    try {
      bot.setControlState('jump', true);
      bot.setControlState('back', true);
    } catch (_) {
      this.busy = null;
      return false;
    }
    this._notice('lava nearby, retreating');
    setTimeout(() => {
      try {
        bot.setControlState('jump', false);
        bot.setControlState('back', false);
      } catch (_) {
        this.busy = null;
        return;
      }
      if (this.busy === 'lava') this.busy = null;
    }, 900);
    return true;
  }

  _checkLowHealth(bot) {
    if (!Number.isFinite(bot.health) || bot.health >= 8) return false;
    const now = Date.now();

    // 低血的处理统一走 escape（往远离怪的方向持续跑），
    // 不用"后退两步"——那点距离怪一步就追上，等于站着挨打。
    if (this.mode !== 'escape') {
      const previous = this.mode;
      this.busy = null;
      this._stopMotion(bot, false);
      this.mode = 'escape';
      this.modeArgs = { until: now + 15000 };
      this._notice(`血量 ${Math.round(bot.health)}，脱离战斗（原模式 ${previous}）`);
      if (this.recordEvent) {
        this.recordEvent({ event: 'retreat', hp: Math.round(bot.health), from: previous });
      }
    }
    return true;
  }

  _foodItem(bot) {
    try {
      if (!bot.inventory || typeof bot.inventory.items !== 'function') return null;
      return bot.inventory.items().find((item) => {
        if (!item || !item.name) return false;
        if (FOOD_NAMES.has(item.name)) return true;
        const registry = bot.registry && (bot.registry.foodsByName || bot.registry.foods);
        return Boolean(registry && registry[item.name]);
      }) || null;
    } catch (_) {
      return null;
    }
  }

  _startEating(bot) {
    if (this.busy) return;
    if (!Number.isFinite(bot.food) || bot.food >= 18) return;
    const now = Date.now();
    if (now - this.lastEatAt < 5000) return;
    const item = this._foodItem(bot);
    this.lastEatAt = now;
    if (!item) return;

    this.busy = 'eat';
    void (async () => {
      try {
        await bot.equip(item, 'hand');
        await Promise.race([bot.consume(), sleep(6000)]);
      } catch (error) {
        this._log('auto eat failed: ' + errorText(error));
      } finally {
        if (this.busy === 'eat') this.busy = null;
      }
    })();
  }

  _followTick(bot, now) {
    if (now - this.lastFollowAt < 1000) return;
    this.lastFollowAt = now;
    const result = skills.followTick(bot, this.modeArgs.player, { distance: 2 });
    if (!result.ok && now - this.lastFollowWarnAt > 30000) {
      this.lastFollowWarnAt = now;
      this._notice('follow target unavailable: ' + String(this.modeArgs.player || ''));
    }
  }

  _guardTick(bot, now) {
    if (now - this.lastGuardAt < 800) return;
    this.lastGuardAt = now;

    // 血量低时不要傻站着。之前是直接 return，怪在旁边却既不还手也不跑，
    // 结果在出生点被反复咬死。现在改成先跑开。
    if (Number.isFinite(bot.health) && bot.health < 8) {
      if (this.mode !== 'escape') {
        this._notice(`血量 ${Math.round(bot.health)}，守家中止，先跑`);
        this.mode = 'escape';
        this.modeArgs = { until: Date.now() + 15000 };
      }
      return;
    }

    // 半径要和 mine 的"附近有敌对生物"检测一致（8 格），
    // 否则会出现"检测到怪就停工，但 guard 够不着"的死锁
    const radius = Math.max(6, Math.min(16, Number(this.modeArgs.radius) || 8));
    skills.guardTick(bot, { radius, cooldownMs: 900, state: this.guardState });
  }

  /**
   * mine 模式的停止条件。返回原因字符串表示应该停，null 表示继续。
   *
   * 没有这层的话，她会对着同一片区域无限挖到天荒地老：
   * 背包满了还在挖、天黑了还在砍、旁边站着僵尸还在砍树。
   */
  _mineStopReason(bot, now) {
    const args = this.modeArgs || {};

    // 1. 挖够数了
    const want = Number(args.count);
    if (Number.isFinite(want) && want > 0 && this.minedCount >= want) {
      return `已挖够 ${want} 个`;
    }

    // 2. 超时了
    const limitMin = Number(args.maxMinutes);
    if (Number.isFinite(limitMin) && limitMin > 0 && this.mineStartedAt) {
      const elapsedMin = (now - this.mineStartedAt) / 60000;
      if (elapsedMin >= limitMin) return `已挖了 ${limitMin} 分钟`;
    }

    // 3. 背包快满了
    const empty = bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
      ? bot.inventory.emptySlotCount()
      : null;
    if (empty !== null && empty <= 2) return `背包快满了（剩 ${empty} 格）`;

    // 4. 天黑了——但只在地表才计较。
    // 地下挖矿不受昼夜影响，在地里因为"天黑"收工纯属浪费。
    if (args.nightOff !== false && this._isNight(bot) && this._isOutdoors(bot)) {
      return '天黑了';
    }

    // 5. 附近有敌对生物（除非显式允许）
    // 地下挖矿时这个检查放宽，否则洞里一只僵尸就要收工，太频繁
    if (args.avoidHostiles !== false && this._isOutdoors(bot)) {
      const hostile = this._nearestHostile(bot, 8);
      if (hostile) return `附近有 ${hostile}`;
    }

    return null;
  }
  /** 判断是否在地表：头顶上方 8 格内能看到天空就算。 */
  _isOutdoors(bot) {
    try {
      const pos = bot.entity.position.floored();
      for (let dy = 1; dy <= 8; dy += 1) {
        const block = bot.blockAt(pos.offset(0, dy, 0));
        if (!block) continue;
        if (block.name !== 'air' && block.name !== 'cave_air' && block.boundingBox !== 'empty') {
          return false; // 头顶有实体方块 = 在洞里
        }
      }
      return true;
    } catch (_) {
      return true; // 判断不了就按地表处理，保守
    }
  }

  _isNight(bot) {
    try {
      const t = bot.time && bot.time.timeOfDay;
      if (!Number.isFinite(t)) return false;
      return t >= 13000 && t <= 23000;
    } catch (_) {
      return false;
    }
  }

  _nearestHostile(bot, radius = 8) {
    try {
      const HOSTILE = new Set([
        'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
        'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator',
        'ravager', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton',
        'piglin_brute', 'hoglin', 'zoglin', 'warden',
      ]);
      for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity === bot.entity || !entity.position) continue;
        const name = String(entity.name || entity.type || '').replace('minecraft:', '');
        if (!HOSTILE.has(name)) continue;
        const d = entity.position.distanceTo(bot.entity.position);
        if (d <= radius) return name;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  _finishMine(reason) {
    if (this.mode !== 'mine') return;
    this._finishMode('mine', reason, {
      mined: this.minedCount,
      reason,
    });
  }

  /** 通用收工：结束当前模式并回到 idle，记录原因供意图层判断。 */
  _finishMode(modeName, reason, extra) {
    if (this.mode !== modeName) return;
    this.modeDoneReasons[modeName] = reason;
    if (modeName === 'mine') this.mineDoneReason = reason;
    this._notice(modeName + ' 结束：' + reason, { reason, ...(extra || {}) });
    this._log(modeName + ' finished: ' + reason);
    this.mode = 'idle';
    this.modeArgs = {};
    this.busy = null;
  }

  getModeDoneReason(modeName) {
    return this.modeDoneReasons[String(modeName || '')] || '';
  }

  /**
   * 挖矿目标选择，跳过已知挖不动的方块。
   *
   * 没有这层的话，findNearestBlock 每轮都返回最近的那一块，
   * 而那一块可能够不到/被保护/工具不对，于是无限重试同一块——
   * 表现就是"她一直对着一个方块动，砍不下来"。
   */
  _findMineTarget(bot, radius) {
    const wanted = this.modeArgs.block;
    const bad = this.badBlocks || (this.badBlocks = new Map());

    // 黑名单有保质期：60 秒后重试，避免真的永久放弃
    const now = Date.now();
    for (const [key, at] of bad) {
      if (now - at > 60000) bad.delete(key);
    }

    const isBad = (block) => {
      if (!block || !block.position) return true;
      const key = `${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}`;
      return bad.has(key);
    };

    try {
      // 先试默认的最近方块
      const nearest = skills.findNearestBlock(bot, wanted, radius);
      if (nearest && !isBad(nearest)) return nearest;

      // 最近的那块不能用，就扫一圈找别的
      const spec = skills.expandBlockTarget(wanted);
      if (!spec) return null;
      const matches = (name) =>
        spec.exact
          ? name === spec.exact
          : spec.members
            ? spec.members.includes(name)
            : spec.suffix
              ? name.split(':').pop().includes(spec.suffix)
              : false;

      const step = 2;
      for (let r = 2; r <= radius; r += step) {
        for (let dx = -r; dx <= r; dx += step) {
          for (let dz = -r; dz <= r; dz += step) {
            for (let dy = -4; dy <= 6; dy += 2) {
              const pos = bot.entity.position.offset(dx, dy, dz);
              const block = bot.blockAt(pos);
              if (!block || !block.name) continue;
              if (!matches(skills.normalizeBlockName(block.name))) continue;
              if (isBad(block)) continue;
              return block;
            }
          }
        }
      }
    } catch (_) {
      // 扫不到就返回 null，让上层报"没有可挖的"
    }
    return null;
  }

  _markBadBlock(block, reason) {
    if (!block || !block.position) return;
    if (!this.badBlocks) this.badBlocks = new Map();
    const key = `${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}`;
    this.badBlocks.set(key, Date.now());
    // 黑名单别无限增长
    if (this.badBlocks.size > 200) {
      const first = this.badBlocks.keys().next().value;
      this.badBlocks.delete(first);
    }
    const pos = `${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}`;
    this._log(`skip block ${pos}: ${reason}`);
  }

  _mineTick(bot, now) {
    if (this.busy) return;
    if (now - this.lastMineAt < 800) return;

    // 先判断该不该停，再决定要不要继续挖
    const stop = this._mineStopReason(bot, now);
    if (stop) {
      // 附近有怪时给个冷却，避免反复播报
      if (now - this.lastDangerWarnAt > 20000 || !stop.startsWith('附近有')) {
        this.lastDangerWarnAt = now;
        this._finishMine(stop);
      } else {
        this._finishMine(stop);
      }

      // 因为身边有怪而收工的话，别在原地等着，先跑开一段距离。
      // 不然怪会一直跟着，下一次挖矿又立刻被打断。
      if (stop.startsWith('附近有')) {
        this.mode = 'escape';
        this.modeArgs = { until: now + 12000 };
      }
      return;
    }

    this.lastMineAt = now;
    const radius = Math.max(1, Math.min(64, Number(this.modeArgs.radius) || 32));
    const block = this._findMineTarget(bot, radius);
    if (!block) {
      if (now - this.lastMineWarnAt > 60000) {
        this.lastMineWarnAt = now;
        const skipped = this.badBlocks ? this.badBlocks.size : 0;
        this._notice(
          `附近 ${radius} 格内没有可挖的 ${this.modeArgs.block}` +
          (skipped ? `（已跳过 ${skipped} 个挖不动的）` : '')
        );
      }
      return;
    }

    const gap = distance(bot.entity.position, block.position);
    if (gap > 4.5) {
      this.busy = 'mine-move';
      void skills.moveTo(
        bot,
        { x: block.position.x, y: block.position.y, z: block.position.z },
        { range: 2, timeoutMs: 8000 }
      ).then((result) => {
        if (!result.ok && this.mode === 'mine') {
          this._log('mine move failed: ' + result.error);
          // 走不过去就把这块拉黑，别一直盯着同一块反复超时
          this._markBadBlock(block, '走不到');
        }
      }).finally(() => {
        if (this.busy === 'mine-move') this.busy = null;
      });
      return;
    }

    this.busy = 'mine';
    void skills.mineBlock(bot, block).then((result) => {
      if (result.ok) {
        this.minedCount += 1;
      } else {
        // 挖不动（够不到、被保护、工具不对……）就换一块，
        // 否则 findNearestBlock 每轮都返回同一块，永远卡在这里。
        this._markBadBlock(block, result.error);
      }
      if (!result.ok && this.mode === 'mine' && now - this.lastMineWarnAt > 60000) {
        this.lastMineWarnAt = now;
        this._notice('mining failed: ' + result.error);
      }
    }).finally(() => {
      if (this.busy === 'mine') this.busy = null;
    });
  }

  /**
   * 睡觉：夜里找床睡过去，天亮自动醒。
   *
   * 没有这个的话，一到夜晚 mine 就被"天黑了"打断，模型只好选待命，
   * 一整晚时间全浪费在空转上。
   */
  async _sleepTick(bot, now) {
    if (this.busy) return;
    if (now - this.lastSleepAt < 5000) return;
    this.lastSleepAt = now;

    // 天亮了就醒
    if (!this._isNight(bot)) {
      const wasSleeping = this.sleeping;
      this.sleeping = false;
      this._finishMode('sleep', '天亮了');
      if (wasSleeping) {
        try {
          if (bot.wake) {
            const bed = bot.findBlock({ matching: (b) => b && /_bed$/.test(b.name), maxDistance: 4 });
            if (bed) await bot.wake();
          }
        } catch (_) {}
      }
      return;
    }

    // 已经在睡
    if (this.sleeping) return;

    // 附近没有床就先找一张
    let bed = null;
    try {
      bed = bot.findBlock({
        matching: (b) => Boolean(b && /_bed$/.test(b.name)),
        maxDistance: 24,
      });
    } catch (_) {
      bed = null;
    }

    if (!bed) {
      // 没床：别整晚站着。改成往地下挖矿——地下不受昼夜影响，
      // 既安全又不浪费一晚上。
      this._finishMode('sleep', '没找到床');
      return;
    }

    this.busy = 'sleep';
    try {
      const gap = distance(bot.entity.position, bed.position);
      if (gap > 2.5) {
        const moved = await skills.moveTo(
          bot,
          { x: bed.position.x, y: bed.position.y, z: bed.position.z },
          { range: 1.5, timeoutMs: 15000 }
        );
        if (!moved.ok) {
          this._finishMode('sleep', '走不到床边');
          return;
        }
      }
      await bot.sleep(bed);
      this.sleeping = true;
      this._notice('睡下了');
    } catch (error) {
      this._notice('睡觉失败：' + errorText(error));
      this._finishMode('sleep', '睡觉失败');
    } finally {
      if (this.busy === 'sleep') this.busy = null;
    }
  }

  _wanderTick(bot, now) {
    if (this.busy) return;
    if (now - this.lastWanderAt < 3000) return;
    try {
      if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) return;
    } catch (_) {
      return;
    }
    this.lastWanderAt = now;
    const position = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const distanceAway = 6 + Math.random() * 8;
    this.busy = 'wander';
    void skills.moveTo(
      bot,
      {
        x: position.x + Math.cos(angle) * distanceAway,
        y: position.y,
        z: position.z + Math.sin(angle) * distanceAway,
      },
      { range: 2, timeoutMs: 8000 }
    ).finally(() => {
      if (this.busy === 'wander') this.busy = null;
    });
  }

  async _tick() {
    if (!this._movementEnabled() || !this._isReady()) {
      this.lastPosition = null;
      return;
    }
    const bot = this._getBot();
    if (!bot || !bot.entity || !bot.entity.position) return;
    this._bindBotEvents(bot);
    const now = Date.now();

    if (this._checkLava(bot)) return;
    if (this._checkWater(bot)) return;
    if (this._checkLowHealth(bot)) {
      this._escapeTick(bot, now);
      this._checkStuck(bot);
      return;
    }
    this._startEating(bot);
    this._checkStuck(bot);
    if (this.busy) return;

    switch (this.mode) {
      case 'follow':
        this._followTick(bot, now);
        break;
      case 'guard':
        this._guardTick(bot, now);
        break;
      case 'mine':
        this._mineTick(bot, now);
        break;
      case 'wander':
        this._wanderTick(bot, now);
        break;
      case 'sleep':
        this._sleepTick(bot, now);
        break;
      case 'escape':
        this._escapeTick(bot, now);
        break;
      default:
        break;
    }
  }
}

function createAutonomy(options = {}) {
  return new Autonomy(options);
}

module.exports = {
  Autonomy,
  createAutonomy,
  MODES,
  FOOD_NAMES,
};
