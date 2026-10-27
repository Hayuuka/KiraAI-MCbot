'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  playerRadius: 16,
  safeRadius: 8,
  safeHoldMs: 3000,
  durationMs: 600000,
});

function playerEntity(bot, name) {
  const player = bot && bot.players ? bot.players[name] : null;
  return player && player.entity && player.entity.position ? player.entity : null;
}

function nearestHostileNear(bot, origin, radius) {
  let best = null;
  let bestDistance = Infinity;
  for (const entity of Object.values((bot && bot.entities) || {})) {
    if (!entity || entity === bot.entity || !entity.position || !skills.guard.isHostile(entity)) continue;
    const distance = skills.move.positionDistance(origin, entity.position);
    if (!Number.isFinite(distance) || distance > radius || distance >= bestDistance) continue;
    best = entity;
    bestDistance = distance;
  }
  return best;
}

class AssistTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.combatState = {};
    this.playerSafe = false;
    this.safeSince = null;
    this.playerUnavailable = false;
  }

  static normalizeArgs(args = {}) {
    return { player: String(args.player || args.name || '').trim() };
  }

  static feasible(ctx = {}) {
    const name = String((ctx.args && ctx.args.player) || '').trim();
    if (!name || !playerEntity(ctx.bot, name)) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.assist;
    const player = playerEntity(ctx.bot, name);
    const target = nearestHostileNear(ctx.bot, player.position, finiteNumber(config && config.playerRadius, FALLBACK.playerRadius));
    if (!target) return null;
    return {
      args: { player: name },
      etaSec: 30,
      note: `协助 ${name}`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.assist) || {};
    this.settings = {
      ...((ctx && ctx.config && ctx.config.combat) || {}),
      playerRadius: Math.max(2, finiteNumber(config.playerRadius, FALLBACK.playerRadius)),
      safeRadius: Math.max(1, finiteNumber(config.safeRadius, FALLBACK.safeRadius)),
      safeHoldMs: Math.max(0, finiteNumber(config.safeHoldMs, FALLBACK.safeHoldMs)),
      durationMs: integerAtLeast(config.durationMs, FALLBACK.durationMs, 1000),
    };
    if (!playerEntity(ctx.bot, this.args.player)) {
      this.fail(FAILURE_REASONS.PLAYER_UNAVAILABLE);
      return false;
    }
    if (ctx.shadow) return true;
    return Promise.resolve(skills.inventory.equipBestWeapon(ctx.bot)).then((ok) => ok !== false);
  }

  progressMetric(ctx) {
    return this.playerSafe ? 100 : this.elapsedSec(ctx);
  }

  isDone(ctx) {
    return this.playerSafe || this.elapsedSec(ctx) * 1000 >= this.settings.durationMs;
  }

  isFailed() {
    return this.playerUnavailable ? { reason: FAILURE_REASONS.PLAYER_UNAVAILABLE } : null;
  }

  _tick(ctx) {
    const player = playerEntity(ctx.bot, this.args.player);
    if (!player) {
      this.playerUnavailable = true;
      return;
    }
    const target = nearestHostileNear(ctx.bot, player.position, this.settings.safeRadius);
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        player: this.args.player,
        target: target ? target.name : null,
      });
      return;
    }
    if (this.pending) return;

    if (!target) {
      if (this.safeSince === null) this.safeSince = ctx.now;
      if (ctx.now - this.safeSince >= this.settings.safeHoldMs) this.playerSafe = true;
      skills.combat.stopCombat(ctx.bot);
      return;
    }
    this.safeSince = null;

    const result = skills.combat.combatTick(ctx.bot, target, this.combatState, this.settings, ctx.now);
    if (result.action === 'retreat') {
      const spot = skills.world.findSafeSpot(ctx.bot, {
        searchRadius: 12,
        preferredDistance: this.settings.creeperRetreatDistance || 10,
        threats: [{ position: target.position, dist: result.dist || 4 }],
      });
      if (spot) {
        this.runPending('assist_retreat', () => skills.move.moveTo(ctx.bot, spot, {
          range: 1,
          timeoutMs: 5000,
        }));
      }
    }
  }

  onFinish(ctx) {
    if (!ctx || !ctx.shadow) skills.combat.stopCombat(ctx && ctx.bot);
  }
}

AssistTask.kind = 'assist';
AssistTask.priority = 50;
AssistTask.selfTimed = true;
AssistTask.schema = {
  type: 'object',
  properties: {
    player: { type: 'string' },
  },
  required: ['player'],
};

module.exports = { AssistTask };
