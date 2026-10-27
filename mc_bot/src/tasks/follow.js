'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber } = require('./base');

const FALLBACK = Object.freeze({
  distance: 2,
  maxMinutes: 30,
});

/**
 * 持续跟随某个玩家。
 *
 * 这是 `mc_follow` 在实战模式下的落地形式：旧 autonomy 的 follow 模式
 * 已经不再启动，跟随必须作为任务走 agenda。
 */
class FollowTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
  }

  static normalizeArgs(args = {}) {
    return {
      player: String(args.player ?? args.name ?? args.target ?? '').trim(),
      distance: Math.max(1, finiteNumber(args.distance, FALLBACK.distance)),
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    const args = ctx.args || {};
    const name = String(args.player ?? args.name ?? '').trim();
    if (!bot || !name) return null;
    if (!skills.follow.isPlayerVisible(bot, name)) return null;
    const player = skills.move.findPlayer(bot, name);
    const gap = player && player.entity && player.entity.position
      ? skills.move.positionDistance(bot.entity.position, player.entity.position)
      : null;
    return {
      args: { player: name, distance: finiteNumber(args.distance, FALLBACK.distance) },
      etaSec: 10,
      note: gap == null ? `跟随 ${name}` : `跟随 ${name}（现在相距 ${Math.round(gap)} 格）`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.follow) || {};
    this.settings = {
      distance: Math.max(1, finiteNumber(config.distance, this.args.distance || FALLBACK.distance)),
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
    };
    this.args.distance = this.settings.distance;
    if (!skills.follow.isPlayerVisible(ctx.bot, this.args.player)) {
      this.fail(FAILURE_REASONS.PLAYER_UNAVAILABLE);
      return false;
    }
    return true;
  }

  progressMetric(ctx) {
    const player = this._player(ctx.bot);
    if (!player) return this._lastGap == null ? 0 : this._lastGap;
    const gap = skills.move.positionDistance(ctx.bot.entity.position, player.entity.position);
    this._lastGap = gap;
    // 靠近是正向进度，但玩家一直不动时也要让指标变化，避免被看门狗误判。
    return Number.isFinite(gap) ? 100 - gap : 0;
  }

  isDone() {
    return false;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (!this._player(ctx.bot)) {
      return { reason: FAILURE_REASONS.PLAYER_UNAVAILABLE };
    }
    return null;
  }

  _player(bot) {
    const player = skills.move.findPlayer(bot, this.args.player);
    return player && player.entity && player.entity.position ? player : null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, { player: this.args.player, distance: this.settings.distance });
      return;
    }
    if (this.pending) return;
    const bot = ctx.bot;

    const result = skills.follow.followTick(bot, this.args.player, { distance: this.settings.distance });
    if (!result || result.ok === false) {
      // 玩家暂时看不见不算失败，下一 tick 重试；isFailed 负责兜底
      this._emit(ctx, 'follow_retry', { reason: result && result.error });
    }
  }

  onFinish(ctx) {
    if (!ctx || ctx.shadow) return;
    skills.follow.stopFollow(ctx.bot);
  }
}

FollowTask.kind = 'follow';
FollowTask.priority = 70;
FollowTask.selfTimed = true;
FollowTask.schema = {
  type: 'object',
  properties: {
    player: { type: 'string' },
    distance: { type: 'number', minimum: 1 },
  },
  required: ['player'],
};

module.exports = { FollowTask };
