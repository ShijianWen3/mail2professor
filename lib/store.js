// lib/store.js
// 导师库（agent 的长期记忆）+ 设置读写，全部落在 chrome.storage.local。
//
// 数据结构：
//   professors: { [id]: { id, name, email, school, homepageUrl, tags[], summary,
//                         status, notes[{ts,text}], drafts[{ts,subject,body}],
//                         createdAt, updatedAt } }
//   notes:      [{ ts, text }]   全局笔记（跨导师的研究方向备忘等）
//
// status 用固定英文 key 存储，UI 负责翻译。

export const STATUSES = ['new', 'drafted', 'contacted', 'replied', 'meeting', 'offer', 'declined', 'archived'];

export const SETTING_KEYS = [
  'provider', 'baseUrl', 'model', 'apiKey', 'maxSteps',
  'myName', 'mySchool', 'myBackground', 'lang'
];

export async function getSettings() {
  const data = await chrome.storage.local.get(SETTING_KEYS);
  return data || {};
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

export class Store {
  constructor() {
    this.professors = {};
    this.notes = [];
    this.loaded = false;
  }

  async load() {
    const data = await chrome.storage.local.get(['professors', 'notes']);
    this.professors = data.professors || {};
    this.notes = Array.isArray(data.notes) ? data.notes : [];
    this.loaded = true;
    return this;
  }

  async persist() {
    await chrome.storage.local.set({ professors: this.professors, notes: this.notes });
  }

  list() {
    return Object.values(this.professors).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 按 id / 邮箱 / 姓名定位，姓名支持包含匹配（模型经常只记得姓或名字的写法差异）
  find({ id, name, email } = {}) {
    if (id && this.professors[id]) return this.professors[id];
    const list = this.list();
    if (email) {
      const target = String(email).trim().toLowerCase();
      const hit = list.find((p) => (p.email || '').toLowerCase() === target);
      if (hit) return hit;
    }
    if (name) {
      const target = String(name).trim().toLowerCase();
      if (target) {
        let hit = list.find((p) => (p.name || '').toLowerCase() === target);
        if (!hit) hit = list.find((p) => (p.name || '').toLowerCase().includes(target));
        if (!hit) hit = list.find((p) => target.includes((p.name || '').toLowerCase()) && p.name);
        if (hit) return hit;
      }
    }
    return null;
  }

  upsert(input = {}) {
    const existing = this.find({ id: input.id, name: input.name, email: input.email });
    const now = Date.now();
    const base = existing || {
      id: `p_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: '',
      email: '',
      school: '',
      homepageUrl: '',
      tags: [],
      summary: '',
      status: 'new',
      notes: [],
      drafts: [],
      createdAt: now
    };

    const next = { ...base, updatedAt: now };
    if (input.name) next.name = String(input.name).trim();
    if (input.email) next.email = String(input.email).trim();
    if (input.school) next.school = String(input.school).trim();
    if (input.homepageUrl) next.homepageUrl = String(input.homepageUrl).trim();
    if (input.homepage_url) next.homepageUrl = String(input.homepage_url).trim();
    if (input.summary) next.summary = String(input.summary).trim();
    if (input.status && STATUSES.includes(input.status)) next.status = input.status;
    if (Array.isArray(input.tags) && input.tags.length) {
      const merged = [...(base.tags || []), ...input.tags.map((t) => String(t).trim()).filter(Boolean)];
      next.tags = [...new Set(merged)].slice(0, 12);
    }
    if (input.note) next.notes = [...(base.notes || []), { ts: now, text: String(input.note) }].slice(-40);

    // 合并时必须保留历史（草稿、备注），否则每次 upsert 都会丢记录
    next.notes = next.notes || [];
    next.drafts = base.drafts || [];
    this.professors[next.id] = next;
    return next;
  }

  remove(id) {
    if (!this.professors[id]) return false;
    delete this.professors[id];
    return true;
  }

  addDraft(profId, draft) {
    if (!profId || !this.professors[profId]) return;
    const rec = this.professors[profId];
    rec.drafts = [...(rec.drafts || []), { ts: Date.now(), ...draft }].slice(-10);
    if (rec.status === 'new') rec.status = 'drafted';
    rec.updatedAt = Date.now();
  }

  addNote(text) {
    this.notes = [...this.notes, { ts: Date.now(), text: String(text) }].slice(-50);
  }

  // 给系统提示词用的极简摘要：只给姓名/学校/状态，避免上下文膨胀
  brief() {
    const list = this.list();
    if (!list.length) return '（导师库为空）';
    return list
      .slice(0, 40)
      .map((p) => `- ${p.name || '未命名'}${p.school ? ` @${p.school}` : ''} [${p.status}]${p.email ? ` ${p.email}` : ' 无邮箱'}`)
      .join('\n');
  }
}
