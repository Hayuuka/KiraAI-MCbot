'use strict';

const move = require('./move');

const ARMOR_SLOT_INDEX = Object.freeze({ head: 5, torso: 6, legs: 7, feet: 8 });
const ARMOR_SLOTS = Object.freeze(['head', 'torso', 'legs', 'feet']);
const SLOT_ALIASES = Object.freeze({
  head: 'head', helmet: 'head', hat: 'head', 头盔: 'head',
  torso: 'torso', chest: 'torso', chestplate: 'torso', 胸甲: 'torso',
  legs: 'legs', leggings: 'legs', pants: 'legs', 护腿: 'legs', 裤子: 'legs',
  feet: 'feet', boots: 'feet', shoes: 'feet', 靴子: 'feet', 鞋: 'feet',
  hand: 'hand', mainhand: 'hand', 'main-hand': 'hand', 主手: 'hand',
  'off-hand': 'off-hand', offhand: 'off-hand', 副手: 'off-hand',
});

// 模型经常给中文名，指令层先做一层常见别名归一化；找不到时仍会把
// 完整背包列表返回给模型，让它自己纠正。
const ITEM_ALIASES = Object.freeze({
  木头: 'oak_log', 原木: 'oak_log', 木板: 'oak_planks', 木棍: 'stick',
  石头: 'stone', 圆石: 'cobblestone', 泥土: 'dirt', 沙子: 'sand', 沙砾: 'gravel',
  铁: 'iron_ingot', 金: 'gold_ingot', 煤: 'coal', 木炭: 'charcoal', 钻石: 'diamond',
  木镐: 'wooden_pickaxe', 石镐: 'stone_pickaxe', 铁镐: 'iron_pickaxe',
  金镐: 'golden_pickaxe', 钻石镐: 'diamond_pickaxe', 下界合金镐: 'netherite_pickaxe',
  木斧: 'wooden_axe', 石斧: 'stone_axe', 铁斧: 'iron_axe', 金斧: 'golden_axe',
  钻石斧: 'diamond_axe', 下界合金斧: 'netherite_axe',
  木锹: 'wooden_shovel', 石锹: 'stone_shovel', 铁锹: 'iron_shovel',
  金锹: 'golden_shovel', 钻石锹: 'diamond_shovel', 下界合金锹: 'netherite_shovel',
  木剑: 'wooden_sword', 石剑: 'stone_sword', 铁剑: 'iron_sword',
  金剑: 'golden_sword', 钻石剑: 'diamond_sword', 下界合金剑: 'netherite_sword',
  皮革头盔: 'leather_helmet', 皮头盔: 'leather_helmet', 铁头盔: 'iron_helmet',
  金头盔: 'golden_helmet', 钻石头盔: 'diamond_helmet', 下界合金头盔: 'netherite_helmet',
  皮革胸甲: 'leather_chestplate', 皮甲: 'leather_chestplate', 铁胸甲: 'iron_chestplate',
  金胸甲: 'golden_chestplate', 钻石胸甲: 'diamond_chestplate', 下界合金胸甲: 'netherite_chestplate',
  皮革护腿: 'leather_leggings', 皮裤: 'leather_leggings', 铁护腿: 'iron_leggings',
  金护腿: 'golden_leggings', 钻石护腿: 'diamond_leggings', 下界合金护腿: 'netherite_leggings',
  皮革靴子: 'leather_boots', 皮鞋: 'leather_boots', 铁靴子: 'iron_boots',
  金靴子: 'golden_boots', 钻石靴子: 'diamond_boots', 下界合金靴子: 'netherite_boots',
  盾牌: 'shield', 面包: 'bread', 熟牛肉: 'cooked_beef', 生牛肉: 'beef',
  熟猪肉: 'cooked_porkchop', 生猪排: 'porkchop', 熟鸡肉: 'cooked_chicken',
  生鸡肉: 'chicken', 苹果: 'apple', 金苹果: 'golden_apple',
  火把: 'torch', 床: 'bed',
});

const FOOD_NAMES = new Set([
  'apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'carrot',
  'golden_carrot', 'potato', 'baked_potato', 'poisonous_potato', 'beetroot',
  'beetroot_soup', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop',
  'cooked_chicken', 'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit',
  'rabbit', 'rabbit_stew', 'cooked_cod', 'cod', 'cooked_salmon', 'salmon',
  'tropical_fish', 'pufferfish', 'melon_slice', 'sweet_berries',
  'glow_berries', 'dried_kelp', 'cookie', 'pumpkin_pie', 'mushroom_stew',
  'suspicious_stew', 'honey_bottle',
]);

const TIER_SCORE = Object.freeze({
  wooden: 10,
  golden: 20,
  stone: 30,
  iron: 40,
  diamond: 60,
  netherite: 70,
});

function normalizeItemName(value) {
  let name = String(value == null ? '' : value).trim().toLowerCase();
  if (!name) return '';
  if (ITEM_ALIASES[name]) return ITEM_ALIASES[name];
  name = name.replace(/^minecraft:/, '').replace(/\s+/g, '_');
  return ITEM_ALIASES[name] || name;
}

function itemName(item) {
  return normalizeItemName(item && item.name);
}

function inventoryItems(bot) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return [];
    return bot.inventory.items().filter((item) => item && item.name);
  } catch (_) {
    return [];
  }
}

function itemMatches(item, wanted) {
  const name = itemName(item);
  const target = normalizeItemName(wanted);
  if (!name || !target) return false;
  if (target === 'bed') return /_bed$/.test(name);
  if (target.startsWith('#')) {
    const spec = move.expandBlockTarget(target);
    if (!spec) return false;
    const full = move.normalizeBlockName(name);
    if (spec.exact) return full === spec.exact;
    if (spec.members) return spec.members.includes(full);
    if (spec.suffix) return name.includes(spec.suffix);
    return false;
  }
  return name === target;
}

function findItems(bot, name) {
  return inventoryItems(bot).filter((item) => itemMatches(item, name));
}

function findItem(bot, name) {
  return findItems(bot, name)[0] || null;
}

function count(bot, name) {
  try {
    return findItems(bot, name).reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  } catch (_) {
    return 0;
  }
}

function foodScore(item, bot) {
  const name = itemName(item);
  if (!name) return -1;
  if (name === 'enchanted_golden_apple') return -100;
  if (name === 'golden_apple') return -50;
  try {
    const food = bot && bot.registry && bot.registry.foodsByName
      ? bot.registry.foodsByName[name]
      : null;
    if (food) return Number(food.effectiveQuality) || Number(food.foodPoints) || 1;
  } catch (_) {}
  return FOOD_NAMES.has(name) ? 1 : -1;
}

function findFood(bot) {
  return inventoryItems(bot)
    .filter((item) => FOOD_NAMES.has(itemName(item)) || foodScore(item, bot) >= 0)
    .sort((a, b) => foodScore(b, bot) - foodScore(a, bot))[0] || null;
}

function tierOf(name) {
  const text = normalizeItemName(name);
  const match = text.match(/^(wooden|golden|stone|iron|diamond|netherite)_/);
  return match ? match[1] : '';
}

function toolTypeOf(name) {
  const text = normalizeItemName(name);
  const match = text.match(/(pickaxe|shears|shovel|sword|hoe|axe)$/);
  return match ? match[1] : '';
}

function weaponScore(item) {
  const name = itemName(item);
  if (!name) return 0;
  const tier = TIER_SCORE[tierOf(name)] || 0;
  if (/_sword$/.test(name)) return tier * 10 + 8;
  if (/_axe$/.test(name)) return tier * 10 + 4;
  if (name === 'trident') return 58;
  if (name === 'mace') return 62;
  if (name === 'bow' || name === 'crossbow') return 35;
  return 0;
}

function armorSlotOf(name) {
  const text = normalizeItemName(name);
  if (/_helmet$/.test(text)) return 'head';
  if (/_chestplate$/.test(text) || text === 'elytra') return 'torso';
  if (/_leggings$/.test(text)) return 'legs';
  if (/_boots$/.test(text)) return 'feet';
  return '';
}

function armorScore(item) {
  const name = itemName(item);
  const tier = TIER_SCORE[tierOf(name)] || 0;
  if (!armorSlotOf(name)) return -1;
  return tier * 10 + (name === 'turtle_helmet' ? 5 : 0);
}

function normalizeSlot(slot) {
  const key = String(slot == null ? '' : slot).trim().toLowerCase();
  return SLOT_ALIASES[key] || '';
}

function armorSlotIndex(slot) {
  return ARMOR_SLOT_INDEX[normalizeSlot(slot)] ?? null;
}

function getEquippedItem(bot, slot) {
  const wanted = normalizeSlot(slot);
  if (!wanted) return null;
  try {
    if (wanted === 'hand' && bot.heldItem) return bot.heldItem;
    if (wanted === 'off-hand' && bot.inventory && bot.inventory.slots) {
      return bot.inventory.slots[45] || null;
    }
    const index = ARMOR_SLOT_INDEX[wanted];
    if (index != null && bot.inventory && Array.isArray(bot.inventory.slots)) {
      return bot.inventory.slots[index] || null;
    }
    if (bot.entity && Array.isArray(bot.entity.equipment)) {
      const equipmentIndex = { hand: 0, 'off-hand': 1, feet: 2, legs: 3, torso: 4, head: 5 }[wanted];
      if (equipmentIndex != null) return bot.entity.equipment[equipmentIndex] || null;
    }
  } catch (_) {}
  return null;
}

function selectorToolType(selector) {
  const text = String(selector == null ? '' : selector).toLowerCase();
  if (/log|wood|plank|stem|#.*wood/.test(text)) return 'axe';
  if (/ore|stone|deepslate|cobble|obsidian|ancient_debris/.test(text)) return 'pickaxe';
  if (/dirt|sand|gravel|clay|snow|soul_soil|mud/.test(text)) return 'shovel';
  if (/leaf|leaves|wool|vine|moss/.test(text)) return 'hoe';
  return '';
}

function blockToolRequirements(bot, block) {
  if (typeof block === 'string') {
    const type = selectorToolType(block);
    return { types: type ? [type] : [], required: false };
  }
  if (!block) return { types: [], required: false };

  const types = new Set();
  const harvestIds = block.harvestTools && typeof block.harvestTools === 'object'
    ? Object.keys(block.harvestTools)
    : [];
  const registryItems = bot && bot.registry && bot.registry.items;
  if (registryItems) {
    for (const id of harvestIds) {
      const tool = registryItems[id] || registryItems[Number(id)];
      const type = tool && toolTypeOf(tool.name);
      if (type) types.add(type);
    }
  }

  const material = String(block.material || '').toLowerCase();
  for (const type of ['pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'sword']) {
    if (material.includes('mineable/' + type)) types.add(type);
  }
  if (!types.size) {
    const type = selectorToolType(block.name || '');
    if (type) types.add(type);
  }
  return { types: Array.from(types), required: harvestIds.length > 0 };
}

function canHarvestWith(block, item) {
  if (!block || typeof block !== 'object' || !block.harvestTools || !item) return true;
  const type = Number(item.type);
  return Boolean(block.harvestTools[type] || block.harvestTools[String(type)] || block.harvestTools[item.type]);
}

function bestToolFromItems(bot, block) {
  const requirement = blockToolRequirements(bot, block);
  if (!requirement.types.length && !requirement.required) return { best: null, requirement };
  const candidates = inventoryItems(bot)
    .filter((item) => !requirement.types.length || requirement.types.includes(toolTypeOf(item.name)))
    .filter((item) => canHarvestWith(block, item))
    .sort((a, b) => {
      const tierDiff = (TIER_SCORE[tierOf(b.name)] || 0) - (TIER_SCORE[tierOf(a.name)] || 0);
      if (tierDiff) return tierDiff;
      return String(a.name).localeCompare(String(b.name));
    });
  return { best: candidates[0] || null, requirement };
}

function bestToolForBlock(bot, block) {
  return bestToolFromItems(bot, block);
}

async function equipBestTool(bot, block) {
  try {
    if (!bot) return false;
    const { best, requirement } = bestToolFromItems(bot, block);
    if (!best) return !requirement.required;

    const held = getEquippedItem(bot, 'hand');
    if (held && itemName(held) === itemName(best)) return true;

    // 手上已经有同类且更高档的工具时不要降级。
    const heldType = toolTypeOf(held && held.name);
    const heldTier = TIER_SCORE[tierOf(held && held.name)] || 0;
    const bestTier = TIER_SCORE[tierOf(best.name)] || 0;
    if (requirement.types.includes(heldType) && canHarvestWith(block, held) && heldTier >= bestTier) return true;

    await bot.equip(best, 'hand');
    return true;
  } catch (_) {
    return false;
  }
}

async function equipBestWeapon(bot) {
  try {
    const candidates = inventoryItems(bot)
      .filter((item) => weaponScore(item) > 0)
      .sort((a, b) => weaponScore(b) - weaponScore(a));
    const best = candidates[0];
    if (!best) return true;
    const held = getEquippedItem(bot, 'hand');
    if (held && itemName(held) === itemName(best)) return true;
    await bot.equip(best, 'hand');
    return true;
  } catch (_) {
    return false;
  }
}

async function equipBestArmor(bot) {
  try {
    if (!bot) return false;
    let ok = true;
    for (const slot of ARMOR_SLOTS) {
      const candidates = inventoryItems(bot)
        .filter((item) => armorSlotOf(item.name) === slot)
        .sort((a, b) => armorScore(b) - armorScore(a));
      const best = candidates[0];
      if (!best) continue;
      const current = getEquippedItem(bot, slot);
      if (current && itemName(current) === itemName(best)) continue;
      if (current && armorScore(current) >= armorScore(best)) continue;
      try {
        await bot.equip(best, slot);
      } catch (_) {
        ok = false;
      }
    }
    return ok;
  } catch (_) {
    return false;
  }
}

async function waitTicks(bot, ticks = 2) {
  try {
    if (bot && typeof bot.waitForTicks === 'function') await bot.waitForTicks(ticks);
  } catch (_) {}
}

function uniqueItemNames(bot) {
  return Array.from(new Set(inventoryItems(bot).map(itemName).filter(Boolean))).sort();
}

async function dropItem(bot, name, requestedCount) {
  try {
    if (!bot) return { ok: false, error: 'bot offline' };
    const wanted = normalizeItemName(name);
    if (!wanted) return { ok: false, error: 'item is required' };
    const all = requestedCount === undefined
      || requestedCount === null
      || String(requestedCount).toLowerCase() === 'all';
    const requested = all ? null : Math.max(1, Math.trunc(Number(requestedCount) || 1));
    const before = count(bot, wanted);
    if (before <= 0) {
      return { ok: false, error: `背包里没有 ${wanted}`, available: uniqueItemNames(bot) };
    }

    let toDrop = requested;
    let lastMoved = 0;
    while (all || toDrop > 0) {
      const item = findItem(bot, wanted);
      if (!item) break;
      const available = Math.max(1, Number(item.count) || 1);
      const amount = all ? available : Math.min(toDrop, available);
      const beforeDrop = count(bot, wanted);
      if (amount >= available) await bot.tossStack(item);
      else await bot.toss(item.type, null, amount);
      await waitTicks(bot, 2);
      const afterDrop = count(bot, wanted);
      const moved = Math.max(0, beforeDrop - afterDrop);
      lastMoved += moved;
      if (moved <= 0) break;
      if (!all) toDrop -= moved;
      if (lastMoved > before + 1) break;
    }

    const remaining = count(bot, wanted);
    const dropped = Math.max(0, before - remaining);
    if (dropped <= 0) {
      return { ok: false, error: '丢出后背包没有变化（可能被服务器拒绝）', remaining };
    }
    return {
      ok: true,
      dropped: wanted,
      count: dropped,
      remaining,
      requested: all ? 'all' : requested,
    };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  ARMOR_SLOT_INDEX,
  ARMOR_SLOTS,
  FOOD_NAMES,
  normalizeItemName,
  normalizeSlot,
  armorSlotIndex,
  armorSlotOf,
  getEquippedItem,
  inventoryItems,
  findItem,
  findItems,
  count,
  findFood,
  equipBestTool,
  equipBestWeapon,
  equipBestArmor,
  dropItem,
  uniqueItemNames,
  weaponScore,
  armorScore,
  toolTypeOf,
  canHarvestWith,
  bestToolForBlock,
};
