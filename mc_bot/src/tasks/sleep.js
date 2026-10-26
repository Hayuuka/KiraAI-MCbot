'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  startBeforeDuskTicks: 1200,
  bedSearchRadius: 24,
  flatSearchRadius: 6,
  reach: 3,
  moveTimeoutMs: 10000,
  sleepTimeoutMs: 5000,
  maxMinutes: 10,
  maxAttempts: 4,
  monsterRadius: 8,
});

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function monsterNearby(perception, radius) {
  const threats = perception && Array.isArray(perception.threats) ? perception.threats : [];
  return threats.find((threat) => Number(threat.dist) <= radius) || null;
}

class SleepTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.attempts = 0;
    this.sawNight = false;
    this.sleepObserved = false;
    this.monsterLogged = false;
  }

  static normalizeArgs(args = {}) {
    return {
      bedPos: args.bedPos && typeof args.bedPos === 'object' ? { ...args.bedPos } : null,
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    const perception = ctx.perception;
    if (!bot || !perception || bot.isSleeping) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.sleep;
    const before = Math.max(0, finiteNumber(config && config.startBeforeDuskTicks, FALLBACK.startBeforeDuskTicks));
    const isDay = perception.world.isDay;
    const ticksToDusk = Number(perception.world.ticksToDusk);
    const nightSoon = isDay === false || (isDay === true && Number.isFinite(ticksToDusk) && ticksToDusk <= before);
    if (!nightSoon || perception.world.underground) return null;

    const requested = ctx.args && ctx.args.bedPos;
    const nearby = requested && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(requested[axis])))
      ? skills.world.blockAt(bot, Number(requested.x), Number(requested.y), Number(requested.z))
      : skills.world.findBed(bot, finiteNumber(config && config.bedSearchRadius, FALLBACK.bedSearchRadius));
    const bedItem = skills.place.findBedItem(bot);
    if (requested && (!nearby || !/_bed$/.test(String(nearby.name || '').split(':').pop()))) return null;
    if (!nearby && !bedItem) return null;
    return {
      args: {},
      etaSec: 45,
      note: nearby ? '附近有床，走过去睡' : '背包有床，找平地放下再睡',
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.sleep) || {};
    this.settings = {
      startBeforeDuskTicks: Math.max(0, finiteNumber(config.startBeforeDuskTicks, FALLBACK.startBeforeDuskTicks)),
      bedSearchRadius: Math.max(4, finiteNumber(config.bedSearchRadius, FALLBACK.bedSearchRadius)),
      flatSearchRadius: Math.max(2, finiteNumber(config.flatSearchRadius, FALLBACK.flatSearchRadius)),
      reach: Math.max(1, finiteNumber(config.reach, FALLBACK.reach)),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      sleepTimeoutMs: Math.max(1000, finiteNumber(config.sleepTimeoutMs, FALLBACK.sleepTimeoutMs)),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      monsterRadius: Math.max(1, finiteNumber(config.monsterRadius, FALLBACK.monsterRadius)),
    };
    this.sawNight = ctx.perception && ctx.perception.world.isDay === false;
    return true;
  }

  progressMetric(ctx) {
    if (ctx.bot && ctx.bot.isSleeping) return 100;
    return this.attempts;
  }

  isDone(ctx) {
    if (ctx.bot && ctx.bot.isSleeping === true) {
      this.sleepObserved = true;
      return true;
    }
    const isDay = ctx.perception && ctx.perception.world.isDay;
    if (isDay === false) this.sawNight = true;
    return this.sawNight && isDay === true;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.SLEEP_REJECTED };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      const bed = skills.world.findBed(ctx.bot, this.settings.bedSearchRadius);
      this.markShadowPlan(ctx, {
        bed: bed ? [bed.position.x, bed.position.y, bed.position.z] : null,
        bedItem: Boolean(skills.place.findBedItem(ctx.bot)),
      });
      return;
    }
    if (ctx.perception.world.isDay === false) this.sawNight = true;
    if (ctx.perception.world.isDay !== false) return;
    if (this.pending) return;

    const monster = monsterNearby(ctx.perception, this.settings.monsterRadius);
    if (monster) {
      if (!this.monsterLogged) {
        this.monsterLogged = true;
        this._emit(ctx, 'sleep_wait_monsters', { type: monster.type, dist: monster.dist });
      }
      return;
    }
    this.monsterLogged = false;

    const requested = this.args.bedPos;
    const bed = requested
      ? skills.world.blockAt(ctx.bot, Number(requested.x), Number(requested.y), Number(requested.z))
      : skills.world.findBed(ctx.bot, this.settings.bedSearchRadius);
    if (bed) {
      if (!/_bed$/.test(String(bed.name || '').split(':').pop())) {
        this.fail(FAILURE_REASONS.NO_BED);
        return;
      }
      const distance = skills.move.positionDistance(ctx.bot.entity.position, bed.position);
      if (distance > this.settings.reach) {
        this.runPending('sleep_move', () => skills.move.moveTo(ctx.bot, bed.position, {
          range: 2,
          timeoutMs: this.settings.moveTimeoutMs,
        }));
        return;
      }
      this.runPending('sleep', () => withTimeout(
        ctx.bot.sleep(bed),
        this.settings.sleepTimeoutMs,
        'sleep'
      ));
      return;
    }

    if (!skills.place.findBedItem(ctx.bot)) {
      this.fail(FAILURE_REASONS.NO_BED);
      return;
    }
    const flat = skills.world.findFlatSpot(ctx.bot, { searchRadius: this.settings.flatSearchRadius });
    if (!flat) {
      this.attempts += 1;
      return;
    }
    this.runPending('sleep_place', () => skills.place.placeBedAt(ctx.bot, flat));
  }

  onPendingSuccess(ctx, result, label) {
    if (label === 'sleep') {
      if (ctx.bot.isSleeping === true) {
        this.sleepObserved = true;
      } else {
        this.attempts += 1;
      }
      return;
    }
    if (label === 'sleep_place') {
      if (!result || result.ok === false) {
        this.attempts += 1;
        this._emit(ctx, 'task_action_failed', {
          label,
          reason: FAILURE_REASONS.PLACE_FAILED,
          message: result && result.error ? result.error : null,
        });
      }
      return;
    }
    if (label === 'sleep_move' && (!result || result.ok === false)) {
      this.attempts += 1;
    }
  }

  onPendingError(ctx, error, label) {
    if (label === 'sleep_place') {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: FAILURE_REASONS.PLACE_FAILED,
        message: error && error.message ? error.message : String(error),
      });
      return;
    }
    if (label === 'sleep' || label === 'sleep_move') {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: label === 'sleep' ? FAILURE_REASONS.SLEEP_REJECTED : FAILURE_REASONS.PATH_UNREACHABLE,
        message: error && error.message ? error.message : String(error),
      });
    }
  }
}

SleepTask.kind = 'sleep';
SleepTask.priority = 60;
SleepTask.schema = {
  type: 'object',
  properties: {
    bedPos: { type: 'object' },
  },
};

module.exports = { SleepTask };
