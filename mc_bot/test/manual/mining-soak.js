'use strict';

// 阶段 5 手工验收：180 秒假世界，检查阶梯下挖、火把和岩浆防护。
// 仅此脚本使用执行模式；生产默认仍由 config 控制 shadowMode。

const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');
const { createBrain } = require('../../src/body/brain');
const mineSkill = require('../../src/skills/mine');
const placeSkill = require('../../src/skills/place');
const moveSkill = require('../../src/skills/move');

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function block(name, x, y, z, light = 10) {
  return {
    name,
    position: vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    light,
  };
}

function makeFakeWorld() {
  const blocks = new Map();
  const items = [
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_shovel', count: 1 },
    { name: 'torch', count: 32 },
  ];
  const calls = { mine: 0, lavaMined: 0, moves: 0 };
  const torchDepths = [];
  let held = null;

  for (let x = -40; x <= 40; x += 1) {
    for (let y = 40; y <= 63; y += 1) {
      const name = y === 63 ? 'grass_block' : 'stone';
      blocks.set(`${x},${y},0`, block(name, x, y, 0));
    }
  }
  for (let x = -12; x <= 12; x += 1) {
    blocks.set(`${x},40,0`, block('iron_ore', x, 40, 0));
  }
  // 第一方向（+x）在下降 13 格处会遇到局部岩浆陷阱；换到 -x 后可继续。
  for (let x = 13; x <= 24; x += 1) {
    blocks.set(`${x},50,0`, block('lava', x, 50, 0));
  }

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
      emptySlotCount: () => 34,
    },
    pathfinder: {
      setGoal() {},
      setMovements() {},
      isMoving() { return false; },
    },
    blockAt(position) {
      return blocks.get(key(position)) || block('air', position.x, position.y, position.z, 4);
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

  return { bot, blocks, items, calls, torchDepths };
}

async function main() {
  const { bot, blocks, items, calls, torchDepths } = makeFakeWorld();
  let clock = 1_000_000;
  const records = [];
  const originalMine = mineSkill.mineBlock;
  const originalPlace = placeSkill.placeTorchAt;
  const originalMove = moveSkill.moveTo;

  mineSkill.mineBlock = async (_bot, target) => {
    calls.mine += 1;
    const name = String(target.name || '').split(':').pop();
    if (name.includes('lava')) calls.lavaMined += 1;
    blocks.delete(key(target.position));
    const drop = name === 'iron_ore' || name === 'deepslate_iron_ore' ? 'raw_iron' : name;
    const existing = items.find((item) => item.name === drop);
    if (existing) existing.count += 1;
    else items.push({ name: drop, count: 1 });
    return { ok: true };
  };

  placeSkill.placeTorchAt = async () => {
    const depth = 64 - Math.floor(bot.entity.position.y);
    torchDepths.push(depth);
    return { ok: true, placed: true };
  };

  moveSkill.moveTo = async (_bot, target) => {
    calls.moves += 1;
    bot.entity.position = vec3(target.x, target.y, target.z);
    return { ok: true };
  };

  const brain = createBrain({
    config: {
      brain: {
        shadowMode: false,
        tickMs: 100,
        driveMs: 1000,
        arbiterMs: 180000,
        tasks: {
          digDown: { depth: 24, maxMinutes: 5 },
          mineOre: { count: 8, maxMinutes: 8 },
        },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => clock,
  });

  const sequence = [];
  let lastTop = null;
  brain.running = true;
  const startedAt = clock;

  try {
    for (let tick = 0; tick < 1800; tick += 1) {
      clock += 100;
      brain.tick();
      await new Promise((resolve) => setImmediate(resolve));

      const top = brain.agenda.top();
      const signature = brain.agenda.snapshot().map((task) => `${task.kind}:${task.state}`).join(' > ') || 'none';
      if (signature !== lastTop) {
        lastTop = signature;
        if (top && top.kind !== 'goto' && top.kind !== 'idle') {
          sequence.push({
            t: Math.round((clock - startedAt) / 100) / 10,
            top: top ? { kind: top.kind, state: top.state, priority: top.priority } : null,
            signature,
          });
        }
      }
    }
  } finally {
    brain.running = false;
    mineSkill.mineBlock = originalMine;
    placeSkill.placeTorchAt = originalPlace;
    moveSkill.moveTo = originalMove;
  }

  const dispatched = records
    .filter((entry) => entry.event === 'agenda_push')
    .reduce((counts, entry) => {
      const kind = entry.task && entry.task.kind;
      if (kind) counts[kind] = (counts[kind] || 0) + 1;
      return counts;
    }, {});
  const minY = Math.min(...Array.from(blocks.values()).filter((entry) => entry.name === 'stone').map((entry) => entry.position.y));
  const digDownTorchDepths = records
    .filter((entry) => entry.event === 'task_torch_placed' && entry.depth != null)
    .map((entry) => entry.depth);
  const summary = {
    simulatedSeconds: 180,
    seenKinds: Array.from(new Set(records.filter((entry) => entry.event === 'agenda_push').map((entry) => entry.task.kind))),
    dispatched,
    digDownDispatches: dispatched.digDown || 0,
    mineOreDispatches: dispatched.mineOre || 0,
    allTorchPlacementDepths: torchDepths,
    digDownTorchDepths,
    torchEveryFive: digDownTorchDepths.every((depth) => depth > 0 && depth % 5 === 0),
    lavaMined: calls.lavaMined,
    mineCalls: calls.mine,
    moveCalls: calls.moves,
    finalPosition: [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z],
    lowestRemainingStoneY: Number.isFinite(minY) ? minY : null,
    recordEvents: records.length,
  };

  console.log('AGENDA SEQUENCE');
  for (const entry of sequence) console.log(JSON.stringify(entry));
  console.log('SUMMARY');
  console.log(JSON.stringify(summary, null, 2));

  const ok = summary.digDownDispatches > 0 &&
    summary.digDownTorchDepths.length >= 1 &&
    summary.torchEveryFive &&
    summary.lavaMined === 0;
  if (!ok) {
    console.error('FAILED: expected digDown, 5-block torch cadence, and zero lava mined');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
