'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { perceive } = require('../src/body/perception');
const { createAgenda } = require('../src/body/agenda');
const { createBrain } = require('../src/body/brain');
const { Task, TASK_STATE, FAILURE_REASONS } = require('../src/tasks/base');
const { IdleTask } = require('../src/tasks/idle');
const { GotoTask } = require('../src/tasks/goto');
const { CollectBlockTask } = require('../src/tasks/collect');

function block(name, position, extra = {}) {
  return {
    name,
    position: vec3(position[0], position[1], position[2]),
    boundingBox: 'block',
    light: 15,
    ...extra,
  };
}

function makeBot(options = {}) {
  const state = {
    items: (options.items || []).slice(),
    targets: (options.targets || []).slice(),
    position: options.position || vec3(0, 64, 0),
    health: options.health ?? 20,
    food: options.food ?? 20,
    timeOfDay: options.timeOfDay ?? 6000,
    held: options.held || null,
  };
  const calls = {
    equip: [],
    dig: [],
    goals: [],
    chat: [],
  };
  const bot = {
    username: 'ChuXiaoxue',
    health: state.health,
    food: state.food,
    foodSaturation: 5,
    isSleeping: false,
    time: { timeOfDay: state.timeOfDay },
    game: { dimension: 'minecraft:overworld' },
    entity: {
      position: state.position,
      velocity: vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      effects: {},
    },
    entities: options.entities || {},
    players: options.players || {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => state.items.slice(),
      emptySlotCount: () => Math.max(0, 36 - state.items.length),
    },
    pathfinder: {
      setGoal(goal) {
        calls.goals.push(goal);
      },
      isMoving() {
        return false;
      },
    },
    findBlock({ matching }) {
      return state.targets.find((candidate) => matching(candidate)) || null;
    },
    blockAt(position) {
      if (options.solidAbove && position.y > state.position.y && position.y <= state.position.y + 8) {
        return block('stone', [position.x, position.y, position.z]);
      }
      return { name: 'air', boundingBox: 'empty', light: 12 };
    },
    equip: async (item, slot) => {
      calls.equip.push({ item, slot });
      state.held = item;
    },
    dig: async (target) => {
      calls.dig.push(target);
    },
    chat: (text) => calls.chat.push(text),
  };
  Object.defineProperty(bot, 'heldItem', { get: () => state.held });
  return { bot, state, calls };
}

function makeConfig(overrides = {}) {
  return {
    tasks: {
      idle: { durationMs: 5000 },
      goto: { tolerance: 1, timeoutSec: 60, maxAttempts: 3, moveTimeoutMs: 1000, arriveRange: 1 },
      collectBlock: {
        selector: '#minecraft:logs',
        count: 2,
        radius: 32,
        maxMinutes: 5,
        maxNoTargetTicks: 20,
        blacklistMs: 60000,
        maxAttemptsPerBlock: 2,
        moveTimeoutMs: 1000,
        arriveRange: 1,
        reach: 4.5,
      },
    },
    ...overrides,
  };
}

function makeContext(bot, overrides = {}) {
  return {
    bot,
    now: 1000,
    shadow: true,
    config: makeConfig(),
    record() {},
    ...overrides,
  };
}

test('感知快照是纯数据且不可变', () => {
  const zombie = { id: 2, name: 'zombie', position: vec3(3, 64, 0) };
  const cow = { id: 3, name: 'cow', position: vec3(5, 64, 0) };
  const { bot } = makeBot({
    health: 17,
    items: [{ name: 'oak_log', count: 3 }],
    entities: { 2: zombie, 3: cow },
    solidAbove: true,
  });

  const snapshot = perceive(bot, { ready: true, now: 1234, config: { undergroundDepth: 2 } });

  assert.equal(snapshot.t, 1234);
  assert.equal(snapshot.self.hp, 17);
  assert.equal(snapshot.inventory.counts.oak_log, 3);
  assert.equal(snapshot.threats[0].type, 'zombie');
  assert.equal(snapshot.world.underground, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.self), true);
  assert.throws(() => {
    snapshot.self.hp = 1;
  }, TypeError);
});

test('任务栈按世界时间完成 idle 并自动出栈', () => {
  const { bot } = makeBot();
  const agenda = createAgenda({ maxDepth: 4, defaultLeaseMs: 10000, now: () => 1000 });
  const task = new IdleTask({ durationMs: 1000 }, { source: 'test' });
  const ctx = makeContext(bot);

  agenda.push(task, { now: 1000, leaseMs: 5000 });
  agenda.tick(ctx);
  assert.equal(task.state, TASK_STATE.RUNNING);
  assert.equal(agenda.size, 1);

  agenda.tick({ ...ctx, now: 1999 });
  assert.equal(agenda.size, 1);

  agenda.tick({ ...ctx, now: 2000 });
  assert.equal(task.state, TASK_STATE.DONE);
  assert.equal(agenda.size, 0);
});

test('goto 只按坐标判定成功，shadow 下不寻路', () => {
  const { bot, state, calls } = makeBot();
  const ctx = makeContext(bot);
  const task = new GotoTask({ x: 10, z: 0, tolerance: 1 }, { source: 'test' });

  task.tick(ctx);
  assert.equal(task.state, TASK_STATE.RUNNING);
  assert.equal(calls.goals.length, 0);

  state.position = vec3(10, 64, 0);
  bot.entity.position = state.position;
  task.tick({ ...ctx, now: 1100 });

  assert.equal(task.state, TASK_STATE.DONE);
  assert.equal(calls.goals.length, 0);
});

test('collectBlock 用背包增量判定成功，shadow 下不换工具也不挖', async () => {
  const logBlock = block('oak_log', [4, 64, 0], { material: 'mineable/axe' });
  const { bot, state, calls } = makeBot({
    targets: [logBlock],
    items: [{ name: 'iron_axe', count: 1 }],
  });
  const config = makeConfig();
  const ctx = makeContext(bot, { config });
  const task = new CollectBlockTask({ selector: '#minecraft:logs', count: 2 }, { source: 'test' });
  const feasible = CollectBlockTask.feasible({ bot, config, args: { selector: '#minecraft:logs' } });

  assert.ok(feasible);
  task.tick(ctx);
  assert.equal(task.state, TASK_STATE.RUNNING);
  assert.equal(calls.equip.length, 0);
  assert.equal(calls.dig.length, 0);
  assert.equal(calls.goals.length, 0);

  state.items.push({ name: 'oak_log', count: 2 });
  task.tick({ ...ctx, now: 1200 });

  assert.equal(task.state, TASK_STATE.DONE);
  assert.equal(calls.dig.length, 0);
});

test('brain shadow 只记录选择，不触发装备/寻路/挖掘', () => {
  const logBlock = block('oak_log', [4, 64, 0]);
  const { bot, calls } = makeBot({ targets: [logBlock] });
  const records = [];
  const now = () => 1000;
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: true,
        tickMs: 100,
        arbiterMs: 500,
        tasks: makeConfig().tasks,
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    legacy: { getMode: () => 'idle', intent: { current: null } },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now,
  });

  brain.start();
  brain.tick();
  const snapshot = brain.snapshot();
  brain.stop();

  assert.equal(snapshot.shadowMode, true);
  assert.equal(snapshot.doing.kind, 'collectBlock');
  assert.ok(records.some((entry) => entry.event === 'shadow_decision'));
  assert.ok(records.some((entry) => entry.event === 'task_shadow_plan'));
  assert.equal(calls.equip.length, 0);
  assert.equal(calls.dig.length, 0);
  assert.equal(calls.goals.length, 0);
});

test('白天附近没资源时用短途 goto 兜底，而不是一直 idle', () => {
  const { bot } = makeBot({ targets: [] });
  const records = [];
  const brain = createBrain({
    config: { brain: { shadowMode: true, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    legacy: { getMode: () => 'wander', intent: { current: null } },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => 1000,
  });

  brain.start();
  brain.tick();
  const snapshot = brain.snapshot();
  brain.stop();

  assert.equal(snapshot.doing.kind, 'goto');
  const decision = records.find((entry) => entry.event === 'shadow_decision');
  assert.equal(decision.stage1Equivalent, true);
});

test('反射只冻结任务，解除后由 brain 恢复', () => {
  const { bot } = makeBot({ health: 20 });
  let now = 1000;
  const brain = createBrain({
    config: { brain: { shadowMode: true, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record() {},
    now: () => now,
  });
  const task = new IdleTask({ durationMs: 30000 }, { source: 'test' });
  brain.agenda.push(task, { now, leaseMs: 60000 });
  brain.start();
  brain.tick();
  assert.equal(task.state, TASK_STATE.RUNNING);

  let ran = 0;
  brain.interrupts.register({
    kind: 'test_interrupt',
    priority: 90,
    condition: (perception) => perception.self.hp < 10,
    run: () => {
      ran += 1;
    },
  });
  bot.health = 5;
  now = 1100;
  brain.tick();
  assert.equal(task.state, TASK_STATE.FROZEN);
  assert.equal(ran, 1);
  assert.equal(task.failure, null);

  bot.health = 20;
  now = 1200;
  brain.tick();
  assert.equal(task.state, TASK_STATE.RUNNING);
  assert.equal(task.failure, null);
  brain.stop();
});

test('任务失败原因使用枚举而不是错误字符串', () => {
  class FailingTask extends Task {}
  FailingTask.kind = 'failing';

  const { bot } = makeBot();
  const task = new FailingTask({}, { source: 'test' });
  task.tick(makeContext(bot));
  task.fail(FAILURE_REASONS.NO_TARGET, { message: 'any text' });

  assert.equal(task.state, TASK_STATE.FAILED);
  assert.equal(task.failure.reason, FAILURE_REASONS.NO_TARGET);
});
