'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  distance: 16,
  searchRadius: 20,
  moveTimeoutMs: 8000,
  timeoutSec: 20,
  maxAttempts: 3,
});

function threatsWithin(perception, distance) {
  const threats = perception && Array.isArray(perception.threats) ? perception.threats : [];
  return threats.filter((threat) => Number(threat.dist) <= distance);
}

class FleeTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.attempts = 0;
  }

  static normalizeArgs(args = {}) {
    return { distance: integerAtLeast(args.distance, FALLBACK.distance, 4) };
  }

  static feasible(ctx = {}) {
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.flee;
    const distance = Math.max(4, finiteNumber(config && config.distance, FALLBACK.distance));
    if (!threatsWithin(ctx.perception, distance).length) return null;
    return {
      args: { distance },
      etaSec: 15,
      note: `撤离到威胁 ${Math.round(distance)} 格外`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.flee) || {};
    this.settings = {
      distance: Math.max(4, finiteNumber(config.distance, this.args.distance || FALLBACK.distance)),
      searchRadius: Math.max(4, finiteNumber(config.searchRadius, FALLBACK.searchRadius)),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      timeoutSec: Math.max(1, finiteNumber(config.timeoutSec, FALLBACK.timeoutSec)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
    };
    this.args.distance = this.settings.distance;
    return true;
  }

  progressMetric(ctx) {
    const threats = ctx.perception && ctx.perception.threats;
    if (!Array.isArray(threats) || !threats.length) return this.settings.distance;
    return Math.min(...threats.map((threat) => Number(threat.dist) || 0));
  }

  isDone(ctx) {
    return threatsWithin(ctx.perception, this.settings.distance).length === 0;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.timeoutSec) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.NO_SAFE_SPOT };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        distance: this.settings.distance,
        threats: ctx.perception.threats.map((threat) => ({ type: threat.type, dist: threat.dist })),
      });
      return;
    }
    if (this.pending) return;
    const spot = skills.world.findSafeSpot(ctx.bot, {
      searchRadius: this.settings.searchRadius,
      preferredDistance: this.settings.distance,
      threats: ctx.perception.threats,
    });
    if (!spot) {
      this.attempts += 1;
      return;
    }
    this.runPending('flee', () => skills.move.moveTo(ctx.bot, spot, {
      range: 1,
      timeoutMs: this.settings.moveTimeoutMs,
    }));
  }

  onPendingSuccess(ctx, result, label) {
    if (label !== 'flee') return;
    if (!result || result.ok === false) {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: FAILURE_REASONS.PATH_UNREACHABLE,
        message: result && result.error ? result.error : null,
      });
    }
  }

  onPendingError(ctx, error, label) {
    if (label !== 'flee') return;
    this.attempts += 1;
    this._emit(ctx, 'task_action_failed', {
      label,
      reason: FAILURE_REASONS.PATH_UNREACHABLE,
      message: error && error.message ? error.message : String(error),
    });
  }
}

FleeTask.kind = 'flee';
FleeTask.priority = 70;
FleeTask.schema = {
  type: 'object',
  properties: { distance: { type: 'integer', minimum: 4 } },
};

module.exports = { FleeTask };
