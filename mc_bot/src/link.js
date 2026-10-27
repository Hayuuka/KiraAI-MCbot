'use strict';

/**
 * 与云端 mc_bridge 插件通信。
 *
 * KiraAI 的插件 WebSocket 路由当前不可用（所有 WS 升级请求被拒），因此这里
 * 改用 HTTP 轮询，不需要任何 KiraAI 侧改动：
 *
 *   GET  {base}/poll?token=...&wait=20   -> 取走待执行的动作
 *   POST {base}/result                   -> 回报结果 + 推送游戏事件
 *   GET  {base}/status?token=...         -> 健康检查
 *
 * base 形如 http://127.0.0.1:15267/api/plugin/mc_bridge
 */

const { EventEmitter } = require('events');
const { isLinkConfigured } = require('./config');
const { normalizeToolName } = require('./actions');

const PROTOCOL_VERSION = '0.2.0';

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LinkClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.actions = options.actions || null;
    this.log = options.log || console;

    this.running = false;
    this.connected = false;
    this.loopTask = null;
    this.eventQueue = [];
    this.eventTask = null;
    this.reconnectDelay = this.reconnectMin;
  }

  get linkCfg() {
    return this.config.link || {};
  }

  get reconnectMin() {
    return Number(this.linkCfg.reconnectMinMs) || 2000;
  }

  get reconnectMax() {
    return Number(this.linkCfg.reconnectMaxMs) || 30000;
  }

  get pollHoldSeconds() {
    const value = Number(this.linkCfg.pollHoldSeconds);
    return Number.isFinite(value) && value > 0 ? Math.min(20, value) : 15;
  }

  get token() {
    return String(this.linkCfg.token || '');
  }

  /**
   * 允许配置里写 ws:// 或 http://，统一归一化成 HTTP API 基址。
   * 兼容旧配置：ws://host:port/ws/plugin/mc_bridge/agent -> http://host:port/api/plugin/mc_bridge
   */
  get baseUrl() {
    let url = String(this.linkCfg.url || '').trim();
    if (!url) return '';
    url = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/ws\/plugin\/mc_bridge(?:\/.*)?$/i, '/api/plugin/mc_bridge');
    url = url.replace(/\/api\/plugin\/mc_bridge(?:\/poll|\/result|\/status)$/i, '/api/plugin/mc_bridge');
    if (/\/api\/plugin\/mc_bridge$/i.test(url)) return url;
    return url + '/api/plugin/mc_bridge';
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.info || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[link] ' + message);
    } catch (_) {
      return;
    }
  }

  start() {
    if (this.running) return true;
    if (!this.actions || typeof this.actions.invoke !== 'function') {
      this._log('actions are unavailable; link not started');
      return false;
    }
    if (!isLinkConfigured(this.config)) {
      this._log('link token is not configured; link not started');
      return false;
    }
    this.running = true;
    this.reconnectDelay = this.reconnectMin;
    this.loopTask = this._pollLoop();
    this.eventTask = this._eventLoop();
    this._sayHello();
    return true;
  }

  stop() {
    this.running = false;
    if (this.loopTask) {
      this.loopTask = null;
    }
    if (this.eventTask) {
      this.eventTask = null;
    }
    this.connected = false;
  }

  async _sayHello() {
    try {
      await this._post('/result', { type: 'hello', name: String((this.config.bot && this.config.bot.username) || '') });
    } catch (error) {
      this._log('hello failed: ' + errorText(error));
    }
  }

  // ------------------------------------------------------------------
  // 轮询取任务
  // ------------------------------------------------------------------

  /**
   * 隔离轮询：任何时刻都保持一个 poll 挂起在云端。
   *
   * 之前是「取到结果后才发下一次 poll」，两次之间有空隙；任务若在空隙到达，
   * 就得多等一整轮长轮询，超过模型侧 6 秒的工具超时。
   * 现在取到任务后立刻续上一个新的 poll，再异步执行任务。
   */
  async _pollLoop() {
    let inflight = null;

    const arm = () => {
      inflight = this._poll().catch((error) => ({ _error: error }));
      return inflight;
    };

    arm();

    while (this.running) {
      const data = await inflight;

      if (!this.running) break;

      if (!data || data._error) {
        if (this.connected) {
          this.connected = false;
          this._log('disconnected: ' + errorText(data && data._error));
          this.emit('close');
        }
        await this._backoff();
        arm();
        continue;
      }

      if (data.ok) {
        if (!this.connected) {
          this.connected = true;
          this.reconnectDelay = this.reconnectMin;
          this._log('connected to ' + this.baseUrl);
          this.emit('open');
        }
        // 立刻续上新的 poll，任务在后台执行
        arm();
        if (data.job) {
          this._handleJob(data.job).catch((error) => {
            this._log('job failed: ' + errorText(error));
          });
        }
      } else {
        if (data.error) this._log('poll rejected: ' + data.error);
        await this._backoff();
        arm();
      }
    }
  }

  async _poll() {
    const url =
      this.baseUrl +
      '/poll?token=' + encodeURIComponent(this.token) +
      '&wait=' + this.pollHoldSeconds;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.pollHoldSeconds + 10) * 1000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async _backoff() {
    const delay = Math.max(500, Math.min(this.reconnectDelay, this.reconnectMax));
    this._log('retry in ' + delay + 'ms');
    this.reconnectDelay = Math.min(this.reconnectMax, Math.max(this.reconnectMin, delay * 2));
    await sleep(delay);
  }

  async _handleJob(job) {
    const id = job.id;
    const tool = String(job.tool || '');
    const args = job.args && typeof job.args === 'object' ? job.args : {};
    let result;
    try {
      result = await this.actions.invoke(tool, args, {
        actor: 'cloud',
        requestId: id,
        tool: normalizeToolName(tool),
      });
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (!result || typeof result !== 'object') result = { ok: false, error: 'no result' };

    let frame;
    if (result.ok) {
      const { ok, ...rest } = result;
      frame = { type: 'result', id, ok: true, data: rest };
    } else {
      const { ok, error, ...details } = result;
      frame = { type: 'result', id, ok: false, error: String(error || 'unknown error'), ...details };
    }

    try {
      await this._post('/result', frame);
    } catch (error) {
      this._log('result post failed: ' + errorText(error));
    }
  }

  // ------------------------------------------------------------------
  // 推送事件
  // ------------------------------------------------------------------

  sendEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (!this.running) return false;
    this.eventQueue.push(event);
    if (this.eventQueue.length > 200) this.eventQueue.splice(0, this.eventQueue.length - 200);
    if (this.eventTask === null) this.eventTask = this._eventLoop();
    return true;
  }

  async _eventLoop() {
    while (this.running) {
      if (!this.eventQueue.length) {
        await sleep(300);
        continue;
      }
      const event = this.eventQueue.shift();
      try {
        await this._post('/result', { type: 'event', kind: event.kind, data: event.data || {} });
      } catch (error) {
        this._log('event post failed: ' + errorText(error));
        // 推送失败不重排队，避免旧事件堆积
      }
    }
  }

  // ------------------------------------------------------------------

  async _post(pathname, payload) {
    const url = this.baseUrl + pathname;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, token: this.token }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  isConnected() {
    return this.connected;
  }
}

function createLink(options = {}) {
  return new LinkClient(options);
}

module.exports = {
  LinkClient,
  createLink,
  PROTOCOL_VERSION,
};
