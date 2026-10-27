'use strict';

// 实战模式（shadowMode=false）下的接线检查。
// 这些 bug 在 shadow 模式下永远不会暴露，所以单独加一组测试。

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { probeBelow, digBlockSafely } = require('../src/skills/mining');

function worldBot(blocks) {
  const world = new Map();
  for (const [key, block] of Object.entries(blocks)) world.set(key, block);
  return {
    entity: { position: vec3(0, 64, 0) },
    blockAt(position) {
      const key = Math.floor(position.x) + ',' + Math.floor(position.y) + ',' + Math.floor(position.z);
      return world.get(key) || { name: 'air', boundingBox: 'empty' };
    },
  };
}

function solid(name = 'stone') {
  return { name, boundingBox: 'block' };
}

function blockAtKey(x, y, z) {
  return x + ',' + y + ',' + z;
}

test('probeBelow 能发现斜下方的岩浆', () => {
  const blocks = {};
  for (let y = 60; y <= 64; y += 1) blocks[blockAtKey(0, y, 0)] = solid();
  blocks[blockAtKey(1, 63, 0)] = { name: 'lava', boundingBox: 'empty' };

  const result = probeBelow(worldBot(blocks), vec3(0, 64, 0), 4);
  assert.equal(result.ok, false);
  assert.equal(result.hazard, 'lava');
});

test('probeBelow 在纯石头环境仍判定安全', () => {
  const blocks = {};
  for (let y = 58; y <= 64; y += 1) {
    for (let x = -1; x <= 1; x += 1) {
      for (let z = -1; z <= 1; z += 1) blocks[blockAtKey(x, y, z)] = solid();
    }
  }
  const result = probeBelow(worldBot(blocks), vec3(0, 64, 0), 4);
  assert.equal(result.ok, true);
  assert.equal(result.hazard, null);
});

test('probeBelow 能发现正下方的岩浆', () => {
  const blocks = {};
  blocks[blockAtKey(0, 63, 0)] = solid();
  blocks[blockAtKey(0, 62, 0)] = { name: 'lava', boundingBox: 'empty' };
  const result = probeBelow(worldBot(blocks), vec3(0, 64, 0), 4);
  assert.equal(result.hazard, 'lava');
});

test('probeBelow 能发现连续空气造成的坠落风险', () => {
  const blocks = {};
  blocks[blockAtKey(0, 63, 0)] = { name: 'air', boundingBox: 'empty' };
  blocks[blockAtKey(0, 62, 0)] = { name: 'air', boundingBox: 'empty' };
  blocks[blockAtKey(0, 61, 0)] = { name: 'air', boundingBox: 'empty' };
  const result = probeBelow(worldBot(blocks), vec3(0, 64, 0), 4);
  assert.equal(result.hazard, 'fall');
});

test('digBlockSafely 拒绝挖开旁边就是岩浆的方块', async () => {
  const blocks = {};
  blocks[blockAtKey(0, 64, 0)] = solid();
  blocks[blockAtKey(0, 63, 0)] = solid();
  blocks[blockAtKey(0, 62, 0)] = solid();
  blocks[blockAtKey(1, 64, 0)] = { name: 'lava', boundingBox: 'empty' };

  const bot = worldBot(blocks);
  bot.dig = async () => { throw new Error('should not be called'); };
  const block = { ...bot.blockAt(vec3(0, 64, 0)), position: vec3(0, 64, 0) };

  const result = await digBlockSafely(bot, block, { probeDepth: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.hazard, 'lava');
});
