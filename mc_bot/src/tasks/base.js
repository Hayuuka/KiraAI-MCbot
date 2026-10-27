'use strict';

const TASK_STATE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  FROZEN: 'frozen',
  DONE: 'done',
  FAILED: 'failed',
});

const FAILURE_REASONS = Object.freeze({
  INVALID_ARGS: 'invalid_args',
  PREPARE_FAILED: 'prepare_failed',
  TOOL_UNAVAILABLE: 'tool_unavailable',
  NO_TARGET: 'no_target',
  PATH_UNREACHABLE: 'path_unreachable',
  MINE_FAILED: 'mine_failed',
  NO_FOOD: 'no_food',
  CONSUME_FAILED: 'consume_failed',
  NO_BED: 'no_bed',
  SLEEP_REJECTED: 'sleep_rejected',
  NO_SHELTER_MATERIAL: 'no_shelter_material',
  NO_SAFE_SPOT: 'no_safe_spot',
  PLACE_FAILED: 'place_failed',
  THREAT_TOO_HIGH: 'threat_too_high',
  PLAYER_UNAVAILABLE: 'player_unavailable',
  CONTROL_FAILED: 'control_failed',
  DIG_FAILED: 'dig_failed',
  NO_SOLID_GROUND: 'no_solid_ground',
  TIMEOUT: 'timeout',
  LEASE_EXPIRED: 'lease_expired',
  CANCELLED: 'cancelled',
  SILENT_TIMEOUT: 'silent_timeout',
  NO_PROGRESS: 'no_progress',
  STACK_OVERFLOW: 'stack_overflow',
  INTERNAL_ERROR: 'internal_error',
});

const FAILURE_REASON_VALUES = new Set(Object.values(FAILURE_REASONS));
const PREPARE_PENDING = '__prepare__';
let nextTaskId = 1;

function nowOf(ctx) {
  const now = Number(ctx && ctx.now);
  return Number.isFinite(now) ? now : Date.now();
}

function isPromiseLike(value) {
  return Boolean(value && typeof value.then === 'function');
}

function errorMessage(error) {
  if (!error) return null;
  return error.message || String(error);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerAtLeast(value, fallback, minimum) {
  return Math.max(minimum, Math.trunc(finiteNumber(value, fallback)));
}

function positionKey(position) {
  if (!position) return '';
  return Math.floor(Number(position.x)) + ',' +
    Math.floor(Number(position.y)) + ',' +
    Math.floor(Number(position.z));
}

class Task {
  constructor(args = {}, meta = {}) {
    const TaskClass = this.constructor;
    const input = args && typeof args === 'object' ? args : {};
    this.kind = TaskClass.kind || 'task';
    this.args = typeof TaskClass.normalizeArgs === 'function'
      ? TaskClass.normalizeArgs(input)
      : { ...input };
    this.id = meta.id || (this.kind + '-' + nextTaskId++);
    this.source = String(meta.source || 'local');
    this.priority = finiteNumber(meta.priority, finiteNumber(TaskClass.priority, 0));
    this.createdAt = finiteNumber(meta.createdAt, Date.now());
    this.startedAt = null;
    this.finishedAt = null;
    this.leaseExpiresAt = null;
    this.state = TASK_STATE.PENDING;
    this.failure = null;
    this.result = null;
    this.pending = null;
    this._prepareStarted = false;
    this._prepared = false;
    this._preFreezeState = null;
    this._prePauseState = null;
    this._frozenAt = null;
    this._lastProgressAt = null;
    this._lastProgressMetric = null;
    this._shadowPlannedAt = null;
  }

  get isTerminal() {
    return this.state === TASK_STATE.DONE || this.state === TASK_STATE.FAILED;
  }

  get isFrozen() {
    return this.state === TASK_STATE.FROZEN;
  }

  get isPaused() {
    return this.state === TASK_STATE.PAUSED;
  }

  static feasible() {
    return null;
  }

  /**
   * 子类只做"准备动作"（校验参数、记录背包基线、换工具）。
   * 返回 false 表示准备失败；异步工作一律返回 Promise，由 Task.tick 轮询。
   */
  prepare() {
    return true;
  }

  progressMetric() {
    return 0;
  }

  isDone() {
    return false;
  }

  isFailed() {
    return null;
  }

  // 任务主动选择静默时返回 true，看门狗会跳过它。
  expectsQuiet() {
    return false;
  }

  onPendingSuccess() {}

  onPendingError(ctx, error) {
    this.fail(FAILURE_REASONS.INTERNAL_ERROR, { error });
  }

  onFinish() {}

  onResume(ctx) {
    this._lastProgressAt = nowOf(ctx);
  }

  freeze(ctx) {
    if (this.isTerminal || this.isFrozen) return false;
    this._frozenAt = nowOf(ctx);
    this._preFreezeState = this.state;
    this.state = TASK_STATE.FROZEN;
    return true;
  }

  pause() {
    if (this.isTerminal || this.isFrozen || this.isPaused) return false;
    this._prePauseState = this.state;
    this.state = TASK_STATE.PAUSED;
    return true;
  }

  resume() {
    if (!this.isPaused) return false;
    this.state = this._prePauseState || TASK_STATE.RUNNING;
    this._prePauseState = null;
    return true;
  }

  thaw(ctx) {
    if (!this.isFrozen) return false;
    if (this._frozenAt != null) {
      const delta = nowOf(ctx) - this._frozenAt;
      if (this.startedAt != null) this.startedAt += delta;
      if (this._lastProgressAt != null) this._lastProgressAt += delta;
      this._frozenAt = null;
    }
    this.state = this._preFreezeState || TASK_STATE.RUNNING;
    this._preFreezeState = null;
    return true;
  }

  tick(ctx) {
    if (!ctx || !ctx.bot) {
      this.fail(FAILURE_REASONS.INTERNAL_ERROR, { message: 'task context has no bot' });
      return;
    }
    if (this.isTerminal || this.isFrozen || this.isPaused) return;

    const now = nowOf(ctx);
    if (!this._prepareStarted) {
      this._prepareStarted = true;
      this.startedAt = now;
      this._lastProgressAt = now;
      this.state = TASK_STATE.RUNNING;

      let prepared;
      try {
        prepared = this.prepare(ctx);
      } catch (error) {
        this.fail(FAILURE_REASONS.PREPARE_FAILED, { error, ctx });
        return;
      }

      if (isPromiseLike(prepared)) {
        this._setPending(PREPARE_PENDING, prepared);
        return;
      }
      if (prepared === false) {
        this.fail(FAILURE_REASONS.PREPARE_FAILED);
        return;
      }
      this._prepared = true;
    }

    if (this.pending) {
      if (!this.pending.settled) return;
      this._drainPending(ctx);
      if (this.isTerminal || this.isFrozen) return;
    }

    if (!this._prepared) return;

    this._updateProgress(ctx);
    let done = false;
    try {
      done = Boolean(this.isDone(ctx));
    } catch (error) {
      this.fail(FAILURE_REASONS.INTERNAL_ERROR, { error, ctx });
      return;
    }
    if (done) {
      this.succeed({ ctx });
      return;
    }

    let failure = null;
    try {
      failure = this.isFailed(ctx);
    } catch (error) {
      this.fail(FAILURE_REASONS.INTERNAL_ERROR, { error, ctx });
      return;
    }
    if (failure) {
      this.fail(failure.reason, { ...failure, ctx });
      return;
    }

    // 本轮刚处理完一个异步动作，下一 tick 再做下一步，避免同一 tick 连发动作。
    if (this.pending === null && this._drainedThisTick) {
      this._drainedThisTick = false;
      return;
    }
    this._drainedThisTick = false;

    try {
      this._tick(ctx);
    } catch (error) {
      this.fail(FAILURE_REASONS.INTERNAL_ERROR, { error, ctx });
    }
  }

  _tick() {}

  _setPending(label, promise, meta = {}) {
    if (this.pending) return false;
    const entry = {
      label,
      settled: false,
      value: undefined,
      error: null,
      meta,
    };
    this.pending = entry;
    Promise.resolve(promise).then(
      (value) => {
        entry.settled = true;
        entry.value = value;
      },
      (error) => {
        entry.settled = true;
        entry.error = error || new Error('async task failed');
      }
    );
    return true;
  }

  runPending(label, factory, meta = {}) {
    if (this.pending || this.isTerminal || this.isFrozen) return false;
    let promise;
    try {
      promise = factory();
    } catch (error) {
      this.onPendingError(null, error, label, meta);
      return false;
    }
    return this._setPending(label, promise, meta);
  }

  _drainPending(ctx) {
    const entry = this.pending;
    if (!entry || !entry.settled) return false;
    this.pending = null;
    this._drainedThisTick = true;

    if (entry.label === PREPARE_PENDING) {
      if (entry.error) {
        this.fail(FAILURE_REASONS.PREPARE_FAILED, { error: entry.error, ctx });
      } else if (entry.value === false) {
        this.fail(FAILURE_REASONS.PREPARE_FAILED, { ctx });
      } else {
        this._prepared = true;
      }
      return true;
    }

    if (entry.error) this.onPendingError(ctx, entry.error, entry.label, entry.meta || {});
    else this.onPendingSuccess(ctx, entry.value, entry.label, entry.meta || {});
    return true;
  }

  _updateProgress(ctx) {
    let metric;
    try {
      metric = Number(this.progressMetric(ctx));
    } catch (_) {
      return;
    }
    if (!Number.isFinite(metric)) return;
    if (this._lastProgressMetric === null || Math.abs(metric - this._lastProgressMetric) >= 0.001) {
      this._lastProgressMetric = metric;
      this._lastProgressAt = nowOf(ctx);
    }
  }

  elapsedSec(ctx) {
    if (this.startedAt == null) return 0;
    return Math.max(0, (nowOf(ctx) - this.startedAt) / 1000);
  }

  progressStaleSec(ctx) {
    if (this._lastProgressAt == null) return 0;
    return Math.max(0, (nowOf(ctx) - this._lastProgressAt) / 1000);
  }

  markShadowPlan(ctx, details = {}) {
    if (!ctx || !ctx.shadow || this._shadowPlannedAt !== null) return false;
    this._shadowPlannedAt = nowOf(ctx);
    this._emit(ctx, 'task_shadow_plan', details);
    return true;
  }

  succeed(details = {}) {
    if (this.isTerminal) return false;
    this.state = TASK_STATE.DONE;
    this.finishedAt = nowOf(details.ctx || { now: Date.now() });
    this.result = details.result || null;
    this.pending = null;
    this._preFreezeState = null;
    this._emit(details.ctx, 'task_done', { result: this.result });
    try {
      this.onFinish(details.ctx);
    } catch (_) {
      // 收尾失败不能把已完成任务改回失败。
    }
    return true;
  }

  fail(reason, details = {}) {
    if (this.isTerminal) return false;
    const safeReason = FAILURE_REASON_VALUES.has(reason) ? reason : FAILURE_REASONS.INTERNAL_ERROR;
    this.state = TASK_STATE.FAILED;
    this.finishedAt = nowOf(details.ctx || { now: Date.now() });
    this.failure = {
      reason: safeReason,
      message: details.message || errorMessage(details.error) || null,
    };
    this.pending = null;
    this._preFreezeState = null;
    this._emit(details.ctx, 'task_failed', { failure: { ...this.failure } });
    try {
      this.onFinish(details.ctx);
    } catch (_) {
      // 收尾失败不覆盖原始失败原因。
    }
    return true;
  }

  _emit(ctx, event, payload = {}) {
    if (!ctx || typeof ctx.record !== 'function') return;
    try {
      ctx.record(event, {
        task: {
          id: this.id,
          kind: this.kind,
          source: this.source,
          priority: this.priority,
        },
        ...payload,
      });
    } catch (_) {
      // 日志失败不能反向影响任务。
    }
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      args: { ...this.args },
      source: this.source,
      priority: this.priority,
      state: this.state,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      leaseExpiresAt: this.leaseExpiresAt,
      failure: this.failure ? { ...this.failure } : null,
    };
  }
}

Task.selfTimed = false;

module.exports = {
  Task,
  TASK_STATE,
  FAILURE_REASONS,
  FAILURE_REASON_VALUES,
  finiteNumber,
  integerAtLeast,
  positionKey,
  nowOf,
};
