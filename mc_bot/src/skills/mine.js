'use strict';

const pathfinderSkill = require('./move');
const inventory = require('./inventory');

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
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

function blockInfo(block) {
  return {
    type: pathfinderSkill.normalizeBlockName(block.name),
    pos: [Math.round(block.position.x), Math.round(block.position.y), Math.round(block.position.z)],
  };
}

async function mineBlock(bot, block, options = {}) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return { ok: false, error: 'bot offline' };
    if (!block || !block.position) return { ok: false, error: 'block is required' };
    const timeoutMs = Math.max(2000, Math.min(30000, Number(options.timeoutMs) || 15000));
    const distance = pathfinderSkill.positionDistance(bot.entity.position, block.position);
    if (distance > 6.5) return { ok: false, error: 'block is too far away' };

    const beforeName = pathfinderSkill.normalizeBlockName(block.name);
    const toolReady = await inventory.equipBestTool(bot, block);
    if (!toolReady) return { ok: false, error: 'no suitable tool in inventory' };
    try {
      await withTimeout(bot.dig(block, true), timeoutMs, 'dig');
    } catch (error) {
      return { ok: false, error: 'dig failed: ' + errorText(error) };
    }

    await pathfinderSkill.sleep(250);
    const after = bot.blockAt(block.position);
    if (!after) return { ok: false, error: 'could not verify block after dig' };
    if (pathfinderSkill.normalizeBlockName(after.name) === beforeName) {
      return { ok: false, error: 'block did not break (adventure mode or protected area)' };
    }
    return { ok: true, block: blockInfo(block) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function mineNearest(bot, blockId, options = {}) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return { ok: false, error: 'bot offline' };
    const radius = Math.max(1, Math.min(64, Number(options.radius) || 32));
    const block = pathfinderSkill.findNearestBlock(bot, blockId, radius);
    if (!block) return { ok: false, error: 'block not found within ' + radius + ' blocks: ' + blockId };

    const distance = pathfinderSkill.positionDistance(bot.entity.position, block.position);
    if (distance > 4.5) {
      const moved = await pathfinderSkill.moveTo(
        bot,
        { x: block.position.x, y: block.position.y, z: block.position.z },
        { range: 2, timeoutMs: options.moveTimeoutMs || 10000 }
      );
      if (!moved.ok) return { ok: false, error: 'could not reach block: ' + moved.error };
    }
    return await mineBlock(bot, block, options);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

module.exports = {
  mineBlock,
  mineNearest,
  startMine: mineNearest,
  withTimeout,
};
