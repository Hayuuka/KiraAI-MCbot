'use strict';

/**
 * 反射控制器只负责：判断哪个反射成立、执行反射动作。
 * 任务冻结/恢复由 Brain 调 Agenda 完成，反射本身不碰任务状态。
 */
class InterruptController {
  constructor(options = {}) {
    this.log = options.log || console;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this._definitions = [];
  }

  register(definition) {
    if (!definition || typeof definition.condition !== 'function') return null;
    const entry = {
      kind: String(definition.kind || 'interrupt'),
      priority: Number(definition.priority) || 0,
      condition: definition.condition,
      run: typeof definition.run === 'function' ? definition.run : null,
      order: this._definitions.length,
    };
    this._definitions.push(entry);
    this._definitions.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return () => {
      const index = this._definitions.indexOf(entry);
      if (index >= 0) this._definitions.splice(index, 1);
    };
  }

  evaluate(perception, ctx) {
    for (const entry of this._definitions) {
      let active = false;
      try {
        active = Boolean(entry.condition(perception, ctx));
      } catch (error) {
        this._emit('interrupt_condition_error', {
          kind: entry.kind,
          error: error && error.message ? error.message : String(error),
        });
        active = false;
      }
      if (active) return entry;
    }
    return null;
  }

  run(active, ctx) {
    if (!active || typeof active.run !== 'function') return null;
    try {
      const result = active.run(ctx);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this._emit('interrupt_run_error', {
          kind: active.kind,
          error: error && error.message ? error.message : String(error),
        }));
      }
      return result;
    } catch (error) {
      this._emit('interrupt_run_error', {
        kind: active.kind,
        error: error && error.message ? error.message : String(error),
      });
      return null;
    }
  }

  snapshot() {
    return this._definitions.map((entry) => ({
      kind: entry.kind,
      priority: entry.priority,
    }));
  }

  _emit(event, payload) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event, payload);
    } catch (_) {
      // 观测失败不影响反射。
    }
  }
}

function createInterrupts(options = {}) {
  return new InterruptController(options);
}

module.exports = {
  InterruptController,
  createInterrupts,
};
