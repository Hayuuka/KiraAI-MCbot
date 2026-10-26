'use strict';

const fs = require('fs');
const path = require('path');
const { buildStatus } = require('./state');
const skills = require('./skills');

const MAX_SCAN_CHARS = 4000;
const SCAN_CHAR_BUDGET = 3900;
const MAX_SCAN_RADIUS = 16;
const MAX_ATTACK_DISTANCE = 16;
const AUDIT_DIR = path.resolve(__dirname, '..', 'logs');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function truncateChars(value, max) {
  const chars = Array.from(String(value == null ? '' : value));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function cleanChatText(value, max) {
  return truncateChars(String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim(), max);
}

function normalizeToolName(name) {
  const stripped = String(name || '').trim().replace(/^mc[_-]?/i, '');
  return stripped.replace(/[_-]+([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
}

function normalizeBlockName(name) {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return 'minecraft:unknown';
  return text.includes(':') ? text : 'minecraft:' + text;
}

function bareName(name) {
  return normalizeBlockName(name).split(':').pop();
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function positionDistance(from, to) {
  if (!from || !to) return Infinity;
  const dx = Number(from.x) - Number(to.x);
  const dy = Number(from.y) - Number(to.y);
  const dz = Number(from.z) - Number(to.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function safeJson(value, max) {
  try {
    return truncateChars(JSON.stringify(value), max);
  } catch (_) {
    return '"<unserializable>"';
  }
}

function sameEntityName(entity, wanted) {
  const raw = String(wanted || '').toLowerCase();
  const bare = raw.split(':').pop();
  const values = [entity.name, entity.displayName, entity.type, entity.username];
  return values.some((value) => {
    if (value == null) return false;
    const text = String(value).toLowerCase();
    return text === raw || text.split(':').pop() === bare;
  });
}

function createActions(options = {}) {
  const config = options.config || {};
  const connection = options.connection || {};
  const eventHub = options.eventHub || null;
  const autonomy = options.autonomy || null;
  // intent 在 actions 之后才创建（它依赖 link），所以用可变引用，稍后注入
  let intent = options.intent || null;
  const log = options.log || console;
  let auditReady = false;

  function getBot() {
    return typeof connection.getBot === 'function' ? connection.getBot() : null;
  }

  function isReady() {
    return typeof connection.isReady === 'function' ? connection.isReady() : Boolean(getBot());
  }

  function movementEnabled() {
    return Boolean(config.features && config.features.movement);
  }

  function movementError() {
    return { ok: false, error: 'movement disabled by config (features.movement=false)' };
  }

  function pvpEnabled() {
    return Boolean(
      (config.features && config.features.pvp === true) ||
      (config.combat && config.combat.pvp === true) ||
      config.pvp === true
    );
  }

  function readyOrError() {
    const bot = getBot();
    if (!bot || !isReady()) return { ok: false, error: 'bot offline or not ready' };
    return { ok: true, bot };
  }

  function writeAudit(meta, tool, args, result, durationMs) {
    try {
      if (!auditReady) {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        auditReady = true;
      }
      const entry = {
        ts: new Date().toISOString(),
        actor: String((meta && (meta.actor || meta.name)) || 'local'),
        requestId: meta && meta.requestId != null ? meta.requestId : null,
        tool: String(tool || ''),
        ok: Boolean(result && result.ok),
        args: safeJson(args == null ? {} : args, 500),
        ms: durationMs,
      };
      if (!entry.ok) entry.error = truncateChars(result && result.error ? result.error : 'unknown error', 500);
      fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {});
    } catch (error) {
      try {
        const sink = log && (log.warn || log.log);
        if (typeof sink === 'function') sink.call(log, '[audit] write failed: ' + errorText(error));
      } catch (_) {
        return;
      }
    }
  }

  async function say(args) {
    try {
      const source = args && typeof args === 'object' ? args.text ?? args.message : args;
      const maxChars = Math.max(1, Math.min(200, Number(config.limits && config.limits.maxSayChars) || 200));
      const text = cleanChatText(source, maxChars);
      if (!text) return { ok: false, error: 'text is required' };
      const ready = readyOrError();
      if (!ready.ok) return ready;
      ready.bot.chat(text);
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function status() {
    try {
      const mode = autonomy && typeof autonomy.getMode === 'function' ? autonomy.getMode() : 'idle';
      const result = buildStatus(getBot(), isReady(), mode);
      // 挖矿模式时附带进度，模型据此判断"还在干活"还是"卡住了"
      if (result && result.ok && mode === 'mine' && autonomy) {
        result.mine = {
          mined: Number(autonomy.minedCount) || 0,
          elapsedSec: autonomy.mineStartedAt
            ? Math.round((Date.now() - autonomy.mineStartedAt) / 1000)
            : 0,
        };
      }
      return result;
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function inventory() {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const bot = ready.bot;
      if (!bot.inventory || typeof bot.inventory.items !== 'function') {
        return { ok: false, error: 'inventory unavailable' };
      }
      const items = bot.inventory.items();
      const counts = new Map();
      let total = 0;
      for (const item of items) {
        if (!item) continue;
        const name = String(item.name || 'unknown');
        const count = Number(item.count) || 1;
        total += count;
        counts.set(name, (counts.get(name) || 0) + count);
      }
      const list = Array.from(counts, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      let emptySlots = 0;
      try {
        const empty = bot.inventory.emptySlotCount;
        emptySlots = typeof empty === 'function' ? Number(empty.call(bot.inventory)) || 0 : Number(empty) || 0;
      } catch (_) {
        emptySlots = 0;
      }
      return {
        ok: true,
        total,
        totalTypes: counts.size,
        items: list.slice(0, 15),
        emptySlots,
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function drop(args) {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const source = args && typeof args === 'object' ? args : { item: args };
      const wanted = String(source.item ?? source.name ?? '').trim();
      if (!wanted) return { ok: false, error: 'item is required' };
      return await skills.inventory.dropItem(ready.bot, wanted, source.count ?? 1);
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function equip(args) {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const bot = ready.bot;
      const source = args && typeof args === 'object' ? args : { item: args };
      const wanted = String(source.item ?? source.name ?? '').trim();
      if (!wanted) return { ok: false, error: 'item is required' };

      const normalized = skills.inventory.normalizeItemName(wanted);
      const item = skills.inventory.findItem(bot, normalized);
      const inferredSlot = source.slot
        ? skills.inventory.normalizeSlot(source.slot)
        : skills.inventory.armorSlotOf(normalized) || 'hand';
      const already = inferredSlot ? skills.inventory.getEquippedItem(bot, inferredSlot) : null;
      if (already && skills.inventory.normalizeItemName(already.name) === normalized) {
        return { ok: true, slot: inferredSlot, wearing: normalized, replaced: null, note: '本来就穿着' };
      }
      if (!item) {
        return {
          ok: false,
          error: `背包里没有 ${normalized}`,
          available: skills.inventory.uniqueItemNames(bot),
        };
      }

      const slot = inferredSlot;
      if (!slot) return { ok: false, error: 'unknown slot: ' + String(source.slot) };

      const before = skills.inventory.getEquippedItem(bot, slot);
      await bot.equip(item, slot);
      try {
        if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(2);
      } catch (_) {}
      const after = skills.inventory.getEquippedItem(bot, slot);
      if (!after || skills.inventory.normalizeItemName(after.name) !== normalized) {
        return { ok: false, error: '穿上后没有生效（可能被服务器拒绝）', slot };
      }
      return {
        ok: true,
        slot,
        wearing: normalized,
        replaced: before ? skills.inventory.normalizeItemName(before.name) : null,
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function unequip(args) {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const bot = ready.bot;
      const source = args && typeof args === 'object' ? args : { slot: args };
      const slot = skills.inventory.normalizeSlot(source.slot ?? source.name);
      if (!slot) return { ok: false, error: 'slot is required' };
      if (typeof bot.unequip !== 'function') return { ok: false, error: 'unequip unavailable' };

      const before = skills.inventory.getEquippedItem(bot, slot);
      if (!before) return { ok: true, slot, unequipped: null, note: '该槽位本来就是空的' };
      await bot.unequip(slot);
      try {
        if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(2);
      } catch (_) {}
      const after = skills.inventory.getEquippedItem(bot, slot);
      if (after && skills.inventory.normalizeItemName(after.name) === skills.inventory.normalizeItemName(before.name)) {
        return { ok: false, error: '脱下后没有生效（可能被服务器拒绝）', slot };
      }
      return {
        ok: true,
        slot,
        unequipped: skills.inventory.normalizeItemName(before.name),
        now: after ? skills.inventory.normalizeItemName(after.name) : null,
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function recentChat(args) {
    try {
      const source = args && typeof args === 'object' ? args.limit : args;
      const limit = Math.max(1, Math.min(50, Math.trunc(Number(source) || 20)));
      const messages = eventHub && typeof eventHub.getRecentChat === 'function' ? eventHub.getRecentChat(limit) : [];
      return { ok: true, count: messages.length, messages };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function fitScan(radius, blockList, entityList, notableList) {
    const blocks = blockList.slice(0, 10).map((item) => ({ type: truncateChars(item.type, 80), count: item.count }));
    const entities = entityList.slice(0, 10).map((item) => ({ type: truncateChars(item.type, 80), dist: item.dist }));
    const notable = notableList.slice(0, 10).map((item) => ({
      type: truncateChars(item.type, 80),
      pos: item.pos,
    }));

    const size = () => JSON.stringify({ ok: true, radius, blocks, entities, notable }).length;
    while (size() > SCAN_CHAR_BUDGET) {
      if (notable.length) notable.pop();
      else if (entities.length) entities.pop();
      else if (blocks.length) blocks.pop();
      else break;
    }
    if (size() > SCAN_CHAR_BUDGET) {
      for (const block of blocks) block.type = truncateChars(block.type, 32);
      for (const entity of entities) entity.type = truncateChars(entity.type, 32);
      for (const item of notable) item.type = truncateChars(item.type, 32);
    }
    if (size() > SCAN_CHAR_BUDGET) {
      blocks.length = 0;
      entities.length = 0;
      notable.length = 0;
    }
    return { ok: true, radius, blocks, entities, notable };
  }

  function scan(args) {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const bot = ready.bot;
      const source = args && typeof args === 'object' ? args.radius ?? args.r : args;
      let radius = Math.trunc(Number(source) || 16);
      radius = Math.max(1, Math.min(MAX_SCAN_RADIUS, radius));

      const origin = bot.entity.position;
      const centerX = Math.floor(origin.x);
      const centerY = Math.floor(origin.y);
      const centerZ = Math.floor(origin.z);
      const Vec3 = origin.constructor;
      const counts = new Map();
      const notableAll = [];
      const excluded = new Set(['air', 'cave_air', 'void_air', 'light']);

      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dz = -radius; dz <= radius; dz += 1) {
            if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
            const block = bot.blockAt(new Vec3(centerX + dx, centerY + dy, centerZ + dz));
            if (!block) continue;
            const bare = bareName(block.name);
            if (!bare || excluded.has(bare)) continue;
            const type = normalizeBlockName(block.name);
            counts.set(type, (counts.get(type) || 0) + 1);
            if (/_ore$/.test(bare) || bare === 'ancient_debris') {
              notableAll.push({
                type,
                pos: [centerX + dx, centerY + dy, centerZ + dz],
                distance: dx * dx + dy * dy + dz * dz,
              });
            }
          }
        }
      }

      const blockList = Array.from(counts, ([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

      const entityList = [];
      for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity === bot.entity || entity.id === bot.entity.id) continue;
        if (!entity.position) continue;
        const distance = positionDistance(origin, entity.position);
        if (!Number.isFinite(distance) || distance > radius) continue;
        let type = 'minecraft:entity';
        if (entity.type === 'player') type = 'minecraft:player';
        else type = normalizeBlockName(entity.name || entity.displayName || entity.type || 'entity');
        entityList.push({ type, dist: round1(distance), distance });
      }
      entityList.sort((a, b) => a.distance - b.distance);

      notableAll.sort((a, b) => a.distance - b.distance);
      const notableList = notableAll.slice(0, 10);
      return fitScan(radius, blockList, entityList, notableList);
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function attack(args) {
    try {
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const bot = ready.bot;
      const source = args && typeof args === 'object' ? args.target ?? args.name ?? args.entity : args;
      const wanted = String(source == null ? '' : source).trim();
      if (!wanted) return { ok: false, error: 'target is required' };

      const entities = Object.values(bot.entities || {}).filter(
        (entity) => entity && entity !== bot.entity && entity.id !== bot.entity.id && entity.position
      );
      let target = null;
      const player = Object.values(bot.players || {}).find(
        (entry) => entry && String(entry.username || '').toLowerCase() === wanted.toLowerCase()
      );
      if (player && player.entity) target = player.entity;

      if (!target && /^\d+$/.test(wanted)) {
        target = bot.entities && bot.entities[Number(wanted)] ? bot.entities[Number(wanted)] : null;
      }
      if (!target) {
        const matches = entities.filter((entity) => sameEntityName(entity, wanted));
        matches.sort(
          (a, b) => positionDistance(bot.entity.position, a.position) - positionDistance(bot.entity.position, b.position)
        );
        target = matches[0] || null;
      }
      if (!target) return { ok: false, error: 'target not found: ' + wanted };

      const distance = positionDistance(bot.entity.position, target.position);
      if (!Number.isFinite(distance) || distance > MAX_ATTACK_DISTANCE) {
        return { ok: false, error: 'target is beyond 16 blocks' };
      }

      const isPlayer = target.type === 'player' || Boolean(target.username) || Boolean(player && player.entity === target);
      if (isPlayer && !pvpEnabled()) {
        return { ok: false, error: 'pvp is disabled (set features.pvp=true to enable)' };
      }

      bot.attack(target);
      return {
        ok: true,
        target: target.username || target.name || target.displayName || target.type || 'entity',
        dist: round1(distance),
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function move(args) {
    try {
      if (!movementEnabled()) return movementError();
      const ready = readyOrError();
      if (!ready.ok) return ready;
      let target = args && typeof args === 'object' ? args.target ?? args.to : args;
      if (!target && args && typeof args === 'object' && args.x !== undefined) {
        target = { x: args.x, y: args.y, z: args.z };
      }
      if (target == null || target === '') return { ok: false, error: 'target is required' };
      const timeoutMs = args && typeof args === 'object' ? args.timeoutMs : undefined;
      return await skills.moveTo(ready.bot, target, { timeoutMs });
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function follow(args) {
    try {
      if (!movementEnabled()) return movementError();
      const ready = readyOrError();
      if (!ready.ok) return ready;
      const source = args && typeof args === 'object' ? args.player ?? args.target ?? args.name : args;
      const name = String(source == null ? '' : source).trim();
      if (!name) return { ok: false, error: 'player is required' };
      if (!skills.follow.isPlayerVisible(ready.bot, name)) {
        return { ok: false, error: 'player not visible: ' + name };
      }
      if (autonomy && typeof autonomy.setMode === 'function') {
        const result = autonomy.setMode('follow', { player: name });
        if (!result || !result.ok) return result || { ok: false, error: 'could not start follow' };
      } else {
        const result = skills.startFollow(ready.bot, name);
        if (!result.ok) return result;
      }
      return { ok: true, mode: 'follow', player: name };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function stop() {
    try {
      const bot = getBot();
      if (autonomy && typeof autonomy.setMode === 'function') {
        try {
          autonomy.setMode('idle');
        } catch (_) {
          return { ok: false, error: 'could not stop autonomy' };
        }
      }
      if (bot) {
        skills.stopFollow(bot);
        skills.stopMove(bot);
        try {
          if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
        } catch (_) {}
        try {
          if (typeof bot.stopDigging === 'function') bot.stopDigging();
        } catch (_) {}
      }
      return { ok: true, stopped: true, mode: 'idle' };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function mode(args) {
    try {
      if (!movementEnabled()) return movementError();
      const source = typeof args === 'string' ? { mode: args } : args && typeof args === 'object' ? args : {};
      const requested = String(source.mode ?? source.name ?? source.value ?? '').trim().toLowerCase();
      if (!requested) return { ok: false, error: 'mode is required' };
      const allowed = ['idle', 'follow', 'guard', 'mine', 'wander', 'sleep', 'escape'];
      if (!allowed.includes(requested)) return { ok: false, error: 'unknown mode: ' + requested };

      if (!autonomy || typeof autonomy.setMode !== 'function') {
        return { ok: false, error: 'autonomy is unavailable' };
      }
      if (requested !== 'idle' && !isReady()) return { ok: false, error: 'bot offline or not ready' };

      const modeArgs = source.args && typeof source.args === 'object' ? { ...source.args } : {};
      for (const [key, value] of Object.entries(source)) {
        if (key !== 'mode' && key !== 'name' && key !== 'value' && key !== 'args') modeArgs[key] = value;
      }
      const result = autonomy.setMode(requested, modeArgs);
      if (!result || !result.ok) return result || { ok: false, error: 'could not change mode' };

      // mine 模式：立刻检查附近有没有目标方块。
      // 否则模型会以为"设置成功=开始挖了"，而实际上她可能一直站着找不到东西。
      if (requested === 'mine') {
        const wanted = String(modeArgs.block || '').trim();
        if (!wanted) {
          autonomy.setMode('idle');
          return { ok: false, error: 'mine 模式需要 block 参数（方块 id 或 #minecraft:logs 这样的标签）' };
        }
        const radius = Math.max(1, Math.min(64, Number(modeArgs.radius) || 32));
        const bot = getBot();
        const found = bot ? skills.findNearestBlock(bot, wanted, radius) : null;
        if (!found) {
          autonomy.setMode('idle');
          return {
            ok: false,
            error: `附近 ${radius} 格内找不到 ${wanted}，已退回 idle。可以先用 mc_scan 看周围环境，或让她先走到有树的地方。`,
            searched: radius,
          };
        }
        return {
          ok: true,
          mode: requested,
          target: wanted,
          first_block: [Math.round(found.position.x), Math.round(found.position.y), Math.round(found.position.z)],
          distance: Math.round(skills.positionDistance(bot.entity.position, found.position) * 10) / 10,
        };
      }

      return { ok: true, mode: requested };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function plan(args) {
    try {
      if (!movementEnabled()) return movementError();
      if (!intent || typeof intent.setPlan !== 'function') {
        return { ok: false, error: 'plan 不可用（自主调度未启用）' };
      }
      if (!isReady()) return { ok: false, error: 'bot offline or not ready' };

      const source = args && typeof args === 'object' ? args : {};
      const steps = Array.isArray(source.steps) ? source.steps : Array.isArray(args) ? args : null;
      if (!steps || !steps.length) return { ok: false, error: 'steps 不能为空' };

      // 每步的 block/count/maxMinutes 是平铺参数，转成 setMode 认识的 args
      const normalized = steps.map((s) => {
        if (!s || typeof s !== 'object') return null;
        const mode = String(s.mode || '').trim();
        if (!mode) return null;
        const stepArgs = { ...(s.args && typeof s.args === 'object' ? s.args : {}) };
        for (const key of ['block', 'count', 'maxMinutes', 'radius', 'player']) {
          if (s[key] !== undefined && s[key] !== null && s[key] !== '') stepArgs[key] = s[key];
        }
        return { mode, args: stepArgs, label: String(s.label || mode) };
      }).filter(Boolean);

      if (!normalized.length) return { ok: false, error: '没有有效的步骤' };

      const accepted = intent.setPlan(normalized);
      if (!accepted) return { ok: false, error: '计划被拒绝' };

      return {
        ok: true,
        steps: normalized.map((s) => s.label),
        note: '计划已开始执行，做完一步会自动接下一步；有事可以随时叫停。',
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  const handlers = {
    say,
    status,
    inventory,
    drop,
    equip,
    unequip,
    recentChat,
    scan,
    attack,
    move,
    follow,
    stop,
    mode,
    plan,
  };

  async function invoke(toolName, args = {}, meta = {}) {
    const started = Date.now();
    let result;
    try {
      const key = normalizeToolName(toolName);
      const handler = handlers[key];
      if (typeof handler !== 'function') {
        result = { ok: false, error: 'unknown tool: ' + String(toolName) };
      } else {
        result = await handler(args, meta);
      }
      if (!result || typeof result !== 'object') {
        result = { ok: false, error: 'action returned no result' };
      } else if (typeof result.ok !== 'boolean') {
        result = { ok: false, error: 'action returned invalid result' };
      }
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    writeAudit(meta, toolName, args, result, Date.now() - started);
    return result;
  }

  function attachIntent(runner) {
    intent = runner;
  }

  return {
    ...handlers,
    attachIntent,
    invoke,
    handlers,
    toolNames: Object.keys(handlers),
    auditPath: AUDIT_FILE,
  };
}

module.exports = {
  createActions,
  normalizeToolName,
  MAX_SCAN_CHARS,
  MAX_SCAN_RADIUS,
  MAX_ATTACK_DISTANCE,
};
