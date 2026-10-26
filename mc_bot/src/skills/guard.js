'use strict';

const { positionDistance, round1 } = require('./move');

const HOSTILE_NAMES = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'bogged',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'vex',
  'blaze',
  'ghast',
  'magma_cube',
  'slime',
  'phantom',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian',
  'shulker',
  'hoglin',
  'zoglin',
  'piglin_brute',
  'wither_skeleton',
  'wither',
  'warden',
]);

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function bareName(value) {
  return String(value || '').toLowerCase().split(':').pop();
}

function isHostile(entity) {
  if (!entity) return false;
  if (entity.type === 'player' || entity.username) return false;
  const name = bareName(entity.name || entity.displayName || '');
  return HOSTILE_NAMES.has(name) || entity.type === 'hostile';
}

function findNearestHostile(bot, radius = 6) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return null;
    const maxDistance = Math.max(1, Number(radius) || 6);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || entity === bot.entity || entity.id === bot.entity.id) continue;
      if (!entity.position || !isHostile(entity)) continue;
      const distance = positionDistance(bot.entity.position, entity.position);
      if (distance <= maxDistance && distance < nearestDistance) {
        nearest = entity;
        nearestDistance = distance;
      }
    }
    return nearest ? { entity: nearest, distance: nearestDistance } : null;
  } catch (_) {
    return null;
  }
}

function entityLabel(entity) {
  if (!entity) return 'unknown';
  return bareName(entity.name || entity.displayName || entity.type || 'entity');
}

function guardTick(bot, options = {}) {
  try {
    if (!bot || !bot.entity) return { ok: false, error: 'bot offline' };
    const radius = Math.max(1, Number(options.radius) || 6);
    const cooldownMs = Math.max(100, Number(options.cooldownMs) || 900);
    const state = options.state || {};
    const target = findNearestHostile(bot, radius);
    if (!target) return { ok: true, target: null };

    const now = Date.now();
    if (now - (Number(state.lastAttackAt) || 0) < cooldownMs) {
      return { ok: true, target: { type: entityLabel(target.entity), dist: round1(target.distance) }, waiting: true };
    }

    // 够不着就走过去。之前只挥拳不移动，怪站在 3 格外永远打不到，
    // 表现为"守家 3 分钟毫无进展"。
    if (target.distance > 3.0) {
      state.lastAttackAt = now;
      try {
        if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
          const { goals } = require('mineflayer-pathfinder');
          const p = target.entity.position;
          bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));
        } else {
          const p = target.entity.position;
          const me = bot.entity.position;
          bot.entity.yaw = Math.atan2(p.z - me.z, p.x - me.x) - Math.PI / 2;
          bot.setControlState('forward', true);
          setTimeout(() => {
            try { bot.setControlState('forward', false); } catch (_) {}
          }, 400);
        }
      } catch (_) {
        // 追不上就算了，下一轮再试
      }
      return { ok: true, target: { type: entityLabel(target.entity), dist: round1(target.distance) }, chasing: true };
    }

    state.lastAttackAt = now;
    try {
      // 进入攻击距离，停下追击，否则会从怪身上冲过去
      try {
        if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
          bot.pathfinder.setGoal(null);
        }
        bot.setControlState('forward', false);
      } catch (_) {}

      if (typeof bot.lookAt === 'function') {
        const eye = target.entity.position.offset(0, (target.entity.height || 1.6) * 0.8, 0);
        Promise.resolve(bot.lookAt(eye, true)).catch(() => {});
      }
      bot.attack(target.entity);
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }

    return { ok: true, target: { type: entityLabel(target.entity), dist: round1(target.distance) } };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

module.exports = {
  HOSTILE_NAMES,
  isHostile,
  findNearestHostile,
  guardTick,
  entityLabel,
};
