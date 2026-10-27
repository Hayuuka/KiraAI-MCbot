'use strict';

const inventorySkill = require('../skills/inventory');
const combatSkill = require('../skills/combat');

const HOSTILE_TYPES = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'illusioner', 'piglin_brute', 'hoglin',
  'zoglin', 'wither_skeleton', 'blaze', 'ghast', 'magma_cube', 'slime',
  'silverfish', 'endermite', 'warden', 'breeze',
]);

const PASSIVE_TYPES = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule',
  'llama', 'goat', 'fox', 'wolf', 'cat', 'ocelot', 'parrot', 'polar_bear',
  'panda', 'turtle', 'frog', 'axolotl', 'bee', 'villager', 'wandering_trader',
]);

const ARMOR_POINTS = Object.freeze({
  leather_helmet: 1, golden_helmet: 2, chainmail_helmet: 2, iron_helmet: 2,
  turtle_helmet: 2, diamond_helmet: 3, netherite_helmet: 3,
  leather_chestplate: 3, golden_chestplate: 5, chainmail_chestplate: 5,
  iron_chestplate: 6, diamond_chestplate: 8, netherite_chestplate: 8,
  leather_leggings: 2, golden_leggings: 3, chainmail_leggings: 4,
  iron_leggings: 5, diamond_leggings: 6, netherite_leggings: 6,
  leather_boots: 1, golden_boots: 1, chainmail_boots: 2, iron_boots: 2,
  diamond_boots: 3, netherite_boots: 3,
});

const DEFAULTS = Object.freeze({
  undergroundDepth: 8,
  threatRadius: 16,
  maxThreats: 8,
  maxNearby: 8,
  dayStartTick: 0,
  duskTick: 12000,
  nightStartTick: 13000,
  ticksPerDay: 24000,
});

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function bareName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().split(':').pop();
}

function entityType(entity) {
  return bareName(entity && (entity.name || entity.type || entity.displayName));
}

function positionOf(entity) {
  const position = entity && entity.position;
  if (!position) return null;
  const x = Number(position.x);
  const y = Number(position.y);
  const z = Number(position.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function blockAt(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return null;
  try {
    const Vec3 = bot.entity && bot.entity.position && bot.entity.position.constructor;
    const position = Vec3 ? new Vec3(x, y, z) : { x, y, z };
    return bot.blockAt(position);
  } catch (_) {
    return null;
  }
}

function isSolidBlock(block) {
  if (!block) return false;
  const name = bareName(block.name);
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return false;
  if (name === 'water' || name === 'lava') return false;
  return block.boundingBox !== 'empty';
}

function scanUnderground(bot, position, depth) {
  if (!bot || !position) return false;
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  const z = Math.floor(position.z);
  for (let offset = 1; offset <= depth; offset += 1) {
    if (isSolidBlock(blockAt(bot, x, y + offset, z))) return true;
  }
  return false;
}

function armorPoints(bot) {
  let points = 0;
  for (const slot of inventorySkill.ARMOR_SLOTS) {
    const item = inventorySkill.getEquippedItem(bot, slot);
    if (!item || !item.name) continue;
    const name = bareName(item.name);
    let value = ARMOR_POINTS[name];
    if (value == null) {
      try {
        const definition = bot.registry && bot.registry.itemsByName
          ? bot.registry.itemsByName[name]
          : null;
        value = Number(definition && definition.armorPoints);
      } catch (_) {
        value = 0;
      }
    }
    if (Number.isFinite(value)) points += value;
  }
  return points;
}

function effectsOf(bot) {
  const output = [];
  const effects = bot && bot.entity && bot.entity.effects;
  if (!effects || typeof effects !== 'object') return output;
  for (const effect of Object.values(effects)) {
    if (!effect) continue;
    const name = effect.name || effect.displayName || effect.id;
    if (name != null) output.push(String(name));
  }
  return output;
}

function heldItem(bot) {
  const item = bot && bot.heldItem;
  return item && item.name ? bareName(item.name) : null;
}

function inventorySummary(bot) {
  const counts = {};
  let items = [];
  try {
    if (bot && bot.inventory && typeof bot.inventory.items === 'function') items = bot.inventory.items();
  } catch (_) {
    items = [];
  }
  for (const item of items) {
    if (!item || !item.name) continue;
    const name = bareName(item.name);
    counts[name] = (counts[name] || 0) + (Number(item.count) || 1);
  }

  let freeSlots = null;
  try {
    if (bot && bot.inventory && typeof bot.inventory.emptySlotCount === 'function') {
      freeSlots = Number(bot.inventory.emptySlotCount());
    }
  } catch (_) {
    freeSlots = null;
  }

  return {
    counts,
    freeSlots: Number.isFinite(freeSlots) ? freeSlots : null,
    armor: armorPoints(bot),
  };
}

function nearbyPlayers(bot, origin, maxNearby) {
  const output = [];
  try {
    for (const player of Object.values((bot && bot.players) || {})) {
      if (!player || !player.username || player.username === bot.username) continue;
      const position = positionOf(player.entity);
      if (!position) continue;
      const dist = distanceBetween(origin, position);
      if (!Number.isFinite(dist) || dist > 32) continue;
      output.push({ name: String(player.username), dist: round1(dist) });
    }
  } catch (_) {
    return [];
  }
  output.sort((a, b) => a.dist - b.dist);
  return output.slice(0, maxNearby);
}

function nearbyEntities(bot, origin, config) {
  const threats = [];
  const animals = [];
  const items = [];
  const playerNames = new Set(
    Object.values((bot && bot.players) || {})
      .map((player) => player && player.username)
      .filter(Boolean)
  );

  let entities = {};
  try {
    entities = (bot && bot.entities) || {};
  } catch (_) {
    entities = {};
  }

  for (const entity of Object.values(entities)) {
    if (!entity || entity === bot.entity) continue;
    const position = positionOf(entity);
    if (!position) continue;
    const dist = distanceBetween(origin, position);
    if (!Number.isFinite(dist)) continue;
    const type = entityType(entity);
    if (!type) continue;

    if (playerNames.has(entity.username)) continue;
    if (HOSTILE_TYPES.has(type)) {
      if (dist <= config.threatRadius && threats.length < config.maxThreats) {
        threats.push({
          id: entity.id == null ? null : entity.id,
          type,
          dist: round1(dist),
          position,
          threat: null,
          hp: numberOrNull(entity.health),
          aggressive: null,
          lineOfSight: null,
        });
      }
    } else if (type === 'item' || type === 'item_stack') {
      if (dist <= 16 && items.length < config.maxNearby) {
        const label = entity.displayName || entity.name || 'item';
        items.push({ name: String(label), dist: round1(dist) });
      }
    } else if (PASSIVE_TYPES.has(type) && dist <= 24 && animals.length < config.maxNearby) {
      animals.push({ type, dist: round1(dist) });
    }
  }

  threats.sort((a, b) => a.dist - b.dist);
  animals.sort((a, b) => a.dist - b.dist);
  items.sort((a, b) => a.dist - b.dist);
  return { threats, animals, items };
}

function worldSnapshot(bot, position, config) {
  const tick = numberOrNull(bot && bot.time && bot.time.timeOfDay);
  const nightStart = config.nightStartTick;
  const dayStart = config.dayStartTick;
  const ticksPerDay = config.ticksPerDay;
  const isDay = tick == null ? null : tick >= dayStart && tick < nightStart;
  let ticksToDusk = null;
  let ticksToDawn = null;
  if (tick != null) {
    ticksToDusk = tick >= dayStart && tick < config.duskTick
      ? Math.max(0, config.duskTick - tick)
      : 0;
    ticksToDawn = tick < nightStart
      ? Math.max(0, ticksPerDay - nightStart + dayStart)
      : Math.max(0, ticksPerDay - tick + dayStart);
  }

  let biome = null;
  let light = null;
  let weather = 'clear';
  try {
    if (position) {
      const feet = blockAt(bot, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
      light = numberOrNull(feet && feet.light);
      if (feet && feet.biome && feet.biome.name) biome = String(feet.biome.name);
    }
    if (bot.isRaining) weather = Number(bot.thunderState) > 0 ? 'thunder' : 'rain';
  } catch (_) {
    // 视野字段拿不到时保持 null，不影响其他感知。
  }

  return {
    timeOfDay: tick == null ? null : Math.round(tick),
    isDay,
    ticksToDusk,
    ticksToDawn,
    weather,
    underground: scanUnderground(bot, position, config.undergroundDepth),
    biome,
    light,
  };
}

function selfSnapshot(bot, position, armor) {
  const entity = bot && bot.entity;
  const velocity = entity && entity.velocity;
  const positionBlock = position
    ? blockAt(bot, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    : null;
  return {
    pos: position ? { x: round1(position.x), y: round1(position.y), z: round1(position.z) } : null,
    dim: String((bot && bot.game && bot.game.dimension) || 'unknown'),
    hp: numberOrNull(bot && bot.health),
    food: numberOrNull(bot && bot.food),
    saturation: numberOrNull(bot && bot.foodSaturation),
    onGround: Boolean(entity && entity.onGround),
    inWater: Boolean(entity && entity.isInWater),
    inLava: Boolean(entity && entity.isInLava),
    isSleeping: Boolean(bot && bot.isSleeping),
    y: position ? round1(position.y) : null,
    light: numberOrNull(positionBlock && positionBlock.light),
    velocity: velocity ? {
      x: round1(velocity.x),
      y: round1(velocity.y),
      z: round1(velocity.z),
    } : null,
    held: heldItem(bot),
    armor,
    effects: effectsOf(bot),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * 同步采集一份纯数据快照。不把 mineflayer 对象带出去，避免任务层误改世界。
 */
function perceive(bot, options = {}) {
  const config = { ...DEFAULTS, ...(options.config || {}) };
  const position = positionOf(bot && bot.entity);
  const inventory = inventorySummary(bot);
  const nearby = position
    ? nearbyEntities(bot, position, config)
    : { threats: [], animals: [], items: [] };
  const ready = options.ready != null
    ? Boolean(options.ready)
    : Boolean(options.connection && typeof options.connection.isReady === 'function'
      ? options.connection.isReady()
      : bot);
  const self = selfSnapshot(bot, position, inventory.armor);
  const world = worldSnapshot(bot, position, config);
  const threatContext = {
    hp: self.hp,
    armor: inventory.armor,
    hostileCount: nearby.threats.length,
    light: world.light,
  };
  const threats = nearby.threats.map((threat) => ({
    ...threat,
    threat: Math.round(combatSkill.threatScore(threat, threatContext) * 100) / 100,
  }));
  const power = Math.round(combatSkill.myPower(bot, inventory.armor) * 100) / 100;
  for (const threat of threats) threat.canWin = threat.threat <= power;

  return deepFreeze({
    t: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    ready,
    self,
    world,
    threats,
    myPower: power,
    nearby: {
      players: position ? nearbyPlayers(bot, position, config.maxNearby) : [],
      animals: nearby.animals,
      items: nearby.items,
    },
    inventory,
  });
}

module.exports = {
  perceive,
  deepFreeze,
  HOSTILE_TYPES,
  PASSIVE_TYPES,
  DEFAULTS,
};
