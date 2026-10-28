'use strict';

const inventorySkill = require('../skills/inventory');
const moveSkill = require('../skills/move');

const PICKAXES = Object.freeze([
  'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
]);

const DRIVE_TASKS = Object.freeze({
  night: [{ kind: 'sleep', priority: 60 }],
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
    const idle = (reason, note = '') => ({
      kind: 'idle',
      args: idleArgs,
      priority: local.idlePriority,
      reason,
      note,
    });

    const hp = perception.self.hp;
    if (hp != null && hp < local.minHpToWork) {
      return idle('low_hp_waiting_regen', `等待回血（food=${perception.self.food}）`);
    }
    const threat = perception.threats.find((entry) => entry.dist <= local.dangerRadius);
    if (threat) {
      if (threat.canWin === false) {
        return { kind: 'flee', args: {}, priority: 70, reason: 'threat_too_strong' };
      }
      const FightTask = this.tasks && this.tasks.get ? this.tasks.get('fight') : null;
      const spec = FightTask
        ? FightTask.feasible({
          ...ctx,
          args: { targetId: threat.id, type: threat.type },
        })
        : null;
      if (spec) {
        return {
          kind: 'fight',
          args: spec.args || { targetId: threat.id, type: threat.type },
          priority: 50,
          reason: 'engage_threat',
        };
      }
      return { kind: 'flee', args: {}, priority: 70, reason: 'threat_too_strong' };
    }
    if (perception.world.isDay === false && !perception.world.underground && !local.workAtNight) {
      const night = this._chooseNight(ctx);
      if (night) return night;
      return idle('night_no_option:sleep=no_bed');
    }

    const canWork = perception.world.isDay !== false ||
      perception.world.underground === true ||
      local.workAtNight === true;
    const hasStonePick = PICKAXES.some((name) => inventorySkill.count(ctx.bot, name) > 0);
    const stone = canWork
      ? moveSkill.findNearestBlock(ctx.bot, '#minecraft:stone', local.miningSearchRadius || 32)
      : null;

    if (canWork && !hasStonePick && stone) {
      const CollectTask = this.tasks && this.tasks.get ? this.tasks.get('collectBlock') : null;
      const spec = CollectTask
        ? CollectTask.feasible({
          ...ctx,
          args: { selector: '#minecraft:stone', count: 3, radius: local.miningSearchRadius || 32 },
        })
        : null;
      if (spec) {
        return {
          kind: 'collectBlock',
          args: spec.args,
          priority: local.collectPriority,
          reason: 'stone_tool_upgrade',
          note: spec.note || '收集石头制作石镐',
        };
      }
    }

    const y = Number(perception.self.pos && perception.self.pos.y);
    if (
      canWork &&
      hasStonePick &&
      inventorySkill.count(ctx.bot, 'iron_ingot') <= 0 &&
      y >= 60
    ) {
      const MineOreTask = this.tasks && this.tasks.get ? this.tasks.get('mineOre') : null;
      const spec = MineOreTask
        ? MineOreTask.feasible({ ...ctx, args: { ore: 'iron_ore' } })
        : null;
      if (spec) {
        return {
          kind: 'mineOre',
          args: spec.args,
          priority: local.miningPriority || 45,
          reason: 'iron_supply',
          note: spec.note || '挖铁矿',
        };
      }
    }

    const freeSlots = Number(perception.inventory && perception.inventory.freeSlots);
    if (
      canWork &&
      perception.world.isDay === true &&
      perception.world.underground !== true &&
      Number.isFinite(freeSlots) &&
      freeSlots >= 30
    ) {
      const DigDownTask = this.tasks && this.tasks.get ? this.tasks.get('digDown') : null;
      const spec = DigDownTask
        ? DigDownTask.feasible({ ...ctx, args: { depth: 10 } })
        : null;
      if (spec) {
        return {
          kind: 'digDown',
          args: spec.args,
          priority: local.miningPriority || 45,
          reason: 'surface_mining',
          note: spec.note || '阶梯式向下探索',
        };
      }
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

  _chooseNight(ctx) {
    const options = [{ kind: 'sleep', priority: 60 }];
    for (const option of options) {
      const TaskClass = this.tasks && this.tasks.get ? this.tasks.get(option.kind) : null;
      if (!TaskClass) continue;
      let spec = null;
      try {
        spec = TaskClass.feasible({ ...ctx, args: {} });
      } catch (_) {
        spec = null;
      }
      if (!spec) continue;
      return {
        kind: option.kind,
        args: spec.args || {},
        priority: option.priority,
        reason: 'night_' + option.kind,
        note: spec.note || '',
      };
    }
    return null;
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
