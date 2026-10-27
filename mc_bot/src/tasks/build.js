'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  blueprint: '3x3x3',
  material: null,
  maxMinutes: 10,
  maxAttempts: 3,
  reach: 4.5,
  moveTimeoutMs: 8000,
});

function coordinate(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function pointOf(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return { x: coordinate(value[0], 0), y: coordinate(value[1], 64), z: coordinate(value[2], 0) };
  }
  if (value && typeof value === 'object') {
    return {
      x: coordinate(value.x, 0),
      y: coordinate(value.y, 64),
      z: coordinate(value.z, 0),
    };
  }
  return null;
}

function bareName(name) {
  return String(name || '').trim().toLowerCase().split(':').pop();
}

class BuildTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.targets = [];
    this.material = null;
    this.attempts = 0;
  }

  static normalizeArgs(args = {}) {
    return {
      blueprint: String(args.blueprint || FALLBACK.blueprint),
      at: pointOf(args.at) || pointOf(args.position) || pointOf(args),
      material: args.material ? bareName(args.material) : null,
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    if (!bot || !bot.entity || !bot.entity.position) return null;
    const args = BuildTask.normalizeArgs(ctx.args && typeof ctx.args === 'object' ? ctx.args : {});
    if (!args.at || String(args.blueprint || FALLBACK.blueprint) !== '3x3x3') return null;
    const material = args.material || skills.place.findBuildingBlock(bot, 26);
    if (!material) return null;
    const name = typeof material === 'string' ? material : material.name;
    if (skills.inventory.count(bot, name) < 26) return null;
    return {
      args: { ...args, material: name },
      etaSec: 180,
      note: `用 ${name} 在 ${args.at.x},${args.at.y},${args.at.z} 搭 3x3x3 盒子`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.build) || {};
    this.settings = {
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      reach: Math.max(1, finiteNumber(config.reach, FALLBACK.reach)),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
    };
    this.material = bareName(this.args.material) || null;
    if (!this.material) {
      const found = skills.place.findBuildingBlock(ctx.bot, 26);
      this.material = found ? found.name : null;
    }
    if (!this.material || skills.inventory.count(ctx.bot, this.material) < 26 || !this.args.at) {
      this.fail(FAILURE_REASONS.NO_SHELTER_MATERIAL);
      return false;
    }
    this.targets = buildTargets(this.args.at);
    return true;
  }

  progressMetric(ctx) {
    if (!this.targets.length) return 0;
    return this.targets.filter((target) => {
      const block = skills.mining.blockAt(ctx.bot, target);
      return block && !skills.mining.isAir(block) && bareName(block.name) === this.material;
    }).length;
  }

  isDone(ctx) {
    return this.progressMetric(ctx) >= this.targets.length;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) return { reason: FAILURE_REASONS.TIMEOUT };
    if (this.attempts >= this.settings.maxAttempts) return { reason: FAILURE_REASONS.PLACE_FAILED };
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, { at: this.args.at, material: this.material, blocks: this.targets.length });
      return;
    }
    if (this.pending) return;
    const target = this.targets.find((position) => {
      const block = skills.mining.blockAt(ctx.bot, position);
      return !block || skills.mining.isAir(block);
    });
    if (!target) return;

    const support = skills.place.findPlacementSupport(ctx.bot, target, 'any');
    if (!support) {
      this.attempts += 1;
      return;
    }
    this.runPending('build', () => skills.place.placeItemAt(ctx.bot, this.material, target, {
      accept: (name) => name === this.material,
      supportMode: 'any',
    }), { target });
  }

  onPendingSuccess(ctx, result, label) {
    if (label !== 'build') return;
    if (!result || result.ok === false) {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: FAILURE_REASONS.PLACE_FAILED,
        message: result && result.error ? result.error : null,
      });
    }
  }

  onPendingError(ctx, error, label) {
    if (label !== 'build') return;
    this.attempts += 1;
    this._emit(ctx, 'task_action_failed', {
      label,
      reason: FAILURE_REASONS.PLACE_FAILED,
      message: error && error.message ? error.message : String(error),
    });
  }
}

function buildTargets(at) {
  const output = [];
  for (let y = at.y; y < at.y + 3; y += 1) {
    for (let x = at.x - 1; x <= at.x + 1; x += 1) {
      for (let z = at.z - 1; z <= at.z + 1; z += 1) {
        const boundary = y === at.y || y === at.y + 2 ||
          x === at.x - 1 || x === at.x + 1 ||
          z === at.z - 1 || z === at.z + 1;
        if (boundary) output.push({ x, y, z });
      }
    }
  }
  return output.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

BuildTask.kind = 'build';
BuildTask.priority = 45;
BuildTask.selfTimed = true;
BuildTask.schema = {
  type: 'object',
  properties: {
    blueprint: { type: 'string' },
    at: {
      oneOf: [
        { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        { type: 'object' },
      ],
    },
    material: { type: 'string' },
  },
  required: ['at'],
};

module.exports = { BuildTask, buildTargets };
