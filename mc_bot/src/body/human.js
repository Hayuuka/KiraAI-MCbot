'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function angleDelta(from, to) {
  let delta = (to - from + Math.PI) % (Math.PI * 2) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

class Humanizer {
  constructor(options = {}) {
    this.config = {
      lookMinMs: 3000,
      lookMaxMs: 6000,
      actionMinMs: 20000,
      actionMaxMs: 40000,
      delayMinMs: 80,
      delayMaxMs: 220,
      maxTurnPerTick: Math.PI * 25 / 180,
      ...(options.config || {}),
    };
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this._idle = false;
    this._readyAt = 0;
    this._nextLookAt = 0;
    this._nextActionAt = 0;
    this._lookTarget = null;
    this._lookApplyAt = 0;
    this._action = null;
    this._releaseAt = 0;
    this._lastAction = null;
  }

  update(ctx) {
    if (!ctx || !ctx.bot || ctx.shadow) return false;
    const top = ctx.agenda ? ctx.agenda.top() : null;
    if (!top || top.kind !== 'idle') {
      this._leaveIdle(ctx);
      return false;
    }
    const now = Number(ctx.now) || Date.now();
    if (!this._idle) this._enterIdle(now);
    if (now < this._readyAt) return false;

    if (this._releaseAt && now >= this._releaseAt) {
      this._release(ctx);
      this._releaseAt = 0;
    }

    if (this._action && now >= this._action.applyAt) {
      this._applyAction(ctx, this._action);
      this._releaseAt = now + this._action.holdMs;
      this._lastAction = this._action.kind;
      this._action = null;
    }

    if (!this._action && now >= this._nextActionAt) {
      const action = this._pickAction();
      this._action = {
        kind: action,
        applyAt: now + this._delay(),
        holdMs: action === 'swing' ? 80 : 180,
      };
      this._nextActionAt = now + this._between(this.config.actionMinMs, this.config.actionMaxMs);
    }

    if (this._lookTarget && now >= this._lookApplyAt) {
      this._turnToward(ctx, now);
    }
    if (now >= this._nextLookAt) {
      this._lookTarget = {
        yaw: (this.random() - 0.5) * Math.PI * 1.4,
        pitch: (this.random() - 0.5) * 0.35,
      };
      this._lookApplyAt = now + this._delay();
      this._nextLookAt = now + this._between(this.config.lookMinMs, this.config.lookMaxMs);
    }
    return true;
  }

  snapshot() {
    return {
      idle: this._idle,
      lastAction: this._lastAction,
      looking: Boolean(this._lookTarget),
    };
  }

  _enterIdle(now) {
    this._idle = true;
    this._readyAt = now + this._delay();
    this._nextLookAt = this._readyAt + this._between(500, 1500);
    this._nextActionAt = now + this._between(20000, 40000);
  }

  _leaveIdle(ctx) {
    if (!this._idle) return;
    this._idle = false;
    this._lookTarget = null;
    this._action = null;
    this._releaseAt = 0;
    this._release(ctx);
  }

  _release(ctx) {
    try {
      if (ctx && ctx.bot && typeof ctx.bot.clearControlStates === 'function') {
        ctx.bot.clearControlStates();
      }
    } catch (_) {
      return;
    }
  }

  _applyAction(ctx, action) {
    const bot = ctx.bot;
    try {
      if (action.kind === 'jump') bot.setControlState('jump', true);
      else if (action.kind === 'sneak') bot.setControlState('sneak', true);
      else if (action.kind === 'forward') bot.setControlState('forward', true);
      else if (action.kind === 'swing' && typeof bot.swingArm === 'function') bot.swingArm('right', true);
    } catch (_) {
      return;
    }
  }

  _turnToward(ctx, now) {
    const bot = ctx.bot;
    const target = this._lookTarget;
    if (!target || !bot.entity) return;
    const currentYaw = Number(bot.entity.yaw);
    const yaw = Number.isFinite(currentYaw) ? currentYaw : 0;
    const delta = angleDelta(yaw, target.yaw);
    const step = clamp(delta, -this.config.maxTurnPerTick, this.config.maxTurnPerTick);
    const nextYaw = yaw + step;
    try {
      const result = bot.look(nextYaw, target.pitch, true);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      return;
    }
    bot.entity.yaw = nextYaw;
    bot.entity.pitch = target.pitch;
    if (Math.abs(delta) <= Math.abs(step) + 0.001) {
      this._lookTarget = null;
      this._lookApplyAt = 0;
    } else {
      this._lookApplyAt = now + 100;
    }
  }

  _pickAction() {
    const actions = ['jump', 'sneak', 'swing', 'forward'];
    return actions[Math.floor(this.random() * actions.length) % actions.length];
  }

  _delay() {
    return this._between(this.config.delayMinMs, this.config.delayMaxMs);
  }

  _between(min, max) {
    const low = Math.max(0, Number(min) || 0);
    const high = Math.max(low, Number(max) || low);
    return low + this.random() * (high - low);
  }
}

function createHumanizer(options = {}) {
  return new Humanizer(options);
}

module.exports = { Humanizer, createHumanizer };
