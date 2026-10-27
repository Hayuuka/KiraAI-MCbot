'use strict';

const TEMPLATES = Object.freeze({
  dawn: ['天亮了，该继续干活了。', '太阳出来了。'],
  ore: ['找到矿了。', '这块矿归我了。'],
  hurt: ['好疼。', '谁打我？'],
  escaped: ['总算甩掉了。', '安全了。'],
  sleep: ['该睡了。', '天黑了，我去睡了。'],
});

class TemplateVoice {
  constructor(options = {}) {
    this.eventHub = options.eventHub || null;
    this.connection = options.connection || null;
    this.config = { cooldownMs: 60000, perKeyCooldownMs: 300000, ...(options.config || {}) };
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this._lastSpokeAt = -Infinity;
    this._lastByKey = new Map();
    this._lastHurtAt = 0;
    this._lastIsDay = null;
    this.lastText = null;
  }

  tick(ctx) {
    if (!ctx || ctx.shadow) return false;
    const now = Number(ctx.now) || this.now();
    const isDay = ctx.perception && ctx.perception.world ? ctx.perception.world.isDay : null;
    if (this._lastIsDay === false && isDay === true) this.speak('dawn', ctx, now);
    this._lastIsDay = isDay;
    const hurtAt = Number(ctx.lastHurtAt) || 0;
    if (hurtAt > 0 && hurtAt !== this._lastHurtAt && now - hurtAt <= 2000) {
      this.speak('hurt', ctx, now);
    }
    this._lastHurtAt = hurtAt;
    return true;
  }

  onAgendaEvent(event, payload = {}, ctx = null) {
    if (!ctx || ctx.shadow) return false;
    const now = Number(ctx.now) || this.now();
    const task = payload.task || {};
    if (event === 'agenda_push' && task.kind === 'sleep') this.speak('sleep', ctx, now);
    if (event === 'agenda_settle' && payload.outcome === 'done' && task.kind === 'mineOre') {
      this.speak('ore', ctx, now);
    }
    if (event === 'agenda_settle' && payload.outcome === 'done' && task.kind === 'flee') {
      this.speak('escaped', ctx, now);
    }
    return true;
  }

  speak(key, ctx, nowValue) {
    const now = Number(nowValue) || this.now();
    if (now - this._lastSpokeAt < this.config.cooldownMs) return false;
    if (now - (this._lastByKey.get(key) || -Infinity) < this.config.perKeyCooldownMs) return false;
    const bot = ctx && ctx.bot;
    if (!bot || typeof bot.chat !== 'function') return false;
    const choices = TEMPLATES[key] || [];
    if (!choices.length) return false;
    const text = choices[Math.floor(this.random() * choices.length) % choices.length];
    try {
      bot.chat(text);
      if (this.eventHub && typeof this.eventHub.report === 'function') {
        this.eventHub.report('chat', {
          player: bot.username || 'ChuXiaoxue',
          text,
          source: 'self',
          ts: now,
        });
      }
      this._lastSpokeAt = now;
      this._lastByKey.set(key, now);
      this.lastText = text;
      return true;
    } catch (_) {
      return false;
    }
  }

  snapshot() {
    return { lastText: this.lastText, lastSpokeAt: this._lastSpokeAt };
  }
}

function createVoice(options = {}) {
  return new TemplateVoice(options);
}

module.exports = { TemplateVoice, createVoice, TEMPLATES };
