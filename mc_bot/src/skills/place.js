'use strict';

const inventory = require('./inventory');
const world = require('./world');

const BUILDING_BLOCKS = Object.freeze([
  'cobblestone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks',
  'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'oak_log',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function blockName(block) {
  return String(block && block.name ? block.name : '').toLowerCase().split(':').pop();
}

function findPlacementSupport(bot, target, mode = 'below') {
  const candidates = [];
  if (mode === 'any') {
    candidates.push(
      { x: target.x, y: target.y - 1, z: target.z, face: [0, 1, 0] },
      { x: target.x + 1, y: target.y, z: target.z, face: [-1, 0, 0] },
      { x: target.x - 1, y: target.y, z: target.z, face: [1, 0, 0] },
      { x: target.x, y: target.y, z: target.z + 1, face: [0, 0, -1] },
      { x: target.x, y: target.y, z: target.z - 1, face: [0, 0, 1] },
      { x: target.x, y: target.y + 1, z: target.z, face: [0, -1, 0] }
    );
  } else {
    candidates.push({ x: target.x, y: target.y - 1, z: target.z, face: [0, 1, 0] });
  }
  for (const candidate of candidates) {
    const block = world.blockAt(bot, candidate.x, candidate.y, candidate.z);
    if (world.isSolid(block)) return { block, face: candidate.face };
  }
  return null;
}

function positionOf(position) {
  if (!position) return null;
  const x = Math.floor(Number(position.x));
  const y = Math.floor(Number(position.y));
  const z = Math.floor(Number(position.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

async function placeItemAt(bot, itemName, targetPosition, options = {}) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return { ok: false, error: 'bot offline' };
    const target = positionOf(targetPosition);
    if (!target) return { ok: false, error: 'invalid target' };
    const item = inventory.findItem(bot, itemName);
    if (!item) return { ok: false, error: 'item not in inventory: ' + itemName };

    const targetBlock = world.blockAt(bot, target.x, target.y, target.z);
    if (!world.isAir(targetBlock)) return { ok: false, error: 'target is not empty' };
    const supportInfo = findPlacementSupport(bot, target, options.supportMode);
    if (!supportInfo) {
      return {
        ok: false,
        error: options.supportMode === 'any'
          ? 'no adjacent supporting block'
          : 'no supporting block below target',
      };
    }
    const support = supportInfo.block;

    await bot.equip(item, 'hand');
    const Vec3 = bot.entity.position.constructor;
    const face = new Vec3(supportInfo.face[0], supportInfo.face[1], supportInfo.face[2]);
    await withTimeout(
      bot.placeBlock(support, face),
      Math.max(1000, Number(options.timeoutMs) || 5000),
      'place'
    );
    await sleep(Math.max(0, Number(options.settleMs) || 250));

    const placed = world.blockAt(bot, target.x, target.y, target.z);
    if (!placed || world.isAir(placed)) {
      return { ok: false, error: 'placed block was not observed' };
    }
    if (typeof options.accept === 'function' && !options.accept(blockName(placed))) {
      return { ok: false, error: 'unexpected placed block: ' + blockName(placed) };
    }
    return { ok: true, block: blockName(placed), position: target };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

function findBedItem(bot) {
  return inventory.findItem(bot, 'bed');
}

async function placeBedAt(bot, targetPosition, options = {}) {
  const bed = findBedItem(bot);
  if (!bed) return { ok: false, error: 'no bed in inventory' };
  return placeItemAt(bot, bed.name, targetPosition, {
    ...options,
    accept: (name) => /_bed$/.test(name),
  });
}

function findBuildingBlock(bot, required = 1) {
  for (const name of BUILDING_BLOCKS) {
    const count = inventory.count(bot, name);
    if (count >= required) return { name, count };
  }
  return null;
}

async function placeBuildingBlockAt(bot, targetPosition, options = {}) {
  const block = findBuildingBlock(bot, 1);
  if (!block) return { ok: false, error: 'no building block in inventory' };
  return placeItemAt(bot, block.name, targetPosition, {
    ...options,
    accept: (name) => name === block.name,
  });
}

async function placeTorchAt(bot, targetPosition, options = {}) {
  if (!inventory.findItem(bot, 'torch')) return { ok: false, error: 'no torch in inventory' };
  return placeItemAt(bot, 'torch', targetPosition, {
    ...options,
    accept: (name) => name === 'torch' || name === 'wall_torch' || name === 'soul_torch',
  });
}

module.exports = {
  BUILDING_BLOCKS,
  placeItemAt,
  findPlacementSupport,
  placeBedAt,
  placeBuildingBlockAt,
  placeTorchAt,
  findBedItem,
  findBuildingBlock,
  blockName,
};
