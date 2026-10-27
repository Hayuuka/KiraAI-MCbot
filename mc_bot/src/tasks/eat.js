'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  untilFood: 18,
  maxMinutes: 2,
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

class EatTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
  }

  static normalizeArgs(args = {}) {
    return {
      untilFood: integerAtLeast(args.untilFood, FALLBACK.untilFood, 1),
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    if (!bot || !Number.isFinite(Number(bot.food))) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.eat;
    const untilFood = Math.max(1, Math.trunc(finiteNumber(config && config.untilFood, FALLBACK.untilFood)));
    if (Number(bot.food) >= untilFood) return null;
    const food = skills.inventory.findFood(bot);
    if (!food) return null;
    return {
      args: { untilFood },
      etaSec: 10,
      note: `吃 ${food.name}，把饥饿值补到 ${untilFood}`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.eat) || {};
    this.settings = {
      untilFood: integerAtLeast(this.args.untilFood, finiteNumber(config.untilFood, FALLBACK.untilFood), 1),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      consumeTimeoutMs: Math.max(1000, finiteNumber(config.consumeTimeoutMs, FALLBACK.consumeTimeoutMs)),
    };
    if (!skills.inventory.findFood(ctx.bot)) {
      this.fail(FAILURE_REASONS.NO_FOOD);
      return false;
    }
    return true;
  }

  progressMetric(ctx) {
    return Number(ctx.bot && ctx.bot.food) || 0;
  }

  isDone(ctx) {
    return Number(ctx.bot && ctx.bot.food) >= this.settings.untilFood;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (!skills.inventory.findFood(ctx.bot)) {
      return { reason: FAILURE_REASONS.NO_FOOD };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      const food = skills.inventory.findFood(ctx.bot);
      this.markShadowPlan(ctx, {
        untilFood: this.settings.untilFood,
        food: food ? food.name : null,
      });
      return;
    }
    if (this.pending) return;
    const food = skills.inventory.findFood(ctx.bot);
    if (!food) return;
    this.runPending('eat', async () => {
      await ctx.bot.equip(food, 'hand');
      await withTimeout(ctx.bot.consume(), this.settings.consumeTimeoutMs, 'consume');
      return true;
    });
  }

  onPendingError(ctx, error, label) {
    if (label !== 'eat') return;
    this.fail(FAILURE_REASONS.CONSUME_FAILED, {
      ctx,
      message: error && error.message ? error.message : String(error),
    });
  }
}

EatTask.kind = 'eat';
EatTask.priority = 55;
EatTask.selfTimed = true;
EatTask.schema = {
  type: 'object',
  properties: {
    untilFood: { type: 'integer', minimum: 1, maximum: 20 },
  },
};

module.exports = { EatTask };
