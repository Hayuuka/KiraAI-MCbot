'use strict';

const DEFAULTS = Object.freeze({
  hunger: {
    triggerFood: 6,
    lowHpTriggerFood: 18,
    lowHp: 18,
    satisfiedFood: 18,
  },
  health: {
    triggerHpRatio: 0.3,
    satisfiedHpRatio: 0.7,
  },
  night: {
    preDuskTicks: 1200,
  },
});

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function merge(base, extra) {
  const output = { ...base };
  if (!extra || typeof extra !== 'object') return output;
  for (const [key, value] of Object.entries(extra)) {
    output[key] = value && typeof value === 'object' && base[key]
      ? merge(base[key], value)
      : value;
  }
  return output;
}

class DriveSystem {
  constructor(options = {}) {
    const source = options.config || options || {};
    this.config = merge(DEFAULTS, source);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.state = {
      hunger: { active: false, value: 0, triggeredAt: null, updatedAt: null },
      health: { active: false, value: 0, triggeredAt: null, updatedAt: null },
      night: { active: false, value: 0, triggeredAt: null, updatedAt: null },
    };
    this._lastSnapshot = null;
  }

  update(perception, now = this.now()) {
    const self = perception && perception.self ? perception.self : {};
    const world = perception && perception.world ? perception.world : {};
    const counts = perception && perception.inventory && perception.inventory.counts
      ? perception.inventory.counts
      : {};
    const hungerConfig = this.config.hunger;
    const healthConfig = this.config.health;
    const nightConfig = this.config.night;

    const food = numberOr(self.food, 20);
    const hp = numberOr(self.hp, 20);
    const hpRatio = Math.max(0, Math.min(1, hp / 20));
    const hungerTrigger = food <= hungerConfig.triggerFood ||
      (food <= hungerConfig.lowHpTriggerFood && hp < hungerConfig.lowHp);
    this._apply('hunger', hungerTrigger, food >= hungerConfig.satisfiedFood, 1 - food / 20, now);
    this._apply(
      'health',
      hpRatio < healthConfig.triggerHpRatio,
      hpRatio >= healthConfig.satisfiedHpRatio,
      1 - hpRatio,
      now
    );

    const hasBed = Object.keys(counts).some((name) => /_bed$/.test(name));
    const isDay = world.isDay;
    const ticksToDusk = numberOr(world.ticksToDusk, 0);
    const nightTrigger = !world.underground && (
      isDay === false || (isDay === true && ticksToDusk <= nightConfig.preDuskTicks)
    );
    const nightSatisfied = isDay === true && ticksToDusk > nightConfig.preDuskTicks;
    const nightValue = isDay === false ? 1 : Math.max(0, 1 - ticksToDusk / 13000);
    this._apply('night', nightTrigger, nightSatisfied, nightValue, now, { hasBed });

    this._lastSnapshot = {
      hunger: { ...this.state.hunger },
      health: { ...this.state.health },
      night: { ...this.state.night, hasBed },
      urgent: this.urgent(),
    };
    return this.snapshot();
  }

  get(name) {
    return this.state[name] || null;
  }

  urgent() {
    const order = ['night', 'health', 'hunger'];
    return order.filter((name) => this.state[name] && this.state[name].active);
  }

  snapshot() {
    if (!this._lastSnapshot) {
      return {
        hunger: { ...this.state.hunger },
        health: { ...this.state.health },
        night: { ...this.state.night },
        urgent: this.urgent(),
      };
    }
    return {
      hunger: { ...this._lastSnapshot.hunger },
      health: { ...this._lastSnapshot.health },
      night: { ...this._lastSnapshot.night },
      urgent: this._lastSnapshot.urgent.slice(),
    };
  }

  _apply(name, trigger, satisfied, value, now, extra = {}) {
    const drive = this.state[name];
    if (!drive.active && trigger) {
      drive.active = true;
      drive.triggeredAt = now;
    } else if (drive.active && satisfied) {
      drive.active = false;
      drive.triggeredAt = null;
    }
    drive.value = Math.max(0, Math.min(1, Number(value) || 0));
    drive.updatedAt = now;
    Object.assign(drive, extra);
  }
}

function createDrives(options = {}) {
  return new DriveSystem(options);
}

module.exports = {
  DriveSystem,
  createDrives,
  DEFAULTS,
};
