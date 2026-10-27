'use strict';

const DRIVE_TASKS = Object.freeze({
  night: [
    { kind: 'sleep', priority: 60 },
    { kind: 'shelter', priority: 59 },
  ],
  health: [{ kind: 'heal', priority: 58 }],
  hunger: [{ kind: 'eat', priority: 55 }],
});

class Arbiter {
  constructor(options = {}) {
    this.config = options.config || {};
    this.tasks = options.tasks || null;
    this.drives = options.drives || null;
    this._reportedUnavailable = new Set();
  }

  step(ctx) {
    if (!ctx) return null;
    const driveChoice = this._chooseDrive(ctx);
    if (driveChoice) return driveChoice;
    if (ctx.agenda && ctx.agenda.top()) return null;
    return this._chooseLocal(ctx);
  }

  _chooseDrive(ctx) {
    if (!this.drives || typeof this.drives.urgent !== 'function') return null;
    const urgent = this.drives.urgent();
    for (const drive of urgent) {
      const mappings = DRIVE_TASKS[drive] || [];
      for (const mapping of mappings) {
        const TaskClass = this.tasks && this.tasks.get ? this.tasks.get(mapping.kind) : null;
        if (!TaskClass) {
          this._reportUnavailable(ctx, drive, mapping.kind);
          continue;
        }

        let spec = null;
        try {
          spec = TaskClass.feasible({ ...ctx, args: {} });
        } catch (_) {
          spec = null;
        }
        if (!spec) {
          this._reportUnavailable(ctx, drive, mapping.kind);
          continue;
        }
        return {
          kind: mapping.kind,
          args: spec.args || {},
          priority: mapping.priority,
          reason: 'drive_' + drive,
          note: spec.note || '',
        };
      }
    }
    return null;
  }

  _chooseLocal(ctx) {
    const local = this.config.local || {};
    const perception = ctx.perception;
    const idleArgs = { durationMs: this.config.tasks.idle.durationMs };
    const idle = (reason) => ({
      kind: 'idle',
      args: idleArgs,
      priority: local.idlePriority,
      reason,
    });

    const hp = perception.self.hp;
    if (hp != null && hp < local.minHpToWork) return idle('low_hp');
    const dangerous = perception.threats.find((threat) => threat.dist <= local.dangerRadius);
    if (dangerous) return idle('threat_nearby');
    if (perception.world.isDay === false && !perception.world.underground && !local.workAtNight) {
      return idle('night_without_stage1_shelter');
    }

    const candidates = this.tasks.available(ctx, this._taskDefaults());
    const collect = candidates.find((candidate) => candidate.kind === 'collectBlock');
    if (collect) {
      return {
        kind: collect.kind,
        args: collect.args,
        priority: local.collectPriority,
        reason: 'nearby_resource',
        note: collect.note,
      };
    }

    const stroll = this._strollTarget(perception);
    const GotoTask = this.tasks && this.tasks.get ? this.tasks.get('goto') : null;
    const goto = stroll && GotoTask ? GotoTask.feasible({ ...ctx, args: stroll }) : null;
    if (goto) {
      return {
        kind: 'goto',
        args: goto.args,
        priority: local.strollPriority,
        reason: 'daytime_stroll',
        note: goto.note,
      };
    }
    return idle('no_local_work');
  }

  _taskDefaults() {
    const tasks = this.config.tasks;
    return {
      idle: { durationMs: tasks.idle.durationMs },
      collectBlock: {
        selector: tasks.collectBlock.selector,
        count: tasks.collectBlock.count,
        radius: tasks.collectBlock.radius,
        maxMinutes: tasks.collectBlock.maxMinutes,
      },
    };
  }

  _strollTarget(perception) {
    const position = perception && perception.self && perception.self.pos;
    if (!position) return null;
    const local = this.config.local || {};
    const min = Math.max(1, Number(local.strollMinRadius) || 4);
    const max = Math.max(min, Number(local.strollMaxRadius) || 12);
    const distance = min + Math.random() * (max - min);
    const angle = Math.random() * Math.PI * 2;
    return {
      x: Math.round(position.x + Math.cos(angle) * distance),
      y: null,
      z: Math.round(position.z + Math.sin(angle) * distance),
    };
  }

  _reportUnavailable(ctx, drive, kind) {
    const key = drive + ':' + kind;
    if (this._reportedUnavailable.has(key)) return;
    this._reportedUnavailable.add(key);
    if (ctx && typeof ctx.record === 'function') {
      ctx.record('drive_task_unavailable', { drive, kind });
    }
  }
}

function createArbiter(options = {}) {
  return new Arbiter(options);
}

module.exports = {
  Arbiter,
  createArbiter,
  DRIVE_TASKS,
};
