'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');

const { createBrain } = require('../src/body/brain');
const { perceive } = require('../src/body/perception');
const { GotoTask } = require('../src/tasks/goto');
const { DigInTask } = require('../src/tasks/digIn');
const mineSkill = require('../src/skills/mine');

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

function setupArbiterThreat(threat) {
  const zombie = { id: 2, name: 'zombie', position: vec3(5, 64, 0), health: 20 };
  const bot = makeBot({ items: [{ name: 'iron_sword', count: 1 }], entities: { 2: zombie } });
  const brain = createBrain({
    config: { brain: { shadowMode: true, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [] },
    log: { warn() {}, log() {} },
    record() {},
  });
  const perception = makePerception(bot);
  perception.threats = [threat];
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

test('夜间无床、背包无方块、无山壁时，产出非 idle 的兜底任务', () => {
  const { brain, ctx } = setupNightFallback();
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'digIn');
  assert.notEqual(choice.kind, 'idle');
});

test('digIn 在天亮后完成', () => {
  const { bot, brain, ctx } = setupNightFallback();
  const task = new DigInTask({}, { source: 'local', priority: 58 });
  task.tick(ctx);
  assert.equal(task.state, 'running');
  task.tick({
    ...ctx,
    now: 2000,
    perception: { ...ctx.perception, world: { ...ctx.perception.world, isDay: true } },
  });
  assert.equal(task.isDone({
    ...ctx,
    perception: { ...ctx.perception, world: { ...ctx.perception.world, isDay: true } },
  }), true);
  assert.equal(task.state, 'done');
  assert.ok(brain);
  assert.ok(bot);
});

test('digIn 挖成功后不再重复挖', async () => {
  const { bot, ctx } = setupNightFallback();
  const originalMine = mineSkill.mineBlock;
  let mineCalls = 0;
  mineSkill.mineBlock = async () => {
    mineCalls += 1;
    bot.entity.position = vec3(0, 63, 0);
    return { ok: true };
  };
  const task = new DigInTask({}, { source: 'local', priority: 58 });
  const liveCtx = { ...ctx, shadow: false };
  try {
    task.tick(liveCtx);
    await new Promise((resolve) => setImmediate(resolve));
    task.tick({ ...liveCtx, now: 1100 });
    for (let index = 0; index < 5; index += 1) {
      task.tick({ ...liveCtx, now: 1200 + index * 100 });
    }
  } finally {
    mineSkill.mineBlock = originalMine;
  }
  assert.equal(mineCalls, 1);
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

test('digIn 躲好后不会被看门狗回收', () => {
  const { brain, ctx } = setupNightFallback();
  const records = [];
  const liveCtx = {
    ...ctx,
    record: (event, payload) => records.push({ event, ...payload }),
  };
  const task = new DigInTask({}, { source: 'local', priority: 58 });
  task.tick(liveCtx);
  task.dugOnce = true;
  brain.agenda.push(task, { now: liveCtx.now, leaseMs: null });

  for (let elapsed = 100; elapsed <= 60000; elapsed += 100) {
    const next = { ...liveCtx, now: 1000 + elapsed };
    brain.agenda.tick(next);
    brain.watchdog.check(next);
  }

  assert.equal(brain.agenda.size, 1);
  assert.equal(brain.agenda.top(), task);
  assert.equal(records.some((entry) => entry.event === 'stuck_recovery'), false);
});

test('digIn 挖之前仍然会被看门狗管', () => {
  const { brain, ctx } = setupNightFallback();
  const records = [];
  const liveCtx = {
    ...ctx,
    record: (event, payload) => records.push({ event, ...payload }),
  };
  const task = new DigInTask({}, { source: 'local', priority: 58 });
  task.tick(liveCtx);
  brain.agenda.push(task, { now: liveCtx.now, leaseMs: null });

  for (let elapsed = 100; elapsed <= 45000; elapsed += 100) {
    const next = { ...liveCtx, now: 1000 + elapsed };
    brain.agenda.tick(next);
    brain.watchdog.check(next);
    if (brain.agenda.size === 0) break;
  }

  assert.equal(brain.agenda.size, 0);
  assert.equal(task.failure && task.failure.reason, 'no_progress');
  assert.equal(records.some((entry) => entry.event === 'stuck_recovery'), true);
});

test('重复的同类仲裁不会刷日志', () => {
  const { brain, ctx, records } = setupCollectLease();
  const task = brain._arbitrate(ctx);
  assert.equal(task.kind, 'collectBlock');
  for (let index = 0; index < 100; index += 1) brain._arbitrate(ctx);
  const rejected = records.filter((entry) => entry.event === 'preempt_rejected');
  assert.ok(rejected.length <= 1);
});

test('低血等待回血使用明确原因并带食物信息', () => {
  const { brain, ctx } = setupCollectLease();
  ctx.perception.self.hp = 5;
  ctx.perception.self.food = 4;
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'idle');
  assert.equal(choice.reason, 'low_hp_waiting_regen');
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
