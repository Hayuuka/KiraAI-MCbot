'use strict';

const path = require('path');

const { loadConfig, ACCOUNT_NAME, MC_VERSION } = require('./config');
const { createConnection } = require('./connect');
const { createEventHub } = require('./events');
const { createAutonomy } = require('./autonomy');
const { createActions } = require('./actions');
const { createLink } = require('./link');
const { createIntentRunner } = require('./intent');
const { createBrain } = require('./body/brain');
const { createMind } = require('./body/mind');
const { createProjectManager } = require('./body/projects');
const { createDiary } = require('./body/diary');
const { createHumanizer } = require('./body/human');
const { createVoice } = require('./body/voice');

function formatEvent(event) {
  if (!event || !event.data) return '';
  const data = event.data;
  if (event.kind === 'chat') return '[chat] ' + data.player + ': ' + data.text;
  if (event.kind === 'join' || event.kind === 'leave') return '[' + event.kind + '] ' + data.player;
  return '[' + event.kind + '] ' + (data.text || '');
}

function createRuntime(options = {}) {
  const config = options.config || loadConfig();
  const log = options.log || console;
  let link = null;
  let mind = null;
  let diary = null;

  const eventHub = createEventHub({
    config,
    log,
    onEvent: (event) => {
      const summary = formatEvent(event);
      if (summary) {
        try {
          const sink = log && (log.info || log.log);
          if (typeof sink === 'function') sink.call(log, summary);
        } catch (_) {
          return;
        }
      }
      if (link) link.sendEvent(event);
    },
  });

  const connection = createConnection({
    config,
    log,
    autoStart: false,
    onBot: (bot) => {
      eventHub.attach(bot);
      try {
        log.log('[bot] created ' + ACCOUNT_NAME + ' (version ' + MC_VERSION + ')');
      } catch (_) {
        return;
      }
    },
    onSpawn: (bot) => {
      const position = bot && bot.entity && bot.entity.position;
      const where = position ? ' at ' + position.x + ',' + position.y + ',' + position.z : '';
      try {
        log.log('[bot] spawned' + where);
      } catch (_) {
        return;
      }
    },
    onEnd: (reason) => {
      try {
        log.warn('[bot] disconnected: ' + reason);
      } catch (_) {
        return;
      }
    },
    onKicked: (reason) => {
      try {
        log.warn('[bot] kicked: ' + reason);
      } catch (_) {
        return;
      }
      eventHub.reportSystem('kicked: ' + reason);
      if (mind) mind.requestWake('kicked');
    },
    onError: (error) => {
      try {
        log.warn('[bot] error: ' + (error && error.message ? error.message : String(error)));
      } catch (_) {
        return;
      }
    },
    onDeath: () => {
      try {
        log.warn('[bot] died');
      } catch (_) {
        return;
      }
      if (mind) mind.requestWake('death');
      if (diary && typeof diary.recordDeath === 'function') diary.recordDeath();
    },
  });

  const autonomy = createAutonomy({ config, connection, eventHub, log });
  // actions 要在 intent 之前建（intent 需要它间接依赖的 link 稍后就绪），
  // 建完后把 intent 引用注入进去，供 mc_plan 工具使用
  const actions = createActions({ config, connection, eventHub, autonomy, log });
  link = createLink({ config, actions, log });
  mind = createMind({
    link,
    config: config.brain && config.brain.mind,
    log,
  });
  const dataDir = path.join(__dirname, '..', 'data');
  const projects = createProjectManager({
    file: path.join(dataDir, 'projects.json'),
    log,
  });
  diary = createDiary({
    file: path.join(dataDir, 'diary.jsonl'),
    log,
  });
  const human = createHumanizer({ config: config.brain && config.brain.human });
  const voice = createVoice({
    eventHub,
    connection,
    config: config.brain && config.brain.voice,
  });

  const intent = createIntentRunner({
    config,
    autonomy,
    log,
    recordDir: path.join(__dirname, '..', 'logs'),
    isCloudReady: () => Boolean(link && typeof link.isConnected === 'function' && link.isConnected()),
    // 空闲时把处境发给云端，由模型决定下一步。模型会自己调 mc_mode，
    // 身体这边只负责等（返回 'awaiting-model'），不重复设置模式。
    decide: async (situation) => {
      if (!link || typeof link.sendEvent !== 'function' || !link.isConnected()) {
        return null; // 云端不在，走兜底轮转
      }
      link.sendEvent({ kind: 'intent', data: situation });
      return 'awaiting-model';
    },
  });

  // 第 1 阶段：新行为层与旧 autonomy 并行运行。默认 shadowMode=true，
  // 只采集感知、走任务栈并写对比日志，不发出任何游戏动作。
  const brain = createBrain({
    config,
    connection,
    legacy: autonomy,
    mind,
    projects,
    diary,
    human,
    voice,
    log,
    recordDir: path.join(__dirname, '..', 'logs'),
  });
  mind.attachBrain(brain);
  mind.setRecorder((event, payload) => brain._record(event, payload));

  // mc_plan / mc_do 工具需要 intent 与 mind 引用
  if (actions && typeof actions.attachIntent === 'function') {
    actions.attachIntent(intent);
  }
  if (actions && typeof actions.attachMind === 'function') {
    actions.attachMind(mind);
  }
  // mc_stop 在实战模式下要能真正清空新行为层的任务栈
  if (actions && typeof actions.attachBrain === 'function') {
    actions.attachBrain(brain);
  }

  // 手动指令（用户下的话）优先于自动计划。
  // 关键：模型响应 intent 时自己调 mc_mode，那不是"人工指令"，不能被标记成 manual
  // ——否则一次人工命令之后自主调度就永久让位，bot 再也不自己做事。
  const originalSetMode = autonomy.setMode.bind(autonomy);
  autonomy.setMode = (mode, args) => {
    const fromModel = intent && typeof intent.consumeModelTurn === 'function' && intent.consumeModelTurn();
    // 模型自己回应的这一次要记账，并结束"等待模型决策"状态，
    // 否则会一直被当成 pending 直到 90 秒超时才继续。
    if (fromModel && intent && typeof intent.onModelDecided === 'function') {
      intent.onModelDecided(mode, args || {});
    }
    if (intent && mode !== 'idle' && !fromModel) {
      intent.setManual(mode, args || {});
    }
    return originalSetMode(mode, args);
  };

  const runtime = {
    config,
    connection,
    eventHub,
    autonomy,
    actions,
    link,
    intent,
    mind,
    projects,
    diary,
    human,
    voice,
    brain,
    start() {
      // shadow 模式：旧状态机执行、新行为层只观察。
      // 非 shadow 模式：新行为层接管，旧状态机和旧调度必须停掉——
      // 否则两边会同时 setControlState / moveTo，互相打断，比任何单边都糟。
      const shadow = brain.shadowMode !== false;
      if (shadow) {
        autonomy.start();
        intent.start();
      } else {
        log.log('[mc_bot] 新行为层接管（shadowMode=false），旧 autonomy/intent 不启动');
      }
      link.start();
      connection.start();
      brain.start();
      return runtime;
    },
    stop() {
      try {
        brain.stop();
      } catch (_) {}
      try {
        link.stop();
      } catch (_) {}
      try {
        intent.stop();
      } catch (_) {}
      try {
        autonomy.stop();
      } catch (_) {}
      try {
        connection.stop();
      } catch (_) {}
    },
  };
  return runtime;
}

function main() {
  const config = loadConfig();
  for (const warning of config._warnings || []) {
    console.warn('[config] ' + warning);
  }

  const runtime = createRuntime({ config });
  runtime.start();
  console.log('[mc_bot] starting as ' + ACCOUNT_NAME + ' with Minecraft version ' + MC_VERSION);
  console.log('[mc_bot] target ' + config.bot.host + ':' + config.bot.port + ', movement=' + config.features.movement);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[mc_bot] shutting down (' + signal + ')');
    runtime.stop();
    setTimeout(() => process.exit(0), 250);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    console.warn('[mc_bot] unhandled rejection: ' + (error && error.message ? error.message : String(error)));
  });
  process.on('uncaughtException', (error) => {
    console.error('[mc_bot] uncaught exception: ' + (error && error.stack ? error.stack : String(error)));
  });

  return runtime;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[mc_bot] startup failed: ' + (error && error.stack ? error.stack : String(error)));
    process.exit(1);
  }
}

module.exports = {
  createRuntime,
  main,
  formatEvent,
};
