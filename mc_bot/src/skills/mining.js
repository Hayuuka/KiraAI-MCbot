'use strict';

const vec3 = require('vec3');
const mine = require('./mine');
const inventory = require('./inventory');
const place = require('./place');

const LIQUIDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const AIR = new Set(['air', 'cave_air', 'void_air']);

function bareName(name) {
  return String(name || '').toLowerCase().split(':').pop();
}

function positionOf(value) {
  if (!value) return null;
  const x = Math.floor(Number(value.x));
  const y = Math.floor(Number(value.y));
  const z = Math.floor(Number(value.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function blockAt(bot, position) {
  if (!bot || typeof bot.blockAt !== 'function') return null;
  const pos = positionOf(position);
  if (!pos) return null;
  try {
    return bot.blockAt(vec3(pos.x, pos.y, pos.z));
  } catch (_) {
    return null;
  }
}

function isAir(block) {
  if (!block) return false;
  return AIR.has(bareName(block.name)) || block.boundingBox === 'empty';
}

function isSolid(block) {
  if (!block || isAir(block)) return false;
  return block.boundingBox === 'block' || block.boundingBox === 'entity';
}

/**
 * 查看 position 下方连续方块的第一个危险。
 * position 本身不检查，从 y - 1 开始逐格向下。
 */
function probeBelow(bot, position, depth = 4) {
  const start = positionOf(position);
  if (!start) return { ok: false, hazard: 'unknown', blockName: null };
  const limit = Math.max(1, Math.min(32, Math.trunc(Number(depth) || 4)));
  let airRun = 0;
  let lastName = null;

  for (let offset = 1; offset <= limit; offset += 1) {
    const block = blockAt(bot, { x: start.x, y: start.y - offset, z: start.z });
    if (!block) return { ok: false, hazard: 'unknown', blockName: lastName };
    const name = bareName(block.name);
    lastName = name;
    if (name === 'lava' || name === 'flowing_lava') {
      return { ok: false, hazard: 'lava', blockName: name };
    }
    if (name === 'water' || name === 'flowing_water') {
      return { ok: false, hazard: 'water', blockName: name };
    }
    if (name === 'bedrock') {
      return { ok: false, hazard: 'bedrock', blockName: name };
    }
    if (isAir(block)) {
      airRun += 1;
      if (airRun >= 3) return { ok: false, hazard: 'fall', blockName: name };
    } else {
      airRun = 0;
    }
  }

  return { ok: true, hazard: null, blockName: lastName };
}

async function digBlockSafely(bot, block, options = {}) {
  if (!bot || !bot.entity || !bot.entity.position) {
    return { ok: false, code: 'bot_offline', error: 'bot offline' };
  }
  if (!block || !block.position) {
    return { ok: false, code: 'invalid_block', error: 'block is required' };
  }

  const target = positionOf(block.position);
  if (!target) return { ok: false, code: 'invalid_block', error: 'invalid block position' };
  const before = blockAt(bot, target);
  if (!before || isAir(before)) {
    return { ok: true, alreadyGone: true, hazard: null };
  }

  const probe = probeBelow(bot, target, options.probeDepth || options.depth || 4);
  if (probe.hazard === 'lava' || probe.hazard === 'water') {
    return {
      ok: false,
      code: 'hazard_' + probe.hazard,
      hazard: probe.hazard,
      blockName: probe.blockName,
    };
  }
  if (probe.hazard === 'fall' && options.allowFall !== true) {
    return {
      ok: false,
      code: 'hazard_fall',
      hazard: 'fall',
      blockName: probe.blockName,
    };
  }
  if (probe.hazard === 'bedrock' && options.allowBedrock !== true) {
    return {
      ok: false,
      code: 'hazard_bedrock',
      hazard: 'bedrock',
      blockName: probe.blockName,
    };
  }

  const result = await mine.mineBlock(bot, before, {
    timeoutMs: options.timeoutMs,
  });
  if (!result || result.ok === false) {
    return {
      ok: false,
      code: 'mine_failed',
      error: result && result.error ? result.error : 'mine failed',
    };
  }

  const after = blockAt(bot, target);
  if (!after || bareName(after.name) === bareName(before.name)) {
    return { ok: false, code: 'mine_failed', error: 'block did not break' };
  }
  return { ok: true, hazard: null, block: bareName(before.name) };
}

function torchTargets(bot, position) {
  const base = positionOf(position);
  if (!base) return [];
  return [
    base,
    { x: base.x + 1, y: base.y, z: base.z },
    { x: base.x - 1, y: base.y, z: base.z },
    { x: base.x, y: base.y, z: base.z + 1 },
    { x: base.x, y: base.y, z: base.z - 1 },
  ];
}

async function placeTorchIfDark(bot, options = {}) {
  if (!bot || !bot.entity || !bot.entity.position) {
    return { ok: false, placed: false, error: 'bot offline' };
  }
  const position = positionOf(options.position || bot.entity.position);
  if (!position) return { ok: false, placed: false, error: 'invalid position' };
  if (inventory.count(bot, 'torch') <= 0) {
    return { ok: true, placed: false, reason: 'no_torch' };
  }

  const lightBlock = blockAt(bot, position);
  const light = Number(lightBlock && lightBlock.light);
  if (Number.isFinite(light) && light >= 8) {
    return { ok: true, placed: false, reason: 'bright_enough', light };
  }

  for (const target of torchTargets(bot, position)) {
    const targetBlock = blockAt(bot, target);
    const support = blockAt(bot, { x: target.x, y: target.y - 1, z: target.z });
    if (!isAir(targetBlock) || !isSolid(support)) continue;
    const result = await place.placeTorchAt(bot, target, {
      timeoutMs: options.timeoutMs,
      settleMs: options.settleMs,
    });
    if (result && result.ok) {
      return { ok: true, placed: true, position: target, light };
    }
    return {
      ok: false,
      placed: false,
      error: result && result.error ? result.error : 'torch placement failed',
      light,
    };
  }

  return { ok: false, placed: false, error: 'no safe torch position', light };
}

module.exports = {
  LIQUIDS,
  bareName,
  blockAt,
  isAir,
  isSolid,
  probeBelow,
  digBlockSafely,
  placeTorchIfDark,
};
