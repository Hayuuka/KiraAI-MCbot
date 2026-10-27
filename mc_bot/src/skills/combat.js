'use strict';

const inventory = require('./inventory');
const move = require('./move');
const guard = require('./guard');

const THREAT_BASE = Object.freeze({
  warden: 999,
  elder_guardian: 999,
  creeper: 5,
  wither_skeleton: 4,
  blaze: 4,
  ghast: 3.5,
  skeleton: 3,
  stray: 3,
  pillager: 2.5,
  witch: 2.5,
  zombie: 2,
  husk: 2,
  drowned: 2,
  spider: 1.5,
  cave_spider: 2,
  enderman: 3,
  slime: 1,
  magma_cube: 2,
  phantom: 2.5,
  silverfish: 1,
});

const WEAPON_DAMAGE = Object.freeze({
  wooden_sword: 4,
  stone_sword: 5,
  iron_sword: 6,
  golden_sword: 4,
  diamond_sword: 7,
  netherite_sword: 8,
  wooden_axe: 3,
  stone_axe: 4,
  iron_axe: 5,
  golden_axe: 3,
  diamond_axe: 6,
  netherite_axe: 7,
  trident: 9,
  mace: 6,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bareName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().split(':').pop();
}

function threatScore(threat, context = {}) {
  const type = bareName(threat && (threat.type || threat.name));
  const base = THREAT_BASE[type] == null ? 1 : THREAT_BASE[type];
  if (base >= 999) return base;
  const dist = Number(threat && threat.dist);
  const hp = Number(context.hp);
  const armor = Number(context.armor);
  const hostileCount = Number(context.hostileCount);
  const light = Number(context.light);
  const distFactor = clamp(1.6 - (Number.isFinite(dist) ? dist : 12) / 12, 0.2, 1.6);
  const hpFactor = (1 - (Number.isFinite(hp) ? hp : 20) / 20) * 1.2;
  const gearFactor = Number.isFinite(armor) && armor >= 10 ? 0.7 : Number.isFinite(armor) && armor >= 4 ? 0.9 : 1.15;
  const countFactor = Number.isFinite(hostileCount) && hostileCount > 3 ? 1.5 : 1;
  const lightFactor = Number.isFinite(light) && light < 8 ? 1.1 : 1;
  // 燃烧的怪贴上来自带火焰伤害，近身打它自己也会被点着
  const fireFactor = threat && threat.onFire ? 1.45 : 1;
  return base * distFactor * gearFactor * countFactor * lightFactor * fireFactor + hpFactor;
}

function weaponDamageForItem(bot, item) {
  const name = bareName(item && item.name);
  if (WEAPON_DAMAGE[name] != null) return WEAPON_DAMAGE[name];
  try {
    const definition = bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName[name] : null;
    const damage = Number(definition && definition.damage);
    if (Number.isFinite(damage) && damage > 0) return damage;
  } catch (_) {}
  return 1;
}

function weaponDamage(bot) {
  return weaponDamageForItem(bot, bot && bot.heldItem);
}

function bestWeaponDamage(bot) {
  const held = weaponDamage(bot);
  const best = inventory.bestWeapon(bot);
  return Math.max(held, weaponDamageForItem(bot, best));
}

function myPower(bot, armor = 0) {
  const damage = bestWeaponDamage(bot);
  const hp = Number(bot && bot.health);
  const food = Number(bot && bot.food);
  return damage * 1.8 +
    (Number.isFinite(armor) ? armor : 0) * 0.25 +
    (Number.isFinite(hp) ? hp : 20) * 0.2 +
    (Number.isFinite(food) ? food : 20) * 0.05;
}

function shouldFlee(score, bot, armor = 0, ratio = 1.3) {
  return score > myPower(bot, armor) * Math.max(1, ratio);
}

function attackCooldownMs(bot, config = {}) {
  const name = bareName(bot && bot.heldItem && bot.heldItem.name);
  if (/_sword$/.test(name)) return Number(config.swordCooldownMs) || 625;
  if (/_axe$/.test(name)) return Number(config.axeCooldownMs) || 1000;
  if (name === 'trident') return Number(config.tridentCooldownMs) || 900;
  return Number(config.defaultCooldownMs) || 400;
}

function isCreeper(entity) {
  return bareName(entity && (entity.name || entity.displayName)) === 'creeper';
}

function creeperPrimed(entity, threshold = 1) {
  if (!isCreeper(entity) || !entity.metadata) return false;
  let value = entity.metadata.fuse;
  if (value == null && entity.metadata[16] != null) value = entity.metadata[16];
  if (value == null && Array.isArray(entity.metadata)) value = entity.metadata[16] ?? entity.metadata[17];
  const number = Number(value);
  return Number.isFinite(number) && number >= threshold;
}

function stopCombat(bot) {
  try {
    if (bot && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
    if (bot && typeof bot.clearControlStates === 'function') bot.clearControlStates();
  } catch (_) {}
}

function clearControlLater(bot, control, ms) {
  setTimeout(() => {
    try {
      bot.setControlState(control, false);
    } catch (_) {}
  }, Math.max(20, Number(ms) || 100));
}

/**
 * 同步战斗 tick：接近、转向、走位、按武器冷却攻击。
 * 返回 action 供任务决定是否改用撤离动作。
 */
function combatTick(bot, target, state, config = {}, now = Date.now()) {
  if (!bot || !bot.entity || !target || !target.position) {
    return { ok: true, action: 'target_gone' };
  }
  const distance = move.positionDistance(bot.entity.position, target.position);
  if (isCreeper(target)) {
    const dangerRadius = Number(config.creeperDangerRadius) || 4;
    return {
      ok: true,
      action: 'retreat',
      reason: creeperPrimed(target, Number(config.creeperFuseValue) || 1) || distance <= dangerRadius
        ? 'creeper_close'
        : 'creeper_avoid',
      dist: Math.round(distance * 10) / 10,
    };
  }

  if (distance > (Number(config.attackRange) || 2.6)) {
    try {
      const { goals } = require('mineflayer-pathfinder');
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        const p = target.position;
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, Number(config.approachRange) || 2));
      }
    } catch (_) {}
    return { ok: true, action: 'chasing', dist: Math.round(distance * 10) / 10 };
  }

  try {
    if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
  } catch (_) {}

  if (now - (Number(state.lastLookAt) || 0) >= (Number(config.lookIntervalMs) || 100)) {
    state.lastLookAt = now;
    try {
      const height = Number(target.height) || 1.6;
      const chest = target.position.offset(0, height * 0.8, 0);
      if (typeof bot.lookAt === 'function') Promise.resolve(bot.lookAt(chest, true)).catch(() => {});
    } catch (_) {}
  }

  if (now - (Number(state.lastStrafeSwitchAt) || 0) >=
    (Number(state.strafeIntervalMs) || 900)) {
    state.lastStrafeSwitchAt = now;
    state.strafeDirection = state.strafeDirection === 'left' ? 'right' : 'left';
    state.strafeIntervalMs = 900 + Math.random() * 500;
    try {
      bot.setControlState('left', state.strafeDirection === 'left');
      bot.setControlState('right', state.strafeDirection === 'right');
    } catch (_) {}
  }

  if (distance < (Number(config.retreatDistance) || 2.2)) {
    try {
      bot.setControlState('back', true);
      clearControlLater(bot, 'back', Number(config.backstepMs) || 120);
    } catch (_) {}
  }

  if (now - (Number(state.lastAttackAt) || 0) < attackCooldownMs(bot, config)) {
    return { ok: true, action: 'waiting', dist: Math.round(distance * 10) / 10 };
  }

  state.lastAttackAt = now;
  state.attacksSinceJump = (Number(state.attacksSinceJump) || 0) + 1;
  try {
    bot.attack(target);
    if (state.attacksSinceJump >= (Number(config.jumpEveryAttacks) || 3)) {
      state.attacksSinceJump = 0;
      bot.setControlState('jump', true);
      clearControlLater(bot, 'jump', Number(config.jumpHoldMs) || 120);
    }
  } catch (error) {
    return {
      ok: false,
      action: 'attack_failed',
      error: error && error.message ? error.message : String(error),
    };
  }
  return { ok: true, action: 'attacked', dist: Math.round(distance * 10) / 10 };
}

function findTarget(bot, options = {}) {
  const wantedId = options.id == null ? null : Number(options.id);
  const wantedType = bareName(options.type);
  const radius = Number(options.radius);
  let best = null;
  let bestDistance = Infinity;
  for (const entity of Object.values((bot && bot.entities) || {})) {
    if (!entity || !entity.position || entity === bot.entity) continue;
    if (wantedId != null && Number(entity.id) !== wantedId) continue;
    if (wantedType && bareName(entity.name || entity.displayName) !== wantedType) continue;
    if (wantedId == null && !wantedType && !guard.isHostile(entity)) continue;
    const distance = move.positionDistance(bot.entity.position, entity.position);
    if (Number.isFinite(radius) && distance > radius) continue;
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

module.exports = {
  THREAT_BASE,
  WEAPON_DAMAGE,
  threatScore,
  weaponDamage,
  weaponDamageForItem,
  bestWeaponDamage,
  myPower,
  shouldFlee,
  attackCooldownMs,
  isCreeper,
  creeperPrimed,
  combatTick,
  stopCombat,
  findTarget,
};
