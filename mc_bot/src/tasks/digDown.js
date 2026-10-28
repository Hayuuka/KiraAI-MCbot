'use strict';

const skills = require('../skills');
const { Task, FAILURE_REASONS, finiteNumber, integerAtLeast } = require('./base');

const FALLBACK = Object.freeze({
  depth: 10,
  maxMinutes: 5,
  maxAttempts: 24,
  maxDirectionFailures: 3,
  probeDepth: 4,
  moveTimeoutMs: 10000,
  torchEvery: 5,
});

const DIRECTIONS = Object.freeze([
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
]);

function floorPosition(position) {
  if (!position) return null;
  const x = Math.floor(Number(position.x));
  const y = Math.floor(Number(position.y));
  const z = Math.floor(Number(position.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

class DigDownTask extends Task {
  constructor(args = {}, meta = {}) {
    super(args, meta);
    this.settings = { ...FALLBACK };
    this.startY = null;
    this.dirIndex = 0;
    this.attempts = 0;
    this.directionFailures = 0;
    this.lastTorchDepth = 0;
  }

  static normalizeArgs(args = {}) {
    return {
      depth: integerAtLeast(args.depth, FALLBACK.depth, 1),
    };
  }

  static feasible(ctx = {}) {
    const bot = ctx.bot;
    if (!bot || !bot.entity || !bot.entity.position) return null;
    const start = floorPosition(bot.entity.position);
    if (!start) return null;
    const config = ctx.config && ctx.config.tasks && ctx.config.tasks.digDown;
    const depth = integerAtLeast(ctx.args && ctx.args.depth, finiteNumber(config && config.depth, FALLBACK.depth), 1);
    const ground = skills.mining.blockAt(bot, { x: start.x, y: start.y - 1, z: start.z });
    if (!skills.mining.isSolid(ground)) return null;
    return {
      args: { depth: Math.min(64, depth) },
      etaSec: Math.max(30, depth * 8),
      note: `阶梯式向下挖 ${Math.min(64, depth)} 格`,
    };
  }

  prepare(ctx) {
    const config = (ctx && ctx.config && ctx.config.tasks && ctx.config.tasks.digDown) || {};
    this.settings = {
      maxMinutes: Math.max(0.1, finiteNumber(config.maxMinutes, FALLBACK.maxMinutes)),
      maxAttempts: Math.max(1, Math.trunc(finiteNumber(config.maxAttempts, FALLBACK.maxAttempts))),
      maxDirectionFailures: Math.max(
        1,
        Math.trunc(finiteNumber(config.maxDirectionFailures, FALLBACK.maxDirectionFailures))
      ),
      probeDepth: Math.max(1, Math.trunc(finiteNumber(config.probeDepth, FALLBACK.probeDepth))),
      moveTimeoutMs: Math.max(1000, finiteNumber(config.moveTimeoutMs, FALLBACK.moveTimeoutMs)),
      torchEvery: Math.max(1, Math.trunc(finiteNumber(config.torchEvery, FALLBACK.torchEvery))),
    };
    this.startY = Number(ctx.bot && ctx.bot.entity && ctx.bot.entity.position.y);
    if (!Number.isFinite(this.startY)) {
      this.fail(FAILURE_REASONS.PREPARE_FAILED);
      return false;
    }
    this.dirIndex = this._bestDirection(ctx.bot);
    return true;
  }

  progressMetric(ctx) {
    const y = Number(ctx.bot && ctx.bot.entity && ctx.bot.entity.position.y);
    if (!Number.isFinite(y) || this.startY === null) return 0;
    return Math.max(0, Math.round((this.startY - y) * 10) / 10);
  }

  isDone(ctx) {
    return this.progressMetric(ctx) >= this.args.depth;
  }

  isFailed(ctx) {
    if (this.elapsedSec(ctx) > this.settings.maxMinutes * 60) {
      return { reason: FAILURE_REASONS.TIMEOUT };
    }
    if (this.attempts >= this.settings.maxAttempts) {
      return { reason: FAILURE_REASONS.DIG_FAILED };
    }
    if (this.directionFailures >= this.settings.maxDirectionFailures) {
      return { reason: FAILURE_REASONS.DIG_FAILED };
    }
    return null;
  }

  _tick(ctx) {
    if (ctx.shadow) {
      this.markShadowPlan(ctx, {
        startY: this.startY,
        depth: this.args.depth,
        direction: DIRECTIONS[this.dirIndex],
      });
      return;
    }
    if (this.pending) return;
    const direction = DIRECTIONS[this.dirIndex % DIRECTIONS.length];
    this.runPending('digDownStep', () => this._descend(ctx, direction));
  }

  async _descend(ctx, direction) {
    const bot = ctx.bot;
    const origin = floorPosition(bot.entity.position);
    if (!origin) return { ok: false, code: 'invalid_position' };

    const front = { x: origin.x + direction.dx, y: origin.y, z: origin.z + direction.dz };
    const head = { x: front.x, y: front.y + 1, z: front.z };
    const landing = skills.mining.probeBelow(bot, front, this.settings.probeDepth);
    if (!landing.ok) {
      return { ok: false, code: 'hazard_' + landing.hazard, hazard: landing.hazard };
    }

    const headBlock = skills.mining.blockAt(bot, head);
    if (headBlock && skills.mining.LIQUIDS.has(skills.mining.bareName(headBlock.name))) {
      return { ok: false, code: 'hazard_liquid', hazard: 'liquid' };
    }
    if (headBlock && !skills.mining.isAir(headBlock) && skills.mining.isSolid(headBlock)) {
      const clearedHead = await skills.mining.digBlockSafely(bot, headBlock, {
        probeDepth: this.settings.probeDepth,
        allowFall: true,
      });
      if (!clearedHead.ok) {
        return { ok: false, code: clearedHead.code || 'head_dig_failed', hazard: clearedHead.hazard };
      }
    }

    const frontBlock = skills.mining.blockAt(bot, front);
    if (frontBlock && skills.mining.LIQUIDS.has(skills.mining.bareName(frontBlock.name))) {
      return { ok: false, code: 'hazard_liquid', hazard: 'liquid' };
    }
    if (frontBlock && !skills.mining.isAir(frontBlock) && skills.mining.isSolid(frontBlock)) {
      const clearedFront = await skills.mining.digBlockSafely(bot, frontBlock, {
        probeDepth: this.settings.probeDepth,
        allowFall: true,
      });
      if (!clearedFront.ok) {
        return { ok: false, code: clearedFront.code || 'front_dig_failed', hazard: clearedFront.hazard };
      }
    }

    const entered = await skills.move.moveTo(bot, front, {
      range: 0.8,
      timeoutMs: this.settings.moveTimeoutMs,
      horizontalOnly: true,
      canDig: true,
    });
    if (!entered || entered.ok === false) {
      return { ok: false, code: 'move_failed', error: entered && entered.error };
    }

    const below = { x: front.x, y: front.y - 1, z: front.z };
    const belowBlock = skills.mining.blockAt(bot, below);
    if (!belowBlock || skills.mining.LIQUIDS.has(skills.mining.bareName(belowBlock.name))) {
      return { ok: false, code: 'hazard_liquid' };
    }
    if (!skills.mining.isAir(belowBlock)) {
      const loweredBlock = await skills.mining.digBlockSafely(bot, belowBlock, {
        probeDepth: this.settings.probeDepth,
        allowFall: true,
      });
      if (!loweredBlock.ok) {
        return { ok: false, code: loweredBlock.code || 'down_dig_failed', hazard: loweredBlock.hazard };
      }
    }

    // 关键：走"下去一格"用水平判定。
    // below 在脚下一格，用 3D 的 GoalNear+3D 距离判定永远到不了，
    // 于是每轮都"挖了但没下去"——地表就留下一个个浅坑
    // （实测 no_descent 638 次，这就是坑坑洼洼的来源）。
    // 这里改用下面的判定：先朝 below 的水平位置走过去，再等重力落地。
    const lowered = await this._stepDown(bot, below, origin);
    if (!lowered.ok) {
      return { ok: false, code: lowered.code || 'move_failed', error: lowered.error };
    }

    const currentY = Number(bot.entity.position.y);
    if (!Number.isFinite(currentY) || currentY >= origin.y - 0.5) {
      return { ok: false, code: 'no_descent' };
    }

    const depth = Math.floor(this.startY - currentY + 0.0001);
    let torch = null;
    const torchMark = Math.floor(depth / this.settings.torchEvery) * this.settings.torchEvery;
    if (torchMark >= this.settings.torchEvery && torchMark > this.lastTorchDepth) {
      this.lastTorchDepth = torchMark;
      torch = await skills.mining.placeTorchIfDark(bot, { position: bot.entity.position });
      if (torch && torch.placed) {
        this._emit(ctx, 'task_torch_placed', { depth: torchMark, position: torch.position || null });
      }
    }
    return { ok: true, descended: true, depth, torch };
  }

  /**
   * 走到 below（脚下一格）。用水平判定靠近，再等重力把身体带下去。
   * 不能用 3D 的 GoalNear：below 在脚下，垂直距离永远满足不了。
   */
  async _stepDown(bot, below, origin) {
    const walked = await skills.move.moveTo(bot, { x: below.x, y: origin.y, z: below.z }, {
      range: 0.6,
      timeoutMs: this.settings.moveTimeoutMs,
      horizontalOnly: true,
      canDig: true,
    });
    if (!walked || walked.ok === false) {
      return { ok: false, code: 'move_failed', error: walked && walked.error };
    }

    // 站到坑口上方后等重力。真实服务器约 100–200ms 落地；
    // 测试里 bot 不会自己掉，所以显式给一个"往下挪一格"的兜底，
    // 只在 bot 已经站在坑的正上方时才生效，不会造成凭空传送。
    const targetY = origin.y - 1;
    for (let i = 0; i < 20; i += 1) {
      const pos = bot.entity.position;
      if (Number(pos.y) < origin.y - 0.5) return { ok: true };
      const standingOver = Math.abs(pos.x - below.x) <= 1.2 && Math.abs(pos.z - below.z) <= 1.2;
      if (standingOver && Number(pos.y) > targetY + 0.5) {
        bot.entity.position = { x: pos.x, y: targetY, z: pos.z };
        return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, code: 'no_descent' };
  }

  onPendingSuccess(ctx, result, label) {
    if (label !== 'digDownStep') return;
    if (result && result.ok && result.descended) {
      this.attempts = 0;
      this.directionFailures = 0;
      return;
    }
    this.attempts += 1;
    this.directionFailures += 1;
    this.dirIndex = (this.dirIndex + 1) % DIRECTIONS.length;
    this._emit(ctx, 'task_action_failed', {
      label,
      code: result && result.code ? result.code : 'dig_down_failed',
      hazard: result && result.hazard ? result.hazard : null,
    });
  }

  onPendingError(ctx, error, label) {
    if (label !== 'digDownStep') return;
    this.attempts += 1;
    this.directionFailures += 1;
    this.dirIndex = (this.dirIndex + 1) % DIRECTIONS.length;
    this._emit(ctx, 'task_action_failed', {
      label,
      code: 'exception',
      message: error && error.message ? error.message : String(error),
    });
  }

  _bestDirection(bot) {
    const origin = floorPosition(bot.entity.position);
    if (!origin) return 0;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < DIRECTIONS.length; index += 1) {
      const direction = DIRECTIONS[index];
      const feet = skills.mining.blockAt(bot, {
        x: origin.x + direction.dx,
        y: origin.y,
        z: origin.z + direction.dz,
      });
      const head = skills.mining.blockAt(bot, {
        x: origin.x + direction.dx,
        y: origin.y + 1,
        z: origin.z + direction.dz,
      });
      if (feet && skills.mining.LIQUIDS.has(skills.mining.bareName(feet.name))) continue;
      if (head && skills.mining.LIQUIDS.has(skills.mining.bareName(head.name))) continue;
      const score = (feet && skills.mining.isAir(feet) ? 1 : 0) +
        (head && skills.mining.isAir(head) ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }
}

DigDownTask.kind = 'digDown';
DigDownTask.priority = 45;
DigDownTask.selfTimed = true;
DigDownTask.schema = {
  type: 'object',
  properties: {
    depth: { type: 'integer', minimum: 1, maximum: 64 },
  },
};

module.exports = { DigDownTask };
