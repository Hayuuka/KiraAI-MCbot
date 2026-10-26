#!/usr/bin/env node
/**
 * 一键启动：ViaProxy → SSH 隧道 → mc_bot
 *
 * 不是开机自启，只是双击/一条命令拉起全部进程。
 * 按 Ctrl-C 会把三个子进程一起收掉。
 *
 * 各组件的关系：
 *   ViaProxy  把 26.1 客户端翻译成 26.2 服务端能懂的协议，监听 127.0.0.1:25568
 *   SSH 隧道  把云端 KiraAI 的 5267 映射到本机 15267（mc_bot 通过它访问插件）
 *   mc_bot    mineflayer 身体，连 25568，同时轮询 15267
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = __dirname;
const VIA_DIR = path.join(ROOT, 'runtime', 'viaproxy');
const BOT_DIR = path.join(ROOT, 'mc_bot');

const SSH_KEY = process.env.MC_SSH_KEY || path.join(process.env.USERPROFILE || '', '.ssh', 'codex_vps_ed25519_v2');
const SSH_HOST = process.env.MC_SSH_HOST || 'root@120.26.117.155';
const LOCAL_TUNNEL_PORT = 15267;
const REMOTE_PORT = 5267;

const children = [];
let shuttingDown = false;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function log(tag, line) {
  const text = String(line).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!text) return;
  for (const row of text.split('\n')) {
    console.log(`[${stamp()}] [${tag}] ${row}`);
  }
}

function track(name, child) {
  children.push({ name, child });
  child.stdout && child.stdout.on('data', (d) => log(name, d));
  child.stderr && child.stderr.on('data', (d) => log(name, d));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(name, `进程退出 code=${code} signal=${signal}`);
  });
  return child;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port, label, timeoutMs = 90000, childRef = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childRef && childRef.exited) {
      log('start', `${label} 进程已退出，启动失败`);
      return false;
    }
    if (await portOpen(port)) {
      log('start', `${label} 就绪（端口 ${port}）`);
      return true;
    }
    await sleep(1000);
  }
  log('start', `${label} 等待超时（端口 ${port}）`);
  return false;
}

// ---------------------------------------------------------------------

function startViaProxy() {
  if (!fs.existsSync(path.join(VIA_DIR, 'ViaProxy.jar'))) {
    log('start', `找不到 ViaProxy.jar：${VIA_DIR}`);
    return null;
  }
  // Java 读不了中文绝对路径，cwd 必须是 jar 所在目录且只传相对名
  const child = spawn('java', ['-jar', 'ViaProxy.jar', 'config', 'viaproxy.yml'], {
    cwd: VIA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log('start', 'ViaProxy 启动中…');
  const tracked = track('viaproxy', child);

  // 记录异常退出，供 waitForPort 判断"端口通了但不是我们起的"这种情况
  tracked.exited = false;
  child.on('exit', () => {
    tracked.exited = true;
  });
  return tracked;
}

/**
 * SSH 隧道。断线后自动重连——之前手动跑的时候断网就得手动重开。
 */
function startTunnel() {
  if (!fs.existsSync(SSH_KEY)) {
    log('start', `找不到 SSH 密钥：${SSH_KEY}（可用 MC_SSH_KEY 覆盖）`);
    return null;
  }
  let child = null;
  let stopped = false;

  const launch = () => {
    if (stopped) return;
    child = spawn(
      'ssh',
      [
        '-N',
        '-L', `${LOCAL_TUNNEL_PORT}:127.0.0.1:${REMOTE_PORT}`,
        '-i', SSH_KEY,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'BatchMode=yes',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        SSH_HOST,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    child.stderr.on('data', (d) => log('tunnel', d));
    child.on('exit', (code) => {
      if (stopped) return;
      log('tunnel', `连接断开（code=${code}），3 秒后重连`);
      setTimeout(launch, 3000);
    });
  };

  launch();
  log('start', 'SSH 隧道启动中…');
  return {
    name: 'tunnel',
    kill() {
      stopped = true;
      if (child) try { child.kill(); } catch (_) {}
    },
  };
}

function startBot() {
  if (!fs.existsSync(path.join(BOT_DIR, 'node_modules', 'mineflayer', 'package.json'))) {
    log('start', 'mc_bot 依赖缺失，请先在 mc_bot 目录运行 npm install');
    return null;
  }
  const child = spawn(process.execPath, [path.join('src', 'index.js')], {
    cwd: BOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log('start', 'mc_bot 启动中…');
  return track('mc_bot', child);
}

// ---------------------------------------------------------------------

async function main() {
  console.log('=== KiraAI Minecraft 身体 · 一键启动 ===\n');

  // 0. 端口预检：如果已被占用，说明有旧实例在跑，先提示而不是硬启动
  const busy = [];
  if (await portOpen(25568)) busy.push('25568（ViaProxy）');
  if (await portOpen(LOCAL_TUNNEL_PORT)) busy.push(`${LOCAL_TUNNEL_PORT}（SSH 隧道）`);
  if (busy.length) {
    console.error('以下端口已被占用，可能已有实例在运行：');
    for (const item of busy) console.error('  - ' + item);
    console.error('\n请先关掉旧的窗口/进程，或直接使用正在运行的那一份。');
    process.exit(1);
  }

  // 1. ViaProxy
  const via = startViaProxy();
  if (!via) {
    console.error('\nViaProxy 无法启动，中止。');
    process.exit(1);
  }
  if (!(await waitForPort(25568, 'ViaProxy', 90000, via))) {
    console.error('\nViaProxy 没起来，检查 runtime/viaproxy/logs/ 下的日志。');
    shutdown();
    process.exit(1);
  }

  // 2. 隧道
  const tunnel = startTunnel();
  if (tunnel) {
    if (!(await waitForPort(LOCAL_TUNNEL_PORT, 'SSH 隧道', 30000))) {
      log('start', '隧道未就绪，mc_bot 会一直重试；请检查密钥和网络');
    }
  }

  // 3. bot
  await sleep(1000);
  startBot();

  console.log('\n=== 全部启动完成，Ctrl-C 退出 ===\n');
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在关闭…');
  for (const entry of children) {
    try {
      entry.child.kill();
    } catch (_) {}
  }
}

process.on('SIGINT', () => {
  shutdown();
  setTimeout(() => process.exit(0), 1500);
});
process.on('SIGTERM', () => {
  shutdown();
  setTimeout(() => process.exit(0), 1500);
});

main().catch((error) => {
  console.error('启动失败：', error);
  shutdown();
  process.exit(1);
});
