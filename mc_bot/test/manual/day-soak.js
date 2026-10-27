'use strict';

// 仅 fake-world 验收脚本使用执行模式；生产/默认配置仍必须是 shadowMode=true。

const vec3 = require('vec3');
const minecraftData = require('minecraft-data')('1.21.1');
const { createBrain } = require('../../src/body/brain');

function key(position) {
  return position.x + ',' + position.y + ',' + position.z;
}

function block(name, x, y, z) {
  return {
    name,
    position: vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    light: 15,
  };
}

function makeFakeWorld() {
  const blocks = new Map();
  const items = [
    { name: 'stone_axe', count: 1 },
    { name: 'stone_pickaxe', count: 1 },
  ];
  let held = null;
  let sleepCalls = 0;
  let goal = null;
  const calls = { dig: 0, attack: 0, move: 0 };
  for (let x = -12; x <= 16; x += 1) {
    for (let z = -12; z <= 12; z += 1) {
      blocks.set(x + ',63,' + z, block('stone', x, 63, z));
    }
  }
  for (let y = 64; y <= 76; y += 1) {
    blocks.set('4,' + y + ',0', block('oak_log', 4, y, 0));
  }

  const zombie = {
    id: 2,
    name: 'zombie',
    displayName: 'Zombie',
    position: vec3(12, 64, 0),
    health: 20,
    height: 1.9,
    kind: 'Hostile mobs',
  };

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
    entities: { 2: zombie },
    players: {},
    inventory: {
      slots: Array(46).fill(null),
      items: () => items.slice(),
      emptySlotCount: () => 20,
    },
    pathfinder: {
      setGoal(nextGoal) {
        if (!nextGoal) {
          goal = null;
          return;
        }
        calls.move += 1;
        goal = nextGoal;
      },
      setMovements() {},
      isMoving() {
        if (!goal) return false;
        return Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z) > 1;
      },
      advance(step = 0.5) {
        if (!goal) return;
        const dx = Number(goal.x) - bot.entity.position.x;
        const dz = Number(goal.z) - bot.entity.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance <= 1) {
          bot.entity.position = vec3(goal.x, bot.entity.position.y, goal.z);
          goal = null;
          return;
        }
        const amount = Math.min(step, distance);
        bot.entity.position = vec3(
          bot.entity.position.x + dx / distance * amount,
          bot.entity.position.y,
          bot.entity.position.z + dz / distance * amount
        );
      },
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
    },
    async dig(target) {
      calls.dig += 1;
      blocks.delete(key(target.position));
      const existing = items.find((item) => item.name === target.name);
      if (existing) existing.count += 1;
      else items.push({ name: target.name, count: 1 });
      await new Promise((resolve) => setImmediate(resolve));
    },
    attack(entity) {
      calls.attack += 1;
      entity.health -= 7;
      if (entity.health <= 0) delete bot.entities[entity.id];
    },
    async lookAt() {},
    setControlState() {},
    clearControlStates() {},
    async consume() { sleepCalls += 1; },
    async sleep() { sleepCalls += 1; },
    on() {},
  };
  Object.defineProperty(bot, 'heldItem', { get: () => held });
  return { bot, zombie, calls, getSleepCalls: () => sleepCalls };
}

async function main() {
  const { bot, zombie, calls, getSleepCalls } = makeFakeWorld();
  let clock = 1_000_000;
  const records = [];
  const brain = createBrain({
    config: {
      brain: {
        shadowMode: false,
        tickMs: 100,
        driveMs: 1000,
        arbiterMs: 500,
        local: { localLeaseMs: 120000 },
      },
    },
    connection: { getBot: () => bot, isReady: () => true },
    log: { warn() {}, log() {} },
    record: (entry) => records.push(entry),
    now: () => clock,
  });

  brain.running = true;
  const start = clock;
  const sequence = [];
  const seenKinds = new Set();
  let lastTop = null;

  for (let tick = 0; tick < 600; tick += 1) {
    clock += 100;
    if (clock - start >= 5000 && zombie.health > 0) {
      zombie.position = vec3(5, 64, 0);
    }
    brain.tick();
    bot.pathfinder.advance();
    const top = brain.agenda.top();
    const signature = brain.agenda.snapshot()
      .map((task) => task.kind + ':' + task.state)
      .join(' > ') || 'none';
    if (signature !== lastTop) {
      lastTop = signature;
      sequence.push({
        t: Math.round((clock - start) / 100) / 10,
        top: top ? { kind: top.kind, state: top.state, id: top.id, priority: top.priority } : null,
        signature,
        stack: brain.agenda.snapshot().map((task) => ({ kind: task.kind, state: task.state, priority: task.priority })),
      });
    }
    if (top) seenKinds.add(top.kind);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  brain.running = false;
  const summary = {
    simulatedSeconds: 60,
    seenKinds: Array.from(seenKinds),
    digCalls: calls.dig,
    attackCalls: calls.attack,
    moveCalls: calls.move,
    sleepCalls: getSleepCalls(),
    zombieAlive: zombie.health > 0,
    recordEvents: records.length,
  };

  console.log('AGENDA SEQUENCE');
  for (const entry of sequence) console.log(JSON.stringify(entry));
  console.log('SUMMARY');
  console.log(JSON.stringify(summary, null, 2));

  const ok = seenKinds.has('collectBlock') && seenKinds.has('fight');
  if (!ok) {
    console.error('FAILED: expected both collectBlock and fight in agenda history');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
