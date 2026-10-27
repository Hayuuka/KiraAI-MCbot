'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  maxMinutes: 12,
  maxAttempts: 3,
  digTimeoutMs: 15000,
});

function groundBlock(bot) {
  const position = bot && bot.entity && bot.entity.position;
  if (!position) return null;
  return skills.world.blockAt(
    bot,
    Math.floor(position.x),
    Math.floor(position.y) - 1,
    Math.floor(position.z)
  );
}

function diggableGround(block) {
  if (!skills.world.isSolid(block) || skills.world.isLiquid(block)) return false;
  const name = String(block.name || '').toLowerCase().split(':').pop();
  return name !== 'bedrock';
}

class DigInTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.startY = null;
    this.dugOnce = false;
    this.attempts = 0;
  }

  static normalizeArgs() {
    return {};
  }

  static feasible(ctx = {}) {
    const perception = ctx.perception;
    const bot = ctx.bot;
    if (!bot || !perception) return null;
    if (perception.world.isDay !== false || perception.world.underground) return null;
    if (!diggableGround(groundBlock(bot))) return null;
    return { args: {}, etaSec: 30, note: '原地挖 1 格蹲到天亮' };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.digIn) || {};
    this.settings = {
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      digTimeoutMs: Math.max(1000, finiteNumber(config.digTimeoutMs, FALLBACK.digTimeoutMs)),
    };
    this.startY = ctx.bot.entity.position.y;
    return true;
  }

  progressMetric() {
    return this.dugOnce ? 1 : 0;
  }

  isDone(ctx) {
    return Boolean(ctx.perception && ctx.perception.world.isDay === true);
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.DIG_FAILED };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, { startY: this.startY });
      return;
    }
    if (this.dugOnce || this.pending) return;

    const ground = groundBlock(ctx.bot);
    if (!diggableGround(ground)) {
      this.fail(FAILURE_REASONS.NO_SOLID_GROUND);
      return;
    }
    this.runPending('digIn', () => skills.mine.mineBlock(ctx.bot, ground, {
      timeoutMs: this.settings.digTimeoutMs,
    }));
  }

  onPendingSuccess(ctx, result, label) {
    if (label !== 'digIn') return;
    const y = Number(ctx.bot && ctx.bot.entity && ctx.bot.entity.position.y);
    if ((!result || result.ok !== false) && Number.isFinite(y) && y < this.startY - 0.5) {
      this.dugOnce = true;
      const head = {
        x: Math.floor(ctx.bot.entity.position.x),
        y: Math.floor(this.startY),
        z: Math.floor(ctx.bot.entity.position.z),
      };
      if (skills.place.findBuildingBlock(ctx.bot, 1)) {
        this.runPending('digInSeal', () => skills.place.placeBuildingBlockAt(ctx.bot, head));
      }
      return;
    }
    this.attempts += 1;
  }

  onPendingError(ctx, error, label) {
    if (label === 'digIn') this.attempts += 1;
  }
}

DigInTask.kind = 'digIn';
DigInTask.priority = 58;
DigInTask.selfTimed = true;
DigInTask.schema = { type: 'object', properties: {} };

module.exports = { DigInTask, diggableGround };
