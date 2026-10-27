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

test('实战模式下 mc_stop 会清空新行为层的任务栈', () => {
  const { loadConfig } = require('../src/config');
  const { createRuntime } = require('../src/index');
  const tasks = require('../src/tasks');

  const config = loadConfig();
  const runtime = createRuntime({ config, log: { log() {}, warn() {}, info() {} } });
  const task = tasks.create('goto', { x: 100, y: 64, z: 100 }, { source: 'local', priority: 30 });
  runtime.brain.agenda.push(task, { now: Date.now(), leaseMs: null });
  assert.equal(runtime.brain.agenda.size, 1);

  const result = runtime.actions.stop();
  assert.equal(result.ok, true);
  assert.equal(runtime.brain.agenda.size, 0);
  runtime.stop();
});

test('brain.stopAll 停掉动作但保持行为层运行', () => {
  const { createBrain } = require('../src/body/brain');
  const tasks = require('../src/tasks');
  const { loadConfig } = require('../src/config');

  let cleared = 0;
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    pathfinder: { setGoal: () => {} },
    clearControlStates: () => { cleared += 1; },
    stopDigging: () => {},
  };
  const brain = createBrain({
    config: loadConfig(),
    connection: { getBot: () => bot, isReady: () => true },
    log: { log() {}, warn() {} },
    record: () => {},
  });
  brain.running = true;
  brain.agenda.push(
    tasks.create('goto', { x: 5, y: 64, z: 5 }, { source: 'local', priority: 30 }),
    { now: 0, leaseMs: null },
  );

  brain.stopAll('test');
  assert.equal(brain.agenda.size, 0);
  assert.equal(cleared, 1);
  assert.equal(brain.running, true, '停下不等于关闭行为层');
});

test('实战模式下 mc_follow 会创建 follow 任务', () => {
  const { loadConfig } = require('../src/config');
  const { createRuntime } = require('../src/index');

  const config = loadConfig();
  const runtime = createRuntime({ config, log: { log() {}, warn() {}, info() {} } });
  const player = { username: 'Hayuuka', entity: { position: vec3(3, 64, 0) } };
  const fakeBot = {
    username: 'ChuXiaoxue',
    entity: { position: vec3(0, 64, 0) },
    players: { Hayuuka: player },
    pathfinder: { setGoal() {}, isMoving: () => false },
    inventory: { items: () => [], slots: Array(46).fill(null) },
    time: { timeOfDay: 6000 },
    game: { dimension: 'overworld' },
    health: 20,
    food: 20,
    registry: { itemsByName: {}, blocksByName: {}, foodsByName: {} },
    on() {},
    setControlState() {},
    clearControlStates() {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty', light: 15 }),
  };
  runtime.connection.getBot = () => fakeBot;
  runtime.connection.isReady = () => true;

  const result = runtime.actions.follow({ player: 'Hayuuka' });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'brain');
  assert.equal(runtime.brain.agenda.top().kind, 'follow');
  runtime.stop();
});

test('被连续攻击时 hurt 反射按武器冷却持续反击，不是冷却期干站着', async () => {
  const { createHurtReflex } = require('../src/body/interrupts');

  let attacks = 0;
  const zombie = { id: 1, name: 'zombie', position: vec3(2, 64, 0), health: 20 };
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: { 1: zombie },
    heldItem: { name: 'iron_sword' },
    inventory: {
      items: () => [{ name: 'iron_sword', type: 1, count: 1, slot: 36 }],
      slots: Array(46).fill(null),
    },
    pathfinder: { setGoal() {} },
    attack: () => { attacks += 1; },
    lookAt: async () => {},
    equip: async () => {},
    registry: {},
  };
  const reflex = createHurtReflex({
    counterMinHp: 12,
    counterRadius: 4,
    swingCooldownMs: 650,
    cooldownMs: 250,
  });
  const perception = { self: { hp: 20 }, threats: [{ id: 1, type: 'zombie', dist: 2 }] };

  let t = 100000;
  for (let i = 0; i < 30; i += 1) {
    t += 100;
    const ctx = { now: t, bot, perception, lastHurtAt: t, shadow: false, record: () => {} };
    if (reflex.condition(perception, ctx)) {
      const result = reflex.run(ctx);
      if (result && result.then) await result;
    }
  }
  assert.ok(attacks >= 4, `3 秒内至少应攻击 4 次，实际 ${attacks}`);
});

test('hurt 反射在够不着时会追过去而不是原地不动', async () => {
  const { createHurtReflex } = require('../src/body/interrupts');
  const goalsSet = [];
  const zombie = { id: 2, name: 'zombie', position: vec3(8, 64, 0), health: 20 };
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: { 2: zombie },
    heldItem: { name: 'iron_sword' },
    inventory: {
      items: () => [{ name: 'iron_sword', type: 1, count: 1, slot: 36 }],
      slots: Array(46).fill(null),
    },
    pathfinder: { setGoal: (goal) => goalsSet.push(goal) },
    attack: () => {},
    lookAt: async () => {},
    equip: async () => {},
    registry: {},
  };
  const reflex = createHurtReflex({ counterMinHp: 12, counterRadius: 4, chaseRadius: 16 });
  const perception = { self: { hp: 20 }, threats: [{ id: 2, type: 'zombie', dist: 8 }] };
  const ctx = { now: 100000, bot, perception, lastHurtAt: 100000, shadow: false, record: () => {} };

  const result = reflex.run(ctx);
  if (result && result.then) await result;
  assert.equal(goalsSet.length, 1, '应该设置寻路目标追过去');
});

test('打断日志不会每 tick 重复记录', () => {
  const { createBrain } = require('../src/body/brain');
  const { loadConfig } = require('../src/config');
  const events = [];
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    health: 20,
    food: 20,
    isSleeping: false,
    time: { timeOfDay: 6000 },
    game: { dimension: 'overworld' },
    players: {},
    entities: { 1: { id: 1, name: 'zombie', position: vec3(2, 64, 0) } },
    inventory: { items: () => [], slots: Array(46).fill(null), emptySlotCount: () => 36 },
    registry: { itemsByName: {}, foodsByName: {} },
    pathfinder: { setGoal() {}, isMoving: () => false },
    blockAt: () => ({ name: 'grass_block', boundingBox: 'block', light: 15 }),
    on() {},
    attack() {},
    lookAt: async () => {},
    setControlState() {},
    clearControlStates() {},
  };
  let t = 100000;
  const brain = createBrain({
    config: loadConfig(),
    connection: { getBot: () => bot, isReady: () => true },
    log: { log() {}, warn() {} },
    record: (event) => events.push(event),
    now: () => t,
    brainConfig: { ...loadConfig().brain, shadowMode: false },
  });
  brain.running = true;
  brain._lastHurtAt = 100000;
  for (let i = 0; i < 20; i += 1) {
    t += 100;
    brain._lastHurtAt = t;
    brain.tick();
  }
  const active = events.filter((e) => e.event === 'interrupt_active');
  assert.ok(active.length <= 2, `20 个 tick 内 interrupt_active 不应重复刷屏，实际 ${active.length}`);
});

test('能识别燃烧的实体（metadata key 0 bit 0）', () => {
  const { perceive } = require('../src/body/perception');
  const bot = {
    entity: { position: vec3(0, 64, 0), velocity: vec3(0, 0, 0), onGround: true, metadata: { 0: 0x01 } },
    health: 20,
    food: 20,
    isSleeping: false,
    players: {},
    entities: {
      1: { id: 1, name: 'zombie', position: vec3(2, 64, 0), metadata: { 0: 0x01 } },
      2: { id: 2, name: 'zombie', position: vec3(3, 64, 0), metadata: { 0: 0x00 } },
    },
    time: { timeOfDay: 6000 },
    game: { dimension: 'overworld' },
    inventory: { items: () => [], emptySlotCount: () => 36, slots: [] },
    blockAt: () => ({ name: 'grass_block', boundingBox: 'block', light: 15, biome: { name: 'plains' } }),
    registry: { itemsByName: {}, foodsByName: {} },
  };
  const p = perceive(bot, { ready: true, now: Date.now() });
  const burning = p.threats.find((t) => t.id === 1);
  const normal = p.threats.find((t) => t.id === 2);
  assert.equal(burning.onFire, true, '燃烧的僵尸应标记 onFire');
  assert.equal(normal.onFire, false, '正常僵尸不应标记 onFire');
  assert.equal(p.self.onFire, true, '玩家自身着火也要能被识别');
});

test('燃烧的威胁评分更高', () => {
  const combat = require('../src/skills/combat');
  const ctx = { hp: 20, armor: 0, hostileCount: 1, light: 15 };
  const normal = combat.threatScore({ type: 'zombie', dist: 2, onFire: false }, ctx);
  const burning = combat.threatScore({ type: 'zombie', dist: 2, onFire: true }, ctx);
  assert.ok(burning > normal, `燃烧僵尸应更危险：${burning} vs ${normal}`);
});

test('自己着火时 fire 反射会优先找水', async () => {
  const { createFireReflex } = require('../src/body/interrupts');
  const move = require('../src/skills/move');

  const bot = {
    entity: { position: vec3(0, 64, 0), isInWater: false },
    pathfinder: { setGoal() {} },
  };
  const originalFind = move.findNearestBlock;
  const originalMoveTo = move.moveTo;
  const waterBlock = { name: 'water', position: vec3(5, 64, 5) };
  let movedTo = null;
  move.findNearestBlock = () => waterBlock;
  move.moveTo = async (b, target) => { movedTo = target; return { ok: true }; };

  try {
    const reflex = createFireReflex({});
    const perception = { self: { onFire: true }, threats: [] };
    const ctx = { now: 1000, bot, perception, shadow: false, record: () => {} };
    assert.equal(reflex.condition(perception, ctx), true);
    const result = reflex.run(ctx);
    if (result && result.then) await result;
    assert.ok(movedTo, '应该朝水源移动');
    assert.equal(movedTo.x, 5);
  } finally {
    move.findNearestBlock = originalFind;
    move.moveTo = originalMoveTo;
  }
});
