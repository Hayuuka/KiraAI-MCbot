'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { FightTask } = require('../src/tasks/fight');
const { GuardTask } = require('../src/tasks/guard');
const { AssistTask } = require('../src/tasks/assist');
const combat = require('../src/skills/combat');
const move = require('../src/skills/move');
const world = require('../src/skills/world');

function makeBot(options = {}) {
  const state = {
    items: (options.items || []).slice(),
    position: options.position || vec3(0, 64, 0),
    held: options.held || null,
  };
  const calls = { attack: 0, equip: 0, goals: 0, clear: 0 };
  const bot = {
    username: 'ChuXiaoxue',
    health: options.health ?? 20,
    food: 20,
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
    players: options.players || {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => state.items.slice(),
      emptySlotCount: () => 30,
    },
    pathfinder: {
      setGoal() { calls.goals += 1; },
      isMoving() { return false; },
    },
    blockAt() { return { name: 'air', boundingBox: 'empty', light: 15 }; },
    equip: async (item) => {
      calls.equip += 1;
      state.held = item;
    },
    attack() { calls.attack += 1; },
    lookAt: async () => {},
    setControlState() {},
    clearControlStates() { calls.clear += 1; },
    on() {},
  };
  Object.defineProperty(bot, 'heldItem', {
    get: () => state.held,
    set: (value) => { state.held = value; },
  });
  bot.calls = calls;
  return bot;
}

function makeConfig() {
  return {
    combat: {
      fleePowerRatio: 1.3,
      attackRange: 2.6,
      approachRange: 2,
      retreatDistance: 2.2,
      backstepMs: 20,
      strafeSwitchMinMs: 900,
      strafeSwitchMaxMs: 1400,
      jumpEveryAttacks: 3,
      jumpHoldMs: 20,
      lookIntervalMs: 100,
      defaultCooldownMs: 400,
      swordCooldownMs: 625,
      axeCooldownMs: 1000,
      tridentCooldownMs: 900,
      creeperFuseValue: 1,
      creeperDangerRadius: 4,
      creeperRetreatDistance: 10,
      threatRadius: 32,
    },
    tasks: {
      fight: { attackRange: 2.6, approachRange: 2, maxMinutes: 2, creeperDangerRadius: 4, creeperRetreatDistance: 10 },
      guard: { radius: 12, durationMs: 5000 },
      assist: { playerRadius: 16, safeRadius: 8, safeHoldMs: 1000, durationMs: 10000 },
    },
  };
}

function makePerception(overrides = {}) {
  return {
    self: { hp: 20, food: 20, armor: 0, pos: { x: 0, y: 64, z: 0 }, ...(overrides.self || {}) },
    world: { isDay: true, ticksToDusk: 6000, underground: false, light: 15, ...(overrides.world || {}) },
    threats: overrides.threats || [],
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

test('威胁评分随距离升高，warden 始终是最高危险', () => {
  const close = combat.threatScore({ type: 'zombie', dist: 2 }, { hp: 20, armor: 0, hostileCount: 1, light: 15 });
  const far = combat.threatScore({ type: 'zombie', dist: 11 }, { hp: 20, armor: 0, hostileCount: 1, light: 15 });
  assert.ok(close > far);
  assert.ok(combat.threatScore({ type: 'warden', dist: 30 }, { hp: 20 }) >= 999);
});

test('攻击冷却按武器类型计算', () => {
  const bot = makeBot();
  bot.heldItem = { name: 'iron_sword' };
  assert.equal(combat.attackCooldownMs(bot, makeConfig().combat), 625);
  bot.heldItem = { name: 'iron_axe' };
  assert.equal(combat.attackCooldownMs(bot, makeConfig().combat), 1000);
  bot.heldItem = null;
  assert.equal(combat.attackCooldownMs(bot, makeConfig().combat), 400);
});

test('fight 在 shadow 下不换武器、不攻击，目标消失后完成', () => {
  const zombie = { id: 2, name: 'zombie', position: vec3(2, 64, 0), health: 20 };
  const bot = makeBot({ entities: { 2: zombie }, items: [{ name: 'iron_sword', count: 1 }] });
  const task = new FightTask({ targetId: 2, type: 'zombie' }, { source: 'test' });
  const ctx = makeContext(bot);

  task.tick(ctx);
  assert.equal(bot.calls.equip, 0);
  assert.equal(bot.calls.attack, 0);
  task.tick({ ...ctx, now: 1100 });
  assert.equal(bot.calls.attack, 0);

  delete bot.entities[2];
  task.tick({ ...ctx, now: 1200 });
  assert.equal(task.state, 'done');
  assert.equal(bot.calls.clear, 0);
});

test('fight 执行时按武器冷却攻击', async () => {
  const zombie = { id: 2, name: 'zombie', position: vec3(2, 64, 0), health: 20 };
  const bot = makeBot({ entities: { 2: zombie }, items: [{ name: 'iron_sword', count: 1 }] });
  const task = new FightTask({ targetId: 2, type: 'zombie' }, { source: 'test' });
  const ctx = makeContext(bot, { shadow: false });

  task.tick(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  // 第一 tick 只结算异步 prepare，下一 tick 才进入战斗循环。
  task.tick({ ...ctx, now: 1000 });
  task.tick({ ...ctx, now: 1000 });
  assert.equal(bot.calls.attack, 1);
  task.tick({ ...ctx, now: 1200 });
  assert.equal(bot.calls.attack, 1);
  task.tick({ ...ctx, now: 1700 });
  assert.equal(bot.calls.attack, 2);
  task.fail('timeout', { ctx });
});

test('苦力怕进入近距时返回撤退而不是攻击', () => {
  const creeper = { id: 3, name: 'creeper', position: vec3(3, 64, 0), metadata: { fuse: 1 } };
  const bot = makeBot({ entities: { 3: creeper } });
  const result = combat.combatTick(bot, creeper, {}, makeConfig().combat, 1000);
  assert.equal(result.action, 'retreat');
  assert.equal(combat.creeperPrimed(creeper), true);
  assert.equal(bot.calls.attack, 0);
});

test('guard 在 shadow 下只记录，时间到由任务时钟完成', () => {
  const bot = makeBot();
  const task = new GuardTask({ radius: 12, durationMs: 5000 }, { source: 'test' });
  const ctx = makeContext(bot);
  task.tick(ctx);
  assert.equal(bot.calls.equip, 0);
  task.tick({ ...ctx, now: 6000 });
  assert.equal(task.state, 'done');
});

test('guard 无敌人时会巡逻移动而不是原地静止', async () => {
  const bot = makeBot({ items: [{ name: 'iron_sword', count: 1 }] });
  const task = new GuardTask({ radius: 12, durationMs: 5000 }, { source: 'test' });
  const ctx = makeContext(bot, { shadow: false, now: 1000 });
  const originalFind = world.findSafeSpot;
  const originalMove = move.moveTo;
  const moveOptions = [];
  let moveCalls = 0;
  world.findSafeSpot = () => ({ x: 5, y: 64, z: 0 });
  move.moveTo = async (_bot, _spot, options) => {
    moveCalls += 1;
    moveOptions.push(options);
    return { ok: true };
  };
  try {
    task.tick(ctx);
    await new Promise((resolve) => setImmediate(resolve));
    task.tick({ ...ctx, now: 1100 });
    await new Promise((resolve) => setImmediate(resolve));
    task.tick({ ...ctx, now: 1200 });
  } finally {
    world.findSafeSpot = originalFind;
    move.moveTo = originalMove;
  }
  assert.equal(moveCalls, 1);
  assert.deepEqual(moveOptions[0], { range: 1, timeoutMs: 5000 });
});

test('guard 巡逻期间发现敌人立即恢复战斗', async () => {
  const bot = makeBot({ items: [{ name: 'iron_sword', count: 1 }] });
  const task = new GuardTask({ radius: 12, durationMs: 5000 }, { source: 'test' });
  const ctx = makeContext(bot, { shadow: false, now: 1000 });
  const originalFind = world.findSafeSpot;
  const originalMove = move.moveTo;
  const originalCombatTick = combat.combatTick;
  let moveCalls = 0;
  let combatCalls = 0;
  world.findSafeSpot = () => ({ x: 5, y: 64, z: 0 });
  move.moveTo = async () => {
    moveCalls += 1;
    return { ok: true };
  };
  combat.combatTick = () => {
    combatCalls += 1;
    return { ok: true, action: 'attacked' };
  };
  try {
    for (let now = 1000; now <= 1300 && moveCalls === 0; now += 100) {
      task.tick({ ...ctx, now });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(moveCalls, 1);
    bot.entities[2] = { id: 2, name: 'zombie', position: vec3(2, 64, 0), health: 20 };
    for (let now = 1400; now <= 1800 && combatCalls === 0; now += 100) {
      await new Promise((resolve) => setImmediate(resolve));
      task.tick({ ...ctx, now });
    }
  } finally {
    world.findSafeSpot = originalFind;
    move.moveTo = originalMove;
    combat.combatTick = originalCombatTick;
  }
  assert.equal(combatCalls, 1);
});

test('assist 在玩家周围威胁消失并持续安全后完成', async () => {
  const playerEntity = { username: 'Hayuuka', position: vec3(5, 64, 0), name: 'player' };
  const bot = makeBot({
    items: [{ name: 'iron_sword', count: 1 }],
    players: { Hayuuka: { username: 'Hayuuka', entity: playerEntity } },
  });
  const task = new AssistTask({ player: 'Hayuuka' }, { source: 'test' });
  const ctx = makeContext(bot, { shadow: false, perception: makePerception({ threats: [] }) });

  task.tick(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  task.tick({ ...ctx, now: 1000 });
  task.tick({ ...ctx, now: 2100 });
  task.tick({ ...ctx, now: 3200 });
  task.tick({ ...ctx, now: 3300 });
  assert.equal(task.state, 'done');
});
