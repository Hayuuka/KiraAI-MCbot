'use strict';

function bareName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().split(':').pop();
}

function blockAt(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return null;
  try {
    const Vec3 = bot.entity && bot.entity.position && bot.entity.position.constructor;
    return bot.blockAt(Vec3 ? new Vec3(x, y, z) : { x, y, z });
  } catch (_) {
    return null;
  }
}

function isLiquid(block) {
  const name = bareName(block && block.name);
  return name === 'water' || name === 'flowing_water' ||
    name === 'lava' || name === 'flowing_lava';
}

function isAir(block) {
  const name = bareName(block && block.name);
  return !name || name === 'air' || name === 'cave_air' || name === 'void_air';
}

function isSolid(block) {
  return Boolean(block && !isAir(block) && !isLiquid(block) && block.boundingBox !== 'empty');
}

function isLava(block) {
  const name = bareName(block && block.name);
  return name === 'lava' || name === 'flowing_lava';
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function isStandable(bot, x, y, z) {
  const ground = blockAt(bot, x, y - 1, z);
  const feet = blockAt(bot, x, y, z);
  const head = blockAt(bot, x, y + 1, z);
  return isSolid(ground) && !isLiquid(ground) && isAir(feet) && isAir(head);
}

function nearLava(bot, x, y, z) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (isLava(blockAt(bot, x + dx, y + dy, z + dz))) return true;
      }
    }
  }
  return false;
}

function hasLavaNearby(bot, radius = 2) {
  const position = bot && bot.entity && bot.entity.position;
  if (!position) return false;
  const origin = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
  const limit = Math.max(0, Math.trunc(radius));
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -limit; dx <= limit; dx += 1) {
      for (let dz = -limit; dz <= limit; dz += 1) {
        if (isLava(blockAt(bot, origin.x + dx, origin.y + dy, origin.z + dz))) return true;
      }
    }
  }
  return false;
}

/**
 * 在身体周围找一个可站立的位置。有威胁时优先远离威胁，没有威胁时优先近处。
 * 这里只读方块，不移动 bot。
 */
function findSafeSpot(bot, options = {}) {
  const position = bot && bot.entity && bot.entity.position;
  if (!position) return null;

  const searchRadius = Math.max(2, Math.min(32, Math.trunc(Number(options.searchRadius) || 12)));
  const preferredDistance = Math.max(1, Number(options.preferredDistance) || 6);
  const threats = Array.isArray(options.threats) ? options.threats.filter((item) => item && item.position) : [];
  const origin = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
  let best = null;

  for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
      const horizontal = Math.hypot(dx, dz);
      if (horizontal < 2 || horizontal > searchRadius) continue;
      const x = origin.x + dx;
      const z = origin.z + dz;

      for (let dy = -4; dy <= 4; dy += 1) {
        const y = origin.y + dy;
        if (!isStandable(bot, x, y, z) || nearLava(bot, x, y, z)) continue;

        const candidate = { x, y, z };
        const originDistance = distance(origin, candidate);
        const threatDistance = threats.length
          ? Math.min(...threats.map((threat) => distance(threat.position, candidate)))
          : Infinity;
        const awayScore = Number.isFinite(threatDistance) ? threatDistance * 8 : 0;
        const distanceScore = -Math.abs(originDistance - preferredDistance) * 2;
        const verticalScore = -Math.abs(dy) * 0.5;
        const score = awayScore + distanceScore + verticalScore;
        if (!best || score > best.score) {
          best = {
            x,
            y,
            z,
            score,
            distance: Math.round(originDistance * 10) / 10,
            threatDistance: Number.isFinite(threatDistance)
              ? Math.round(threatDistance * 10) / 10
              : null,
          };
        }
        break;
      }
    }
  }

  return best;
}

module.exports = {
  blockAt,
  isLiquid,
  isAir,
  isSolid,
  isLava,
  isStandable,
  hasLavaNearby,
  findSafeSpot,
  distance,
};
