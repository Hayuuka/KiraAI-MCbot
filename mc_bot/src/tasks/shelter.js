'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  searchRadius: 8,
  moveTimeoutMs: 8000,
  maxMinutes: 10,
  maxAttempts: 4,
  blocksRequired: 2,
  reach: 2,
});

const PHASES = Object.freeze({
  GOTO_OUTSIDE: 'goto_outside',
  DIG_FEET: 'dig_feet',
  DIG_HEAD: 'dig_head',
  ENTER: 'enter',
  SEAL_FEET: 'seal_feet',
  SEAL_HEAD: 'seal_head',
  WAIT: 'wait',
});
const PHASE_ORDER = Object.freeze(Object.values(PHASES));

class ShelterTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.phase = PHASES.GOTO_OUTSIDE;
    this.niche = null;
    this.attempts = 0;
    this.sawNight = false;
  }

  static normalizeArgs() {
    return {};
  }

  static feasible(ctx = {}) {
    const perception = ctx.perception;
    const bot = ctx.bot;
    if (!bot || !perception || perception.world.isDay !== false || perception.world.underground) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.shelter;
    const required = Math.max(1, Math.trunc(finiteNumber(config && config.blocksRequired, FALLBACK.blocksRequired)));
    const blocks = skills.place.findBuildingBlock(bot, required);
    if (!blocks) return null;
    const niche = skills.world.findShelterNiche(bot, {
      searchRadius: finiteNumber(config && config.searchRadius, FALLBACK.searchRadius),
    });
    if (!niche) return null;
    return {
      args: {},
      etaSec: 60,
      note: `挖一个 1x2 避难点，并用 ${blocks.name} 封口`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.shelter) || {};
    this.settings = {
      searchRadius: Math.max(1, finiteNumber(config.searchRadius, FALLBACK.searchRadius)),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      blocksRequired: Math.max(1, Math.trunc(finiteNumber(config.blocksRequired, FALLBACK.blocksRequired))),
      reach: Math.max(1, finiteNumber(config.reach, FALLBACK.reach)),
    };
    this.sawNight = ctx.perception && ctx.perception.world.isDay === false;
    this.niche = skills.world.findShelterNiche(ctx.bot, { searchRadius: this.settings.searchRadius });
    if (!this.niche) {
      this.fail(FAILURE_REASONS.NO_SAFE_SPOT);
      return false;
    }
    if (!skills.place.findBuildingBlock(ctx.bot, this.settings.blocksRequired)) {
      this.fail(FAILURE_REASONS.NO_SHELTER_MATERIAL);
      return false;
    }
    return true;
  }

  progressMetric() {
    return PHASE_ORDER.indexOf(this.phase);
  }

  isDone(ctx) {
    const isDay = ctx.perception && ctx.perception.world.isDay;
    if (isDay === false) this.sawNight = true;
    return this.sawNight && isDay === true;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return {
        reason: this.phase === PHASES.SEAL_FEET || this.phase === PHASES.SEAL_HEAD
          ? FAILURE_REASONS.PLACE_FAILED
          : FAILURE_REASONS.PATH_UNREACHABLE,
      };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        niche: this.niche,
        phase: this.phase,
        block: skills.place.findBuildingBlock(ctx.bot, 1),
      });
      return;
    }
    if (this.pending) return;
    if (ctx.perception.world.isDay === false) this.sawNight = true;
    if (ctx.perception.world.isDay !== false) return;

    if (this.phase === PHASES.GOTO_OUTSIDE) {
      const distance = skills.move.positionDistance(ctx.bot.entity.position, this.niche.outside);
      if (distance <= this.settings.reach) {
        this.phase = PHASES.DIG_FEET;
        return;
      }
      this.runPending('shelter_move_out', () => skills.move.moveTo(ctx.bot, this.niche.outside, {
        range: 1,
        timeoutMs: this.settings.moveTimeoutMs,
      }));
      return;
    }

    if (this.phase === PHASES.DIG_FEET || this.phase === PHASES.DIG_HEAD) {
      const y = this.phase === PHASES.DIG_FEET ? this.niche.inside.y : this.niche.inside.y + 1;
      const block = skills.world.blockAt(ctx.bot, this.niche.inside.x, y, this.niche.inside.z);
      if (skills.world.isAir(block)) {
        this.phase = this.phase === PHASES.DIG_FEET ? PHASES.DIG_HEAD : PHASES.ENTER;
        return;
      }
      const label = this.phase === PHASES.DIG_FEET ? 'shelter_dig_feet' : 'shelter_dig_head';
      this.runPending(label, () => skills.mine.mineBlock(ctx.bot, block));
      return;
    }

    if (this.phase === PHASES.ENTER) {
      const distance = skills.move.positionDistance(ctx.bot.entity.position, this.niche.inside);
      if (distance <= 1) {
        this.phase = PHASES.SEAL_FEET;
        return;
      }
      this.runPending('shelter_move_in', () => skills.move.moveTo(ctx.bot, this.niche.inside, {
        range: 0,
        timeoutMs: this.settings.moveTimeoutMs,
      }));
      return;
    }

    if (this.phase === PHASES.SEAL_FEET) {
      this.runPending('shelter_seal_feet', () => skills.place.placeBuildingBlockAt(ctx.bot, this.niche.outside));
      return;
    }

    if (this.phase === PHASES.SEAL_HEAD) {
      this.runPending('shelter_seal_head', () => skills.place.placeBuildingBlockAt(ctx.bot, {
        x: this.niche.outside.x,
        y: this.niche.outside.y + 1,
        z: this.niche.outside.z,
      }));
    }
  }

  onPendingSuccess(ctx, result, label) {
    if (!result || result.ok === false) {
      this.attempts += 1;
      this._emit(ctx, 'task_action_failed', {
        label,
        reason: label.startsWith('shelter_seal')
          ? FAILURE_REASONS.PLACE_FAILED
          : FAILURE_REASONS.PATH_UNREACHABLE,
        message: result && result.error ? result.error : null,
      });
      return;
    }

    if (label === 'shelter_move_out') this.phase = PHASES.DIG_FEET;
    else if (label === 'shelter_dig_feet') this.phase = PHASES.DIG_HEAD;
    else if (label === 'shelter_dig_head') this.phase = PHASES.ENTER;
    else if (label === 'shelter_move_in') this.phase = PHASES.SEAL_FEET;
    else if (label === 'shelter_seal_feet') this.phase = PHASES.SEAL_HEAD;
    else if (label === 'shelter_seal_head') {
      this.phase = PHASES.WAIT;
      this._emit(ctx, 'shelter_ready', { niche: this.niche });
    }
  }

  onPendingError(ctx, error, label) {
    this.attempts += 1;
    this._emit(ctx, 'task_action_failed', {
      label,
      reason: FAILURE_REASONS.PATH_UNREACHABLE,
      message: error && error.message ? error.message : String(error),
    });
  }
}

ShelterTask.kind = 'shelter';
ShelterTask.priority = 60;
ShelterTask.selfTimed = true;
ShelterTask.schema = { type: 'object', properties: {} };

module.exports = { ShelterTask, PHASES };
