'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');

const { Autonomy } = require('../src/autonomy');
const { IntentRunner, FALLBACK_ROTATION } = require('../src/intent');
const inventory = require('../src/skills/inventory');

function makeBot(options = {}) {
  const controls = {};
  const events = {};
  let held = options.held || null;
  const bot = {
    health: options.health ?? 20,
    food: options.food ?? 20,
    time: { timeOfDay: options.timeOfDay ?? 6000 },
    isSleeping: false,
    entity: {
      position: options.position || vec3(0, 64, 0),
      yaw: 0,
      isInWater: false,
      velocity: vec3(0, 0, 0),
    },
    entities: options.entities || {},
    players: {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => options.items || [],
      emptySlotCount: () => 12,
    },
    pathfinder: {
      setGoal() {},
      isMoving() { return false; },
    },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    setControlState(name, value) { controls[name] = value; },
    clearControlStates() {
      for (const key of Object.keys(controls)) controls[key] = false;
    },
    on(name, handler) { events[name] = handler; },
    sleep: async (bed) => {
      bot.sleepCalls = (bot.sleepCalls || 0) + 1;
      bot.sleepBed = bed;
      bot.isSleeping = true;
    },
    findBlock: () => options.bed || null,
    waitForTicks: async () => {},
  };
  Object.defineProperty(bot, 'heldItem', { get: () => held });
  bot.setHeld = (item) => { held = item; };
  bot.controls = controls;
  bot.events = events;
  return bot;
}

function makeAutonomy(bot) {
  const notices = [];
  const autonomy = new Autonomy({
    config: { features: { movement: true } },
    connection: { getBot: () => bot, isReady: () => true },
    eventHub: { reportSystem: (text) => notices.push(text) },
    log: { warn() {}, log() {} },
  });
  autonomy.notices = notices;
  return autonomy;
}

test('低血触发撤离', async () => {
  const zombie = { name: 'zombie', position: vec3(3, 64, 0) };
  const bot = makeBot({ health: 5, entities: { 1: zombie } });
  const autonomy = makeAutonomy(bot);

  await autonomy._tick();

  assert.equal(autonomy.mode, 'escape');
  assert.equal(bot.controls.forward, true);
  assert.equal(bot.controls.sprint, true);
  assert.ok(autonomy.notices.some((text) => text.includes('脱离战斗')));
});

test('有床的夜晚能成功躺下', async () => {
  const bed = { name: 'red_bed', position: vec3(1, 64, 0) };
  const bot = makeBot({ timeOfDay: 18000, bed });
  const autonomy = makeAutonomy(bot);
  autonomy.mode = 'sleep';

  await autonomy._sleepTick(bot, Date.now());

  assert.equal(bot.sleepCalls, 1);
  assert.equal(bot.isSleeping, true);
  assert.equal(autonomy.sleeping, true);
  assert.ok(autonomy.notices.some((text) => text.includes('睡下了')));
});

test('低血撤离打断后能恢复普通模式分发', async () => {
  const zombie = { name: 'zombie', position: vec3(3, 64, 0) };
  const bot = makeBot({ health: 5, entities: { 1: zombie } });
  const autonomy = makeAutonomy(bot);

  await autonomy._tick();
  assert.equal(autonomy.mode, 'escape');

  bot.health = 20;
  autonomy.modeArgs.until = Date.now() - 1;
  await autonomy._tick();
  assert.equal(autonomy.mode, 'idle');

  let dispatched = false;
  autonomy.mode = 'wander';
  autonomy.modeArgs = {};
  autonomy._wanderTick = () => { dispatched = true; };
  await autonomy._tick();
  assert.equal(dispatched, true);
});

test('isCloudReady=false 时看门狗仍执行兜底轮转', async () => {
  const calls = [];
  const logs = [];
  const autonomy = {
    mode: 'idle',
    mineDoneReason: '',
    minedCount: 0,
    _isReady: () => true,
    setMode(mode, args) {
      calls.push({ mode, args });
      return { ok: true };
    },
  };
  const runner = new IntentRunner({
    autonomy,
    config: { intent: { enabled: true, askModel: true, decideCooldownMs: 1 } },
    isCloudReady: () => false,
    decide: async () => {
      throw new Error('云端不可达时不应调用模型');
    },
    log: { warn: (text) => logs.push(text), log: (text) => logs.push(text) },
  });
  runner.running = true;
  runner.lastDecideAt = Date.now() - 181000;

  await runner._tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, FALLBACK_ROTATION[0].mode);
  assert.deepEqual(calls[0].args, FALLBACK_ROTATION[0].args);
  assert.ok(logs.some((text) => text.includes('看门狗')));
  assert.ok(logs.some((text) => text.includes('兜底计划')));
});

test('equipBestTool 会按方块选择正确工具', async () => {
  const items = [
    { name: 'wooden_pickaxe', type: 1, count: 1 },
    { name: 'stone_pickaxe', type: 2, count: 1 },
    { name: 'iron_pickaxe', type: 3, count: 1 },
    { name: 'iron_axe', type: 4, count: 1 },
  ];
  const bot = makeBot({ items });
  bot.equip = async (item, slot) => {
    assert.equal(slot, 'hand');
    bot.setHeld(item);
  };

  const stone = { name: 'stone', material: 'mineable/pickaxe', harvestTools: { 1: true, 2: true, 3: true } };
  const ok = await inventory.equipBestTool(bot, stone);
  assert.equal(ok, true);
  assert.equal(bot.heldItem.name, 'iron_pickaxe');

  const log = { name: 'oak_log', material: 'mineable/axe' };
  assert.equal(await inventory.equipBestTool(bot, log), true);
  assert.equal(bot.heldItem.name, 'iron_axe');
});
