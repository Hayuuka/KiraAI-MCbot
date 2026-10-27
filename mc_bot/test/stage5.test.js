'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');

const skills = require('../src/skills');
const move = require('../src/skills/move');
const mining = require('../src/skills/mining');
const mineSkill = require('../src/skills/mine');
const placeSkill = require('../src/skills/place');
const { createBrain } = require('../src/body/brain');
const { DigDownTask } = require('../src/tasks/digDown');
const { MineOreTask } = require('../src/tasks/mineOre');

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function block(name, x, y, z, light = 15) {
  return {
    name,
    position: vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    light,
  };
}

function makeBot(options = {}) {
  const blocks = new Map();
  const items = (options.items || []).map((item) => ({ ...item }));
  let held = null;
  const bot = {
    username: 'ChuXiaoxue',
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    game: { dimension: 'minecraft:overworld' },
    registry: minecraftData,
    entity: {
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
    blockAt(position) {
      return blocks.get(key(position)) || block('air', position.x, position.y, position.z);
    },
    findBlock({ maxDistance, matching }) {
      for (const candidate of blocks.values()) {
        if (matching(candidate) && candidate.position.distanceTo(bot.entity.position) <= maxDistance) {
          return candidate;
        }
      }
      return null;
    },
    async equip(item) {
      held = item;
      return true;
    },
    async dig(target) {
      blocks.delete(key(target.position));
    },
    async placeBlock() {},
    setControlState() {},
    clearControlStates() {},
    on() {},
  };
  Object.defineProperty(bot, 'heldItem', { get: () => held });
  bot._blocks = blocks;
  bot._items = items;
  bot.setBlock = (name, x, y, z, light) => {
    if (name === 'air') blocks.delete(key({ x, y, z }));
    else blocks.set(key({ x, y, z }), block(name, x, y, z, light));
  };
  return bot;
}

function fillStoneFloor(bot, minX, maxX, minY, maxY, z = 0) {
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) bot.setBlock('stone', x, y, z);
  }
}

function makePerception(bot, overrides = {}) {
  return {
    t: 1000,
    ready: true,
    self: {
      hp: 20,
      food: 20,
      armor: 0,
      pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      isSleeping: false,
      inWater: false,
      inLava: false,
    },
    world: {
      isDay: true,
      ticksToDusk: 6000,
      underground: false,
      light: 15,
      ...overrides.world,
    },
    threats: [],
    inventory: { counts: {}, freeSlots: 30, ...overrides.inventory },
  };
}

function makeBrain(bot, perception = makePerception(bot)) {
  const records = [];
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: false,
        tickMs: 100,
        arbiterMs: 500,
        tasks: {
          digDown: { maxMinutes: 5 },
          mineOre: { maxNoTargetTicks: 1 },
        },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    drives: { urgent: () => [] },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
  });
  brain.perception = perception;
  const ctx = {
    now: 1000,
    bot,
    perception,
    shadow: false,
    config: brain.config,
    agenda: brain.agenda,
    tasks: brain.tasks,
    drives: brain.drives,
    watchdog: brain.watchdog,
    record: (event, payload) => records.push({ event, ...payload }),
  };
  return { brain, ctx, records };
}

async function drainTask(task, ctx, maxTicks = 120) {
  for (let index = 0; index < maxTicks; index += 1) {
    task.tick({ ...ctx, now: ctx.now + index * 250 });
    await new Promise((resolve) => setImmediate(resolve));
    if (task.isTerminal) return task;
  }
  return task;
}

test('默认寻路不挖方块', () => {
  const bot = makeBot();
  const movements = move.ensureMovements(bot);
  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
});

test('挖矿寻路允许挖方块且禁止搭柱', () => {
  const bot = makeBot();
  const normal = move.ensureMovements(bot);
  const miningMovements = move.ensureMovements(bot, {
    canDig: true,
    digCost: 30,
    allow1by1towers: true,
  });
  assert.notEqual(normal, miningMovements);
  assert.equal(miningMovements.canDig, true);
  assert.equal(miningMovements.digCost, 30);
  assert.equal(miningMovements.allow1by1towers, false);
  assert.equal(miningMovements.dontMineUnderFallingBlock, true);
  assert.equal(miningMovements.dontCreateFlow, true);
});

test('probeBelow 识别脚下岩浆', () => {
  const bot = makeBot();
  bot.setBlock('lava', 0, 63, 0);
  const result = mining.probeBelow(bot, { x: 0, y: 64, z: 0 }, 4);
  assert.equal(result.ok, false);
  assert.equal(result.hazard, 'lava');
});

test('probeBelow 识别连续空气（坠落风险）', () => {
  const bot = makeBot();
  const result = mining.probeBelow(bot, { x: 0, y: 64, z: 0 }, 4);
  assert.equal(result.ok, false);
  assert.equal(result.hazard, 'fall');
});

test('digBlockSafely 拒绝挖穿岩浆上方的方块', async () => {
  const bot = makeBot();
  const target = block('stone', 0, 64, 0);
  bot.setBlock('stone', 0, 64, 0);
  bot.setBlock('lava', 0, 63, 0);
  let mineCalls = 0;
  const original = mineSkill.mineBlock;
  mineSkill.mineBlock = async () => {
    mineCalls += 1;
    return { ok: true };
  };
  try {
    const result = await mining.digBlockSafely(bot, target, { probeDepth: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.hazard, 'lava');
    assert.equal(mineCalls, 0);
  } finally {
    mineSkill.mineBlock = original;
  }
});

test('digDown 每下降 5 格放一次火把', async () => {
  const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'torch', count: 16 }] });
  fillStoneFloor(bot, -1, 12, 48, 63);
  const { ctx } = makeBrain(bot);
  const torchCalls = [];
  const originalDig = mining.digBlockSafely;
  const originalMove = move.moveTo;
  const originalTorch = mining.placeTorchIfDark;
  mining.digBlockSafely = async () => ({ ok: true });
  move.moveTo = async (currentBot, target) => {
    currentBot.entity.position = vec3(target.x, target.y, target.z);
    return { ok: true };
  };
  mining.placeTorchIfDark = async () => {
    torchCalls.push(bot.entity.position.y);
    return { ok: true, placed: true, position: { x: 0, y: 0, z: 0 } };
  };
  try {
    const task = new DigDownTask({ depth: 10 }, { source: 'local', priority: 45 });
    await drainTask(task, ctx);
    assert.equal(task.state, 'done');
    assert.equal(torchCalls.length, 2);
  } finally {
    mining.digBlockSafely = originalDig;
    move.moveTo = originalMove;
    mining.placeTorchIfDark = originalTorch;
  }
});

test('digDown 遇到岩浆会换方向而不是继续挖', async () => {
  const bot = makeBot();
  fillStoneFloor(bot, -2, 2, 60, 63);
  bot.setBlock('lava', 1, 63, 0);
  const { ctx } = makeBrain(bot);
  const task = new DigDownTask({ depth: 2 }, { source: 'local', priority: 45 });
  task.tick(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  task.tick({ ...ctx, now: ctx.now + 250 });
  assert.equal(task.directionFailures, 1);
  assert.equal(task.dirIndex, 1);
  assert.equal(bot.entity.position.x, 0);
});

test('digDown 不会走进前方岩浆方块', async () => {
  const bot = makeBot();
  fillStoneFloor(bot, -2, 2, 60, 63);
  bot.setBlock('lava', 1, 64, 0);
  const { ctx } = makeBrain(bot);
  const task = new DigDownTask({ depth: 2 }, { source: 'local', priority: 45 });
  task.prepare(ctx);
  const result = await task._descend(ctx, { dx: 1, dz: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hazard_liquid');
  assert.equal(bot.entity.position.x, 0);
});

test('digDown 到达目标深度后完成', async () => {
  const bot = makeBot();
  fillStoneFloor(bot, -1, 12, 50, 63);
  const { ctx } = makeBrain(bot);
  const originalDig = mining.digBlockSafely;
  const originalMove = move.moveTo;
  const originalTorch = mining.placeTorchIfDark;
  mining.digBlockSafely = async () => ({ ok: true });
  move.moveTo = async (currentBot, target) => {
    currentBot.entity.position = vec3(target.x, target.y, target.z);
    return { ok: true };
  };
  mining.placeTorchIfDark = async () => ({ ok: true, placed: false });
  try {
    const task = new DigDownTask({ depth: 3 }, { source: 'local', priority: 45 });
    await drainTask(task, ctx);
    assert.equal(task.state, 'done');
    assert.equal(bot.entity.position.y, 61);
  } finally {
    mining.digBlockSafely = originalDig;
    move.moveTo = originalMove;
    mining.placeTorchIfDark = originalTorch;
  }
});

test('mineOre 在没有目标矿时返回 no_target 而不是卡住', async () => {
  const bot = makeBot();
  const perception = makePerception(bot);
  const { ctx } = makeBrain(bot, perception);
  const task = new MineOreTask({ ore: 'iron_ore', count: 1 }, { source: 'local', priority: 45 });
  await drainTask(task, { ...ctx, shadow: true }, 4);
  assert.equal(task.state, 'failed');
  assert.equal(task.failure && task.failure.reason, 'no_target');
});

test('mineOre 在暗处会放火把', async () => {
  const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'torch', count: 4 }] });
  bot.setBlock('iron_ore', 8, 64, 0, 4);
  const perception = makePerception(bot, { world: { light: 4 } });
  const { ctx } = makeBrain(bot, perception);
  let torchCalls = 0;
  const originalTorch = mining.placeTorchIfDark;
  const originalMove = move.moveTo;
  mining.placeTorchIfDark = async () => {
    torchCalls += 1;
    return { ok: true, placed: true, position: { x: 0, y: 64, z: 0 } };
  };
  move.moveTo = async () => ({ ok: true });
  try {
    const task = new MineOreTask({ ore: 'iron_ore', count: 1 }, { source: 'local', priority: 45 });
    await drainTask(task, ctx, 6);
    assert.ok(torchCalls >= 1, JSON.stringify({ state: task.state, failure: task.failure, pending: task.pending && task.pending.label }));
  } finally {
    mining.placeTorchIfDark = originalTorch;
    move.moveTo = originalMove;
  }
});

test('有石镐且附近有铁时会选择 mineOre', () => {
  const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }] });
  bot.setBlock('iron_ore', 6, 64, 0);
  const { brain, ctx } = makeBrain(bot);
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'mineOre');
  assert.equal(choice.args.ore, 'iron_ore');
});

test('白天空背包且有石镐时会选择 digDown', () => {
  const bot = makeBot({ items: [{ name: 'stone_pickaxe', count: 1 }], freeSlots: 34 });
  fillStoneFloor(bot, -3, 3, 60, 63);
  const perception = makePerception(bot, { inventory: { freeSlots: 34 } });
  const { brain, ctx } = makeBrain(bot, perception);
  const choice = brain.arbiter.step(ctx);
  assert.equal(choice.kind, 'digDown');
});

test('placeTorchIfDark 在亮处不消耗火把', async () => {
  const bot = makeBot({ items: [{ name: 'torch', count: 4 }] });
  bot.setBlock('stone', 0, 63, 0, 15);
  const original = placeSkill.placeTorchAt;
  let placeCalls = 0;
  placeSkill.placeTorchAt = async () => {
    placeCalls += 1;
    return { ok: true };
  };
  try {
    const result = await mining.placeTorchIfDark(bot, { position: bot.entity.position });
    assert.equal(result.ok, true);
    assert.equal(result.placed, false);
    assert.equal(placeCalls, 0);
  } finally {
    placeSkill.placeTorchAt = original;
  }
});
