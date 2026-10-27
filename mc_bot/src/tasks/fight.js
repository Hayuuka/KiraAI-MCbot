'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  attackRange: 2.6,
  approachRange: 2,
  maxMinutes: 2,
  creeperDangerRadius: 4,
  creeperRetreatDistance: 10,
});

class FightTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.combatState = {};
    this.retreating = false;
    this.tooDangerous = false;
  }

  static normalizeArgs(args = {}) {
    return {
      targetId: args.targetId == null && args.id == null ? null : Number(args.targetId ?? args.id),
      type: args.type ? String(args.type).toLowerCase().split(':').pop() : null,
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    if (!bot) return null;
    const requested = ctx.args || {};
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.fight;
    const radius = finiteNumber(ctx.config && ctx.config.combat && ctx.config.combat.threatRadius, 16);
    const target = requested.targetId != null || requested.type
      ? skills.combat.findTarget(bot, { id: requested.targetId, type: requested.type, radius })
      : skills.combat.findTarget(bot, { radius });
    if (!target) return null;
    return {
      args: {
        targetId: target.id == null ? null : Number(target.id),
        type: String(target.name || target.displayName || '').toLowerCase().split(':').pop(),
      },
      etaSec: 20,
      note: `攻击 ${target.name || target.displayName}`,
    };
  }

  prepare(ctx) {
    const combatConfig = (ctx && ctx.config && ctx.config.combat) || {};
    const fightConfig = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.fight) || {};
    this.settings = {
      ...combatConfig,
      ...fightConfig,
      attackRange: Math.max(1, finiteNumber(fightConfig.attackRange, finiteNumber(combatConfig.attackRange, FALLBACK.attackRange))),
      approachRange: Math.max(0, finiteNumber(fightConfig.approachRange, finiteNumber(combatConfig.approachRange, FALLBACK.approachRange))),
      maxMinutes: Math.max(0.1, finiteNumber(fightConfig.maxMinutes, FALLBACK.maxMinutes)),
      creeperDangerRadius: Math.max(1, finiteNumber(fightConfig.creeperDangerRadius, FALLBACK.creeperDangerRadius)),
      creeperRetreatDistance: Math.max(4, finiteNumber(fightConfig.creeperRetreatDistance, FALLBACK.creeperRetreatDistance)),
    };
    const target = this._target(ctx.bot);
    if (!target) {
      this.fail(FAILURE_REASONS.NO_TARGET);
      return false;
    }
    if (ctx.shadow) return true;
    return Promise.resolve(skills.inventory.equipBestWeapon(ctx.bot)).then((ok) => {
      if (ok === false) {
        this.fail(FAILURE_REASONS.TOOL_UNAVAILABLE);
        return false;
      }
      return true;
    });
  }

  progressMetric(ctx) {
    const target = this._target(ctx.bot);
    if (!target) return 100;
    if (Number.isFinite(Number(target.health))) return -Number(target.health);
    return -skills.move.positionDistance(ctx.bot.entity.position, target.position);
  }

  isDone(ctx) {
    const target = this._target(ctx.bot);
    if (!target) {
      if (!ctx.shadow) skills.combat.stopCombat(ctx.bot);
      return true;
    }
    return false;
  }

  isFailed(ctx) {
    if (this.tooDangerous) return { reason: FAILURE_REASONS.THREAT_TOO_HIGH };
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    return null;
  }

  _target(bot) {
    return skills.combat.findTarget(bot, {
      id: this.args.targetId,
      type: this.args.type,
      radius: this.settings && this.settings.threatRadius ? this.settings.threatRadius : 32,
    });
  }

  _tick(ctx) {
    const target = this._target(ctx.bot);
    if (!target) return;
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        target: target.name || target.displayName,
        id: target.id,
        dist: skills.move.positionDistance(ctx.bot.entity.position, target.position),
      });
      return;
    }
    if (this.pending) return;

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
      this.tooDangerous = true;
      return;
    }

    const result = skills.combat.combatTick(
      ctx.bot,
      target,
      this.combatState,
      this.settings,
      ctx.now
    );
    if (result.action === 'retreat') {
      this.retreating = true;
      const spot = skills.world.findSafeSpot(ctx.bot, {
        searchRadius: Math.max(8, this.settings.creeperRetreatDistance + 4),
        preferredDistance: this.settings.creeperRetreatDistance,
        threats: [{ position: target.position, dist: result.dist || 4 }],
      });
      if (!spot) {
        this.fail(FAILURE_REASONS.NO_SAFE_SPOT);
        return;
      }
      this.runPending('fight_retreat', () => skills.move.moveTo(ctx.bot, spot, {
        range: 1,
        timeoutMs: 6000,
      }));
      return;
    }
    if (!result.ok) {
      this._emit(ctx, 'fight_action_failed', {
        action: result.action,
        message: result.error || null,
      });
    }
  }

  onPendingSuccess(ctx, result, label) {
    if (label === 'fight_retreat') {
      this.fail(FAILURE_REASONS.THREAT_TOO_HIGH, { ctx });
    }
  }

  onPendingError(ctx, error, label) {
    if (label === 'fight_retreat') this.fail(FAILURE_REASONS.THREAT_TOO_HIGH, { ctx, error });
  }

  onFinish(ctx) {
    if (!this.retreating && (!ctx || !ctx.shadow)) skills.combat.stopCombat(ctx && ctx.bot);
  }
}

FightTask.kind = 'fight';
FightTask.priority = 50;
FightTask.selfTimed = true;
FightTask.schema = {
  type: 'object',
  properties: {
    targetId: { type: 'integer' },
    type: { type: 'string' },
  },
};

module.exports = { FightTask };
