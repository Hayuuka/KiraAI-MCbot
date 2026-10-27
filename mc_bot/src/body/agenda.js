'use strict';

const { TASK_STATE, FAILURE_REASONS, nowOf } = require('../tasks/base');

class Agenda {
  constructor(options = {}) {
    this.maxDepth = Math.max(1, Math.trunc(Number(options.maxDepth) || 12));
    this.defaultLeaseMs = Math.max(1000, Math.trunc(Number(options.defaultLeaseMs) || 600000));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this._tasks = [];
    this._ctx = null;
  }

  get size() {
    return this._tasks.length;
  }

  top() {
    return this._tasks[this._tasks.length - 1] || null;
  }

  list() {
    return this._tasks.slice();
  }

  push(task, options = {}) {
    if (!task || typeof task.tick !== 'function') return null;
    if (this._tasks.length >= this.maxDepth) {
      const bottom = this._tasks[0];
      if (bottom && bottom.state !== TASK_STATE.FROZEN) {
        this.drop(bottom, FAILURE_REASONS.STACK_OVERFLOW);
      }
    }
    if (this._tasks.length >= this.maxDepth) return null;

    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : this.now();
    const leaseMs = options.leaseMs === null
      ? null
      : Math.max(1000, Math.trunc(Number(options.leaseMs) || this.defaultLeaseMs));
    task.leaseExpiresAt = leaseMs === null ? null : now + leaseMs;
    const previousTop = this.top();
    this._tasks.push(task);
    if (previousTop && previousTop.state === TASK_STATE.RUNNING) previousTop.pause();
    this._emit('agenda_push', {
      task: task.toJSON ? task.toJSON() : { id: task.id, kind: task.kind },
      leaseMs,
    });
    return task;
  }

  tick(ctx) {
    this._ctx = ctx;
    const task = this.top();
    if (!task) return null;

    if (task.isTerminal) {
      this._settle(task);
      return task;
    }
    if (task.isFrozen) return task;
    if (task.isPaused) {
      task.resume();
      if (typeof task.onResume === 'function') task.onResume(ctx);
      this._emit('agenda_resume', { task: task.toJSON ? task.toJSON() : { id: task.id, kind: task.kind } });
    }

    const now = nowOf(ctx);
    if (task.leaseExpiresAt !== null && now >= task.leaseExpiresAt) {
      task.fail(FAILURE_REASONS.LEASE_EXPIRED, { ctx });
      this._settle(task);
      return task;
    }

    task.tick(ctx);
    if (task.isTerminal) this._settle(task);
    return task;
  }

  freezeTop() {
    const task = this.top();
    return Boolean(task && task.freeze());
  }

  thawTop() {
    const task = this.top();
    return Boolean(task && task.thaw());
  }

  dropTop(reason = FAILURE_REASONS.CANCELLED) {
    const task = this.top();
    return task ? this.drop(task, reason) : null;
  }

  drop(taskOrId, reason = FAILURE_REASONS.CANCELLED) {
    const index = this._tasks.findIndex((task) => task === taskOrId || task.id === taskOrId);
    if (index < 0) return null;
    const task = this._tasks[index];
    if (!task.isTerminal) task.fail(reason);
    this._tasks.splice(index, 1);
    this._emit('agenda_drop', {
      task: task.toJSON ? task.toJSON() : { id: task.id, kind: task.kind },
      reason,
    });
    return task;
  }

  clear(reason = FAILURE_REASONS.CANCELLED) {
    while (this._tasks.length) this.dropTop(reason);
  }

  snapshot() {
    return this._tasks.map((task) => (task.toJSON ? task.toJSON() : {
      id: task.id,
      kind: task.kind,
      state: task.state,
    }));
  }

  _settle(task, ctx = this._ctx) {
    const index = this._tasks.lastIndexOf(task);
    if (index >= 0) this._tasks.splice(index, 1);
    this._emit('agenda_settle', {
      task: task.toJSON ? task.toJSON() : { id: task.id, kind: task.kind },
      outcome: task.state,
      failure: task.failure ? { ...task.failure } : null,
    });
    const next = this.top();
    if (next && next.isPaused) {
      next.resume();
      if (typeof next.onResume === 'function') next.onResume(ctx);
      this._emit('agenda_resume', { task: next.toJSON ? next.toJSON() : { id: next.id, kind: next.kind } });
    }
  }

  _emit(event, payload) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event, payload);
    } catch (_) {
      // 记录失败不能影响任务栈。
    }
  }
}

function createAgenda(options = {}) {
  return new Agenda(options);
}

module.exports = {
  Agenda,
  createAgenda,
};
