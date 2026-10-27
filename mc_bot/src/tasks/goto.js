'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  tolerance: 2,
  timeoutSec: 60,
  maxAttempts: 3,
  moveTimeoutMs: 10000,
  arriveRange: 2,
});

function horizontalDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.z) - Number(b.z));
}

class GotoTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this._providedTolerance = args && args.tolerance != null;
    this.tolerance = this.args.tolerance;
    this.settings = { ...FALLBACK };
    this.startDistance = null;
    this.attempts = 0;
  }

  static normalizeArgs(args = {}) {
    return {
      x: finiteNumber(args.x, NaN),
      y: args.y == null ? null : finiteNumber(args.y, NaN),
      z: finiteNumber(args.z, NaN),
      tolerance: Math.max(0, finiteNumber(args.tolerance, 2)),
    };
  }

  static feasible(ctx = {}) {
    const args = ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
    const x = finiteNumber(args.x, NaN);
    const z = finiteNumber(args.z, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.goto;
    const tolerance = Math.max(0, finiteNumber(args.tolerance, finiteNumber(config && config.tolerance, 2)));
    return {
      args: {
        x,
        y: args.y == null ? null : finiteNumber(args.y, null),
        z,
        tolerance,
      },
      etaSec: 30,
      note: `走到 ${Math.round(x)}, ${Math.round(z)}`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.goto) || {};
    this.settings = {
      tolerance: Math.max(0, finiteNumber(config.tolerance, FALLBACK.tolerance)),
      timeoutSec: Math.max(1, finiteNumber(config.timeoutSec, FALLBACK.timeoutSec)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      arriveRange: Math.max(0, finiteNumber(config.arriveRange, FALLBACK.arriveRange)),
    };
    if (!this._providedTolerance) {
      this.tolerance = this.settings.tolerance;
      this.args.tolerance = this.tolerance;
    }
    if (!Number.isFinite(this.args.x) || !Number.isFinite(this.args.z)) {
      this.fail(FAILURE_REASONS.INVALID_ARGS);
      return false;
    }
    const position = ctx.bot && ctx.bot.entity && ctx.bot.entity.position;
    if (!position) {
      this.fail(FAILURE_REASONS.PREPARE_FAILED);
      return false;
    }
    this.startDistance = horizontalDistance(position, this.args);
    return true;
  }

  progressMetric(ctx) {
    if (this.startDistance === null) return 0;
    const position = ctx.bot && ctx.bot.entity && ctx.bot.entity.position;
    if (!position) return 0;
    return this.startDistance - horizontalDistance(position, this.args);
  }

  isDone(ctx) {
    const position = ctx.bot && ctx.bot.entity && ctx.bot.entity.position;
    if (!position) return false;
    return horizontalDistance(position, this.args) <= this.tolerance;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.timeoutSec) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.PATH_UNREACHABLE };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      const position = ctx.bot && ctx.bot.entity && ctx.bot.entity.position;
      this.markShadowPlan(ctx, {
        target: { x: this.args.x, y: this.args.y, z: this.args.z },
        distance: position ? Math.round(horizontalDistance(position, this.args) * 10) / 10 : null,
      });
      return;
    }
    if (this.pending) return;
    const position = ctx.bot && ctx.bot.entity && ctx.bot.entity.position;
    const horizontalOnly = !Number.isFinite(this.args.y);
    const y = horizontalOnly ? position && position.y : this.args.y;
    if (!Number.isFinite(y)) {
      this.fail(FAILURE_REASONS.INVALID_ARGS);
      return;
    }
    this.runPending('goto', () => skills.move.moveTo(
      ctx.bot,
      { x: this.args.x, y, z: this.args.z },
      {
        range: this.settings.arriveRange,
        timeoutMs: this.settings.moveTimeoutMs,
        horizontalOnly,
      }
    ));
  }

  onPendingSuccess(ctx, result, label) {
    if (label !== 'goto') return;
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
    if (label !== 'goto') return;
    this.attempts += 1;
    this._emit(ctx, 'task_action_failed', {
      label,
      reason: FAILURE_REASONS.PATH_UNREACHABLE,
      message: error && error.message ? error.message : String(error),
    });
  }
}

GotoTask.kind = 'goto';
GotoTask.priority = 30;
GotoTask.selfTimed = true;
GotoTask.schema = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    tolerance: { type: 'number', minimum: 0 },
  },
  required: ['x', 'z'],
};

module.exports = { GotoTask, horizontalDistance };
