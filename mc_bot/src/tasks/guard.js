'use strict';

const skills = require('../skills');
const { Task, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({ radius: 12, durationMs: 600000 });
const PATROL_INTERVAL_MS = 4000;

class GuardTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.combatState = {};
    this._lastPatrolAt = -Infinity;
  }

  static normalizeArgs(args = {}) {
    return {
      radius: integerAtLeast(args.radius, FALLBACK.radius, 1),
      durationMs: integerAtLeast(args.durationMs, FALLBACK.durationMs, 1000),
    };
  }

  static feasible(ctx = {}) {
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.guard;
    return {
      args: {
        radius: integerAtLeast(config && config.radius, FALLBACK.radius, 1),
        durationMs: integerAtLeast(config && config.durationMs, FALLBACK.durationMs, 1000),
      },
      etaSec: Math.ceil(integerAtLeast(config && config.durationMs, FALLBACK.durationMs, 1000) / 1000),
      note: '在附近巡逻并攻击敌对生物（有敌人时战斗，没有时来回走动）',
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.guard) || {};
    this.settings = {
      ...((ctx && ctx.config && ctx.config.combat) || {}),
      radius: Math.max(1, finiteNumber(config.radius, this.args.radius || FALLBACK.radius)),
      durationMs: Math.max(1000, finiteNumber(config.durationMs, this.args.durationMs || FALLBACK.durationMs)),
    };
    if (ctx.shadow) return true;
    return Promise.resolve(skills.inventory.equipBestWeapon(ctx.bot)).then((ok) => ok !== false);
  }

  progressMetric(ctx) {
    return this.elapsedSec(ctx);
  }

  isDone(ctx) {
    return this.elapsedSec(ctx) * 1000 >= this.settings.durationMs;
  }

  _target(ctx) {
    return skills.combat.findTarget(ctx.bot, { radius: this.settings.radius });
  }

  _tick(ctx) {
    const target = this._target(ctx);
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        radius: this.settings.radius,
        target: target ? target.name : null,
      });
      return;
    }
    if (this.pending) {
      if (target && this.pending.label === 'guard_patrol') {
        skills.combat.stopCombat(ctx.bot);
        this.pending = null;
      } else {
        return;
      }
    }
    if (!target) {
      skills.combat.stopCombat(ctx.bot);
      this._patrol(ctx);
      return;
    }

    const score = skills.combat.threatScore({
      type: target.name || target.displayName,
      dist: skills.move.positionDistance(ctx.bot.entity.position, target.position),
    }, {
      hp: ctx.perception.self.hp,
      armor: ctx.perception.self.armor,
      hostileCount: ctx.perception.threats.length,
      light: ctx.perception.world.light,
    });
    if (skills.combat.shouldFlee(score, ctx.bot, ctx.perception.self.armor, this.settings.fleePowerRatio)) {
      const spot = skills.world.findSafeSpot(ctx.bot, {
        searchRadius: 12,
        preferredDistance: 10,
        threats: [{ position: target.position, dist: score }],
      });
      if (spot) {
        this.runPending('guard_retreat', () => skills.move.moveTo(ctx.bot, spot, {
          range: 1,
          timeoutMs: 5000,
        }));
      }
      return;
    }

    const result = skills.combat.combatTick(ctx.bot, target, this.combatState, this.settings, ctx.now);
    if (result.action === 'retreat') {
      const spot = skills.world.findSafeSpot(ctx.bot, {
        searchRadius: 12,
        preferredDistance: this.settings.creeperRetreatDistance || 10,
        threats: [{ position: target.position, dist: result.dist || 4 }],
      });
      if (spot) {
        this.runPending('guard_retreat', () => skills.move.moveTo(ctx.bot, spot, {
          range: 1,
          timeoutMs: 5000,
        }));
      }
    }
  }

  _patrol(ctx) {
    const now = Number(ctx.now);
    if (!Number.isFinite(now) || now - this._lastPatrolAt < PATROL_INTERVAL_MS) return;
    this._lastPatrolAt = now;
    const spot = skills.world.findSafeSpot(ctx.bot, {
      searchRadius: 6,
      preferredDistance: 5,
      threats: [],
    });
    if (!spot) return;
    this.runPending('guard_patrol', () => skills.move.moveTo(ctx.bot, spot, {
      range: 1,
      timeoutMs: 5000,
    }));
  }

  onPendingError(ctx, error, label) {
    if (label === 'guard_patrol') return;
    super.onPendingError(ctx, error);
  }

  onFinish(ctx) {
    if (!ctx || !ctx.shadow) skills.combat.stopCombat(ctx && ctx.bot);
  }
}

GuardTask.kind = 'guard';
GuardTask.priority = 50;
GuardTask.selfTimed = true;
GuardTask.schema = {
  type: 'object',
  properties: {
    radius: { type: 'integer', minimum: 1 },
    durationMs: { type: 'integer', minimum: 1000 },
  },
};

module.exports = { GuardTask };
