'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  targetHp: 16,
  eatUntilFood: 18,
  maxMinutes: 5,
  consumeTimeoutMs: 10000,
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

class HealTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    const hp = Number(bot && bot.health);
    if (!Number.isFinite(hp)) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.heal;
    const targetHp = Math.max(1, finiteNumber(config && config.targetHp, FALLBACK.targetHp));
    if (hp >= targetHp) return null;
    const food = Number(bot.food);
    if (food < finiteNumber(config && config.eatUntilFood, FALLBACK.eatUntilFood) &&
      !skills.inventory.findFood(bot)) return null;
    return {
      args: {},
      etaSec: 30,
      note: `休息并把血量恢复到 ${targetHp}`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.heal) || {};
    this.settings = {
      targetHp: Math.max(1, finiteNumber(config.targetHp, FALLBACK.targetHp)),
      eatUntilFood: Math.max(1, finiteNumber(config.eatUntilFood, FALLBACK.eatUntilFood)),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      consumeTimeoutMs: Math.max(1000, finiteNumber(config.consumeTimeoutMs, FALLBACK.consumeTimeoutMs)),
    };
    return true;
  }

  progressMetric(ctx) {
    return Number(ctx.bot && ctx.bot.health) || 0;
  }

  isDone(ctx) {
    return Number(ctx.bot && ctx.bot.health) >= this.settings.targetHp;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    const food = Number(ctx.bot && ctx.bot.food);
    if (food < this.settings.eatUntilFood && !skills.inventory.findFood(ctx.bot)) {
      return { reason: FAILURE_REASONS.NO_FOOD };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        targetHp: this.settings.targetHp,
        hp: ctx.bot.health,
        food: ctx.bot.food,
      });
      return;
    }
    if (this.pending) return;
    if (Number(ctx.bot.food) >= this.settings.eatUntilFood) return;
    const food = skills.inventory.findFood(ctx.bot);
    if (!food) return;
    this.runPending('heal_eat', async () => {
      await ctx.bot.equip(food, 'hand');
      await withTimeout(ctx.bot.consume(), this.settings.consumeTimeoutMs, 'consume');
      return true;
    });
  }

  onPendingError(ctx, error, label) {
    if (label !== 'heal_eat') return;
    this.fail(FAILURE_REASONS.CONSUME_FAILED, {
      ctx,
      message: error && error.message ? error.message : String(error),
    });
  }
}

HealTask.kind = 'heal';
HealTask.priority = 58;
HealTask.selfTimed = true;
HealTask.schema = { type: 'object', properties: {} };

module.exports = { HealTask };
