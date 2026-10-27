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
    findBlock() { return null; },
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
