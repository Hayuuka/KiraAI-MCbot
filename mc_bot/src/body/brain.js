'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULTS } = require('../config');
const { perceive } = require('./perception');
const { createAgenda } = require('./agenda');
const { createDefaultInterrupts } = require('./interrupts');
const { createDrives } = require('./drives');
const { createArbiter } = require('./arbiter');
const { createWatchdog } = require('./watchdog');
const taskRegistry = require('../tasks');
const skills = require('../skills');
const { FAILURE_REASONS } = require('../tasks/base');

const GUARD_YIELD_TASKS = new Set(['collectBlock', 'digDown', 'mineOre', 'craft', 'build']);

const STAGE1_EQUIVALENTS = Object.freeze({
  collectBlock: new Set(['mine']),
  idle: new Set(['idle']),
  goto: new Set(['wander']),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, extra) {
  if (!isPlainObject(extra)) return base;
  const output = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(output[key])) output[key] = merge(output[key], value);
    else output[key] = value;
  }
  return output;
}

function createJsonlRecorder(dir, file, log) {
  let ready = false;
  return (entry) => {
    try {
      if (!ready) {
        fs.mkdirSync(dir, { recursive: true });
        ready = true;
      }
      fs.appendFile(path.join(dir, file), JSON.stringify(entry) + '\n', (error) => {
        if (!error) return;
        try {
          const sink = log && (log.warn || log.log);
          if (typeof sink === 'function') sink.call(log, '[brain] record failed: ' + error.message);
        } catch (_) {
          return;
        }
      });
    } catch (error) {
      try {
        const sink = log && (log.warn || log.log);
        if (typeof sink === 'function') sink.call(log, '[brain] record failed: ' + error.message);
      } catch (_) {
        return;
      }
    }
  };
}

function compactPerception(perception) {
  if (!perception) return null;
  return {
    hp: perception.self.hp,
    food: perception.self.food,
    pos: perception.self.pos,
    light: perception.world.light,
    isDay: perception.world.isDay,
    underground: perception.world.underground,
    threats: perception.threats.map((threat) => ({
      type: threat.type,
      dist: threat.dist,
    })),
  };
}

class Brain {
  constructor(options = {}) {
    const provided = options.brainConfig || (options.config && options.config.brain) || {};
    this.config = merge(merge({}, DEFAULTS.brain), provided);
    this.shadowMode = this.config.shadowMode !== false;
    this.connection = options.connection || {};
    this.legacy = options.legacy || null;
    this.mind = options.mind || null;
    this.projects = options.projects || null;
    this.diary = options.diary || null;
    this.human = options.human || null;
    this.voice = options.voice || null;
    this._lastContext = null;
    this.log = options.log || console;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.tasks = options.tasks || taskRegistry;
    this.stats = {
      ticks: 0,
      offlineTicks: 0,
      interruptedTicks: 0,
      pushed: 0,
      done: 0,
      failed: 0,
      lastTickAt: null,
    };
    this.running = false;
    this.timer = null;
    this.perception = null;
    this._startedAt = null;
    this._lastArbiterAt = 0;
    this._lastDriveAt = 0;
    this._lastTickAt = 0;
    this._offlineSince = null;
    this._offlineLogged = false;
    this._lastUnavailableLogAt = 0;
    this._wasInterrupted = false;
    this._lastInterruptKind = null;
    this._boundBot = null;
    this._lastHurtAt = 0;
    this._hurtSourceId = null;
    this._lastRejectAt = new Map();

    const recordDir = options.recordDir || path.resolve(__dirname, '..', '..', 'logs');
    const fallbackRecorder = createJsonlRecorder(recordDir, this.config.logFile, this.log);
    this.recordSink = typeof options.record === 'function' ? options.record : fallbackRecorder;

    this.drives = options.drives || createDrives({
      config: this.config.drives,
      now: this.now,
    });
    this.watchdog = options.watchdog || createWatchdog({
      config: this.config.watchdog,
      log: this.log,
    });
    this.arbiter = options.arbiter || createArbiter({
      config: this.config,
      tasks: this.tasks,
      drives: this.drives,
    });

    this.agenda = options.agenda || createAgenda({
      maxDepth: this.config.agenda.maxDepth,
      defaultLeaseMs: this.config.agenda.defaultLeaseMs,
      onEvent: (event, payload) => this._onAgendaEvent(event, payload),
    });
    this.interrupts = options.interrupts || createDefaultInterrupts({
      log: this.log,
      reflexConfig: this.config.reflex,
      onEvent: (event, payload) => this._record(event, payload),
    });
  }

  start() {
    if (!this.config.enabled) {
      this._log('新行为层未启用');
      return false;
    }
    if (this.running) return true;
    this.running = true;
    this._startedAt = this.now();
    this.timer = setInterval(() => this.tick(), this.config.tickMs);
    this._record('brain_start', {
      shadowMode: this.shadowMode,
      tickMs: this.config.tickMs,
    });
    this._log('新行为层已启动，shadow=' + this.shadowMode);
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.agenda.clear(FAILURE_REASONS.CANCELLED);
    this._record('brain_stop', { ticks: this.stats.ticks });
    return true;
  }

  /**
   * 用户要求"停下"：清空任务栈并停掉当前动作，但行为层继续运行。
   * 与 stop() 的区别是停下后她仍能响应新指令，反射也仍然工作
   * （撞到岩浆还是会跑）。
   */
  stopAll(reason = 'user_stop') {
    const bot = this._getBot();
    if (this.agenda) this.agenda.clear(FAILURE_REASONS.CANCELLED);
    if (bot) {
      try {
        if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
        if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
        if (typeof bot.stopDigging === 'function') bot.stopDigging();
      } catch (_) {
        // 断线时控制状态可能已清空
      }
    }
    this._record('brain_stop_all', { reason });
    this._log('用户要求停下，任务栈已清空');
    return true;
  }

  /**
   * 定期检查护甲。equipBestArmor 之前从来没被任何地方调用，
   * 所以她背包里有甲也一直裸着。这里每 30 秒补一次，
   * 只在"背包里有更好的甲"时才真的动手。
   */
  _autoArmor(ctx) {
    if (!ctx || ctx.shadow || !ctx.bot) return;
    const now = ctx.now;
    if (this._lastArmorCheckAt && now - this._lastArmorCheckAt < 30000) return;
    this._lastArmorCheckAt = now;

    const armor = skills.inventory;
    if (!armor || typeof armor.equipBestArmor !== 'function') return;
    Promise.resolve(armor.equipBestArmor(ctx.bot))
      .then((ok) => {
        if (ok) this._record('armor_equipped', {});
      })
      .catch(() => {});
  }

  tick() {
    if (!this.running) return null;
    const now = this.now();
    this.stats.ticks += 1;
    this.stats.lastTickAt = now;
    this._lastTickAt = now;

    const bot = this._getBot();
    const ready = this._isReady();
    const perception = perceive(bot, {
      now,
      ready,
      config: this.config.perception,
    });
    this.perception = perception;

    if (!ready || !bot || !bot.entity || !perception.self.pos) {
      this.stats.offlineTicks += 1;
      this._noteUnavailable(now);
      return this.snapshot();
    }
    this._offlineSince = null;
    this._offlineLogged = false;
    this._bindBotEvents(bot);

    if (now - this._lastDriveAt >= this.config.driveMs) {
      this._lastDriveAt = now;
      this.drives.update(perception, now);
    }

    const ctx = this._context(now, bot);
    this._lastContext = ctx;
    const active = this.interrupts.evaluate(perception, ctx);
    if (active) {
      const before = this.agenda.top();
      this.agenda.freezeTop(ctx);
      this.interrupts.run(active, ctx);
      this.stats.interruptedTicks += 1;
      this._wasInterrupted = true;
      // 同一次威胁只记一条，否则每 tick 一条会把日志刷爆
      // （实测每小时 668 条，真正有用的记录全被淹没）。
      if (this._lastInterruptKind !== active.kind) {
        this._lastInterruptKind = active.kind;
        this._record('interrupt_active', {
          kind: active.kind,
          top: before ? { id: before.id, kind: before.kind } : null,
        });
      }
      return this.snapshot();
    }

    if (this._wasInterrupted) {
      this.agenda.thawTop(ctx);
      const top = this.agenda.top();
      if (top && typeof top.onResume === 'function') top.onResume(ctx);
      this._wasInterrupted = false;
      this._lastInterruptKind = null;
      this._record('interrupt_clear', {
        top: top ? { id: top.id, kind: top.kind } : null,
      });
    }

    if (now - this._lastArbiterAt >= this.config.arbiterMs) {
      this._lastArbiterAt = now;
      try {
        this._arbitrate(ctx);
      } catch (error) {
        this._record('brain_error', {
          stage: 'arbitrate',
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    try {
      this.agenda.tick(ctx);
    } catch (error) {
      this._record('brain_error', {
        stage: 'agenda_tick',
        message: error && error.message ? error.message : String(error),
      });
      this.agenda.dropTop(FAILURE_REASONS.INTERNAL_ERROR);
    }

    try {
      this.watchdog.check(ctx);
    } catch (error) {
      this._record('brain_error', {
        stage: 'watchdog',
        message: error && error.message ? error.message : String(error),
      });
    }

    if (this.mind && typeof this.mind.maybeAsk === 'function') {
      try {
        this.mind.maybeAsk(ctx);
      } catch (error) {
        this._record('brain_error', {
          stage: 'mind',
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    if (this.human && typeof this.human.update === 'function') {
      try {
        this.human.update(ctx);
      } catch (error) {
        this._record('brain_error', {
          stage: 'human',
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    this._autoArmor(ctx);
    if (this.voice && typeof this.voice.tick === 'function') {
      try {
        this.voice.tick(ctx);
      } catch (error) {
        this._record('brain_error', {
          stage: 'voice',
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    return this.snapshot();
  }

  snapshot() {
    const top = this.agenda.top();
    const doing = top ? (top.toJSON ? top.toJSON() : {
      id: top.id,
      kind: top.kind,
      state: top.state,
    }) : null;
    return {
      running: this.running,
      shadowMode: this.shadowMode,
      ready: this.perception ? this.perception.ready : this._isReady(),
      perception: this.perception,
      doing,
      agenda: this.agenda.snapshot(),
      drives: this.drives.snapshot(),
      interrupts: this.interrupts.snapshot(),
      watchdog: this.watchdog.snapshot({ agenda: this.agenda, now: this.now() }),
      mind: this.mind && typeof this.mind.snapshot === 'function' ? this.mind.snapshot() : null,
      project: this.projects && typeof this.projects.snapshot === 'function' ? this.projects.snapshot() : null,
      human: this.human && typeof this.human.snapshot === 'function' ? this.human.snapshot() : null,
      voice: this.voice && typeof this.voice.snapshot === 'function' ? this.voice.snapshot() : null,
      stats: { ...this.stats },
    };
  }

  _getBot() {
    return typeof this.connection.getBot === 'function' ? this.connection.getBot() : null;
  }

  _isReady() {
    return typeof this.connection.isReady === 'function' ? Boolean(this.connection.isReady()) : Boolean(this._getBot());
  }

  _context(now, bot) {
    return {
      now,
      bot,
      perception: this.perception,
      shadow: this.shadowMode,
      config: this.config,
      agenda: this.agenda,
      tasks: this.tasks,
      drives: this.drives,
      watchdog: this.watchdog,
      lastHurtAt: this._lastHurtAt,
      hurtSourceId: this._hurtSourceId,
      record: (event, payload) => this._record(event, payload),
    };
  }

  _arbitrate(ctx) {
    const top = this.agenda.top();
    const choice = this.arbiter.step(ctx);
    if (!choice) {
      this._record('local_no_decision', {});
      return null;
    }
    if (this.mind && typeof this.mind.observeChoice === 'function') {
      this.mind.observeChoice(choice, ctx);
    }

    const configuredGuardYieldMs = Number(this.config.local && this.config.local.guardYieldMs);
    const guardYieldMs = Number.isFinite(configuredGuardYieldMs) ? configuredGuardYieldMs : 120000;
    const guardElapsedMs = top && top.kind === 'guard' &&
      typeof top.elapsedSec === 'function'
      ? top.elapsedSec(ctx) * 1000
      : 0;
    const guardYielded = Boolean(
      top &&
      top.kind === 'guard' &&
      guardElapsedMs >= guardYieldMs &&
      GUARD_YIELD_TASKS.has(choice.kind)
    );
    if (top && choice.priority <= top.priority && !guardYielded) {
      // 同类同优先级的重复选择是正常的，不记日志。
      if (choice.kind === top.kind) return null;

      const key = `${top.kind}>${choice.kind}`;
      const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : this.now();
      const lastAt = this._lastRejectAt.get(key);
      if (lastAt == null || now - lastAt >= 30000) {
        this._lastRejectAt.set(key, now);
        this._record('preempt_rejected', {
          from: top.kind,
          to: choice.kind,
          reason: choice.reason,
          topPriority: top.priority,
          choicePriority: choice.priority,
        });
      }
      return null;
    }

    const task = this.tasks.create(choice.kind, choice.args, {
      source: 'local',
      priority: choice.priority,
    });
    if (!task) {
      this._record('local_create_failed', { choice });
      return null;
    }
    if (guardYielded) {
      this._record('guard_yielded', {
        fromTop: 'guard',
        to: choice.kind,
        guardElapsedSec: Math.round(guardElapsedMs / 1000),
      });
    }

    const TaskClass = this.tasks.get ? this.tasks.get(choice.kind) : null;
    const leaseMs = TaskClass && TaskClass.selfTimed ? null : this.config.local.localLeaseMs;
    this.agenda.push(task, { now: ctx.now, leaseMs });
    if (top) {
      this._record('preempt', {
        from: top.kind,
        to: choice.kind,
        reason: choice.reason,
      });
    }
    this._record(this.shadowMode ? 'shadow_decision' : 'local_decision', {
      chosen: {
        kind: choice.kind,
        args: choice.args,
        priority: choice.priority,
        reason: choice.reason,
        note: choice.note || null,
      },
      legacy: this._legacyState(),
      stage1Equivalent: this._isStage1Equivalent(choice.kind, this._legacyState().mode),
      perception: compactPerception(ctx.perception),
    });
    return task;
  }

  _legacyState() {
    const mode = this.legacy && typeof this.legacy.getMode === 'function'
      ? this.legacy.getMode()
      : null;
    const current = this.legacy && this.legacy.intent ? this.legacy.intent.current : null;
    return {
      mode,
      intent: current ? {
        mode: current.mode,
        label: current.label,
        manual: Boolean(current.manual),
      } : null,
    };
  }

  _isStage1Equivalent(kind, legacyMode) {
    const covered = STAGE1_EQUIVALENTS[kind];
    return Boolean(covered && covered.has(legacyMode));
  }

  _bindBotEvents(bot) {
    if (!bot || this._boundBot === bot || typeof bot.on !== 'function') return;
    this._boundBot = bot;
    const markHurt = (sourceId = null) => {
      this._lastHurtAt = this.now();
      this._hurtSourceId = sourceId;
    };

    let lastHp = Number(bot.health);
    const hasThreat = () => Boolean(
      this.perception && Array.isArray(this.perception.threats) && this.perception.threats.length
    );
    try {
      bot.on('entityHurt', (entity) => {
        if (entity === bot.entity && hasThreat()) markHurt();
      });
    } catch (_) {
      // 某些 mineflayer 版本没有该事件。
    }
    try {
      bot.on('health', () => {
        const hp = Number(bot.health);
        if (!Number.isFinite(hp)) return;
        if (Number.isFinite(lastHp) && lastHp - hp >= 2 && hasThreat()) markHurt();
        lastHp = hp;
      });
    } catch (_) {
      // health 事件缺失时仍可由下一阶段的任务进度兜底。
    }
  }

  _onAgendaEvent(event, payload) {
    if (event === 'agenda_push') this.stats.pushed += 1;
    if (event === 'agenda_settle') {
      if (payload && payload.outcome === 'done') this.stats.done += 1;
      if (payload && payload.outcome === 'failed') this.stats.failed += 1;
    }
    if (this.mind && typeof this.mind.observeAgendaEvent === 'function') {
      try {
        this.mind.observeAgendaEvent(event, payload || {});
      } catch (_) {
        // 观察失败不能影响任务栈。
      }
    }
    if (event === 'agenda_settle' && this.projects && typeof this.projects.recordOutcome === 'function') {
      try {
        this.projects.recordOutcome(payload && payload.task, payload && payload.outcome);
      } catch (_) {
        // 项目存档失败不能影响任务栈。
      }
    }
    if (event === 'agenda_settle' && this.diary && typeof this.diary.record === 'function') {
      try {
        this.diary.record(payload || {}, this._lastContext);
      } catch (_) {
        // 日记失败不能影响任务栈。
      }
    }
    if (this.voice && typeof this.voice.onAgendaEvent === 'function') {
      try {
        this.voice.onAgendaEvent(event, payload || {}, this._lastContext);
      } catch (_) {
        // 台词失败不能影响任务栈。
      }
    }
    this._record(event, payload || {});
  }

  _noteUnavailable(now) {
    if (this._offlineSince === null) this._offlineSince = now;
    const elapsedSec = (now - this._offlineSince) / 1000;
    const watchdog = this.config.watchdog;
    if (!this._offlineLogged && elapsedSec >= watchdog.offlineLogSec) {
      this._offlineLogged = true;
      this._lastUnavailableLogAt = now;
      this._record('body_offline', { seconds: Math.round(elapsedSec) });
      this._log('bot 未就绪 ' + Math.round(elapsedSec) + 's，行为层等待连接');
      return;
    }
    if (this._offlineLogged && now - this._lastUnavailableLogAt >= watchdog.logRepeatSec * 1000) {
      this._lastUnavailableLogAt = now;
      this._log('bot 仍未就绪，已等待 ' + Math.round(elapsedSec) + 's');
    }
  }

  _record(event, payload = {}) {
    const entry = {
      ts: new Date(this.now()).toISOString(),
      event,
      shadowMode: this.shadowMode,
      ...payload,
    };
    try {
      this.recordSink(entry);
    } catch (error) {
      this._log('记录失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.warn || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[brain] ' + message);
    } catch (_) {
      return;
    }
  }
}

function createBrain(options = {}) {
  return new Brain(options);
}

module.exports = {
  Brain,
  createBrain,
  compactPerception,
  STAGE1_EQUIVALENTS,
};
