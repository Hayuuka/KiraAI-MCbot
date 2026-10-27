'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { createBrain } = require('../src/body/brain');
const { GotoTask } = require('../src/tasks/goto');

function makeBot(options = {}) {
  const state = {
    items: options.items || [],
    position: options.position || vec3(0, 64, 0),
    targets: options.targets || [],
  };
  return {
    username: 'ChuXiaoxue',
    health: options.health ?? 20,
    food: options.food ?? 10,
    time: { timeOfDay: 6000 },
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
      emptySlotCount: () => 20,
    },
    pathfinder: {
      setGoal() {},
      isMoving() { return false; },
    },
    blockAt() { return { name: 'air', boundingBox: 'empty', light: 15 }; },
    findBlock({ maxDistance, matching }) {
      return state.targets.find((target) =>
        matching(target) && target.position.distanceTo(state.position) <= maxDistance
      ) || null;
    },
    setControlState() {},
    clearControlStates() {},
    on() {},
  };
}

function makePerception(bot) {
  return {
    t: 1000,
    ready: true,
    self: {
      hp: bot.health,
      food: bot.food,
      armor: 0,
      pos: { x: 0, y: 64, z: 0 },
      isSleeping: false,
    },
    world: {
      isDay: true,
      ticksToDusk: 6000,
      underground: false,
      light: 15,
    },
    threats: [],
    inventory: { counts: { bread: 3 }, freeSlots: 20 },
  };
}

function setupPreemption() {
  const bot = makeBot({ food: 10, items: [{ name: 'bread', count: 3 }] });
  const records = [];
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: true,
        tickMs: 100,
        arbiterMs: 500,
        local: { localLeaseMs: 120000 },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => ['hunger'] },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
  });
  const perception = makePerception(bot);
  brain.perception = perception;
  const ctx = {
    bot,
    now: 1000,
    shadow: true,
    config: brain.config,
    agenda: brain.agenda,
    tasks: brain.tasks,
    drives: brain.drives,
    watchdog: brain.watchdog,
    perception,
    record: (event, payload) => records.push({ event, ...payload }),
  };
  const goto = new GotoTask({ x: 10, z: 0, tolerance: 2 }, { source: 'local', priority: 30 });
  brain.agenda.push(goto, { now: 1000, leaseMs: null });
  goto.tick(ctx);
  return { bot, brain, ctx, goto, records };
}

function setupCollectLease() {
  const log = {
    name: 'oak_log',
    position: vec3(3, 64, 0),
    boundingBox: 'block',
  };
  const bot = makeBot({
    items: [{ name: 'stone_axe', count: 1 }],
    targets: [log],
  });
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: true,
        tickMs: 100,
        arbiterMs: 500,
        local: { localLeaseMs: 1000 },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [] },
    log: { warn() {}, log() {} },
    record() {},
  });
  const perception = makePerception(bot);
  brain.perception = perception;
  const ctx = {
    bot,
    now: 1000,
    shadow: true,
    config: brain.config,
    agenda: brain.agenda,
    tasks: brain.tasks,
    drives: brain.drives,
    watchdog: brain.watchdog,
    perception,
    record() {},
  };
  return { brain, ctx };
}

test('栈顶非空时，饥饿需求能否插入', () => {
  const { brain, ctx, goto } = setupPreemption();
  brain._arbitrate(ctx);

  assert.equal(brain.agenda.size, 2);
  assert.equal(brain.agenda.top().kind, 'eat');
  assert.equal(goto.state, 'paused');
});

test('高优先级任务结束后，被暂停的任务恢复', () => {
  const { brain, ctx, goto } = setupPreemption();
  brain._arbitrate(ctx);
  const eat = brain.agenda.top();
  assert.equal(eat.kind, 'eat');

  eat.succeed({ ctx });
  brain.agenda.tick(ctx);

  assert.equal(brain.agenda.top(), goto);
  assert.equal(goto.state, 'running');
});

test('本地 collectBlock 任务能否活过 localLeaseMs', () => {
  const { brain, ctx } = setupCollectLease();
  const task = brain._arbitrate(ctx);
  assert.equal(task.kind, 'collectBlock');
  assert.equal(task.leaseExpiresAt, null);

  for (const now of [2000, 3000, 4000, 5000, 6000, 7000]) {
    brain.agenda.tick({ ...ctx, now });
  }

  assert.equal(brain.agenda.top(), task);
  assert.notEqual(task.state, 'failed');
  assert.notEqual(task.failure && task.failure.reason, 'lease_expired');
});
