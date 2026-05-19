// 持久化巡检历史记录（JSON 文件存储，跨重启保留）
'use strict';

const fs = require('fs');
const path = require('path');

class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.entries = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[history] load failed:', e.message);
      this.entries = [];
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    } catch (e) {
      console.warn('[history] save failed:', e.message);
    }
  }

  add(entry) {
    // 去重：同一 jobId 只保留最新
    this.entries = this.entries.filter(e => e.jobId !== entry.jobId);
    this.entries.unshift(entry);
    // 最多保留 200 条
    if (this.entries.length > 200) this.entries = this.entries.slice(0, 200);
    this._save();
    return entry;
  }

  list({ userId, limit = 50 } = {}) {
    let result = [...this.entries];
    if (userId) {
      result = result.filter(e => e.oidcUserId === userId || e.oidcUserId == null);
    }
    return result.slice(0, limit);
  }

  get(jobId) {
    return this.entries.find(e => e.jobId === jobId) || null;
  }

  remove(jobId) {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.jobId !== jobId);
    if (this.entries.length < before) {
      this._save();
      return true;
    }
    return false;
  }

  clear(userId) {
    if (userId) {
      this.entries = this.entries.filter(e => e.oidcUserId !== userId);
    } else {
      this.entries = [];
    }
    this._save();
  }
}

module.exports = { HistoryStore };
