'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');

const { createBrain } = require('../src/body/brain');
const { createMind, MIND_STATE } = require('../src/body/mind');
const { createActions } = require('../src/actions');
const skills = require('../src/skills');

class FakeLink {
  constructor(connected = true) {
    this.connected = connected;
    this.events = [];
  }

  isConnected() {
    return this.connected;
  }

  sendEvent(event) {
    if (!this.connected) return false;
    this.events.push(event);
    return true;
  }
}

function makeBot(options = {}) {
  const items = (options.items || []).map((item) => ({ ...item }));
  return {
    username: 'ChuXiaoxue',
    health: 20,
    food: 20,
    foodSaturation: 5,
    isSleeping: false,
    time: { timeOfDay: 6000 },
    game: { dimension: 'minecraft:overworld' },
    registry: minecraftData,
    entity: {
      id: 1,
      position: options.position || vec3(0, 64, 0),
      velocity: vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      effects: {},
    },
    entities: {},
    players: {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => items.slice(),
      emptySlotCount: () => options.freeSlots == null ? 30 : options.freeSlots,
    },
    pathfinder: {
      setGoal() {},
      setMovements() {},
      isMoving() { return false; },
    },
    blockAt() { return { name: 'air', boundingBox: 'empty', light: 15 }; },
    findBlock() { return null; },
    async equip() {},
    setControlState() {},
    clearControlStates() {},
    on() {},
  };
}

function makePerception(bot, overrides = {}) {
  return {
    t: 1000,
    ready: true,
    self: {
      hp: bot.health,
      food: bot.food,
      armor: 0,
      pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      isSleeping: false,
      inWater: false,
      inLava: false,
      dim: 'minecraft:overworld',
    },
    world: {
      isDay: true,
      timeOfDay: 6000,
      ticksToDusk: 6000,
      ticksToDawn: null,
      underground: false,
      light: 15,
      ...(overrides.world || {}),
    },
    threats: overrides.threats || [],
    nearby: { players: [], animals: [], items: [] },
    inventory: { counts: {}, freeSlots: 30, armor: 0, ...(overrides.inventory || {}) },
  };
}

function setup(options = {}) {
  let clock = options.now == null ? 1000 : options.now;
  const bot = options.bot || makeBot(options.botOptions);
  const perception = makePerception(bot, options.perception);
  const link = options.link || new FakeLink(options.connected !== false);
  const records = [];
  const mind = createMind({
    link,
    config: {
      enabled: true,
      timeoutMs: 20000,
      cooldownMs: 30000,
      maxAsksPerHour: options.maxAsksPerHour || 12,
      socialIntervalMs: 600000,
      ...(options.mindConfig || {}),
    },
    now: () => clock,
    record: (event, payload) => records.push({ event, ...payload }),
  });
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: options.shadowMode === true,
        tickMs: 100,
        arbiterMs: 500,
        local: { localLeaseMs: 120000 },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [], update() {}, snapshot() { return {}; } },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => clock,
    mind,
  });
  brain.perception = perception;
  mind.attachBrain(brain);
  const ctx = brain._context(clock, bot);
  return {
    bot,
    perception,
    link,
    records,
    mind,
    brain,
    ctx,
    get clock() { return clock; },
    advance(ms) {
      clock += ms;
      return brain._context(clock, bot);
    },
  };
}

test('mind 在栈空时发出 intent', () => {
  const env = setup();
  env.mind.observeChoice({ kind: 'idle', reason: 'no_local_work' }, env.ctx);
  const asked = env.mind.maybeAsk(env.ctx);
  assert.equal(asked, true);
  assert.equal(env.mind.state, MIND_STATE.ASKING);
  assert.equal(env.link.events.length, 1);
  assert.equal(env.link.events[0].kind, 'intent');
  assert.ok(Array.isArray(env.link.events[0].data.can));
});

test('mind 20 秒无回复时降级到本地默认', () => {
  const env = setup();
  assert.equal(env.mind.request(env.ctx, 'test'), true);
  const later = env.advance(20001);
  assert.equal(env.mind.tick(later), MIND_STATE.COOLDOWN);
  assert.equal(env.mind.lastError, 'timeout');
  assert.equal(env.records.some((entry) => entry.event === 'mind_timeout'), true);
});

test('mind 在 12 次/小时后停止发问', () => {
  const env = setup({ maxAsksPerHour: 12 });
  let ctx = env.ctx;
  for (let index = 0; index < 12; index += 1) {
    assert.equal(env.mind.request(ctx, 'rate-test'), true, `ask ${index + 1}`);
    ctx = env.advance(20001);
    env.mind.tick(ctx);
    ctx = env.advance(30001);
    env.mind.tick(ctx);
  }
  assert.equal(env.mind.state, MIND_STATE.IDLE);
  assert.equal(env.mind.request(ctx, 'rate-test'), false);
  assert.equal(env.mind.askTimes.length, 12);
});

test('validate 拒绝不存在的任务名并返回 alternatives', () => {
  const env = setup();
  const result = env.mind.validate('explore', {}, env.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_do');
  assert.ok(result.alternatives.includes('idle'));
});

test('validate 拒绝 feasible 为 false 的任务', () => {
  const env = setup();
  const result = env.mind.validate('sleep', {}, env.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_feasible');
});

test('mc_do 下发的任务 source 是 mind 不是 user', async () => {
  const env = setup();
  const actions = createActions({
    config: { limits: { maxSayChars: 200 }, features: { movement: true } },
    connection: { getBot: () => env.bot, isReady: () => true },
    eventHub: { getRecentChat: () => [] },
    autonomy: { getMode: () => 'idle' },
    log: { warn() {}, log() {} },
  });
  actions.attachMind(env.mind);

  const result = await actions.invoke('mc_do', { do: 'idle', args: {} }, { actor: 'cloud' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const top = env.brain.agenda.top();
  assert.ok(top);
  assert.equal(top.kind, 'idle');
  assert.equal(top.source, 'mind');
});

test('buildSituation 的 can 只来自真实 available 且保持紧凑', () => {
  const env = setup();
  const situation = env.mind.buildSituation(env.ctx);
  const kinds = new Set(env.brain.tasks.kinds());
  assert.ok(situation.can.length >= 1 && situation.can.length <= 6);
  assert.ok(situation.can.every((entry) => kinds.has(entry.do)));
  assert.ok(JSON.stringify(situation).length <= 1400);
});

test('同一任务连续失败两次会发送 task_failed 事件', () => {
  const env = setup();
  env.mind.observeAgendaEvent('agenda_settle', {
    task: { kind: 'collectBlock' },
    outcome: 'failed',
    failure: { reason: 'no_target' },
  });
  env.mind.observeAgendaEvent('agenda_settle', {
    task: { kind: 'collectBlock' },
    outcome: 'failed',
    failure: { reason: 'no_target' },
  });
  const event = env.link.events.find((entry) => entry.kind === 'task_failed');
  assert.ok(event);
  assert.equal(event.data.kind, 'collectBlock');
  assert.equal(event.data.reason, 'no_target');
});

test('link 断开 5 分钟时 brain 仍持续跑本地任务', async () => {
  const env = setup({ connected: false, shadowMode: false });
  env.brain.running = true;
  const originalMove = skills.move.moveTo;
  skills.move.moveTo = async (bot, target) => {
    bot.entity.position = vec3(target.x, target.y == null ? bot.entity.position.y : target.y, target.z);
    return { ok: true };
  };
  let emptySince = null;
  let maxEmptyMs = 0;
  try {
    for (let tick = 0; tick < 3000; tick += 1) {
      env.advance(100);
      env.brain.tick();
      await new Promise((resolve) => setImmediate(resolve));
      if (!env.brain.agenda.top()) {
        if (emptySince == null) emptySince = env.clock;
        maxEmptyMs = Math.max(maxEmptyMs, env.clock - emptySince);
      } else {
        emptySince = null;
      }
    }
  } finally {
    env.brain.running = false;
    skills.move.moveTo = originalMove;
  }
  assert.equal(env.link.events.length, 0);
  assert.ok(maxEmptyMs <= 60000, `agenda empty for ${maxEmptyMs}ms`);
});
