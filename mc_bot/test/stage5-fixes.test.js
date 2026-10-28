'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');

const { createBrain } = require('../src/body/brain');
const { perceive } = require('../src/body/perception');
const { GotoTask } = require('../src/tasks/goto');
const { GuardTask } = require('../src/tasks/guard');
const { DRIVE_TASKS } = require('../src/body/arbiter');

function makeBot(options = {}) {
  const state = {
    items: options.items || [],
    position: options.position || vec3(0, 64, 0),
    targets: options.targets || [],
    held: options.held || null,
  };
  const bot = {
    username: 'ChuXiaoxue',
    health: options.health ?? 20,
    food: options.food ?? 10,
    time: { timeOfDay: 6000 },
    game: { dimension: 'minecraft:overworld' },
    registry: options.registry || minecraftData,
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
      setGoal(goal) {
        if (typeof options.onGoal === 'function') options.onGoal(goal, bot);
      },
      setMovements() {},
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
  Object.defineProperty(bot, 'heldItem', {
    get: () => state.held,
    set: (value) => { state.held = value; },
  });
  return bot;
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
  const records = [];
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
  return { brain, ctx, records };
}

function setupArbiterThreat(threat, options = {}) {
  const zombie = { id: 2, name: 'zombie', position: vec3(5, 64, 0), health: 20 };
  const bot = makeBot({
    items: options.items || [{ name: 'iron_sword', count: 1 }],
    entities: options.entities || { 2: zombie },
    health: options.health,
    food: options.food,
  });
  const brain = createBrain({
    config: { brain: { shadowMode: true, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [] },
    log: { warn() {}, log() {} },
    record() {},
  });
  const perception = makePerception(bot);
  perception.threats = threat ? [threat] : [];
  brain.perception = perception;
  return {
    bot,
    brain,
    ctx: {
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
    },
  };
}

function setupNightFallback() {
  const bot = makeBot();
  bot.blockAt = (position) => position.y === 63
    ? { name: 'dirt', boundingBox: 'block', light: 4 }
    : { name: 'air', boundingBox: 'empty', light: 15 };
  const brain = createBrain({
    config: { brain: { shadowMode: true, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => ['night'] },
    log: { warn() {}, log() {} },
    record() {},
  });
  const perception = makePerception(bot);
  perception.world = { isDay: false, ticksToDusk: 0, underground: false, light: 4 };
  brain.perception = perception;
  return {
    bot,
    brain,
    ctx: {
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
    },
  };
}

test('栈顶非空时，饥饿需求能否插入', () => {
  const { brain, ctx, goto, records } = setupPreemption();
  brain._arbitrate(ctx);

  assert.equal(brain.agenda.size, 2);
  assert.equal(brain.agenda.top().kind, 'eat');
  assert.equal(goto.state, 'paused');
  const preempts = records.filter((entry) => entry.event === 'preempt');
  assert.equal(preempts.length, 1);
  assert.equal(preempts[0].from, 'goto');
  assert.equal(preempts[0].to, 'eat');
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

test('战斗需求能抢占低优先级本地任务', () => {
  const { bot, brain, ctx } = setupArbiterThreat({
    id: 2,
    type: 'zombie',
    dist: 5,
    threat: 2,
    canWin: true,
  });
  const goto = new GotoTask({ x: 10, z: 0, tolerance: 2 }, { source: 'local', priority: 30 });
  brain.agenda.push(goto, { now: ctx.now, leaseMs: null });
  goto.tick(ctx);
  assert.equal(bot.entity.position.y, 64);

  brain._arbitrate(ctx);
  assert.equal(brain.agenda.top().kind, 'fight');
  assert.equal(goto.state, 'paused');
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

test('guard 跑满 120 秒后允许 collectBlock 抢占并记录 guard_yielded', () => {
  const { brain, ctx, records } = setupCollectLease();
  const guard = new GuardTask({ durationMs: 600000 }, { source: 'mind', priority: 50 });
  guard.startedAt = ctx.now - 120000;
  brain.agenda.push(guard, { now: ctx.now - 120000, leaseMs: null });

  const task = brain._arbitrate(ctx);
  assert.equal(task.kind, 'collectBlock');
  assert.equal(brain.agenda.top().kind, 'collectBlock');
  const yielded = records.find((entry) => entry.event === 'guard_yielded');
  assert.ok(yielded);
  assert.equal(yielded.fromTop, 'guard');
  assert.equal(yielded.to, 'collectBlock');
  assert.equal(yielded.guardElapsedSec, 120);
});

test('guard 只跑 60 秒时 collectBlock 仍不能抢占', () => {
  const { brain, ctx, records } = setupCollectLease();
  const guard = new GuardTask({ durationMs: 600000 }, { source: 'mind', priority: 50 });
  guard.startedAt = ctx.now - 60000;
  brain.agenda.push(guard, { now: ctx.now - 60000, leaseMs: null });

  assert.equal(brain._arbitrate(ctx), null);
  assert.equal(brain.agenda.top(), guard);
  assert.equal(records.some((entry) => entry.event === 'guard_yielded'), false);
});

test('8 格内有僵尸时，仲裁器产出 fight 而不是 idle', () => {
  const { brain, ctx } = setupArbiterThreat({
    id: 2,
    type: 'zombie',
    dist: 5,
    threat: 2,
    canWin: true,
  });
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'fight');
  assert.deepEqual(choice.args, { targetId: 2, type: 'zombie' });
});

test('打不过的威胁产出 flee', () => {
  const { brain, ctx } = setupArbiterThreat({
    id: 9,
    type: 'warden',
    dist: 5,
    threat: 999,
    canWin: false,
  });
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'flee');
});

test('手持面包但背包里有铁剑时，单只僵尸仍判为可打', () => {
  const zombie = { id: 2, name: 'zombie', position: vec3(5, 64, 0), health: 20 };
  const bot = makeBot({
    held: { name: 'bread', count: 1 },
    items: [
      { name: 'bread', count: 1 },
      { name: 'iron_sword', count: 1 },
    ],
    entities: { 2: zombie },
  });
  const snapshot = perceive(bot, {
    ready: true,
    now: 1000,
    config: { threatRadius: 16 },
  });

  assert.equal(snapshot.threats[0].canWin, true);
  assert.ok(snapshot.myPower > 6.8);
});

test('夜间无床时只退回 idle，不再挖洞自保', () => {
  const { brain, ctx } = setupNightFallback();
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'idle');
  assert.match(choice.reason, /^night_no_option/);
});

test('digIn 与 shelter 已从任务注册表移除', () => {
  const { brain } = setupNightFallback();
  const kinds = brain.tasks.kinds();
  assert.equal(brain.tasks.get('digIn'), null);
  assert.equal(brain.tasks.get('shelter'), null);
  assert.equal(kinds.includes('digIn'), false);
  assert.equal(kinds.includes('shelter'), false);
  assert.ok(brain.tasks.get('digDown'));
});

test('夜晚驱动与仲裁只保留 sleep', () => {
  assert.deepEqual(DRIVE_TASKS.night, [{ kind: 'sleep', priority: 60 }]);
  const { brain, ctx } = setupNightFallback();
  assert.equal(brain.arbiter._chooseNight(ctx), null);
});

test('反射打断 30 秒后，任务 elapsedSec 是否跳过了这 30 秒', () => {
  const { brain, ctx } = setupPreemption();
  const task = new GotoTask({ x: 10, z: 0, tolerance: 2 }, { source: 'local', priority: 30 });
  task.tick({ ...ctx, now: 1000 });
  const before = task.elapsedSec({ ...ctx, now: 11000 });
  assert.ok(Math.abs(before - 10) < 1);

  task.freeze({ ...ctx, now: 11000 });
  task.thaw({ ...ctx, now: 41000 });
  const after = task.elapsedSec({ ...ctx, now: 41000 });
  assert.ok(Math.abs(after - 10) < 1);
  assert.ok(brain);
});

test('夜间无床的 idle 仍使用正常仲裁优先级', () => {
  const { brain, ctx } = setupNightFallback();
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'idle');
  assert.equal(choice.priority, brain.config.local.idlePriority);
});

test('夜间回退文案不再提 shelter 或 digIn', () => {
  const { brain, ctx } = setupNightFallback();
  const choice = brain.arbiter.step(ctx);
  assert.doesNotMatch(choice.reason, /shelter|digIn/);
});

test('重复的同类仲裁不会刷日志', () => {
  const { brain, ctx, records } = setupCollectLease();
  const task = brain._arbitrate(ctx);
  assert.equal(task.kind, 'collectBlock');
  for (let index = 0; index < 100; index += 1) brain._arbitrate(ctx);
  const rejected = records.filter((entry) => entry.event === 'preempt_rejected');
  assert.ok(rejected.length <= 1);
});

test('低血且无威胁但有食物时派发 heal', () => {
  const { brain, ctx } = setupArbiterThreat(null, {
    health: 5,
    food: 4,
    items: [{ name: 'bread', count: 1 }],
    entities: {},
  });
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'heal');
  assert.equal(choice.reason, 'low_hp_recover');
  assert.equal(choice.priority, 58);
});

test('低血且附近有僵尸但无食物时派发 flee', () => {
  const { brain, ctx } = setupArbiterThreat({
    id: 2,
    type: 'zombie',
    dist: 5,
    threat: 2,
    canWin: false,
  }, {
    health: 5,
    food: 4,
    items: [],
    entities: { 2: { id: 2, name: 'zombie', position: vec3(5, 64, 0), health: 20 } },
  });
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'flee');
  assert.equal(choice.reason, 'low_hp_flee');
  assert.equal(choice.priority, 56);
});

test('低血且无怪无食时只短暂 idle 并快速重评估', () => {
  const { brain, ctx } = setupArbiterThreat(null, {
    health: 5,
    food: 4,
    items: [],
    entities: {},
  });
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'idle');
  assert.equal(choice.reason, 'low_hp_no_recovery');
  assert.ok(choice.args.durationMs <= 3000);
  assert.match(choice.note, /food=4/);
});

test('goto 的目标 y 与实际地形差 3 格时能否判定到达', async () => {
  const goals = [];
  const bot = makeBot({
    onGoal(goal, currentBot) {
      goals.push(goal);
      if (goal) currentBot.entity.position = vec3(goal.x, 67, goal.z);
    },
  });
  const brain = createBrain({
    config: { brain: { shadowMode: false, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record() {},
  });
  const task = new GotoTask({ x: 5, y: null, z: 0, tolerance: 1 }, { source: 'local', priority: 30 });
  const ctx = {
    bot,
    now: 1000,
    shadow: false,
    config: brain.config,
    agenda: brain.agenda,
    tasks: brain.tasks,
    drives: brain.drives,
    watchdog: brain.watchdog,
    perception: makePerception(bot),
    record() {},
  };

  assert.equal(task.isDone(ctx), false);
  task.tick(ctx);
  const pathGoal = goals.find(Boolean);
  assert.ok(pathGoal);
  assert.equal(pathGoal.constructor.name, 'GoalXZ');
  assert.equal(bot.entity.position.y, 67);
  assert.equal(task.isDone(ctx), true);

  await new Promise((resolve) => setImmediate(resolve));
  task.tick({ ...ctx, now: 1100 });
  assert.equal(task.state, 'done');
});
