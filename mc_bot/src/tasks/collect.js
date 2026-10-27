'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast, positionKey } = require('./base');

const FALLBACK = Object.freeze({
  selector: '#minecraft:logs',
  count: 8,
  radius: 32,
  maxMinutes: 5,
  maxNoTargetTicks: 20,
  blacklistMs: 60000,
  maxAttemptsPerBlock: 2,
  moveTimeoutMs: 10000,
  arriveRange: 2,
  reach: 4.5,
});

function mergeArguments(args, config) {
  return {
    selector: String(args.selector || (config && config.selector) || FALLBACK.selector),
    count: integerAtLeast(args.count, finiteNumber(config && config.count, FALLBACK.count), 1),
    radius: integerAtLeast(args.radius, finiteNumber(config && config.radius, FALLBACK.radius), 4),
    maxMinutes: Math.max(
      0.1,
      finiteNumber(args.maxMinutes, finiteNumber(config && config.maxMinutes, FALLBACK.maxMinutes))
    ),
    allowDig: args.allowDig === true,
  };
}

function matchesSelector(spec, block) {
  if (!spec || !block) return false;
  const name = skills.move.normalizeBlockName(block.name);
  if (spec.exact) return name === spec.exact;
  if (spec.members) return spec.members.includes(name);
  if (spec.suffix) return name.split(':').pop().includes(spec.suffix);
  return false;
}

class CollectBlockTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.baseline = null;
    this.badUntil = new Map();
    this.attempts = new Map();
    this.noTargetTicks = 0;
    this.settings = { ...FALLBACK };
  }

  static normalizeArgs(args = {}) {
    return mergeArguments(args, null);
  }

  static feasible(ctx = {}) {
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.collectBlock;
    const args = mergeArguments((ctx.args && typeof ctx.args === 'object' ? ctx.args : {}), config);
    const bot = ctx.bot;
    if (!bot || !bot.entity || !bot.entity.position) return null;

    let target = null;
    try {
      target = skills.move.findNearestBlock(bot, args.selector, args.radius);
    } catch (_) {
      return null;
    }
    if (!target || !target.position) return null;
    const tool = skills.inventory.bestToolForBlock(bot, target);
    if (tool.requirement.required && !tool.best) return null;
    const distance = skills.move.positionDistance(bot.entity.position, target.position);
    return {
      args,
      etaSec: 180,
      note: `最近的目标是 ${target.name}，在 ${Math.round(distance)} 格外`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.collectBlock) || {};
    this.settings = {
      selector: String(config.selector || FALLBACK.selector),
      count: Math.max(1, Math.trunc(finiteNumber(config.count, FALLBACK.count))),
      radius: Math.max(4, Math.trunc(finiteNumber(config.radius, FALLBACK.radius))),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxNoTargetTicks: Math.max(
        1,
        Math.trunc(finiteNumber(config.maxNoTargetTicks, FALLBACK.maxNoTargetTicks))
      ),
      blacklistMs: Math.max(1000, finiteNumber(config.blacklistMs, FALLBACK.blacklistMs)),
      maxAttemptsPerBlock: Math.max(
        1,
        Math.trunc(finiteNumber(config.maxAttemptsPerBlock, FALLBACK.maxAttemptsPerBlock))
      ),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      arriveRange: Math.max(0, finiteNumber(config.arriveRange, FALLBACK.arriveRange)),
      reach: Math.max(1, finiteNumber(config.reach, FALLBACK.reach)),
    };

    this.baseline = skills.inventory.count(ctx.bot, this.args.selector);
    if (ctx.shadow) return true;

    return Promise.resolve(skills.inventory.equipBestTool(ctx.bot, this.args.selector))
      .then((ready) => {
        if (ready === false) {
          this.fail(FAILURE_REASONS.TOOL_UNAVAILABLE);
          return false;
        }
        return true;
      });
  }

  progressMetric(ctx) {
    if (this.baseline === null) return 0;
    return skills.inventory.count(ctx.bot, this.args.selector) - this.baseline;
  }

  isDone(ctx) {
    return this.progressMetric(ctx) >= this.args.count;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.args.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.noTargetTicks >= this.settings.maxNoTargetTicks) {
      return { reason: FAILURE_REASONS.NO_TARGET };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow && this._shadowPlannedAt !== null) return;
    const target = this._findTarget(ctx);
    if (!target) {
      this.noTargetTicks += 1;
      return;
    }
    this.noTargetTicks = 0;

    if (ctx.shadow) {
      const distance = skills.move.positionDistance(ctx.bot.entity.position, target.position);
      this.markShadowPlan(ctx, {
        selector: this.args.selector,
        target: skills.move.normalizeBlockName(target.name),
        pos: [target.position.x, target.position.y, target.position.z],
        distance: Math.round(distance * 10) / 10,
        count: this.args.count,
      });
      return;
    }
    if (this.pending) return;

    const distance = skills.move.positionDistance(ctx.bot.entity.position, target.position);
    if (distance > this.settings.reach) {
      this.runPending('move', () => skills.move.moveTo(
        ctx.bot,
        { x: target.position.x, y: target.position.y, z: target.position.z },
        {
          range: this.settings.arriveRange,
          timeoutMs: this.settings.moveTimeoutMs,
        }
      ), { block: target });
      return;
    }

    this.runPending('mine', () => skills.mine.mineBlock(ctx.bot, target, {
      timeoutMs: this.settings.moveTimeoutMs,
    }), { block: target });
  }

  _findTarget(ctx) {
    const bot = ctx.bot;
    if (!bot || typeof bot.findBlock !== 'function') return null;
    const spec = skills.move.expandBlockTarget(this.args.selector);
    if (!spec) return null;
    const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
    try {
      return bot.findBlock({
        maxDistance: this.args.radius,
        matching: (block) => {
          if (!matchesSelector(spec, block)) return false;
          const until = this.badUntil.get(positionKey(block.position)) || 0;
          return until <= now;
        },
      });
    } catch (_) {
      return null;
    }
  }

  _markTargetFailure(ctx, block, label, detail) {
    if (!block || !block.position) return;
    const key = positionKey(block.position);
    const attempts = (this.attempts.get(key) || 0) + 1;
    this.attempts.set(key, attempts);
    const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
    if (attempts >= this.settings.maxAttemptsPerBlock) {
      this.badUntil.set(key, now + this.settings.blacklistMs);
      this.attempts.delete(key);
    }
    this._emit(ctx, 'task_action_failed', {
      label,
      reason: label === 'move' ? FAILURE_REASONS.PATH_UNREACHABLE : FAILURE_REASONS.MINE_FAILED,
      block: key,
      attempts,
      blacklisted: this.badUntil.has(key),
      message: detail || null,
    });
  }

  onPendingSuccess(ctx, result, label, meta) {
    if (!result || result.ok !== false) return;
    this._markTargetFailure(ctx, meta && meta.block, label, result.error || null);
  }

  onPendingError(ctx, error, label, meta) {
    this._markTargetFailure(
      ctx,
      meta && meta.block,
      label,
      error && error.message ? error.message : String(error)
    );
  }
}

CollectBlockTask.kind = 'collectBlock';
CollectBlockTask.priority = 40;
CollectBlockTask.selfTimed = true;
CollectBlockTask.schema = {
  type: 'object',
  properties: {
    selector: { type: 'string' },
    count: { type: 'integer', minimum: 1 },
    radius: { type: 'integer', minimum: 4, maximum: 64 },
    maxMinutes: { type: 'number' },
    allowDig: { type: 'boolean' },
  },
  required: ['selector'],
};

module.exports = { CollectBlockTask, mergeArguments };
