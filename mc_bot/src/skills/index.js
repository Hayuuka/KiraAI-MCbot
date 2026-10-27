'use strict';

const move = require('./move');
const follow = require('./follow');
const inventory = require('./inventory');
const mine = require('./mine');
const guard = require('./guard');
const world = require('./world');
const place = require('./place');
const combat = require('./combat');
const mining = require('./mining');

module.exports = {
  move,
  follow,
  inventory,
  mine,
  guard,
  world,
  place,
  combat,
  mining,
  ...move,
  followTick: follow.followTick,
  startFollow: follow.startFollow,
  stopFollow: follow.stopFollow,
  mineBlock: mine.mineBlock,
  mineNearest: mine.mineNearest,
  equipBestTool: inventory.equipBestTool,
  equipBestWeapon: inventory.equipBestWeapon,
  equipBestArmor: inventory.equipBestArmor,
  guardTick: guard.guardTick,
  findNearestHostile: guard.findNearestHostile,
  isHostile: guard.isHostile,
};
