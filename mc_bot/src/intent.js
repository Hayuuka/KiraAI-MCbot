'use strict';

/**
 * 自主调度（intent）——让 bot 在没人指挥时也有"接下来做什么"。
 *
 * 分工：
 *   本地规则（这里）  决定"什么时候该换目标""出事了要不要中断"
 *   LLM（云端）       决定"下一步选哪个目标"
 *
 * 这样不会每几秒就问一次 LLM（那会烧钱），只在必要时才问：
 *   1. 当前意图完成了（挖够数、时间到、天黑了……）
 *   2. 当前意图卡住了（长时间没进展）
 *   3. 出事了（被打、掉血、被踢）——这个由 autonomy 直接处理，不经过这里
 *
 * 没有 LLM 可用时（比如云端断线），退化成"固定轮转"的保守计划，
 * 保证她不会站着发呆。
 */

// 没有模型时的兜底轮转：砍树 → 闲逛 → 挖矿
const FALLBACK_ROTATION = [
  { mode: 'mine', args: { block: '#minecraft:logs', count: 32, maxMinutes: 6 }, label: '砍点木头' },
  { mode: 'wander', args: { radius: 8 }, label: '四处走走' },
  { mode: 'mine', args: { block: '#minecraft:ores', count: 8, maxMinutes: 5 }, label: '找点矿' },
];

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

/**
 * 决策日志：单独一个文件，只记"她决定做什么、为什么"。
 * 跑一晚上后可以直接看这条脉络，不用翻几万行游戏聊天。
 */
function createDecisionLog(dir) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(dir, 'decisions.log');
  let ready = false;
  return function write(entry) {
    try {
      if (!ready) {
        fs.mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      fs.appendFile(file, line + '\n', () => {});
    } catch (_) {
      // 日志失败不影响主流程
    }
  };
}

class IntentRunner {
  constructor(options = {}) {
    this.autonomy = options.autonomy || null;
    this.log = options.log || console;
    this.decide = typeof options.decide === 'function' ? options.decide : null;
    this.isCloudReady = typeof options.isCloudReady === 'function' ? options.isCloudReady : null;
    this.config = options.config || {};
    this.record = options.recordDir ? createDecisionLog(options.recordDir) : null;

    this.running = false;
    this.timer = null;
    this.current = null;        // { mode, args, label, startedAt }
    this.rotationIndex = 0;
    this.lastDecideAt = 0;
    this.startedAt = Date.now();
    this.stallWatchdogMs = 3 * 60 * 1000;
    this.decideCooldownMs = Number(this.config.intent && this.config.intent.decideCooldownMs) || 20000;
    this.askModel = Boolean(this.config.intent && this.config.intent.askModel);
    // 人工指令占用多久后交还自主调度（默认 10 分钟）
    this.modelTurnUntil = 0;
    this.planQueue = [];
    this.planIndex = 0;
    this.planTotal = 0;
    this.manualHoldMs = Number(this.config.intent && this.config.intent.manualHoldMs) || 600000;
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.warn || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[intent] ' + message);
    } catch (_) {
      return;
    }
  }

  get enabled() {
    return Boolean(this.config.intent && this.config.intent.enabled);
  }

  start() {
    if (!this.enabled) {
      this._log('自主调度未启用');
      return false;
    }
    if (this.running) return true;
    this.running = true;
    this.timer = setInterval(() => this._tick(), 3000);
    this._log('自主调度已启动');
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.current = null;
  }

  /**
   * 外部（比如用户在 QQ 里下了新指令）可以强制切换意图，
   * 避免自动计划覆盖掉人的安排。
   *
   * 但人工接管必须有期限：否则你命令一次 follow，自主调度就永远让位，
   * bot 之后再也不自己做事了。超时后自动交还给自主调度。
   */
  setManual(mode, args = {}) {
    this.current = {
      mode,
      args,
      label: '手动：' + mode,
      startedAt: Date.now(),
      manual: true,
      manualExpiresAt: Date.now() + this.manualHoldMs,
    };
  }

  clearManual() {
    if (this.current && this.current.manual) {
      this.current = null;
    }
  }

  /**
   * 模型响应 intent 时会自己调 mc_mode。那一次调用要认作"自主决策"，
   * 不能当成人下的命令，否则会立刻进入人工接管状态把自主调度关掉。
   * 发完 intent 后开一个短窗口，窗口内第一次 setMode 就归为模型决策。
   */
  consumeModelTurn() {
    if (!this.modelTurnUntil) return false;
    if (Date.now() > this.modelTurnUntil) {
      this.modelTurnUntil = 0;
      return false;
    }
    this.modelTurnUntil = 0;
    return true;
  }

  /**
   * 模型对 intent 给出了回应。记进决策日志，并把 pending 状态结束掉——
   * 否则下一次 tick 还看到 pending，会一直空等到 90 秒超时。
   */
  onModelDecided(mode, args) {
    const waited = this.current && this.current.startedAt
      ? Math.round((Date.now() - this.current.startedAt) / 1000)
      : null;
    if (this.record) {
      this.record({ event: 'model_choice', mode, args: args || {}, waitedSec: waited });
    }
    if (mode === 'idle') {
      this.current = null;
      this._log(`模型选择待命（等了 ${waited}s）`);
      return;
    }
    this.current = {
      mode,
      args: args || {},
      label: '模型选择：' + mode,
      startedAt: Date.now(),
    };
    this._log(`模型选择 ${mode}（等了 ${waited}s）`);
  }

  async _tick() {
    if (!this.running || !this.autonomy) return;
    try {
      // bot 还没上线时什么都不做，避免启动瞬间发出无效决策
      if (typeof this.autonomy._isReady === 'function' && !this.autonomy._isReady()) {
        return;
      }
      const mode = this.autonomy.mode;
      const now = Date.now();

      // 阶段 0 临时看门狗：决策链上的早退分支可能让模式一直停在 idle，
      // 尤其在云端不可达、isCloudReady 永远为假时，兜底轮转根本轮不到。
      // 超过三分钟没有任何决策就直接本地接管一次，并留下日志。
      const decisionBase = this.lastDecideAt || this.startedAt;
      if (mode === 'idle' && !this.current && now - decisionBase > this.stallWatchdogMs) {
        this._log(`看门狗：已 ${Math.round((now - decisionBase) / 1000)}s 无决策，强制兜底轮转`);
        this._forceFallback('idle_watchdog');
        return;
      }

      // 人工接管到期：交还给自主调度
      if (this.current && this.current.manual) {
        if (Date.now() >= this.current.manualExpiresAt) {
          this._log('人工指令已到期，交还自主调度');
          if (this.record) this.record({ event: 'manual_expired', mode: this.current.mode });
          this.current = null;
        } else {
          return;
        }
      }

      // 刚发出决策请求，等模型调用 mc_mode；超时 90 秒没动静就放弃这轮
      if (this.current && this.current.mode === 'pending') {
        if (Date.now() - this.current.startedAt > 90000) {
          this._log('模型决策超时，改用兜底轮转');
          this.current = null;
        } else {
          return;
        }
      }

      // 当前意图还在跑：autonomy 不在 idle 说明还在执行
      if (mode !== 'idle') {
        // 记录一下，等它自己停
        if (this.current && this.current.mode !== mode) {
          this.current = null;
        }
        return;
      }

      // autonomy 回到 idle 了，说明上一个目标结束（挖够了/天黑了/没找到……）
      if (this.current) {
        const reason = typeof this.autonomy.getModeDoneReason === 'function'
          ? this.autonomy.getModeDoneReason(this.current.mode) || '完成'
          : this.autonomy.mineDoneReason || '完成';
        this._log(`意图结束：${this.current.label}（${reason}）`);
        if (this.record) {
          this.record({
            event: 'finish',
            label: this.current.label,
            mode: this.current.mode,
            reason,
            durationSec: Math.round((Date.now() - this.current.startedAt) / 1000),
            mined: Number(this.autonomy.minedCount) || 0,
          });
        }
        this.current = null;
      }

      await this._pickNext();
    } catch (error) {
      this._log('tick failed: ' + errorText(error));
    }
  }

  /** 开始执行计划里的某一步。手动/模型单步都走这里。 */
  _startPlanStep(step) {
    const result = this.autonomy.setMode(step.mode, step.args || {});
    if (!result || !result.ok) {
      this._log(`计划步骤失败 ${step.mode}: ${result && result.error}`);
      if (this.record) this.record({ event: 'plan_step_failed', mode: step.mode, error: result && result.error });
      // 这一步做不了就跳过去，别把整条计划卡死
      if (this.planQueue.length) {
        const next = this.planQueue.shift();
        this.planIndex += 1;
        this._startPlanStep(next);
      }
      return;
    }
    this.current = {
      mode: step.mode,
      args: step.args || {},
      label: step.label || step.mode,
      startedAt: Date.now(),
      fromPlan: true,
    };
  }

  /** 跳过模型，直接执行兜底轮转。看门狗和云端不可达都走这里。 */
  _forceFallback(reason = 'local_default') {
    const plan = FALLBACK_ROTATION[this.rotationIndex % FALLBACK_ROTATION.length];
    this.rotationIndex += 1;
    this.lastDecideAt = Date.now();

    this._log('采用兜底计划：' + plan.label);
    if (this.record) {
      this.record({
        event: 'fallback',
        why: reason,
        plan: plan.label,
        mode: plan.mode,
        args: plan.args,
      });
    }

    const result = this.autonomy.setMode(plan.mode, plan.args || {});
    if (!result || !result.ok) {
      this._log(`兜底计划失败 ${plan.mode}: ${result && result.error}`);
      if (this.record) {
        this.record({ event: 'start_failed', mode: plan.mode, error: result && result.error });
      }
      return false;
    }

    this.current = {
      mode: plan.mode,
      args: plan.args || {},
      label: plan.label,
      startedAt: Date.now(),
      fromFallback: true,
    };
    return true;
  }

  /**
   * 接收模型给出的多步计划。
   * 格式：[{mode, args, label}, ...]
   */
  setPlan(steps) {
    if (!Array.isArray(steps) || !steps.length) return false;
    const clean = steps
      .filter((s) => s && typeof s === 'object' && s.mode)
      .slice(0, 6)
      .map((s) => ({
        mode: String(s.mode),
        args: s.args && typeof s.args === 'object' ? s.args : {},
        label: String(s.label || s.mode),
      }));
    if (!clean.length) return false;

    this.planQueue = clean;
    this.planTotal = clean.length;
    this.planIndex = 1;
    this._log(`收到 ${clean.length} 步计划：` + clean.map((s) => s.label).join(' → '));
    if (this.record) {
      this.record({ event: 'plan_received', steps: clean.map((s) => s.label) });
    }

    // 立刻执行第一步
    const first = this.planQueue.shift();
    this._startPlanStep(first);
    return true;
  }

  async _pickNext() {
    // 计划队列里还有步骤：直接做下一步，不再问模型
    if (this.planQueue.length) {
      const next = this.planQueue.shift();
      this._log(`执行计划步骤 ${this.planIndex}/${this.planTotal}：${next.label || next.mode}`);
      if (this.record) {
        this.record({
          event: 'plan_step',
          step: this.planIndex,
          total: this.planTotal,
          mode: next.mode,
          args: next.args,
          label: next.label,
        });
      }
      this._startPlanStep(next);
      return;
    }

    const now = Date.now();
    if (now - this.lastDecideAt < this.decideCooldownMs) return;

    // 云端还没连上时先等等，别急着用兜底轮转把机会浪费掉。
    // 启动阶段 link 通常比 bot 晚几秒就绪，这一段空窗会让模型决策被跳过。
    if (this.askModel && typeof this.isCloudReady === 'function' && !this.isCloudReady()) {
      return;
    }

    this.lastDecideAt = now;

    let plan = null;

    // 优先问模型；失败或未启用就用兜底轮转
    if (this.askModel && this.decide) {
      try {
        plan = await this.decide(this._situation());
      } catch (error) {
        this._log('模型决策失败，改用轮转：' + errorText(error));
      }
    }

    // 模型决策走的是"发一条 intent 事件，等它自己调 mc_mode"这条路，
    // 所以这里拿到的是 null，不代表失败——身体侧不重复设模式，避免打架。
    if (plan === 'awaiting-model') {
      this.current = { mode: 'pending', args: {}, label: '等待模型决策', startedAt: Date.now() };
      // 开一个窗口：模型接下来调 mc_mode 属于自主决策，不是人工指令
      this.modelTurnUntil = Date.now() + 60000;
      if (this.record) this.record({ event: 'ask_model', situation: this._situation() });
      return;
    }

    if (!plan || !plan.mode) {
      this._forceFallback('model_unavailable');
      return;
    }

    if (plan.mode === 'idle') {
      this._log('模型选择待命');
      if (this.record) this.record({ event: 'idle_chosen' });
      return;
    }

    const result = this.autonomy.setMode(plan.mode, plan.args || {});
    if (!result || !result.ok) {
      this._log(`切换失败 ${plan.mode}: ${result && result.error}`);
      if (this.record) this.record({ event: 'start_failed', mode: plan.mode, error: result && result.error });
      return;
    }

    this.current = {
      mode: plan.mode,
      args: plan.args || {},
      label: plan.label || plan.mode,
      startedAt: Date.now(),
    };
    this._log('新意图：' + this.current.label);
    if (this.record) this.record({ event: 'start', mode: plan.mode, args: plan.args, label: this.current.label });
  }

  _situation() {
    const autonomy = this.autonomy;
    const bot = typeof autonomy._getBot === 'function' ? autonomy._getBot() : null;
    const position = bot && bot.entity && bot.entity.position;

    // 昼夜和地下状态让模型自己判断该不该继续干，而不是由代码替它决定
    let tod = null;
    let dayProgress = null;
    let underground = null;
    try {
      if (bot && bot.time && Number.isFinite(bot.time.timeOfDay)) {
        tod = bot.time.timeOfDay;
        // 一个游戏日是 24000 tick，白天 0-13000
        dayProgress = tod < 13000
          ? { phase: 'day', remainingSec: Math.round((13000 - tod) / 20) }
          : { phase: 'night', remainingSec: Math.round((24000 - tod) / 20) };
      }
      if (bot && typeof autonomy._isOutdoors === 'function') {
        underground = !autonomy._isOutdoors(bot);
      }
    } catch (_) {
      // 拿不到就留空
    }

    const doneMode = this.current && this.current.mode;
    const lastResult = typeof autonomy.getModeDoneReason === 'function' && doneMode
      ? autonomy.getModeDoneReason(doneMode) || null
      : autonomy.mineDoneReason || null;

    return {
      hp: bot && Number.isFinite(bot.health) ? Math.round(bot.health) : null,
      food: bot && Number.isFinite(bot.food) ? bot.food : null,
      pos: position ? [Math.round(position.x), Math.round(position.y), Math.round(position.z)] : null,
      timeOfDay: tod,
      dayProgress,
      underground,
      lastResult,
    };
  }
}

function createIntentRunner(options = {}) {
  return new IntentRunner(options);
}
module.exports = {
  IntentRunner,
  createIntentRunner,
  FALLBACK_ROTATION,
};
