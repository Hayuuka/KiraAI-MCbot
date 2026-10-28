'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { createAgenda } = require('../src/body/agenda');
const { createArbiter } = require('../src/body/arbiter');
const { EatTask } = require('../src/tasks/eat');
const { HealTask } = require('../src/tasks/heal');
const { FleeTask } = require('../src/tasks/flee');
const { SleepTask } = require('../src/tasks/sleep');
const tasks = require('../src/tasks');
const skills = require('../src/skills');

function key(position) {
  return position.x + ',' + position.y + ',' + position.z;
}

function makeBlock(name, x, y, z, extra = {}) {
  return {
    name,
    position: vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    ...extra,
  };
}

function makeBot(options = {}) {
  const blocks = new Map();
  const state = {
    items: (options.items || []).slice(),
    position: options.position || vec3(0, 64, 0),
    isSleeping: false,
  };
  const calls = { equip: 0, consume: 0, sleep: 0, goals: 0, place: 0, dig: 0 };
  const bot = {
    username: 'ChuXiaoxue',
    health: options.health ?? 20,
    food: options.food ?? 20,
    time: { timeOfDay: options.timeOfDay ?? 6000 },
    game: { dimension: 'minecraft:overworld' },
    isSleeping: false,
    entity: {
      position: state.position,
      velocity: vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      effects: {},
    },
    entities: options.entities || {},
    players: {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => state.items.slice(),
      emptySlotCount: () => Math.max(0, 36 - state.items.length),
    },
    pathfinder: {
      setGoal() { calls.goals += 1; },
      isMoving() { return false; },
    },
    blockAt(position) {
      return blocks.get(key(position)) || makeBlock('air', position.x, position.y, position.z);
    },
    findBlock({ maxDistance, matching }) {
      for (const block of blocks.values()) {
        if (matching(block) && block.position.distanceTo(state.position) <= maxDistance) return block;
      }
      return null;
    },
    equip: async (item) => {
      calls.equip += 1;
      bot.heldItem = item;
    },
    consume: async () => {
      calls.consume += 1;
      bot.food = 20;
    },
    sleep: async (bed) => {
      calls.sleep += 1;
      bot.bed = bed;
      bot.isSleeping = true;
    },
    placeBlock: async (reference, face) => {
      calls.place += 1;
      const target = reference.position.plus(face);
      blocks.set(key(target), makeBlock(bot.heldItem.name, target.x, target.y, target.z));
    },
    dig: async (block) => {
      calls.dig += 1;
      blocks.set(key(block.position), makeBlock('air', block.position.x, block.position.y, block.position.z));
    },
    setControlState() {},
    clearControlStates() {},
    on() {},
    attack() {},
    lookAt() {},
  };
  Object.defineProperty(bot, 'heldItem', {
    configurable: true,
    get() { return bot._heldItem || null; },
    set(value) { bot._heldItem = value; },
  });
  bot.blocks = {
    set(x, y, z, name, extra) { blocks.set(x + ',' + y + ',' + z, makeBlock(name, x, y, z, extra)); },
    get(x, y, z) { return blocks.get(x + ',' + y + ',' + z) || null; },
  };
  bot.calls = calls;
  return bot;
}

function makeConfig() {
  return {
    tasks: {
      idle: { durationMs: 5000 },
      goto: {},
      collectBlock: {},
      eat: { untilFood: 18, maxMinutes: 2, consumeTimeoutMs: 1000 },
      heal: { targetHp: 16, eatUntilFood: 18, maxMinutes: 5, consumeTimeoutMs: 1000 },
      flee: { distance: 16, searchRadius: 20, moveTimeoutMs: 1000, timeoutSec: 20, maxAttempts: 3 },
      sleep: {
        startBeforeDuskTicks: 1200,
        bedSearchRadius: 24,
        flatSearchRadius: 6,
        reach: 3,
        moveTimeoutMs: 1000,
        sleepTimeoutMs: 1000,
        maxMinutes: 10,
        maxAttempts: 4,
        monsterRadius: 8,
      },
    },
    local: {
      minHpToWork: 10,
      dangerRadius: 8,
      workAtNight: false,
      collectPriority: 40,
      strollPriority: 30,
      idlePriority: 10,
      strollMinRadius: 4,
      strollMaxRadius: 12,
    },
  };
}

function makePerception(overrides = {}) {
  return {
    self: {
      hp: 20,
      food: 20,
      isSleeping: false,
      pos: { x: 0, y: 64, z: 0 },
      ...(overrides.self || {}),
    },
    world: {
      isDay: false,
      ticksToDusk: 0,
      underground: false,
      ...(overrides.world || {}),
    },
    threats: overrides.threats || [],
    inventory: { counts: overrides.counts || {} },
  };
}

function makeContext(bot, overrides = {}) {
  return {
    bot,
    now: 1000,
    shadow: true,
    config: makeConfig(),
    perception: makePerception(),
    record() {},
    ...overrides,
  };
}

test('eat 在 shadow 下不进食，并由饥饿值世界状态判定完成', () => {
  const bot = makeBot({ food: 10, items: [{ name: 'bread', count: 2 }] });
  const task = new EatTask({}, { source: 'test' });
  const ctx = makeContext(bot);

  task.tick(ctx);
  assert.equal(task.state, 'running');
  assert.equal(bot.calls.equip, 0);
  assert.equal(bot.calls.consume, 0);

  bot.food = 18;
  task.tick({ ...ctx, now: 1100 });
  assert.equal(task.state, 'done');
});

test('heal 由血量世界状态判定完成', () => {
  const bot = makeBot({ health: 10, food: 20 });
  const task = new HealTask({}, { source: 'test' });
  const ctx = makeContext(bot);

  task.tick(ctx);
  assert.equal(bot.calls.consume, 0);
  bot.health = 16;
  task.tick({ ...ctx, now: 1100 });
  assert.equal(task.state, 'done');
});

test('flee 由威胁距离判定完成，shadow 不寻路', () => {
  const bot = makeBot();
  const task = new FleeTask({ distance: 16 }, { source: 'test' });
  const ctx = makeContext(bot, {
    perception: makePerception({
      threats: [{ type: 'zombie', dist: 4, position: { x: 4, y: 64, z: 0 } }],
    }),
  });

  task.tick(ctx);
  assert.equal(bot.calls.goals, 0);
  task.tick({
    ...ctx,
    now: 1100,
    perception: makePerception({
      threats: [{ type: 'zombie', dist: 20, position: { x: 20, y: 64, z: 0 } }],
    }),
  });
  assert.equal(task.state, 'done');
});

test('sleep 在 shadow 下不调用 bot.sleep，执行时由 isSleeping 判定成功', async () => {
  const bot = makeBot({ items: [{ name: 'red_bed', count: 1 }] });
  bot.blocks.set(0, 63, 0, 'stone');
  bot.blocks.set(2, 63, 0, 'stone');
  bot.blocks.set(2, 64, 0, 'red_bed');
  const perception = makePerception({ world: { isDay: false, ticksToDusk: 0, underground: false } });
  const task = new SleepTask({}, { source: 'test' });
  const ctx = makeContext(bot, { perception });

  task.tick(ctx);
  assert.equal(bot.calls.sleep, 0);

  const liveTask = new SleepTask({}, { source: 'test' });
  liveTask.tick({ ...ctx, shadow: false });
  await new Promise((resolve) => setImmediate(resolve));
  liveTask.tick({ ...ctx, shadow: false, now: 1100 });
  assert.equal(bot.calls.sleep, 1);
  assert.equal(liveTask.state, 'done');
});

test('placeBedAt 只有在目标方块真的变成床后才成功', async () => {
  const bot = makeBot({ items: [{ name: 'red_bed', count: 1 }] });
  bot.blocks.set(0, 63, 0, 'stone');
  const result = await skills.place.placeBedAt(bot, { x: 0, y: 64, z: 0 }, { settleMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(bot.blocks.get(0, 64, 0).name, 'red_bed');
});

test('shelter 任务已不再注册', () => {
  assert.equal(tasks.get('shelter'), null);
});

test('夜间仲裁无床时回退到 idle', () => {
  const bot = makeBot({ items: [{ name: 'dirt', count: 3 }] });
  bot.blocks.set(0, 63, 0, 'stone');
  bot.blocks.set(1, 63, 0, 'stone');
  bot.blocks.set(2, 63, 0, 'stone');
  bot.blocks.set(2, 64, 0, 'stone');
  bot.blocks.set(2, 65, 0, 'stone');
  const config = makeConfig();
  const perception = makePerception({ world: { isDay: false, ticksToDusk: 0, underground: false } });
  const arbiter = createArbiter({
    config,
    tasks,
    drives: { urgent: () => ['night'] },
  });
  const choice = arbiter.step({
    bot,
    now: 1000,
    perception,
    config,
    agenda: createAgenda({ now: () => 1000 }),
    record() {},
  });

  assert.equal(choice.kind, 'idle');
  assert.match(choice.reason, /^night_no_option/);
});
