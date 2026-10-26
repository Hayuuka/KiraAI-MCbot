'use strict';

const { Task, finiteNumber, integerAtLeast } = require('./base');

class IdleTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this._providedDurationMs = args && args.durationMs != null;
    this.durationMs = this.args.durationMs;
  }

  static normalizeArgs(args = {}) {
    return {
      durationMs: integerAtLeast(args.durationMs, 5000, 0),
      look: args.look !== false,
    };
  }

  static feasible(ctx = {}) {
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.idle;
    const durationMs = Math.max(0, Math.trunc(finiteNumber(config && config.durationMs, 5000)));
    return {
      args: { durationMs, look: true },
      etaSec: Math.ceil(durationMs / 1000),
      note: '原地待命',
    };
  }

  prepare(ctx) {
    const config = ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.idle;
    if (!this._providedDurationMs && config) {
      this.durationMs = Math.max(0, Math.trunc(finiteNumber(config.durationMs, this.durationMs)));
      this.args.durationMs = this.durationMs;
    }
    return true;
  }

  progressMetric(ctx) {
    return this.elapsedSec(ctx);
  }

  isDone(ctx) {
    return this.elapsedSec(ctx) * 1000 >= this.durationMs;
  }

  _tick(ctx) {
    this.markShadowPlan(ctx, { durationMs: this.durationMs, look: this.args.look });
  }
}

IdleTask.kind = 'idle';
IdleTask.priority = 10;
IdleTask.schema = {
  type: 'object',
  properties: {
    durationMs: { type: 'integer', minimum: 0 },
    look: { type: 'boolean' },
  },
};

module.exports = { IdleTask };
