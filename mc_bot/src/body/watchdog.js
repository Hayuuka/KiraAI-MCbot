'use strict';

const { FAILURE_REASONS } = require('../tasks/base');

class Watchdog {
  constructor(options = {}) {
    this.config = options.config || {};
    this.log = options.log || console;
  }

  check(ctx) {
    const top = ctx && ctx.agenda ? ctx.agenda.top() : null;
    if (!top || top.isTerminal || top.isFrozen) return false;
    if (!ctx.perception || !ctx.perception.self || ctx.perception.self.isSleeping) return false;
    if (typeof top.expectsQuiet === 'function' && top.expectsQuiet(ctx)) return false;
    if (typeof top.progressStaleSec !== 'function') return false;

    const threshold = Math.max(
      1,
      Number(this.config.stuckProgressSec) ||
        Number(this.config.progressStaleSec) ||
        45
    );
    if (top.progressStaleSec(ctx) < threshold) return false;
    return this.recoverStuck(ctx, 'watchdog');
  }

  recoverStuck(ctx, source = 'stuck') {
    const top = ctx && ctx.agenda ? ctx.agenda.top() : null;
    if (!top || top.isTerminal) return false;

    let recovered = false;
    if (typeof top.recover === 'function') {
      try {
        recovered = Boolean(top.recover(ctx));
      } catch (_) {
        recovered = false;
      }
    }

    if (ctx && typeof ctx.record === 'function') {
      ctx.record('stuck_recovery', {
        source,
        task: { id: top.id, kind: top.kind },
        recovered,
        staleSec: Math.round(top.progressStaleSec(ctx)),
      });
    }
    if (recovered) return true;

    if (ctx && ctx.agenda) ctx.agenda.dropTop(FAILURE_REASONS.NO_PROGRESS);
    return false;
  }

  snapshot(ctx) {
    const top = ctx && ctx.agenda ? ctx.agenda.top() : null;
    return {
      staleSec: top && typeof top.progressStaleSec === 'function'
        ? Math.round(top.progressStaleSec(ctx))
        : 0,
      task: top ? { id: top.id, kind: top.kind, state: top.state } : null,
    };
  }
}

function createWatchdog(options = {}) {
  return new Watchdog(options);
}

module.exports = {
  Watchdog,
  createWatchdog,
};
