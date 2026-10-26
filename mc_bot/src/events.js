'use strict';

const MAX_EVENT_TEXT = 200;
const DEDUPE_MS = 30000;
const LOW_HEALTH_COOLDOWN_MS = 60000;

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function cleanText(value, max = MAX_EVENT_TEXT) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

class EventHub {
  constructor(options = {}) {
    this.config = options.config || {};
    this.log = options.log || console;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.bufferSize = Number(this.config.events && this.config.events.chatBufferSize) || 200;
    this.selfNameFilter = !(this.config.events && this.config.events.selfNameFilter === false);
    this.chatBuffer = [];
    this.seen = new Map();
    this.lastLowHealthAt = 0;
    this.bot = null;
    this.handlers = null;
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.warn || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[events] ' + message);
    } catch (_) {
      return;
    }
  }

  _isDuplicate(text) {
    const now = Date.now();
    const previous = this.seen.get(text);
    if (previous && now - previous < DEDUPE_MS) return true;
    this.seen.set(text, now);
    if (this.seen.size > 500) {
      const cutoff = now - DEDUPE_MS;
      for (const [key, timestamp] of this.seen) {
        if (timestamp < cutoff) this.seen.delete(key);
      }
    }
    return false;
  }

  _pushChat(player, text, ts) {
    this.chatBuffer.push({ player, text, ts });
    const overflow = this.chatBuffer.length - this.bufferSize;
    if (overflow > 0) this.chatBuffer.splice(0, overflow);
  }

  report(kind, data) {
    const source = data && typeof data === 'object' ? data : {};
    const text = cleanText(source.text != null ? source.text : '');
    if (!text) return null;
    if (this._isDuplicate(text)) return null;

    const eventData = { ...source, text, ts: Number(source.ts) || Date.now() };
    const event = { type: 'event', kind: String(kind), data: eventData };
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (error) {
        this._log('event callback failed: ' + errorText(error));
      }
    }
    return event;
  }

  reportSystem(text, extra) {
    return this.report('system', { ...(extra || {}), text: cleanText(text) });
  }

  _handleChat(bot, username, message) {
    const name = String(username || '');
    const text = cleanText(message);
    if (!name || !text) return;
    const self = bot.username || (this.config.bot && this.config.bot.username);
    if (this.selfNameFilter && (name === self || name === (this.config.bot && this.config.bot.username))) {
      return;
    }
    const ts = Date.now();
    this._pushChat(name, text, ts);
    this.report('chat', { player: name, text, ts });
  }

  _handleMessage(jsonMsg, position) {
    if (!jsonMsg || position === 'chat') return;
    let text = '';
    try {
      text = typeof jsonMsg.toString === 'function' ? jsonMsg.toString() : String(jsonMsg);
    } catch (_) {
      return;
    }
    text = cleanText(text);
    if (!text) return;
    this.report('system', { text, position: position || 'system' });
  }

  _handleHealth(bot) {
    const health = Number(bot.health);
    if (!Number.isFinite(health) || health >= 6) return;
    const now = Date.now();
    if (now - this.lastLowHealthAt < LOW_HEALTH_COOLDOWN_MS) return;
    this.lastLowHealthAt = now;
    this.report('health', { hp: health, text: 'health low: ' + health, ts: now });
  }

  attach(bot) {
    if (!bot) return this;
    this.detach();
    this.bot = bot;

    const handlers = {
      chat: (username, message) => this._handleChat(bot, username, message),
      message: (jsonMsg, position) => this._handleMessage(jsonMsg, position),
      playerJoined: (player) => {
        const name = player && (player.username || player.name);
        if (name) this.report('join', { player: String(name), text: String(name) + ' joined' });
      },
      playerLeft: (player) => {
        const name = player && (player.username || player.name);
        if (name) this.report('leave', { player: String(name), text: String(name) + ' left' });
      },
      death: () => this.report('death', { text: 'bot died' }),
      health: () => this._handleHealth(bot),
    };

    this.handlers = handlers;
    for (const [name, handler] of Object.entries(handlers)) {
      bot.on(name, handler);
    }
    return this;
  }

  detach() {
    if (this.bot && this.handlers) {
      for (const [name, handler] of Object.entries(this.handlers)) {
        try {
          this.bot.removeListener(name, handler);
        } catch (_) {
          continue;
        }
      }
    }
    this.bot = null;
    this.handlers = null;
    return this;
  }

  getRecentChat(limit) {
    const amount = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
    return this.chatBuffer.slice(-amount).map((entry) => ({ ...entry }));
  }

  getChatBuffer() {
    return this.chatBuffer.map((entry) => ({ ...entry }));
  }
}

function createEventHub(options = {}) {
  return new EventHub(options);
}

module.exports = {
  EventHub,
  createEventHub,
  cleanText,
  MAX_EVENT_TEXT,
};
