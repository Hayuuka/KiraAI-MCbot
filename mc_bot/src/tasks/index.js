'use strict';

const { IdleTask } = require('./idle');
const { GotoTask } = require('./goto');
const { CollectBlockTask } = require('./collect');
const { EatTask } = require('./eat');
const { HealTask } = require('./heal');
const { FleeTask } = require('./flee');
const { SleepTask } = require('./sleep');
const { ShelterTask } = require('./shelter');
const { FightTask } = require('./fight');
const { GuardTask } = require('./guard');
const { AssistTask } = require('./assist');

const registry = new Map();

function register(TaskClass) {
  if (!TaskClass || !TaskClass.kind) throw new Error('task class requires a kind');
  if (registry.has(TaskClass.kind)) throw new Error('duplicate task kind: ' + TaskClass.kind);
  registry.set(TaskClass.kind, TaskClass);
  return TaskClass;
}

function get(kind) {
  return registry.get(String(kind || '')) || null;
}

function create(kind, args = {}, meta = {}) {
  const TaskClass = get(kind);
  if (!TaskClass) return null;
  return new TaskClass(args, meta);
}

/**
 * 对所有已注册任务调用静态 feasible，只返回现在真的做得到的项。
 * defaults 提供各类任务的默认参数（例如默认砍哪种树、挖多少个）。
 */
function available(ctx = {}, defaults = {}) {
  const output = [];
  for (const TaskClass of registry.values()) {
    const args = defaults[TaskClass.kind] || {};
    let spec = null;
    try {
      spec = TaskClass.feasible({ ...ctx, args });
    } catch (_) {
      spec = null;
    }
    if (!spec) continue;
    output.push({
      kind: TaskClass.kind,
      priority: Number(spec.priority == null ? TaskClass.priority : spec.priority) || 0,
      args: spec.args && typeof spec.args === 'object' ? spec.args : args,
      etaSec: spec.etaSec == null ? null : Number(spec.etaSec),
      note: spec.note || '',
    });
  }
  output.sort((a, b) => b.priority - a.priority);
  return output;
}

function kinds() {
  return Array.from(registry.keys());
}

register(IdleTask);
register(GotoTask);
register(CollectBlockTask);
register(EatTask);
register(HealTask);
register(FleeTask);
register(SleepTask);
register(ShelterTask);
register(FightTask);
register(GuardTask);
register(AssistTask);

module.exports = {
  register,
  get,
  create,
  available,
  can: available,
  kinds,
  IdleTask,
  GotoTask,
  CollectBlockTask,
  EatTask,
  HealTask,
  FleeTask,
  SleepTask,
  ShelterTask,
  FightTask,
  GuardTask,
  AssistTask,
};
