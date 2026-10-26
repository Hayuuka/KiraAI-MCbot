'use strict';

const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { loadConfig, ACCOUNT_NAME, MC_VERSION } = require('./config');

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

class Connection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.config = options.config || loadConfig();
    this.log = options.log || console;
    this.bot = null;
    this.running = false;
    this.generation = 0;
    this.reconnectTimer = null;
    this.spawned = false;
    this.alive = false;
    this.healthSeen = false;
    this.botEnded = false;
    this.reconnectMin = Number(this.config.link && this.config.link.reconnectMinMs) || 2000;
    this.reconnectMax = Number(this.config.link && this.config.link.reconnectMaxMs) || 60000;
    this.reconnectDelay = this.reconnectMin;
  }

  _log(message) {
    try {
      const sink = this.log && (this.log.info || this.log.log);
      if (typeof sink === 'function') sink.call(this.log, '[connect] ' + message);
    } catch (_) {
      return;
    }
  }

  _notify(name, ...args) {
    // 回调既支持 options.bot 也支持 options.onBot（调用方用的是 onXxx 形式）
    const options = this.options || {};
    const callback =
      options[name] ||
      options['on' + String(name).charAt(0).toUpperCase() + String(name).slice(1)];
    if (typeof callback === 'function') {
      try {
        callback(...args);
      } catch (error) {
        this._log(name + ' callback failed: ' + errorText(error));
      }
    }
    try {
      this.emit(name, ...args);
    } catch (error) {
      this._log(name + ' listener failed: ' + errorText(error));
    }
  }

  _broadcastStatus() {
    this._notify('status', this.getStatus());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reconnectDelay = this.reconnectMin;
    this._connect();
  }

  _scheduleReconnect(reason) {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.max(500, Math.min(this.reconnectDelay, this.reconnectMax));
    this.reconnectDelay = Math.min(this.reconnectMax, Math.max(this.reconnectMin, delay * 2));
    this._log('reconnect in ' + delay + 'ms (' + reason + ')');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _handleSpawn(bot, generation) {
    if (this.bot !== bot || this.generation !== generation) return;
    this.spawned = true;
    this.alive = true;
    this.botEnded = false;
    this.reconnectDelay = this.reconnectMin;
    this._log('spawned as ' + ACCOUNT_NAME);
    this._notify('spawn', bot);
    this._broadcastStatus();
  }

  _connect() {
    if (!this.running) return;

    const previousBot = this.bot;
    if (previousBot && !this.botEnded) {
      this.generation += 1;
      this.bot = null;
      try {
        if (typeof previousBot.quit === 'function') previousBot.quit('reconnect');
        else if (typeof previousBot.end === 'function') previousBot.end('reconnect');
      } catch (_) {
        this._log('previous connection cleanup failed');
      }
    }

    this.spawned = false;
    this.alive = false;
    this.healthSeen = false;
    this.botEnded = false;

    let bot;
    try {
      bot = mineflayer.createBot({
        host: this.config.bot.host,
        port: this.config.bot.port,
        username: ACCOUNT_NAME,
        version: MC_VERSION,
        auth: this.config.bot.auth,
      });
    } catch (error) {
      this._log('createBot failed: ' + errorText(error));
      this._scheduleReconnect('createBot');
      return;
    }

    const generation = ++this.generation;
    this.bot = bot;

    try {
      bot.loadPlugin(pathfinder);
    } catch (error) {
      this._log('pathfinder load failed: ' + errorText(error));
    }

    this._notify('bot', bot);

    bot.once('spawn', () => this._handleSpawn(bot, generation));
    bot.on('respawn', () => this._handleSpawn(bot, generation));

    bot.on('health', () => {
      if (this.bot !== bot || this.generation !== generation) return;
      if (Number.isFinite(bot.health)) this.healthSeen = true;
      this._notify('health', bot.health, bot.food, bot);
    });

    try {
      if (bot._client && typeof bot._client.on === 'function') {
        bot._client.on('update_health', () => {
          if (this.bot !== bot || this.generation !== generation) return;
          this.healthSeen = true;
        });
      }
    } catch (error) {
      this._log('health packet hook failed: ' + errorText(error));
    }

    bot.on('death', () => {
      if (this.bot !== bot || this.generation !== generation) return;
      this.alive = false;
      this._log('bot died');
      this._notify('death', bot);
      this._broadcastStatus();
    });

    bot.on('kicked', (reason, loggedIn) => {
      if (this.bot !== bot || this.generation !== generation) return;
      this.spawned = false;
      this.alive = false;
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this._log('kicked: ' + text);
      this._notify('kicked', text, loggedIn, bot);
      this._broadcastStatus();
      this._scheduleReconnect('kicked');
    });

    bot.on('end', (reason) => {
      if (this.bot !== bot || this.generation !== generation) return;
      this.botEnded = true;
      this.spawned = false;
      this.alive = false;
      this.healthSeen = false;
      this._log('connection ended: ' + reason);
      this._notify('end', reason, bot);
      this._broadcastStatus();
      this._scheduleReconnect('end');
    });

    bot.on('error', (error) => {
      if (this.bot !== bot || this.generation !== generation) return;
      this._log('socket error: ' + errorText(error));
      this._notify('error', error, bot);
      this._broadcastStatus();
      this._scheduleReconnect('error');
    });
  }

  getBot() {
    return this.bot;
  }

  isReady() {
    const bot = this.bot;
    if (!this.running || !bot || this.botEnded || !this.spawned || !this.alive || !this.healthSeen) {
      return false;
    }
    const position = bot.entity && bot.entity.position;
    return Boolean(
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      Number.isFinite(position.z)
    );
  }

  getStatus() {
    let position = null;
    const bot = this.bot;
    if (bot && bot.entity && bot.entity.position) {
      position = [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z];
    }
    return {
      running: this.running,
      ready: this.isReady(),
      spawned: this.spawned,
      alive: this.alive,
      healthSeen: this.healthSeen,
      position,
    };
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this.bot;
    this.bot = null;
    this.spawned = false;
    this.alive = false;
    this.healthSeen = false;
    this.botEnded = true;
    if (bot) {
      try {
        if (typeof bot.quit === 'function') bot.quit('mc_bot shutdown');
        else if (typeof bot.end === 'function') bot.end('mc_bot shutdown');
      } catch (error) {
        this._log('stop failed: ' + errorText(error));
      }
    }
    this._broadcastStatus();
  }
}

function createConnection(options = {}) {
  const connection = new Connection(options);
  if (options.autoStart !== false) connection.start();
  return connection;
}

module.exports = {
  Connection,
  createConnection,
  errorText,
};
