'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');

const skills = require('../src/skills');
const { createBrain } = require('../src/body/brain');
const { ProjectManager } = require('../src/body/projects');
const { DiaryWriter } = require('../src/body/diary');
const { Humanizer } = require('../src/body/human');
const { TemplateVoice } = require('../src/body/voice');
const { CraftTask } = require('../src/tasks/craft');
const { BuildTask, buildTargets } = require('../src/tasks/build');

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function makeBot(options = {}) {
  const items = (options.items || []).map((item) => ({ ...item }));
  const blocks = new Map();
  let held = null;
  const bot = {
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
      position: vec3(0, 64, 0),
      yaw: 0,
      pitch: 0,
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
      emptySlotCount: () => 20,
    },
    pathfinder: {
      setGoal() {},
      setMovements() {},
      isMoving() { return false; },
    },
    blockAt(position) {
      return blocks.get(key(position)) || { name: 'air', position: vec3(position.x, position.y, position.z), boundingBox: 'empty', light: 15 };
    },
    findBlock({ matching }) {
      for (const block of blocks.values()) if (matching(block)) return block;
      return null;
    },
    async equip(item) { held = item; },
    async craft() {
      if (typeof options.craft === 'function') await options.craft(bot, items);
    },
    recipesFor() {
      return options.recipes || [];
    },
    async placeBlock() {},
    chat(text) {
      if (!bot.chats) bot.chats = [];
      bot.chats.push(text);
    },
    look(yaw, pitch) {
      if (!bot.looks) bot.looks = [];
      bot.looks.push({ yaw, pitch });
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      return Promise.resolve();
    },
    swingArm() {
      bot.swings = (bot.swings || 0) + 1;
    },
    setControlState(name, value) {
      if (!bot.controls) bot.controls = [];
      bot.controls.push({ name, value });
    },
    clearControlStates() {
      bot.cleared = (bot.cleared || 0) + 1;
    },
    on() {},
  };
  Object.defineProperty(bot, 'heldItem', { get: () => held });
  bot._blocks = blocks;
  bot._items = items;
  bot.setBlock = (name, x, y, z, light = 15) => {
    blocks.set(key({ x, y, z }), {
      name,
      position: vec3(x, y, z),
      boundingBox: name === 'air' ? 'empty' : 'block',
      light,
    });
  };
  return bot;
}

function makeContext(bot, now = 1000) {
  const brain = createBrain({
    config: { brain: { shadowMode: false, tickMs: 100, arbiterMs: 500 } },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [], update() {}, snapshot() { return {}; } },
    log: { warn() {}, log() {} },
    record() {},
    now: () => now,
  });
  brain.perception = {
    ready: true,
    self: { hp: 20, food: 20, armor: 0, pos: { x: 0, y: 64, z: 0 }, isSleeping: false, dim: 'minecraft:overworld' },
    world: { isDay: true, ticksToDusk: 6000, ticksToDawn: null, underground: false, light: 15 },
    threats: [],
    nearby: { players: [], animals: [], items: [] },
    inventory: { counts: {}, freeSlots: 20, armor: 0 },
  };
  return { brain, ctx: brain._context(now, bot) };
}

async function drainTask(task, ctx, maxTicks = 200) {
  for (let index = 0; index < maxTicks; index += 1) {
    task.tick({ ...ctx, now: ctx.now + index * 100 });
    await new Promise((resolve) => setImmediate(resolve));
    if (task.isTerminal) return task;
  }
  return task;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-stage7-'));
}

test('项目步骤可跨会话保存并继续', () => {
  const dir = tempDir();
  const file = path.join(dir, 'projects.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      active: {
        id: 'cabin',
        title: '小木屋',
        steps: [
          { task: { do: 'craft', args: { item: 'oak_planks' } }, done: false },
          { task: { do: 'build', args: { blueprint: '3x3x3' } }, done: false },
        ],
      },
      backlog: [],
    }, null, 2), 'utf8');
    const first = new ProjectManager({ file });
    assert.equal(first.recordOutcome({ kind: 'craft' }, 'done'), true);
    const second = new ProjectManager({ file });
    assert.equal(second.snapshot().done, 1);
    assert.equal(second.snapshot().next.do, 'build');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('日记按 agenda 结果写入 JSONL 并记录死亡数', () => {
  const dir = tempDir();
  const file = path.join(dir, 'diary.jsonl');
  try {
    const diary = new DiaryWriter({ file });
    diary.recordDeath();
    const entry = diary.record({
      task: { kind: 'mineOre', startedAt: 1000, finishedAt: 61000, source: 'mind' },
      outcome: 'done',
    }, { now: 61000 });
    assert.equal(entry.deaths, 1);
    assert.equal(entry.durationSec, 60);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].goal, 'mineOre');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idle 时人化层会延迟转头和小动作', () => {
  const bot = makeBot();
  const human = new Humanizer({
    config: {
      lookMinMs: 0,
      lookMaxMs: 0,
      actionMinMs: 0,
      actionMaxMs: 0,
      delayMinMs: 0,
      delayMaxMs: 0,
    },
    random: () => 0.5,
  });
  const ctx = { bot, now: 1000, shadow: false, agenda: { top: () => ({ kind: 'idle' }) } };
  for (let index = 0; index < 600; index += 1) {
    human.update({ ...ctx, now: 1000 + index * 100 });
  }
  assert.ok(bot.looks && bot.looks.length > 0);
  assert.ok((bot.controls && bot.controls.some((entry) => entry.value === true)) || bot.swings > 0);
});

test('shadow 模式下人化层不产生动作', () => {
  const bot = makeBot();
  const human = new Humanizer({ random: () => 0.5 });
  const ctx = { bot, now: 1000, shadow: true, agenda: { top: () => ({ kind: 'idle' }) } };
  for (let index = 0; index < 30; index += 1) human.update({ ...ctx, now: 1000 + index * 1000 });
  assert.equal(bot.looks, undefined);
  assert.equal(bot.controls, undefined);
});

test('模板台词有 60 秒全局冷却', () => {
  const bot = makeBot();
  const reports = [];
  const voice = new TemplateVoice({
    eventHub: { report: (kind, data) => reports.push({ kind, data }) },
    random: () => 0,
  });
  const base = {
    bot,
    shadow: false,
    agenda: { top: () => ({ kind: 'idle' }) },
    lastHurtAt: 0,
  };
  voice.tick({ ...base, now: 1000, perception: { world: { isDay: false } } });
  voice.tick({ ...base, now: 2000, perception: { world: { isDay: true } } });
  voice.onAgendaEvent('agenda_settle', { task: { kind: 'mineOre' }, outcome: 'done' }, { ...base, now: 3000 });
  voice.onAgendaEvent('agenda_settle', { task: { kind: 'flee' }, outcome: 'done' }, { ...base, now: 62000 });
  assert.equal(bot.chats.length, 2);
  assert.equal(reports.length, 2);
});

test('craft 用背包增量判定完成', async () => {
  const bot = makeBot({
    items: [{ name: 'oak_log', count: 2 }],
    recipes: [{ result: { count: 4 } }],
    craft(_bot, items) {
      const planks = items.find((item) => item.name === 'oak_planks');
      if (planks) planks.count += 4;
      else items.push({ name: 'oak_planks', count: 4 });
    },
  });
  const { ctx } = makeContext(bot);
  const task = new CraftTask({ item: 'oak_planks', count: 4 }, { source: 'mind' });
  await drainTask(task, ctx);
  assert.equal(task.state, 'done');
  assert.equal(skills.inventory.count(bot, 'oak_planks'), 4);
});

test('build 按 3x3x3 边界放置并完成', async () => {
  const bot = makeBot({ items: [{ name: 'cobblestone', count: 30 }] });
  for (let x = -1; x <= 1; x += 1) {
    for (let z = -1; z <= 1; z += 1) bot.setBlock('stone', x, 63, z);
  }
  const { ctx } = makeContext(bot);
  const original = skills.place.placeItemAt;
  skills.place.placeItemAt = async (currentBot, itemName, target) => {
    currentBot.setBlock(itemName, target.x, target.y, target.z);
    const item = currentBot._items.find((entry) => entry.name === itemName);
    if (item) item.count -= 1;
    return { ok: true, block: itemName, position: target };
  };
  try {
    const task = new BuildTask({
      at: [0, 64, 0],
      material: 'cobblestone',
      blueprint: '3x3x3',
    }, { source: 'mind' });
    await drainTask(task, ctx, 400);
    assert.equal(buildTargets({ x: 0, y: 64, z: 0 }).length, 26);
    assert.equal(task.state, 'done', JSON.stringify({ failure: task.failure, progress: task.progressMetric(ctx), blocks: bot._blocks.size }));
    assert.equal(task.progressMetric(ctx), 26);
  } finally {
    skills.place.placeItemAt = original;
  }
});
