'use strict';

const skills = require('../skills');
const { DEFAULTS } = require('../config');

function merge(base, extra) {
  const output = { ...(base || {}) };
  if (!extra || typeof extra !== 'object') return output;
  for (const [key, value] of Object.entries(extra)) output[key] = value;
  return output;
}

function nowOf(ctx) {
  const now = Number(ctx && ctx.now);
  return Number.isFinite(now) ? now : Date.now();
}

function record(ctx, event, payload) {
  if (!ctx || typeof ctx.record !== 'function') return;
  try {
    ctx.record(event, payload || {});
  } catch (_) {
    // 观测失败不影响反射。
  }
}

/**
 * 反射控制器只负责：判断哪个反射成立、执行反射动作。
 * 任务冻结/恢复由 Brain 调 Agenda 完成，反射本身不碰任务状态。
 */
class InterruptController {
  constructor(options = {}) {
    this.log = options.log || console;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this._definitions = [];
  }

  register(definition) {
    if (!definition || typeof definition.condition !== 'function') return null;
    const entry = {
      kind: String(definition.kind || 'interrupt'),
      priority: Number(definition.priority) || 0,
      condition: definition.condition,
      run: typeof definition.run === 'function' ? definition.run : null,
      plan: typeof definition.plan === 'function' ? definition.plan : null,
      cooldownMs: Math.max(0, Number(definition.cooldownMs) || 0),
      order: this._definitions.length,
      lastRunAt: null,
      inFlight: null,
    };
    this._definitions.push(entry);
    this._definitions.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return () => {
      const index = this._definitions.indexOf(entry);
      if (index >= 0) this._definitions.splice(index, 1);
    };
  }

  evaluate(perception, ctx) {
    for (const entry of this._definitions) {
      let active = false;
      try {
        active = Boolean(entry.condition(perception, ctx));
      } catch (error) {
        this._emit('interrupt_condition_error', {
          kind: entry.kind,
          error: error && error.message ? error.message : String(error),
        });
        active = false;
      }
      if (active) return entry;
    }
    return null;
  }

  run(active, ctx) {
    if (!active) return null;
    const now = nowOf(ctx);
    if (active.cooldownMs && active.lastRunAt !== null &&
      now - active.lastRunAt < active.cooldownMs) return null;

    if (ctx && ctx.shadow) {
      active.lastRunAt = now;
      let details = null;
      if (active.plan) {
        try {
          details = active.plan(ctx);
        } catch (error) {
          details = {
            error: error && error.message ? error.message : String(error),
          };
        }
      }
      this._emit('interrupt_shadow_plan', { kind: active.kind, details });
      return null;
    }

    if (active.inFlight) return active.inFlight;
    if (!active.run) return null;
    active.lastRunAt = now;

    try {
      const result = active.run(ctx);
      if (result && typeof result.then === 'function') {
        active.inFlight = Promise.resolve(result)
          .then((value) => {
            active.inFlight = null;
            return value;
          }, (error) => {
            active.inFlight = null;
            this._emit('interrupt_run_error', {
              kind: active.kind,
              error: error && error.message ? error.message : String(error),
            });
            return null;
          });
        return active.inFlight;
      }
      return result;
    } catch (error) {
      this._emit('interrupt_run_error', {
        kind: active.kind,
        error: error && error.message ? error.message : String(error),
      });
      return null;
    }
  }

  snapshot() {
    return this._definitions.map((entry) => ({
      kind: entry.kind,
      priority: entry.priority,
      cooldownMs: entry.cooldownMs,
      inFlight: Boolean(entry.inFlight),
    }));
  }

  _emit(event, payload) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event, payload);
    } catch (_) {
      // 观测失败不影响反射。
    }
  }
}

function nearestThreat(ctx) {
  const threats = ctx && ctx.perception && ctx.perception.threats;
  if (!Array.isArray(threats) || !threats.length) return null;
  return threats.slice().sort((a, b) => a.dist - b.dist)[0] || null;
}

function moveToSafeSpot(ctx, options, threats, kind) {
  const bot = ctx && ctx.bot;
  if (!bot || !bot.entity || !bot.entity.position) {
    return { ok: false, reason: 'bot_unavailable' };
  }
  const spot = skills.world.findSafeSpot(bot, {
    searchRadius: options.searchRadius,
    preferredDistance: options.fleeDistance || options.preferredDistance || 6,
    threats: threats || [],
  });
  if (!spot) {
    record(ctx, 'reflex_action', { kind, ok: false, reason: 'no_safe_spot' });
    return { ok: false, reason: 'no_safe_spot' };
  }
  record(ctx, 'reflex_action', {
    kind,
    ok: true,
    action: 'move',
    target: spot,
  });
  return skills.move.moveTo(bot, spot, {
    range: 1,
    timeoutMs: options.moveTimeoutMs,
  });
}

function jumpToSurface(ctx, durationMs) {
  const bot = ctx && ctx.bot;
  if (!bot || typeof bot.setControlState !== 'function') {
    return { ok: false, reason: 'bot_unavailable' };
  }
  record(ctx, 'reflex_action', { kind: 'water', ok: true, action: 'jump' });
  return new Promise((resolve) => {
    bot.setControlState('jump', true);
    setTimeout(() => {
      try {
        bot.setControlState('jump', false);
      } catch (_) {
        // 断开连接时控制状态可能已清空。
      }
      resolve({ ok: true });
    }, Math.max(100, Number(durationMs) || 900));
  });
}

function createLowHpReflex(config = {}) {
  const cfg = merge(DEFAULTS.brain.reflex.lowHp, config);
  let engaged = false;
  let threatGoneSince = null;

  return {
    kind: 'low_hp',
    priority: 90,
    cooldownMs: cfg.cooldownMs,
    condition(perception, ctx) {
      const hp = Number(perception && perception.self && perception.self.hp);
      const ratio = Number.isFinite(hp) ? hp / 20 : 1;
      const threat = perception && perception.threats
        ? perception.threats.find((item) => item.dist <= cfg.threatRadius)
        : null;

      if (!engaged) {
        engaged = ratio < cfg.hpRatio && Boolean(threat);
        if (engaged) threatGoneSince = null;
        return engaged;
      }
      if (ratio >= cfg.clearHpRatio) {
        engaged = false;
        threatGoneSince = null;
        return false;
      }
      if (!threat) {
        if (threatGoneSince === null) threatGoneSince = nowOf(ctx);
        if (nowOf(ctx) - threatGoneSince >= cfg.clearThreatGoneMs) {
          engaged = false;
          threatGoneSince = null;
          return false;
        }
      } else {
        threatGoneSince = null;
      }
      return true;
    },
    plan(ctx) {
      const threat = nearestThreat(ctx);
      return {
        retreatFrom: threat ? threat.type : null,
        hp: ctx.perception.self.hp,
        fleeDistance: cfg.fleeDistance,
      };
    },
    run(ctx) {
      return moveToSafeSpot(ctx, cfg, ctx.perception.threats, 'low_hp');
    },
  };
}

function createHurtReflex(config = {}) {
  const cfg = merge(DEFAULTS.brain.reflex.hurt, config);
  return {
    kind: 'hurt',
    priority: 85,
    cooldownMs: cfg.cooldownMs,
    condition(perception, ctx) {
      const lastHurtAt = Number(ctx && ctx.lastHurtAt);
      if (!Number.isFinite(lastHurtAt) || lastHurtAt <= 0) return false;
      return nowOf(ctx) - lastHurtAt <= cfg.activeMs;
    },
    plan(ctx) {
      const threat = nearestThreat(ctx);
      return { attacker: threat ? threat.type : null, hp: ctx.perception.self.hp };
    },
    run(ctx) {
      const bot = ctx.bot;
      const threat = nearestThreat(ctx);
      const entity = threat && bot && bot.entities
        ? bot.entities[threat.id] || Object.values(bot.entities).find((item) => item && item.name === threat.type)
        : null;
      const hp = Number(ctx.perception.self.hp);

      if (entity && Number.isFinite(hp) && hp >= cfg.counterMinHp && threat.dist <= cfg.counterRadius) {
        return Promise.resolve(skills.inventory.equipBestWeapon(bot)).then(() => {
          try {
            if (typeof bot.lookAt === 'function') bot.lookAt(entity.position);
            bot.attack(entity);
            record(ctx, 'reflex_action', {
              kind: 'hurt',
              ok: true,
              action: 'counter',
              target: threat.type,
            });
          } catch (error) {
            record(ctx, 'reflex_action', {
              kind: 'hurt',
              ok: false,
              action: 'counter',
              reason: 'attack_failed',
              message: error && error.message ? error.message : String(error),
            });
          }
          return { ok: true };
        });
      }
      return moveToSafeSpot(ctx, cfg, ctx.perception.threats, 'hurt');
    },
  };
}

function createWaterReflex(config = {}) {
  const cfg = merge(DEFAULTS.brain.reflex.water, config);
  return {
    kind: 'water',
    priority: 75,
    cooldownMs: cfg.cooldownMs,
    condition(perception) {
      return Boolean(perception && perception.self && perception.self.inWater);
    },
    plan() {
      return { action: 'move_to_dry_land' };
    },
    run(ctx) {
      const result = moveToSafeSpot(ctx, cfg, [], 'water');
      if (result && typeof result.then === 'function') return result;
      return jumpToSurface(ctx, cfg.surfaceJumpMs);
    },
  };
}

function createLavaReflex(config = {}) {
  const cfg = merge(DEFAULTS.brain.reflex.lava, config);
  return {
    kind: 'lava',
    priority: 100,
    cooldownMs: cfg.cooldownMs,
    condition(perception, ctx) {
      if (perception && perception.self && perception.self.inLava) return true;
      return Boolean(ctx && ctx.bot && skills.world.hasLavaNearby(ctx.bot, cfg.dangerRadius));
    },
    plan() {
      return { action: 'leave_lava' };
    },
    run(ctx) {
      return moveToSafeSpot(ctx, cfg, [], 'lava');
    },
  };
}

function createDefaultInterrupts(options = {}) {
  const controller = new InterruptController(options);
  const config = options.reflexConfig || (options.config && options.config.reflex) || {};
  controller.register(createLavaReflex(config.lava));
  controller.register(createLowHpReflex(config.lowHp));
  controller.register(createHurtReflex(config.hurt));
  controller.register(createWaterReflex(config.water));
  return controller;
}

function createInterrupts(options = {}) {
  return new InterruptController(options);
}

module.exports = {
  InterruptController,
  createInterrupts,
  createDefaultInterrupts,
  createLowHpReflex,
  createHurtReflex,
  createWaterReflex,
  createLavaReflex,
};
