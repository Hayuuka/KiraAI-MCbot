'use strict';

const MAX_STATUS_CHARS = 300;

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function normalizeDimension(value) {
  const text = String(value || 'unknown');
  return text.includes(':') ? text : 'minecraft:' + text;
}

function truncateText(value, max) {
  const chars = Array.from(String(value == null ? '' : value));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

function getMoving(bot) {
  try {
    if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function') {
      return Boolean(bot.pathfinder.isMoving());
    }
    const velocity = bot.entity && bot.entity.velocity;
    if (!velocity) return false;
    return Math.abs(velocity.x) + Math.abs(velocity.y) + Math.abs(velocity.z) > 0.05;
  } catch (_) {
    return false;
  }
}

function nearbyPlayers(bot) {
  const players = [];
  try {
    const source = bot.players || {};
    for (const player of Object.values(source)) {
      if (!player || !player.username || player.username === bot.username) continue;
      const entity = player.entity;
      if (!entity || !entity.position) continue;
      const origin = bot.entity.position;
      const distance = Math.sqrt(
        (origin.x - entity.position.x) ** 2 +
        (origin.y - entity.position.y) ** 2 +
        (origin.z - entity.position.z) ** 2
      );
      if (!Number.isFinite(distance) || distance > 32) continue;
      players.push({
        name: truncateText(player.username, 20),
        dist: round1(distance),
      });
    }
  } catch (_) {
    return [];
  }
  players.sort((a, b) => a.dist - b.dist);
  return players.slice(0, 8);
}

function serializedLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function fitStatus(status) {
  const output = { ...status };
  while (serializedLength(output) > MAX_STATUS_CHARS && output.players.length > 0) {
    output.players.pop();
  }
  if (serializedLength(output) > MAX_STATUS_CHARS) {
    output.dim = truncateText(output.dim, 32);
    output.held = output.held ? truncateText(output.held, 32) : output.held;
    output.mode = truncateText(output.mode, 16);
  }
  if (serializedLength(output) > MAX_STATUS_CHARS) {
    output.dim = truncateText(output.dim, 20);
    output.held = output.held ? truncateText(output.held, 20) : output.held;
    output.mode = truncateText(output.mode, 10);
    output.players = [];
  }
  if (serializedLength(output) > MAX_STATUS_CHARS) {
    output.dim = 'unknown';
    output.held = null;
    output.mode = 'idle';
  }
  return output;
}

function buildStatus(bot, ready, mode) {
  const safeMode = truncateText(mode || 'idle', 20);
  if (!bot || !ready || !bot.entity || !bot.entity.position) {
    return {
      ok: true,
      online: false,
      mode: safeMode,
    };
  }

  const position = bot.entity.position;
  const heldItem = bot.heldItem;
  const status = {
    ok: true,
    online: true,
    pos: [round1(position.x), round1(position.y), round1(position.z)],
    dim: normalizeDimension(bot.game && bot.game.dimension),
    hp: Number.isFinite(bot.health) ? bot.health : null,
    food: Number.isFinite(bot.food) ? bot.food : null,
    held: heldItem && heldItem.name ? heldItem.name : null,
    players: nearbyPlayers(bot),
    mode: safeMode,
    moving: getMoving(bot),
  };
  return fitStatus(status);
}

function statusJson(bot, ready, mode) {
  return JSON.stringify(buildStatus(bot, ready, mode));
}

module.exports = {
  MAX_STATUS_CHARS,
  buildStatus,
  statusJson,
  round1,
  truncateText,
};
