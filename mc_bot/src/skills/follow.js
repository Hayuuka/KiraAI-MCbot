'use strict';

const { Movements, goals } = require('mineflayer-pathfinder');
const { findPlayer, positionDistance, round1 } = require('./move');

function errorText(error) {
  if (!error) return 'unknown error';
  return error.message || String(error);
}

function ensurePathfinder(bot) {
  if (!bot || !bot.pathfinder) throw new Error('pathfinder is not loaded');
  if (!bot._mcMovements) {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot._mcMovements = movements;
  }
  bot.pathfinder.setMovements(bot._mcMovements);
}

function isPlayerVisible(bot, name) {
  const player = findPlayer(bot, name);
  return Boolean(player && player.entity && player.entity.position);
}

function followTick(bot, name, options = {}) {
  try {
    if (!bot || !bot.entity || !bot.entity.position) return { ok: false, error: 'bot offline' };
    const player = findPlayer(bot, name);
    if (!player) return { ok: false, error: 'player not found: ' + name };
    if (!player.entity || !player.entity.position) return { ok: false, error: 'player not visible: ' + name };

    const distance = Math.max(1, Number(options.distance) || 2);
    const gap = positionDistance(bot.entity.position, player.entity.position);
    if (gap <= distance + 0.6) {
      if (bot._mcFollowGoal) {
        bot.pathfinder.setGoal(null);
        bot._mcFollowGoal = null;
      }
      return { ok: true, player: player.username, dist: round1(gap), inRange: true };
    }

    ensurePathfinder(bot);
    if (!bot._mcFollowGoal || bot._mcFollowGoal.entity !== player.entity) {
      bot._mcFollowGoal = new goals.GoalFollow(player.entity, distance);
      bot.pathfinder.setGoal(bot._mcFollowGoal, true);
    } else if (!bot.pathfinder.isMoving()) {
      bot.pathfinder.setGoal(bot._mcFollowGoal, true);
    }

    return { ok: true, player: player.username, dist: round1(gap), inRange: false };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function startFollow(bot, name, options = {}) {
  const visible = isPlayerVisible(bot, name);
  if (!visible) return { ok: false, error: 'player not visible: ' + String(name || '') };
  return followTick(bot, name, options);
}

function stopFollow(bot) {
  try {
    if (bot) {
      bot._mcFollowGoal = null;
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

module.exports = {
  followTick,
  startFollow,
  stopFollow,
  isPlayerVisible,
};
