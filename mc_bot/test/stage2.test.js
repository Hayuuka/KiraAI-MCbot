'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { createDrives } = require('../src/body/drives');
const { createBrain } = require('../src/body/brain');
const { createWatchdog } = require('../src/body/watchdog');
const { createAgenda } = require('../src/body/agenda');
const {
  createDefaultInterrupts,
  createLowHpReflex,
} = require('../src/body/interrupts');
const { Task, TASK_STATE, FAILURE_REASONS } = require('../src/tasks/base');
const skills = require('../src/skills');

function perception(overrides = {}) {
  return {
    t: 1000,
    ready: true,
    self: {
      hp: 20,
      food: 20,
      inWater: false,
      inLava: false,
      isSleeping: false,
      pos: { x: 0, y: 64, z: 0 },
      ...(overrides.self || {}),
    },
    world: {
      isDay: true,
      ticksToDusk: 6000,
      underground: false,
      ...(overrides.world || {}),
    },
    threats: overrides.threats || [],
    inventory: {
      counts: overrides.counts || {},
      freeSlots: 20,
    },
  };
}

function makeBot(options = {}) {
  const state = {
    position: options.position || vec3(0, 64, 0),
    health: options.health ?? 20,
    inWater: options.inWater === true,
    inLava: options.inLava === true,
  };
  const events = {};
  const controls = {};
  const bot = {
    username: 'ChuXiaoxue',
    health: state.health,
    food: 20,
    time: { timeOfDay: 6000 },
    game: { dimension: 'minecraft:overworld' },
    isSleeping: false,
    entity: {
      position: state.position,
      velocity: vec3(0, 0, 0),
      onGround: true,
      isInWater: state.inWater,
      isInLava: state.inLava,
      effects: {},
    },
    entities: options.entities || {},
    players: {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => [],
      emptySlotCount: () => 36,
    },
    pathfinder: {
      setGoal() {},
      isMoving() { return false; },
    },
    blockAt() {
      return { name: 'air', boundingBox: 'empty', light: 15 };
    },
    on(name, handler) {
      events[name] = handler;
    },
    setControlState(name, value) {
      controls[name] = value;
    },
    clearControlStates() {
      for (const key of Object.keys(controls)) controls[key] = false;
    },
    attack() {},
    lookAt() {},
  };
  bot.events = events;
  bot.controls = controls;
  return bot;
}

function brainConfig(extra = {}) {
  return {
    brain: {
      shadowMode: true,
      tickMs: 100,
      arbiterMs: 500,
      ...extra,
    },
  };
}

test('饥饿/健康/夜晚需求条使用不同触发与满足阈值', () => {
  const drives = createDrives();

  drives.update(perception({ self: { food: 6 } }), 1000);
  assert.equal(drives.get('hunger').active, true);
  drives.update(perception({ self: { food: 17 } }), 2000);
  assert.equal(drives.get('hunger').active, true, '17 仍低于满足阈值 18');
  drives.update(perception({ self: { food: 18 } }), 3000);
  assert.equal(drives.get('hunger').active, false);

  drives.update(perception({ self: { hp: 5 } }), 4000);
  assert.equal(drives.get('health').active, true);
  drives.update(perception({ self: { hp: 14 } }), 5000);
  assert.equal(drives.get('health').active, false);

  drives.update(perception({ world: { isDay: true, ticksToDusk: 1000 } }), 6000);
  assert.equal(drives.get('night').active, true);
  drives.update(perception({ world: { isDay: true, ticksToDusk: 5000 } }), 7000);
  assert.equal(drives.get('night').active, false);

  drives.update(perception({ world: { isDay: false, underground: true } }), 8000);
  assert.equal(drives.get('night').active, false);
});

test('默认反射已注册 lava > fire > low_hp > hurt > water', () => {
  const interrupts = createDefaultInterrupts({
    reflexConfig: {},
    onEvent() {},
  });
  assert.deepEqual(
    interrupts.snapshot().map((entry) => entry.kind),
    ['lava', 'fire', 'low_hp', 'hurt', 'water']
  );
});

test('低血反射在 shadow 下只记录，不移动也不跳', () => {
  const zombie = {
    id: 2,
    name: 'zombie',
    position: vec3(3, 64, 0),
  };
  const bot = makeBot({ health: 5, entities: { 2: zombie } });
  const records = [];
  const originalFindSafeSpot = skills.world.findSafeSpot;
  const originalMoveTo = skills.move.moveTo;
  let moved = 0;
  skills.world.findSafeSpot = () => ({ x: 12, y: 64, z: 0 });
  skills.move.moveTo = async () => {
    moved += 1;
    return { ok: true };
  };

  const brain = createBrain({
    config: brainConfig(),
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => 1000,
  });
  try {
    brain.start();
    brain.tick();
    brain.stop();
  } finally {
    skills.world.findSafeSpot = originalFindSafeSpot;
    skills.move.moveTo = originalMoveTo;
  }

  assert.equal(moved, 0);
  assert.ok(records.some((entry) => entry.event === 'interrupt_shadow_plan' && entry.kind === 'low_hp'));
  assert.equal(bot.controls.jump, undefined);
});

test('低血反射执行时会调用撤离移动', async () => {
  const zombie = {
    id: 2,
    name: 'zombie',
    position: vec3(3, 64, 0),
  };
  const bot = makeBot({ health: 5, entities: { 2: zombie } });
  const originalFindSafeSpot = skills.world.findSafeSpot;
  const originalMoveTo = skills.move.moveTo;
  const moves = [];
  skills.world.findSafeSpot = () => ({ x: 12, y: 64, z: 0 });
  skills.move.moveTo = async (targetBot, target, options) => {
    moves.push({ targetBot, target, options });
    return { ok: true };
  };

  const reflex = createLowHpReflex({});
  const ctx = {
    now: 1000,
    bot,
    perception: perception({
      self: { hp: 5 },
      threats: [{ id: 2, type: 'zombie', dist: 3, position: { x: 3, y: 64, z: 0 } }],
    }),
    record() {},
  };
  try {
    assert.equal(reflex.condition(ctx.perception, ctx), true);
    await reflex.run(ctx);
  } finally {
    skills.world.findSafeSpot = originalFindSafeSpot;
    skills.move.moveTo = originalMoveTo;
  }

  assert.equal(moves.length, 1);
  assert.equal(moves[0].target.x, 12);
});

test('受击事件会触发 hurt 反射；落水在 shadow 下不操作控制键', () => {
  const zombie = { id: 2, name: 'zombie', position: vec3(3, 64, 0) };
  const bot = makeBot({ entities: { 2: zombie } });
  const records = [];
  const brain = createBrain({
    config: brainConfig(),
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => 1000,
  });
  brain.start();
  brain.tick();
  assert.equal(typeof bot.events.entityHurt, 'function');
  bot.events.entityHurt(bot.entity);
  brain.tick();
  assert.ok(records.some((entry) => entry.event === 'interrupt_shadow_plan' && entry.kind === 'hurt'));
  brain.stop();

  const swimmer = makeBot({ inWater: true });
  const waterRecords = [];
  const waterBrain = createBrain({
    config: brainConfig(),
    connection: { getBot: () => swimmer, isReady: () => true },
    log: { warn() {}, log() {} },
    record: (entry) => waterRecords.push(entry),
    now: () => 1000,
  });
  waterBrain.start();
  waterBrain.tick();
  waterBrain.stop();

  assert.ok(waterRecords.some((entry) => entry.event === 'interrupt_shadow_plan' && entry.kind === 'water'));
  assert.equal(swimmer.controls.jump, undefined);
});

test('看门狗在任务无进展时回收栈顶', () => {
  class StaticTask extends Task {
    progressMetric() {
      return 0;
    }
  }
  StaticTask.kind = 'static';

  const agenda = createAgenda({ maxDepth: 4, defaultLeaseMs: 120000, now: () => 0 });
  const timer = createWatchdog({ config: { stuckProgressSec: 20, progressStaleSec: 45 } });
  const task = new StaticTask({}, { source: 'test' });
  const bot = makeBot();
  const records = [];
  const ctx = {
    now: 0,
    bot,
    perception: perception(),
    agenda,
    record: (event, payload) => records.push({ event, payload }),
  };
  agenda.push(task, { now: 0, leaseMs: 120000 });
  agenda.tick(ctx);
  assert.equal(task.state, TASK_STATE.RUNNING);

  const result = timer.check({ ...ctx, now: 21000 });
  assert.equal(result, false);
  assert.equal(agenda.top(), null);
  assert.equal(task.failure.reason, FAILURE_REASONS.NO_PROGRESS);
  assert.ok(records.some((entry) => entry.event === 'stuck_recovery'));
});

test('world.findSafeSpot 避开水并识别近处岩浆', () => {
  const blocks = new Map();
  for (let x = -8; x <= 8; x += 1) {
    for (let z = -8; z <= 8; z += 1) {
      const key = x + ',' + (63) + ',' + z;
      blocks.set(key, { name: 'stone', boundingBox: 'block' });
    }
  }
  const bot = makeBot();
  bot.blockAt = (position) => {
    const key = position.x + ',' + position.y + ',' + position.z;
    return blocks.get(key) || { name: 'air', boundingBox: 'empty' };
  };

  const spot = skills.world.findSafeSpot(bot, { searchRadius: 6, preferredDistance: 4 });
  assert.ok(spot);
  assert.ok(Math.abs(spot.x) >= 2 || Math.abs(spot.z) >= 2);

  blocks.set('1,63,0', { name: 'lava', boundingBox: 'empty' });
  assert.equal(skills.world.hasLavaNearby(bot, 2), true);
  blocks.delete('1,63,0');
  assert.equal(skills.world.hasLavaNearby(bot, 2), false);
});
