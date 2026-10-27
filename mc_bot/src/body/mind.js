'use strict';

const taskRegistry = require('../tasks');
const { FAILURE_REASONS } = require('../tasks/base');

const MIND_STATE = Object.freeze({
  IDLE: 'IDLE',
  ASKING: 'ASKING',
  PENDING: 'PENDING',
  COOLDOWN: 'COOLDOWN',
});

const FALLBACK = Object.freeze({
  enabled: true,
  timeoutMs: 20000,
  cooldownMs: 30000,
  maxAsksPerHour: 12,
  socialIntervalMs: 600000,
  taskFailureWakeMinMs: 60000,
  maxCan: 6,
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compactPosition(position) {
  if (!position) return null;
  return [
    Math.round(Number(position.x) * 10) / 10,
    Math.round(Number(position.y) * 10) / 10,
    Math.round(Number(position.z) * 10) / 10,
  ];
}

class Mind {
  constructor(options = {}) {
    this.link = options.link || null;
    this.tasks = options.tasks || taskRegistry;
    this.config = { ...FALLBACK, ...(options.config || {}) };
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.log = options.log || console;
    this.recordSink = typeof options.record === 'function' ? options.record : null;
    this.brain = options.brain || null;

    this.state = MIND_STATE.IDLE;
    this.askedAt = null;
    this.cooldownUntil = 0;
    this.askTimes = [];
    this._askPromise = null;
    this._askResolve = null;
    this._askReason = null;
    this._lastChoice = null;
    this._lastResult = null;
    this._failureKind = null;
    this._consecutiveFailures = 0;
    this._lastFailureWakeAt = -Infinity;
    this._lastInteractionAt = this.now();
    this._lastSituation = null;
    this.lastQuestion = null;
    this.lastAnswer = null;
    this.lastError = null;
  }

  attachBrain(brain) {
    this.brain = brain || null;
    return this;
  }

  setRecorder(record) {
    this.recordSink = typeof record === 'function' ? record : null;
    return this;
  }

  getContext() {
    if (!this.brain) return null;
    const now = typeof this.brain.now === 'function' ? this.brain.now() : this.now();
    const bot = typeof this.brain._getBot === 'function' ? this.brain._getBot() : null;
    if (!bot) return null;
    if (typeof this.brain._context === 'function') return this.brain._context(now, bot);
    return null;
  }

  tick(ctx = this.getContext()) {
    if (!ctx) return this.state;
    const now = this._now(ctx);
    if (this.state === MIND_STATE.ASKING && this.askedAt != null &&
      now - this.askedAt >= this.config.timeoutMs) {
      this._record('mind_timeout', {
        waitedMs: now - this.askedAt,
        reason: this._askReason,
      });
      this.lastError = 'timeout';
      this._finishAsk(null);
      this._enterCooldown(now);
      return this.state;
    }
    if (this.state === MIND_STATE.COOLDOWN && now >= this.cooldownUntil) {
      this.state = MIND_STATE.IDLE;
    }
    if (this.state === MIND_STATE.PENDING) {
      const top = ctx.agenda ? ctx.agenda.top() : null;
      if (!top || top.isTerminal) this._enterCooldown(now);
    }
    this._pruneAskTimes(now);
    return this.state;
  }

  maybeAsk(ctx = this.getContext(), options = {}) {
    if (!ctx || !this.config.enabled) return false;
    this.tick(ctx);
    if (this.state !== MIND_STATE.IDLE) return false;

    const now = this._now(ctx);
    const top = ctx.agenda ? ctx.agenda.top() : null;
    const choice = options.choice || this._lastChoice;
    const choiceReason = choice && choice.reason ? String(choice.reason) : '';
    const idleTrigger = Boolean(
      choice && choice.kind === 'idle' && !choiceReason.startsWith('low_hp')
    ) || Boolean(top && top.kind === 'idle' && choiceReason !== 'low_hp_waiting_regen');
    const failureTrigger = this._consecutiveFailures >= 2;
    const socialTrigger = Boolean(top && top.kind === 'idle') &&
      now - this._lastInteractionAt >= this.config.socialIntervalMs;
    const reason = options.reason ||
      (failureTrigger ? 'task_failed_twice' : null) ||
      (idleTrigger ? 'idle_no_local_work' : null) ||
      (socialTrigger ? 'social_interval' : null);
    if (!reason) return false;
    return this.request(ctx, reason);
  }

  request(ctx = this.getContext(), reason = 'manual') {
    if (!ctx || !this.config.enabled) return false;
    this.tick(ctx);
    if (this.state !== MIND_STATE.IDLE) return false;
    if (!this._linkConnected()) return false;
    const now = this._now(ctx);
    this._pruneAskTimes(now);
    if (this.askTimes.length >= Math.max(1, Math.trunc(this.config.maxAsksPerHour))) {
      this._record('mind_rate_limited', {
        asks: this.askTimes.length,
        limit: this.config.maxAsksPerHour,
      });
      return false;
    }

    const situation = this.buildSituation(ctx);
    this._lastSituation = situation;
    this.lastQuestion = { situation, reason, ts: now };
    this.state = MIND_STATE.ASKING;
    this.askedAt = now;
    this._askReason = reason;
    this.askTimes.push(now);
    this._askPromise = new Promise((resolve) => {
      this._askResolve = resolve;
    });
    this._record('mind_asking', { reason, situation });

    let sent = false;
    try {
      sent = this.link && typeof this.link.sendEvent === 'function'
        ? this.link.sendEvent({ kind: 'intent', data: situation }) !== false
        : false;
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      sent = false;
    }
    if (!sent) {
      this.lastError = 'intent_send_failed';
      this._finishAsk(null);
      this._enterCooldown(now);
      this._record('mind_send_failed', { reason });
      return false;
    }
    return true;
  }

  async ask(situation) {
    if (!this.link || typeof this.link.sendEvent !== 'function') return null;
    this.lastQuestion = { situation, reason: 'direct', ts: this.now() };
    this.state = MIND_STATE.ASKING;
    this.askedAt = this.now();
    this._askReason = 'direct';
    this._askPromise = new Promise((resolve) => {
      this._askResolve = resolve;
    });
    this.link.sendEvent({ kind: 'intent', data: situation });
    return this._askPromise;
  }

  onReply(do_, args = {}, ctx = this.getContext()) {
    if (!ctx) return { ok: false, error: 'body_unavailable' };
    if (ctx.shadow) return { ok: false, error: 'shadow_mode' };
    const now = this._now(ctx);
    const checked = this.validate(do_, args, ctx);
    if (!checked.ok) {
      this.lastError = checked.error;
      this._record('mind_reply_rejected', {
        do: String(do_ || ''),
        error: checked.error,
        alternatives: checked.alternatives || [],
      });
      this._finishAsk(null);
      this._enterCooldown(now);
      return checked;
    }

    const task = checked.task;
    const top = ctx.agenda ? ctx.agenda.top() : null;
    if (top && top.kind !== 'idle' && task.priority <= top.priority) {
      this._finishAsk(null);
      this._enterCooldown(now);
      return {
        ok: false,
        error: 'busy',
        doing: { kind: top.kind, priority: top.priority },
        alternatives: this._alternatives(ctx),
      };
    }

    task.source = 'mind';
    const leaseMs = task.constructor && task.constructor.selfTimed
      ? null
      : (this.brain && this.brain.config && this.brain.config.local
        ? this.brain.config.local.localLeaseMs
        : null);
    ctx.agenda.push(task, { now, leaseMs });
    this.state = MIND_STATE.PENDING;
    this.askedAt = null;
    this.lastAnswer = {
      do: task.kind,
      args: { ...task.args },
      taskId: task.id,
      ts: now,
    };
    this._lastInteractionAt = now;
    this._finishAsk({ do: task.kind, args: { ...task.args }, say: null });
    this._record('mind_reply', {
      do: task.kind,
      args: task.args,
      taskId: task.id,
      source: task.source,
    });
    return {
      ok: true,
      started: true,
      do: task.kind,
      taskId: task.id,
      eta: checked.etaSec == null ? null : checked.etaSec,
    };
  }

  validate(do_, args = {}, ctx = this.getContext()) {
    if (!ctx) return { ok: false, error: 'body_unavailable' };
    const kind = String(do_ || '').trim();
    if (!kind) return { ok: false, error: 'invalid_args', alternatives: this._alternatives(ctx) };
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'invalid_args', alternatives: this._alternatives(ctx) };
    }
    const TaskClass = this.tasks && typeof this.tasks.get === 'function' ? this.tasks.get(kind) : null;
    if (!TaskClass) {
      return {
        ok: false,
        error: 'unknown_do',
        alternatives: this._alternatives(ctx),
      };
    }

    let task = null;
    try {
      task = this.tasks.create(kind, args, { source: 'mind', priority: TaskClass.priority });
    } catch (_) {
      return { ok: false, error: 'invalid_args', alternatives: this._alternatives(ctx) };
    }
    if (!task) return { ok: false, error: 'unknown_do', alternatives: this._alternatives(ctx) };

    let spec = null;
    try {
      spec = TaskClass.feasible({ ...ctx, args: task.args });
    } catch (_) {
      spec = null;
    }
    if (!spec) {
      return { ok: false, error: 'not_feasible', alternatives: this._alternatives(ctx) };
    }

    if (spec.args && typeof spec.args === 'object') {
      try {
        task = this.tasks.create(kind, spec.args, { source: 'mind', priority: TaskClass.priority });
      } catch (_) {
        return { ok: false, error: 'invalid_args', alternatives: this._alternatives(ctx) };
      }
    }
    return {
      ok: true,
      task,
      etaSec: spec.etaSec == null ? null : Number(spec.etaSec),
      note: spec.note || '',
    };
  }

  buildSituation(ctx = this.getContext()) {
    if (!ctx || !ctx.perception) return null;
    const perception = ctx.perception;
    const self = perception.self || {};
    const world = perception.world || {};
    const top = ctx.agenda ? ctx.agenda.top() : null;
    const can = this._available(ctx).slice(0, Math.max(1, Math.trunc(this.config.maxCan)));
    const doing = top ? {
      kind: top.kind,
      state: top.state,
      progress: this._progressOf(top, ctx),
    } : null;
    const situation = {
      hp: self.hp,
      food: self.food,
      pos: compactPosition(self.pos),
      dim: self.dim,
      time: world.isDay === false ? 'night' : 'day',
      ticksToDawn: world.ticksToDawn,
      light: world.light,
      underground: Boolean(world.underground),
      threats: Array.isArray(perception.threats)
        ? perception.threats.slice(0, 4).map((threat) => ({ type: threat.type, dist: threat.dist }))
        : [],
      doing,
      lastResult: this._lastResult,
      project: null,
      can: can.map((entry) => ({
        do: entry.kind,
        args: entry.args,
        note: entry.note,
        eta: entry.etaSec,
      })),
    };

    let serialized = JSON.stringify(situation);
    while (serialized.length > 1400 && situation.can.length > 2) {
      situation.can.pop();
      serialized = JSON.stringify(situation);
    }
    return situation;
  }

  body(ctx = this.getContext()) {
    if (!ctx) return { ok: false, error: 'body_unavailable' };
    const situation = this.buildSituation(ctx);
    return {
      ok: true,
      ...situation,
      state: this.state,
      shadowMode: Boolean(ctx.shadow),
      why: {
        lastChoice: this._lastChoice ? { kind: this._lastChoice.kind, reason: this._lastChoice.reason } : null,
        lastResult: this._lastResult,
        consecutiveFailures: this._consecutiveFailures,
        lastError: this.lastError,
      },
    };
  }

  observeChoice(choice, ctx = this.getContext()) {
    if (!choice) return;
    this._lastChoice = {
      kind: choice.kind,
      reason: choice.reason,
      priority: choice.priority,
    };
  }

  observeAgendaEvent(event, payload = {}) {
    if (event !== 'agenda_settle' && event !== 'agenda_drop') return;
    const task = payload.task || {};
    const kind = String(task.kind || '');
    const outcome = String(payload.outcome || (payload.reason === FAILURE_REASONS.CANCELLED ? 'cancelled' : 'failed'));
    const failure = payload.failure || null;
    this._lastResult = {
      kind,
      outcome,
      reason: failure && failure.reason ? failure.reason : (payload.reason || null),
    };
    if (outcome === 'failed') {
      if (this._failureKind === kind) this._consecutiveFailures += 1;
      else {
        this._failureKind = kind;
        this._consecutiveFailures = 1;
      }
      if (this._consecutiveFailures >= 2 && this._consecutiveFailures % 2 === 0) {
        this._emitTaskFailure(kind, this._lastResult.reason);
      }
    } else {
      this._failureKind = null;
      this._consecutiveFailures = 0;
    }
    this._lastInteractionAt = this.now();
    if (this.state === MIND_STATE.PENDING) this._enterCooldown(this.now());
  }

  requestWake(reason) {
    const ctx = this.getContext();
    if (!ctx) return false;
    return this.request(ctx, String(reason || 'wake'));
  }

  snapshot() {
    return {
      state: this.state,
      askedAt: this.askedAt,
      cooldownUntil: this.cooldownUntil,
      asksLastHour: this.askTimes.length,
      lastChoice: this._lastChoice,
      lastResult: this._lastResult,
      consecutiveFailures: this._consecutiveFailures,
      lastError: this.lastError,
    };
  }

  _available(ctx) {
    try {
      return this.tasks.available(ctx, {}).filter((entry) => entry && entry.kind);
    } catch (_) {
      return [];
    }
  }

  _alternatives(ctx) {
    return this._available(ctx).slice(0, 8).map((entry) => entry.kind);
  }

  _progressOf(task, ctx) {
    if (!task || typeof task.progressMetric !== 'function') return null;
    try {
      const value = Number(task.progressMetric(ctx));
      return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    } catch (_) {
      return null;
    }
  }

  _emitTaskFailure(kind, reason) {
    const ctx = this.getContext();
    const now = this.now();
    if (now - this._lastFailureWakeAt < this.config.taskFailureWakeMinMs) return;
    if (!this._linkConnected()) return;
    this._lastFailureWakeAt = now;
    const data = {
      kind,
      reason,
      failures: this._consecutiveFailures,
      alternatives: ctx ? this._alternatives(ctx) : [],
    };
    try {
      this.link.sendEvent({ kind: 'task_failed', data });
      this._record('mind_task_failed_event', data);
      this._enterCooldown(now);
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
    }
  }

  _finishAsk(value) {
    if (this._askResolve) {
      const resolve = this._askResolve;
      this._askResolve = null;
      this._askPromise = null;
      resolve(value);
    }
  }

  _enterCooldown(now) {
    this.state = MIND_STATE.COOLDOWN;
    this.cooldownUntil = now + Math.max(0, Number(this.config.cooldownMs) || 0);
  }

  _pruneAskTimes(now) {
    while (this.askTimes.length && now - this.askTimes[0] > 3600000) this.askTimes.shift();
  }

  _now(ctx) {
    const value = ctx && ctx.now;
    return Number.isFinite(Number(value)) ? Number(value) : this.now();
  }

  _linkConnected() {
    if (!this.link) return false;
    if (typeof this.link.isConnected === 'function') return Boolean(this.link.isConnected());
    return true;
  }

  _record(event, payload = {}) {
    if (!this.recordSink) return;
    try {
      this.recordSink(event, payload);
    } catch (_) {
      return;
    }
  }
}

function createMind(options = {}) {
  return new Mind(options);
}

module.exports = {
  Mind,
  createMind,
  MIND_STATE,
};
