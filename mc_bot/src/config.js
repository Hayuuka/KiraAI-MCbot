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
