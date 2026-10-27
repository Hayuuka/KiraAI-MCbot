'use strict';

const fs = require('fs');
const path = require('path');

class DiaryWriter {
  constructor(options = {}) {
    this.file = options.file || path.resolve(__dirname, '..', '..', 'data', 'diary.jsonl');
    this.log = options.log || console;
    this.deaths = 0;
  }

  recordDeath() {
    this.deaths += 1;
  }

  record(payload = {}, ctx = null) {
    const task = payload.task || {};
    const finishedAt = Number(task.finishedAt);
    const startedAt = Number(task.startedAt);
    const now = Number(ctx && ctx.now);
    const ts = Number.isFinite(finishedAt) ? new Date(finishedAt).toISOString() : new Date().toISOString();
    let durationSec = 0;
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt)) {
      durationSec = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
    }
    const entry = {
      ts,
      goal: String(task.kind || ''),
      outcome: String(payload.outcome || 'unknown'),
      reason: payload.failure && payload.failure.reason
        ? String(payload.failure.reason)
        : (payload.reason || null),
      durationSec,
      deaths: this.deaths,
      source: task.source || null,
      at: Number.isFinite(now) ? now : null,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
      return entry;
    } catch (error) {
      try {
        const sink = this.log && (this.log.warn || this.log.log);
        if (typeof sink === 'function') sink.call(this.log, '[diary] write failed: ' + (error.message || error));
      } catch (_) {
        return null;
      }
      return null;
    }
  }
}

function createDiary(options = {}) {
  return new DiaryWriter(options);
}

module.exports = { DiaryWriter, createDiary };
