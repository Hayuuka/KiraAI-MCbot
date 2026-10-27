'use strict';

const { Movements, goals } = require('mineflayer-pathfinder');

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBlockName(name) {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return '';
  return text.includes(':') ? text : 'minecraft:' + text;
}

function bareBlockName(name) {
  return normalizeBlockName(name).split(':').pop();
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function findPlayer(bot, name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const players = Object.values((bot && bot.players) || {});
  return players.find((player) => player && String(player.username || '').toLowerCase() === wanted.toLowerCase()) || null;
}

function positionDistance(from, to) {
  if (!from || !to) return Infinity;
  const dx = Number(from.x) - Number(to.x);
  const dy = Number(from.y) - Number(to.y);
  const dz = Number(from.z) - Number(to.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function parseXyz(value) {
  if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return { x, y, z };
    return null;
  }
  const parts = String(value || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/**
 * 支持三种写法：
 *   oak_log                 单个方块
 *   minecraft:oak_log       带命名空间
 *   #minecraft:logs         方块标签（模型常这么写，比如"任意原木"）
 *
 * 方块标签在 1.21+ 是服务端概念，客户端拿不到完整定义，所以这里内置一份
 * 常见标签的成员表。未收录的标签会退化成"名字包含标签后缀"的宽松匹配。
 */
const BLOCK_TAGS = {
  'minecraft:logs': [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
  ],
  'minecraft:planks': [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
    'crimson_planks', 'warped_planks',
  ],
  'minecraft:leaves': [
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
    'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves',
    'azalea_leaves', 'flowering_azalea_leaves',
  ],
  'minecraft:wool': [
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool',
    'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
  ],
  'minecraft:stone': [
    'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff',
  ],
  'minecraft:base_stone_overworld': ['stone', 'granite', 'diorite', 'andesite', 'tuff'],
  'minecraft:ores': [
    'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore',
    'lapis_ore', 'diamond_ore', 'emerald_ore', 'deepslate_coal_ore',
    'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
    'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore',
    'deepslate_emerald_ore', 'nether_quartz_ore', 'nether_gold_ore',
  ],
};

/**
 * 常见误写纠正：模型容易把"挖点石头"翻译成 stone_bricks 这类成品方块，
 * 而那些是玩家合成的，野外挖不到。这里映射回真正的天然方块。
 */
const BLOCK_ALIASES = {
  '#minecraft:stone_bricks': '#minecraft:stone',
  '#minecraft:stone_brick': '#minecraft:stone',
  'minecraft:stone_bricks': 'minecraft:stone',
  'stone_bricks': 'stone',
  'stone_brick': 'stone',
  'cobblestone': 'stone',
  'minecraft:cobblestone': 'minecraft:stone',
  '#minecraft:logs_that_burn': '#minecraft:logs',
  'log': '#minecraft:logs',
  'minecraft:log': '#minecraft:logs',
  'wood': '#minecraft:logs',
  'any_log': '#minecraft:logs',
  'tree': '#minecraft:logs',
  '#minecraft:overworld_natural_logs': '#minecraft:logs',
};

function applyAlias(blockId) {
  const key = String(blockId || '').trim().toLowerCase();
  return BLOCK_ALIASES[key] || blockId;
}

function expandBlockTarget(blockId) {
  const raw = String(applyAlias(blockId) || '').trim().toLowerCase();
  if (!raw) return null;
  if (!raw.startsWith('#')) {
    return { exact: normalizeBlockName(raw) };
  }
  const tag = raw.slice(1);
  const members = BLOCK_TAGS[tag];
  if (members) {
    return { members: members.map((name) => normalizeBlockName(name)) };
  }
  // 未收录的标签：按后缀做宽松匹配（如 #minecraft:saplings -> *_sapling）
  const suffix = tag.split(':').pop().replace(/s$/, '');
  return { suffix };
}

function findNearestBlock(bot, blockId, maxDistance = 64) {
  if (!bot || typeof bot.findBlock !== 'function') return null;
  const spec = expandBlockTarget(blockId);
  if (!spec) return null;

  const matches = (block) => {
    if (!block) return false;
    const name = normalizeBlockName(block.name);
    if (spec.exact) return name === spec.exact;
    if (spec.members) return spec.members.includes(name);
    if (spec.suffix) return name.split(':').pop().includes(spec.suffix);
    return false;
  };

  try {
    return bot.findBlock({ maxDistance, matching: matches });
  } catch (_) {
    return null;
  }
}

function resolveTarget(bot, target) {
  if (!bot || !bot.entity || !bot.entity.position) {
    return { ok: false, error: 'bot position unavailable' };
  }

  if (target && typeof target === 'object' && !Array.isArray(target)) {
    if (target.type === 'player' && target.name) {
      return resolveTarget(bot, 'player:' + target.name);
    }
    if (target.type === 'block' && (target.id || target.name)) {
      return resolveTarget(bot, 'block:' + (target.id || target.name));
    }
    const xyz = parseXyz(target);
    if (xyz) return { ok: true, kind: 'xyz', position: xyz, label: xyz.x + ',' + xyz.y + ',' + xyz.z };
  }

  const raw = String(target == null ? '' : target).trim();
  if (!raw) return { ok: false, error: 'target is required' };

  if (/^player:/i.test(raw)) {
    const name = raw.slice(7).trim();
    if (!name) return { ok: false, error: 'player name is required' };
    const player = findPlayer(bot, name);
    if (!player) return { ok: false, error: 'player not found: ' + name };
    if (!player.entity || !player.entity.position) return { ok: false, error: 'player not visible: ' + name };
    return {
      ok: true,
      kind: 'player',
      position: player.entity.position,
      entity: player.entity,
      label: name,
      distance: positionDistance(bot.entity.position, player.entity.position),
    };
  }

  if (/^block:/i.test(raw)) {
    const blockId = raw.slice(6).trim();
    if (!blockId) return { ok: false, error: 'block id is required' };
    const block = findNearestBlock(bot, blockId, 64);
    if (!block || !block.position) return { ok: false, error: 'block not found within 64 blocks: ' + blockId };
    return {
      ok: true,
      kind: 'block',
      position: block.position,
      block,
      label: normalizeBlockName(block.name),
      distance: positionDistance(bot.entity.position, block.position),
    };
  }

  if (/^xyz:/i.test(raw)) {
    const xyz = parseXyz(raw.slice(4));
    if (!xyz) return { ok: false, error: 'invalid xyz target' };
    return {
      ok: true,
      kind: 'xyz',
      position: xyz,
      label: xyz.x + ',' + xyz.y + ',' + xyz.z,
      distance: positionDistance(bot.entity.position, xyz),
    };
  }

  const player = findPlayer(bot, raw);
  if (player && player.entity && player.entity.position) {
    return {
      ok: true,
      kind: 'player',
      position: player.entity.position,
      entity: player.entity,
      label: raw,
      distance: positionDistance(bot.entity.position, player.entity.position),
    };
  }

  const block = findNearestBlock(bot, raw, 64);
  if (block && block.position) {
    return {
      ok: true,
      kind: 'block',
      position: block.position,
      block,
      label: normalizeBlockName(block.name),
      distance: positionDistance(bot.entity.position, block.position),
    };
  }

  return { ok: false, error: 'invalid target (use player:name, block:id, or xyz:x,y,z)' };
}

function makeVec3(bot, value) {
  if (value && typeof value.distanceTo === 'function') return value;
  const Vec3 = bot.entity && bot.entity.position && bot.entity.position.constructor;
  if (!Vec3) throw new Error('Vec3 unavailable');
  return new Vec3(Number(value.x), Number(value.y), Number(value.z));
}

function ensureMovements(bot) {
  if (!bot.pathfinder) throw new Error('pathfinder is not loaded');
  if (!bot._mcMovements) {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot._mcMovements = movements;
  }
  bot.pathfinder.setMovements(bot._mcMovements);
  return bot._mcMovements;
}

async function moveTo(bot, target, options = {}) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return { ok: false, error: 'bot offline' };
    const resolved = resolveTarget(bot, target);
    if (!resolved.ok) return resolved;

    const range = Math.max(0, Number(options.range) || 1);
    const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 10000));
    const horizontalOnly = options.horizontalOnly === true;
    const destination = makeVec3(bot, resolved.position);
    ensureMovements(bot);

    const goal = horizontalOnly
      ? new goals.GoalXZ(destination.x, destination.z)
      : new goals.GoalNear(destination.x, destination.y, destination.z, range);
    bot.pathfinder.setGoal(goal);

    const startedAt = Date.now();
    let lastMovingAt = startedAt;
    const tolerance = range + 1.2;

    while (Date.now() - startedAt < timeoutMs) {
      const position = bot.entity && bot.entity.position;
      if (!position) {
        bot.pathfinder.setGoal(null);
        return { ok: false, error: 'bot position unavailable' };
      }

      const distance = horizontalOnly
        ? Math.hypot(position.x - destination.x, position.z - destination.z)
        : positionDistance(position, destination);
      if (distance <= tolerance) {
        bot.pathfinder.setGoal(null);
        return {
          ok: true,
          kind: resolved.kind,
          target: resolved.label,
          dist: round1(distance),
        };
      }

      if (bot.pathfinder.isMoving && bot.pathfinder.isMoving()) {
        lastMovingAt = Date.now();
      } else if (Date.now() - lastMovingAt > 1500 && Date.now() - startedAt > 1500) {
        bot.pathfinder.setGoal(null);
        return { ok: false, error: 'pathfinder could not reach target' };
      }

      await sleep(150);
    }

    bot.pathfinder.setGoal(null);
    // 实测：在深水里 mineflayer 的寻路会原地挣扎（isMoving 恒 true 但坐标不变）。
    // 这时与其报模糊的 timeout，不如明确指出原因。
    if (bot.entity && bot.entity.isInWater) {
      return {
        ok: false,
        error: 'move timed out while in water; pathfinder cannot swim reliably here — try moving to land first',
        inWater: true,
        position: [round1(bot.entity.position.x), round1(bot.entity.position.y), round1(bot.entity.position.z)],
      };
    }
    return { ok: false, error: 'move timed out' };
  } catch (error) {
    try {
      if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
    } catch (_) {
      return { ok: false, error: errorText(error) };
    }
    return { ok: false, error: errorText(error) };
  }
}

function stopMove(bot) {
  try {
    if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

module.exports = {
  moveTo,
  stopMove,
  resolveTarget,
  findNearestBlock,
  expandBlockTarget,
  BLOCK_TAGS,
  findPlayer,
  normalizeBlockName,
  bareBlockName,
  positionDistance,
  parseXyz,
  sleep,
  round1,
  errorText,
};
