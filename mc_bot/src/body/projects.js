'use strict';

const fs = require('fs');
const path = require('path');

class ProjectManager {
  constructor(options = {}) {
    this.file = options.file || path.resolve(__dirname, '..', '..', 'data', 'projects.json');
    this.log = options.log || console;
    this._ensureFile();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object') return { active: null, backlog: [] };
      return {
        active: data.active && typeof data.active === 'object' ? data.active : null,
        backlog: Array.isArray(data.backlog) ? data.backlog : [],
      };
    } catch (_) {
      return { active: null, backlog: [] };
    }
  }

  save(data) {
    const output = {
      active: data && data.active ? data.active : null,
      backlog: data && Array.isArray(data.backlog) ? data.backlog : [],
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(output, null, 2) + '\n', 'utf8');
    return output;
  }

  getActive() {
    return this.load().active;
  }

  currentStep() {
    const active = this.getActive();
    if (!active || !Array.isArray(active.steps)) return null;
    return active.steps.find((step) => step && step.done !== true) || null;
  }

  recordOutcome(task, outcome) {
    if (outcome !== 'done' || !task || !task.kind) return false;
    const data = this.load();
    if (!data.active || !Array.isArray(data.active.steps)) return false;
    const step = data.active.steps.find((entry) =>
      entry && entry.done !== true && entry.task && String(entry.task.do || '') === String(task.kind)
    );
    if (!step) return false;
    step.done = true;
    step.completedAt = new Date().toISOString();
    this.save(data);
    return true;
  }

  snapshot() {
    const active = this.getActive();
    if (!active) return null;
    const steps = Array.isArray(active.steps) ? active.steps : [];
    const current = steps.find((step) => step && step.done !== true) || null;
    return {
      id: active.id || null,
      title: active.title || '',
      done: steps.filter((step) => step && step.done === true).length,
      total: steps.length,
      next: current && current.task ? current.task : null,
    };
  }

  _ensureFile() {
    if (fs.existsSync(this.file)) return;
    try {
      this.save({ active: null, backlog: [] });
    } catch (error) {
      try {
        const sink = this.log && (this.log.warn || this.log.log);
        if (typeof sink === 'function') sink.call(this.log, '[projects] init failed: ' + (error.message || error));
      } catch (_) {
        return;
      }
    }
  }
}

function createProjectManager(options = {}) {
  return new ProjectManager(options);
}

module.exports = { ProjectManager, createProjectManager };
