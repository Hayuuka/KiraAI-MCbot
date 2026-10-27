'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  item: 'oak_planks',
  count: 4,
  maxMinutes: 3,
  maxAttempts: 4,
  tableSearchRadius: 8,
});

function bareItem(name) {
  return String(name || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
}

function supportedRecipe(item) {
  const name = bareItem(item);
  if (/_planks$/.test(name)) return { kind: 'planks', table: false };
  if (name === 'stick') return { kind: 'stick', table: false };
  if (name === 'crafting_table') return { kind: 'crafting_table', table: false };
  if (name === 'torch') return { kind: 'torch', table: false };
  if (name === 'chest') return { kind: 'chest', table: true };
  return null;
}

function logCount(bot) {
  const counts = skills.inventory.counts ? skills.inventory.counts(bot) : null;
  if (counts && typeof counts === 'object') {
    return Object.entries(counts)
      .filter(([name]) => /_(log|stem)$/.test(name))
      .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  }
  const items = bot && bot.inventory && typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : [];
  return items
    .filter((item) => /_(log|stem)$/.test(bareItem(item && item.name)))
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0);
}

function hasIngredients(bot, item) {
  const name = bareItem(item);
  const count = (target) => skills.inventory.count(bot, target);
  if (/_planks$/.test(name)) return logCount(bot) > 0;
  if (name === 'stick') {
    return count('oak_planks') + count('spruce_planks') + count('birch_planks') +
      count('jungle_planks') + count('acacia_planks') + count('dark_oak_planks') >= 2;
  }
  if (name === 'crafting_table') {
    return count('oak_planks') + count('spruce_planks') + count('birch_planks') +
      count('jungle_planks') + count('acacia_planks') + count('dark_oak_planks') >= 4;
  }
  if (name === 'torch') return count('coal') + count('charcoal') > 0 && count('stick') > 0;
  if (name === 'chest') {
    return count('oak_planks') + count('spruce_planks') + count('birch_planks') +
      count('jungle_planks') + count('acacia_planks') + count('dark_oak_planks') >= 8;
  }
  return false;
}

class CraftTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.baseline = null;
    this.attempts = 0;
    this.noRecipe = false;
  }

  static normalizeArgs(args = {}) {
    return {
      item: bareItem(args.item) || FALLBACK.item,
      count: integerAtLeast(args.count, FALLBACK.count, 1),
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.craft;
    const args = CraftTask.normalizeArgs({
      ...(config || {}),
      ...(ctx.args && typeof ctx.args === 'object' ? ctx.args : {}),
    });
    if (!bot || !bot.registry || !bot.registry.itemsByName || !bot.registry.itemsByName[args.item]) return null;
    const recipe = supportedRecipe(args.item);
    if (!recipe) return null;
    if (!hasIngredients(bot, args.item)) return null;
    return {
      args,
      etaSec: Math.max(10, args.count * 3),
      note: `制作 ${args.count} 个 ${args.item}`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.craft) || {};
    this.settings = {
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      tableSearchRadius: Math.max(2, Math.trunc(finiteNumber(config.tableSearchRadius, FALLBACK.tableSearchRadius))),
    };
    this.baseline = skills.inventory.count(ctx.bot, this.args.item);
    const definition = ctx.bot && ctx.bot.registry && ctx.bot.registry.itemsByName
      ? ctx.bot.registry.itemsByName[this.args.item]
      : null;
    if (!definition) {
      this.fail(FAILURE_REASONS.NO_TARGET);
      return false;
    }
    return true;
  }

  progressMetric(ctx) {
    if (this.baseline === null) return 0;
    return Math.max(0, skills.inventory.count(ctx.bot, this.args.item) - this.baseline);
  }

  isDone(ctx) {
    return this.progressMetric(ctx) >= this.args.count;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) return { reason: FAILURE_REASONS.TIMEOUT };
    if (this.noRecipe || this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.NO_TARGET };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, { item: this.args.item, count: this.args.count });
      return;
    }
    if (this.pending) return;
    if (!hasIngredients(ctx.bot, this.args.item)) {
      this.noRecipe = true;
      return;
    }

    const recipe = supportedRecipe(this.args.item);
    const table = recipe && recipe.table ? this._findTable(ctx.bot) : null;
    const definition = ctx.bot.registry.itemsByName[this.args.item];
    let recipes = [];
    try {
      recipes = ctx.bot.recipesFor(definition.id, null, 1, table) || [];
    } catch (_) {
      recipes = [];
    }

    if (!recipes.length && recipe && recipe.table && !table) {
      const tableItem = skills.inventory.findItem(ctx.bot, 'crafting_table');
      if (!tableItem) {
        this.noRecipe = true;
        return;
      }
      const spot = skills.world.findFlatSpot(ctx.bot, { searchRadius: 6 });
      if (!spot) {
        this.attempts += 1;
        return;
      }
      this.runPending('craft_place_table', () => skills.place.placeItemAt(ctx.bot, 'crafting_table', spot, {
        accept: (name) => name === 'crafting_table',
      }));
      return;
    }
    if (!recipes.length) {
      this.noRecipe = true;
      return;
    }

    const chosen = recipes[0];
    const resultCount = Math.max(1, Number(chosen.result && chosen.result.count) || 1);
    const remaining = Math.max(1, this.args.count - this.progressMetric(ctx));
    const times = Math.max(1, Math.ceil(remaining / resultCount));
    this.runPending('craft', () => Promise.resolve(ctx.bot.craft(chosen, times, table)), {
      table,
      times,
    });
  }

  onPendingSuccess(ctx, result, label) {
    if (label === 'craft_place_table') {
      if (!result || result.ok === false) this.attempts += 1;
      return;
    }
    if (label !== 'craft') return;
    if (this.progressMetric(ctx) <= 0) this.attempts += 1;
  }

  onPendingError(ctx, error, label) {
    if (label === 'craft' || label === 'craft_place_table') {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: FAILURE_REASONS.NO_TARGET,
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  _findTable(bot) {
    try {
      return bot.findBlock({
        maxDistance: this.settings.tableSearchRadius,
        matching: (block) => String(block && block.name || '').split(':').pop() === 'crafting_table',
      });
    } catch (_) {
      return null;
    }
  }
}

CraftTask.kind = 'craft';
CraftTask.priority = 45;
CraftTask.selfTimed = true;
CraftTask.schema = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    count: { type: 'integer', minimum: 1, maximum: 256 },
  },
  required: ['item'],
};

module.exports = { CraftTask, supportedRecipe, hasIngredients };
