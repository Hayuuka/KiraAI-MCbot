'use strict';

const skills = require('../skills');
const {
  Task,
  FAILURE_REASONS,
  finiteNumber,
  integerAtLeast,
  positionKey,
} = require('./base');

const FALLBACK = Object.freeze({
  ore: 'iron_ore',
  count: 8,
  searchRadius: 32,
  maxMinutes: 8,
  maxNoTargetTicks: 20,
  maxAttempts: 20,
  badBlockMs: 60000,
  moveTimeoutMs: 10000,
  arriveRange: 2,
  reach: 4.5,
  probeDepth: 4,
});

const DROPS = Object.freeze({
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  nether_quartz_ore: 'quartz',
  nether_gold_ore: 'gold_nugget',
});

function bareName(name) {
  return String(name || '').toLowerCase().split(':').pop();
}

function normalizeOre(value) {
  const bare = bareName(String(value || '').trim());
  if (!bare) return FALLBACK.ore;
  if (bare === 'iron') return 'iron_ore';
  if (bare === 'gold') return 'gold_ore';
  if (bare === 'diamond') return 'diamond_ore';
  if (bare === 'coal') return 'coal_ore';
  if (bare === 'copper') return 'copper_ore';
  return bare;
}

function mergeArguments(args = {}, config = null) {
  const values = config || {};
  const ore = normalizeOre(args.ore || values.ore || FALLBACK.ore);
  return {
    ore,
    count: integerAtLeast(args.count, finiteNumber(values.count, FALLBACK.count), 1),
    searchRadius: integerAtLeast(
      args.searchRadius,
      finiteNumber(values.searchRadius, FALLBACK.searchRadius),
      4
    ),
    maxMinutes: Math.max(0.1, finiteNumber(args.maxMinutes, finiteNumber(values.maxMinutes, FALLBACK.maxMinutes))),
  };
}

class MineOreTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.baseline = null;
    this.badUntil = new Map();
    this.noTargetTicks = 0;
    this.attempts = 0;
  }

  static normalizeArgs(args = {}) {
    return mergeArguments(args, null);
  }

  static feasible(ctx = {}) {
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.mineOre;
    const args = mergeArguments((ctx.args && typeof ctx.args === 'object' ? ctx.args : {}), config);
    const bot = ctx.bot;
    if (!bot || !bot.entity || !bot.entity.position) return null;
    const target = findTarget(bot, args.ore, args.searchRadius, new Map());
    if (!target) return null;
    const tool = skills.inventory.bestToolForBlock(bot, target);
    if (tool.requirement.required && !tool.best) return null;
    const distance = skills.move.positionDistance(bot.entity.position, target.position);
    return {
      args,
      etaSec: Math.max(60, args.count * 45),
      note: `附近有 ${target.name}，挖 ${args.count} 个`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.mineOre) || {};
    this.settings = {
      maxNoTargetTicks: Math.max(
        1,
        Math.trunc(finiteNumber(config.maxNoTargetTicks, FALLBACK.maxNoTargetTicks))
      ),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      badBlockMs: Math.max(1000, finiteNumber(config.badBlockMs, FALLBACK.badBlockMs)),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      arriveRange: Math.max(0, finiteNumber(config.arriveRange, FALLBACK.arriveRange)),
      reach: Math.max(1, finiteNumber(config.reach, FALLBACK.reach)),
      probeDepth: Math.max(1, Math.trunc(finiteNumber(config.probeDepth, FALLBACK.probeDepth))),
    };
    this.baseline = skills.inventory.count(ctx.bot, dropFor(this.args.ore));
    if (ctx.shadow) return true;
    return Promise.resolve(skills.inventory.equipBestTool(ctx.bot, this.args.ore))
      .then((ready) => {
        if (ready === false) {
          this.fail(FAILURE_REASONS.TOOL_UNAVAILABLE);
          return false;
        }
        return true;
      });
  }

  progressMetric(ctx) {
    if (this.baseline === null) return 0;
    return Math.max(0, skills.inventory.count(ctx.bot, dropFor(this.args.ore)) - this.baseline);
  }

  isDone(ctx) {
    return this.progressMetric(ctx) >= this.args.count;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.args.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.noTargetTicks >= this.settings.maxNoTargetTicks) {
      return { reason: FAILURE_REASONS.NO_TARGET };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.MINE_FAILED };
    }
    return null;
  }

  _tick(ctx) {
    if (this.pending) return;
    const target = this._findTarget(ctx);
    if (!target) {
      this.noTargetTicks += 1;
      if (ctx.shadow) this.markShadowPlan(ctx, { ore: this.args.ore, target: null });
      return;
    }
    this.noTargetTicks = 0;

    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        ore: this.args.ore,
        target: [target.position.x, target.position.y, target.position.z],
        count: this.args.count,
      });
      return;
    }

    const currentY = Number(ctx.bot.entity.position.y);
    const drop = currentY - Number(target.position.y);
    if (drop >= 5 && this._delegateDigDown(ctx, Math.ceil(drop))) return;

    const distance = skills.move.positionDistance(ctx.bot.entity.position, target.position);
    if (distance > this.settings.reach) {
      this.runPending('mineOreMove', async () => {
        const torch = await skills.mining.placeTorchIfDark(ctx.bot, {
          position: ctx.bot.entity.position,
        });
        if (torch && torch.placed) {
          this._emit(ctx, 'task_torch_placed', { position: torch.position || null });
        }
        const moved = await skills.move.moveTo(
          ctx.bot,
          { x: target.position.x, y: target.position.y, z: target.position.z },
          {
            range: this.settings.arriveRange,
            timeoutMs: this.settings.moveTimeoutMs,
            canDig: true,
          }
        );
        return { moved, torch };
      }, { block: target });
      return;
    }

    this.runPending('mineOre', () => skills.mining.digBlockSafely(ctx.bot, target, {
      probeDepth: this.settings.probeDepth,
      allowFall: false,
    }), { block: target });
  }

  onPendingSuccess(ctx, result, label, meta) {
    if (label === 'mineOreMove') {
      if (!result || !result.moved || result.moved.ok === false) {
        this._markBad(meta.block, ctx);
        this.attempts += 1;
        this._emit(ctx, 'task_action_failed', {
          label,
          code: 'mine_ore_move_failed',
          error: result && result.moved && result.moved.error,
        });
      }
      return;
    }
    if (label !== 'mineOre') return;
    if (!result || result.ok === false) {
      this._markBad(meta.block, ctx);
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        code: result && result.code ? result.code : 'mine_ore_failed',
        hazard: result && result.hazard ? result.hazard : null,
      });
    }
  }

  onPendingError(ctx, error, label, meta) {
    if (label !== 'mineOreMove' && label !== 'mineOre') return;
    this._markBad(meta.block, ctx);
    this.attempts += 1;
    this._emit(ctx, 'task_action_failed', {
      label,
      code: 'exception',
      message: error && error.message ? error.message : String(error),
    });
  }

  _findTarget(ctx) {
    return findTarget(ctx.bot, this.args.ore, this.args.searchRadius, this.badUntil, ctx.now);
  }

  _markBad(block, ctx) {
    if (!block || !block.position) return;
    const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
    this.badUntil.set(positionKey(block.position), now + this.settings.badBlockMs);
  }

  _delegateDigDown(ctx, requiredDepth) {
    if (!ctx.agenda || typeof ctx.agenda.list !== 'function' || !ctx.tasks) return false;
    const existing = ctx.agenda.list().some((task) => task !== this && task.kind === 'digDown' && !task.isTerminal);
    if (existing) return true;

    const TaskClass = typeof ctx.tasks.get === 'function' ? ctx.tasks.get('digDown') : null;
    if (!TaskClass) return false;
    const depth = Math.max(5, Math.min(32, requiredDepth));
    let spec = null;
    try {
      spec = TaskClass.feasible({ ...ctx, args: { depth } });
    } catch (_) {
      spec = null;
    }
    if (!spec) return false;
    const task = ctx.tasks.create('digDown', spec.args || { depth }, {
      source: this.source,
      priority: 45,
    });
    if (!task) return false;
    ctx.agenda.push(task, { now: ctx.now, leaseMs: null });
    this._emit(ctx, 'task_delegated', { to: 'digDown', depth });
    return true;
  }
}

function dropFor(ore) {
  const name = bareName(ore);
  return DROPS[name] || name;
}

function targetNames(ore) {
  const name = bareName(ore);
  if (name === 'iron_ore') return new Set(['iron_ore', 'deepslate_iron_ore']);
  if (name === 'gold_ore') return new Set(['gold_ore', 'deepslate_gold_ore']);
  if (name === 'coal_ore') return new Set(['coal_ore', 'deepslate_coal_ore']);
  if (name === 'copper_ore') return new Set(['copper_ore', 'deepslate_copper_ore']);
  if (name === 'redstone_ore') return new Set(['redstone_ore', 'deepslate_redstone_ore']);
  if (name === 'lapis_ore') return new Set(['lapis_ore', 'deepslate_lapis_ore']);
  if (name === 'diamond_ore') return new Set(['diamond_ore', 'deepslate_diamond_ore']);
  if (name === 'emerald_ore') return new Set(['emerald_ore', 'deepslate_emerald_ore']);
  return new Set([name]);
}

function findTarget(bot, ore, radius, badUntil, nowValue) {
  if (!bot || typeof bot.findBlock !== 'function') return null;
  const names = targetNames(ore);
  const now = Number.isFinite(Number(nowValue)) ? Number(nowValue) : Date.now();
  try {
    return bot.findBlock({
      maxDistance: radius,
      matching: (block) => {
        if (!block || !block.position || !names.has(bareName(block.name))) return false;
        const until = badUntil instanceof Map ? badUntil.get(positionKey(block.position)) || 0 : 0;
        return until <= now;
      },
    });
  } catch (_) {
    return null;
  }
}

MineOreTask.kind = 'mineOre';
MineOreTask.priority = 45;
MineOreTask.selfTimed = true;
MineOreTask.schema = {
  type: 'object',
  properties: {
    ore: { type: 'string' },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    searchRadius: { type: 'integer', minimum: 4, maximum: 64 },
    maxMinutes: { type: 'number' },
  },
};

module.exports = { MineOreTask, normalizeOre, dropFor };
