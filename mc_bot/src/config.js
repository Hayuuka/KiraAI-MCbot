'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNT_NAME = 'ChuXiaoxue';
const MC_VERSION = '26.1';
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULTS = {
  bot: {
    username: ACCOUNT_NAME,
    host: '127.0.0.1',
    port: 25568,
    version: MC_VERSION,
    auth: 'offline',
  },
  link: {
    url: 'ws://127.0.0.1:5267/ws/plugin/mc_bridge/agent',
    token: '从云端插件配置里复制',
    reconnectMinMs: 2000,
    reconnectMaxMs: 60000,
    heartbeatMs: 20000,
  },
  events: {
    chatBufferSize: 200,
    selfNameFilter: true,
  },
  limits: {
    maxSayChars: 200,
  },
  features: {
    movement: true,
  },
  brain: {
    enabled: true,
    // 第 1 阶段默认只观察、不接管旧 autonomy。验收 shadow 对比后再考虑关闭。
    shadowMode: true,
    tickMs: 100,
    driveMs: 1000,
    arbiterMs: 500,
    logFile: 'brain-shadow.jsonl',
    agenda: {
      maxDepth: 12,
      defaultLeaseMs: 600000,
    },
    perception: {
      undergroundDepth: 8,
      threatRadius: 16,
      maxThreats: 8,
      dayStartTick: 0,
      duskTick: 12000,
      nightStartTick: 13000,
      ticksPerDay: 24000,
    },
    local: {
      minHpToWork: 10,
      dangerRadius: 8,
      workAtNight: false,
      localLeaseMs: 120000,
      collectPriority: 40,
      strollPriority: 30,
      idlePriority: 10,
      strollMinRadius: 4,
      strollMaxRadius: 12,
    },
    watchdog: {
      offlineLogSec: 15,
      logRepeatSec: 30,
      silentSec: 30,
      stuckProgressSec: 20,
      progressStaleSec: 45,
    },
    drives: {
      hunger: {
        triggerFood: 6,
        lowHpTriggerFood: 18,
        lowHp: 18,
        satisfiedFood: 18,
      },
      health: {
        triggerHpRatio: 0.3,
        satisfiedHpRatio: 0.7,
      },
      night: {
        preDuskTicks: 1200,
      },
    },
    reflex: {
      lowHp: {
        hpRatio: 0.3,
        threatRadius: 12,
        clearHpRatio: 0.6,
        clearThreatGoneMs: 5000,
        fleeDistance: 18,
        searchRadius: 16,
        moveTimeoutMs: 8000,
        cooldownMs: 3000,
      },
      hurt: {
        activeMs: 2000,
        counterMinHp: 12,
        counterRadius: 4,
        fleeDistance: 12,
        searchRadius: 12,
        moveTimeoutMs: 6000,
        cooldownMs: 1500,
      },
      water: {
        searchRadius: 12,
        moveTimeoutMs: 6000,
        cooldownMs: 2500,
        surfaceJumpMs: 900,
      },
      lava: {
        dangerRadius: 2,
        searchRadius: 16,
        moveTimeoutMs: 6000,
        cooldownMs: 1000,
      },
    },
    combat: {
      fleePowerRatio: 1.3,
      attackRange: 2.6,
      approachRange: 2,
      retreatDistance: 2.2,
      backstepMs: 120,
      strafeSwitchMinMs: 900,
      strafeSwitchMaxMs: 1400,
      jumpEveryAttacks: 3,
      jumpHoldMs: 120,
      lookIntervalMs: 100,
      defaultCooldownMs: 400,
      swordCooldownMs: 625,
      axeCooldownMs: 1000,
      tridentCooldownMs: 900,
      creeperFuseValue: 1,
      creeperDangerRadius: 4,
      creeperRetreatDistance: 10,
    },
    tasks: {
      idle: {
        durationMs: 5000,
      },
      goto: {
        tolerance: 2,
        timeoutSec: 60,
        maxAttempts: 3,
        moveTimeoutMs: 10000,
        arriveRange: 2,
      },
      collectBlock: {
        selector: '#minecraft:logs',
        count: 8,
        radius: 32,
        maxMinutes: 5,
        maxNoTargetTicks: 20,
        blacklistMs: 60000,
        maxAttemptsPerBlock: 2,
        moveTimeoutMs: 10000,
        arriveRange: 2,
        reach: 4.5,
      },
      eat: {
        untilFood: 18,
        maxMinutes: 2,
        consumeTimeoutMs: 10000,
      },
      heal: {
        targetHp: 16,
        eatUntilFood: 18,
        maxMinutes: 5,
        consumeTimeoutMs: 10000,
      },
      flee: {
        distance: 16,
        searchRadius: 20,
        moveTimeoutMs: 8000,
        timeoutSec: 20,
        maxAttempts: 3,
      },
      sleep: {
        startBeforeDuskTicks: 1200,
        bedSearchRadius: 24,
        flatSearchRadius: 6,
        reach: 3,
        moveTimeoutMs: 10000,
        sleepTimeoutMs: 5000,
        maxMinutes: 10,
        maxAttempts: 4,
        monsterRadius: 8,
      },
      shelter: {
        searchRadius: 8,
        moveTimeoutMs: 8000,
        maxMinutes: 10,
        maxAttempts: 4,
        blocksRequired: 2,
        reach: 2,
      },
      fight: {
        attackRange: 2.6,
        approachRange: 2,
        maxMinutes: 2,
        creeperDangerRadius: 4,
        creeperRetreatDistance: 10,
      },
      guard: {
        radius: 12,
        durationMs: 600000,
      },
      assist: {
        playerRadius: 16,
        safeRadius: 8,
        safeHoldMs: 3000,
        durationMs: 600000,
      },
      digIn: {
        maxMinutes: 12,
        maxAttempts: 3,
        digTimeoutMs: 15000,
      },
    },
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, extra) {
  if (!isPlainObject(extra)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = merge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(file, warnings, optional) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT' && optional) return null;
    warnings.push(file + ': ' + (error && error.message ? error.message : String(error)));
    return null;
  }
}

function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadConfig() {
  const warnings = [];
  let config = merge({}, DEFAULTS);

  const baseFile = path.join(ROOT_DIR, 'config.json');
  const base = readJson(baseFile, warnings, false);
  if (base) config = merge(config, base);

  const localFile = path.join(ROOT_DIR, 'config.local.json');
  const local = readJson(localFile, warnings, true);
  if (local) config = merge(config, local);

  config.bot = isPlainObject(config.bot) ? config.bot : {};
  config.bot.username = ACCOUNT_NAME;
  config.bot.version = MC_VERSION;
  config.bot.host = String(config.bot.host || DEFAULTS.bot.host);
  config.bot.port = Math.trunc(numberInRange(config.bot.port, DEFAULTS.bot.port, 1, 65535));
  config.bot.auth = config.bot.auth === 'microsoft' ? 'microsoft' : 'offline';

  config.link = isPlainObject(config.link) ? config.link : {};
  config.link.url = String(config.link.url || DEFAULTS.link.url);
  config.link.token = String(config.link.token || '');
  config.link.reconnectMinMs = Math.trunc(numberInRange(config.link.reconnectMinMs, 2000, 500, 60000));
  config.link.reconnectMaxMs = Math.trunc(numberInRange(config.link.reconnectMaxMs, 60000, config.link.reconnectMinMs, 300000));
  config.link.heartbeatMs = Math.trunc(numberInRange(config.link.heartbeatMs, 20000, 5000, 120000));

  config.events = isPlainObject(config.events) ? config.events : {};
  config.events.chatBufferSize = Math.trunc(numberInRange(config.events.chatBufferSize, 200, 1, 1000));
  config.events.selfNameFilter = config.events.selfNameFilter !== false;

  config.limits = isPlainObject(config.limits) ? config.limits : {};
  config.limits.maxSayChars = Math.trunc(numberInRange(config.limits.maxSayChars, 200, 1, 200));

  config.features = isPlainObject(config.features) ? config.features : {};
  config.features.movement = config.features.movement !== false;
  config.features.pvp = config.features.pvp === true;

  config.brain = isPlainObject(config.brain) ? config.brain : {};
  config.brain.enabled = config.brain.enabled !== false;
  config.brain.shadowMode = config.brain.shadowMode !== false;
  config.brain.tickMs = Math.trunc(numberInRange(config.brain.tickMs, 100, 50, 2000));
  config.brain.arbiterMs = Math.trunc(numberInRange(config.brain.arbiterMs, 500, 100, 10000));

  Object.defineProperty(config, '_warnings', {
    value: warnings,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return config;
}

function isLinkConfigured(config) {
  const token = String(config && config.link && config.link.token ? config.link.token : '').trim();
  const url = String(config && config.link && config.link.url ? config.link.url : '').trim();
  if (!url || !token) return false;
  if (token.includes('从云端') || token.toLowerCase().includes('copy')) return false;
  return true;
}

module.exports = {
  ACCOUNT_NAME,
  MC_VERSION,
  ROOT_DIR,
  DEFAULTS,
  loadConfig,
  isLinkConfigured,
};
