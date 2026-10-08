// lib/store.js
// 持久层：读写在 chrome.storage.local，导师库 + 设置 + 个人资料。
//
// 存储结构（v3）：
//   llm:        { provider, baseUrl, model, apiKey, maxSteps }
//   profile:    { name, school, major, gpaRank, awards, skills, research, email, phone }
//   lang:       'zh' | 'en'
//   professors: { [id]: {...} }   导师库
//   notes:      [...]
//
// 为什么用「两个大对象」而不是一堆扁平 key：
// 扁平 key 需要维护一份 key 列表，新增字段时漏加一个就变成"输入了但存不上"（这正是
// 个人资料曾经踩过的坑）。现在读用 get(null) 全量读、写整对象覆盖，加字段只改 PROFILE_FIELDS。
//
// 另外：写完之后会读回校验（verifyWrite），失败就把错误抛给界面显示，
// 不再出现"明明没存上却显示 ✓ 已保存"。

export const STATUSES = ['new', 'drafted', 'contacted', 'replied', 'meeting', 'offer', 'declined', 'archived'];

export const DEFAULT_MAX_STEPS = 12;

// 个人资料字段定义：UI 表单、完整度统计、喂给模型的画像都从这里生成，
// 以后想加字段（比如"意向方向"）只在这张表里加一行。
export const PROFILE_FIELDS = [
  {
    key: 'name',
    label: { zh: '姓名', en: 'Name' },
    placeholder: { zh: '张三', en: 'Zhang San' },
    core: true
  },
  {
    key: 'school',
    label: { zh: '本科院校', en: 'School' },
    placeholder: { zh: 'XX大学', en: 'XX University' },
    core: true
  },
  {
    key: 'major',
    label: { zh: '专业', en: 'Major' },
    placeholder: { zh: '计算机科学与技术', en: 'Computer Science' },
    core: true
  },
  {
    key: 'gpaRank',
    label: { zh: '成绩 / 排名', en: 'GPA / Rank' },
    placeholder: { zh: 'GPA 3.9/4.0，专业前 3%（2/65）', en: 'GPA 3.9/4.0, top 3% (2/65)' },
    hint: { zh: '排名是导师最关心的信息之一，能写就写', en: 'Rank matters a lot to professors — include it if you can' },
    core: true
  },
  {
    key: 'awards',
    label: { zh: '竞赛奖项', en: 'Awards' },
    type: 'textarea',
    placeholder: {
      zh: 'ACM-ICPC 区域赛银奖；全国大学生数学建模竞赛省一等奖；国家奖学金',
      en: 'ICPC regional silver; national math modeling contest (provincial first prize); national scholarship'
    }
  },
  {
    key: 'skills',
    label: { zh: '科研技能', en: 'Skills' },
    type: 'textarea',
    placeholder: {
      zh: 'PyTorch / HuggingFace / LaTeX / Linux；英语 CET-6 580；熟悉 Transformer 与分布式训练',
      en: 'PyTorch, HuggingFace, LaTeX, Linux; CET-6 580; familiar with Transformers and distributed training'
    }
  },
  {
    key: 'research',
    label: { zh: '科研经历', en: 'Research Experience' },
    type: 'textarea',
    placeholder: {
      zh: '国家级大创一项（NLP 方向，负责人）；一作论文投稿中；在实验室做过检索增强生成',
      en: 'Led a national-level undergrad research project on NLP; first-author paper under review'
    }
  },
  {
    key: 'email',
    label: { zh: '联系邮箱', en: 'Contact Email' },
    placeholder: { zh: 'you@example.edu', en: 'you@example.edu' },
    hint: { zh: '会写进邮件落款，方便导师回信', en: 'Goes into the email signature' }
  },
  {
    key: 'phone',
    label: { zh: '联系电话', en: 'Phone' },
    placeholder: { zh: '138…（可留空）', en: 'optional' }
  }
];

export function emptyProfile() {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, '']));
}

// llm 的结构：provider（当前选中的厂商）+ maxSteps（全局）+ perProvider（各厂商自己的配置）
//   perProvider: { deepseek: { apiKey, baseUrl, model }, openai: {...} }
// 每个厂商一套 key / baseUrl / model，切来切去互不影响。
export function emptyLlm() {
  return { provider: 'deepseek', maxSteps: DEFAULT_MAX_STEPS, perProvider: {} };
}

// 资料完整度：主页要显示"还缺什么"
export function profileCompleteness(profile = {}) {
  const filled = PROFILE_FIELDS.filter((f) => String(profile[f.key] || '').trim());
  const missingCore = PROFILE_FIELDS.filter((f) => f.core && !String(profile[f.key] || '').trim()).map((f) => f.key);
  return {
    filled: filled.length,
    total: PROFILE_FIELDS.length,
    missingCore,
    missing: PROFILE_FIELDS.filter((f) => !String(profile[f.key] || '').trim()).map((f) => f.key)
  };
}

// 把任意历史版本的数据整理成当前结构。纯函数，方便单测。
//
// 历史上出现过三种形状：
//   2.0 及以前：一级扁平 key（apiKey / modelProvider / myName / myBackground …）
//   2.1：       llm = { provider, baseUrl, model, apiKey, maxSteps }   ← 单套 key，切厂商会互相覆盖
//   2.2：       llm = { provider, maxSteps, perProvider: { 厂商: { apiKey, baseUrl, model } } }
export function migrate(raw = {}) {
  const llm = emptyLlm();
  const perProvider = {};

  const oldLlm = raw.llm && typeof raw.llm === 'object' ? raw.llm : null;
  const flat = oldLlm ? {} : raw; // 只有不存在 llm 对象时，才去读上一层的扁平字段
  const pick = (name) => (oldLlm ? oldLlm[name] : flat[name]);

  const provider = pick('provider') || pick('modelProvider') || llm.provider;
  llm.provider = provider;
  llm.maxSteps = Number(pick('maxSteps')) || DEFAULT_MAX_STEPS;

  // 已经是按厂商存的，原样搬过来
  for (const [name, slot] of Object.entries(oldLlm?.perProvider || {})) {
    if (slot && typeof slot === 'object') perProvider[name] = { ...slot };
  }

  // 旧的"单套 key"落到它当时对应的厂商名下（已有值就不覆盖）
  const slot = { ...(perProvider[provider] || {}) };
  const legacyApiKey = pick('apiKey');
  const legacyBaseUrl = pick('baseUrl');
  const legacyModel = pick('model');
  if (legacyApiKey && !slot.apiKey) slot.apiKey = legacyApiKey;
  if (legacyBaseUrl && !slot.baseUrl) slot.baseUrl = legacyBaseUrl;
  if (legacyModel && !slot.model) slot.model = legacyModel;
  if (Object.keys(slot).length) perProvider[provider] = slot;
  llm.perProvider = perProvider;

  const profile = { ...emptyProfile(), ...(raw.profile || {}) };
  if (!raw.profile) {
    if (raw.myName) profile.name = raw.myName;
    if (raw.mySchool) profile.school = raw.mySchool;
    if (raw.myBackground) profile.research = raw.myBackground;
  }

  return {
    llm,
    profile,
    lang: raw.lang === 'en' ? 'en' : 'zh',
    professors: raw.professors && typeof raw.professors === 'object' ? raw.professors : {},
    notes: Array.isArray(raw.notes) ? raw.notes : []
  };
}

// 顺序无关的序列化：chrome.storage 读回时会把对象 key 按字母序重排，
// 所以校验写入是否成功不能用裸 JSON.stringify 比对（会天天误报"保存失败"）。
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const parts = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readRaw() {
  const data = await chrome.storage.local.get(null);
  return data || {};
}

// 写入并读回校验：storage 真出问题时必须让用户看见，而不是显示一个假的 ✓
async function writeVerified(patch) {
  await chrome.storage.local.set(patch);
  const back = await readRaw();
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object') {
      if (stableStringify(back[key]) !== stableStringify(value)) {
        throw new Error(`保存 ${key} 后校验失败，浏览器没有真正写入`);
      }
    } else if (back[key] !== value) {
      throw new Error(`保存 ${key} 后校验失败，浏览器没有真正写入`);
    }
  }
  return back;
}

export async function loadState() {
  return migrate(await readRaw());
}

export async function saveLlm(llm) {
  await writeVerified({ llm });
}

export async function saveProfile(profile) {
  await writeVerified({ profile });
}

export async function saveLang(lang) {
  await writeVerified({ lang });
}

// ─── 导师库 ─────────────────────────────────────────────────────────────────
export class Store {
  constructor() {
    this.professors = {};
    this.notes = [];
    this.loaded = false;
  }

  hydrate({ professors = {}, notes = [] } = {}) {
    this.professors = professors;
    this.notes = notes;
    this.loaded = true;
    return this;
  }

  async load() {
    const raw = await readRaw();
    return this.hydrate({ professors: raw.professors || {}, notes: raw.notes || [] });
  }

  async persist() {
    await chrome.storage.local.set({ professors: this.professors, notes: this.notes });
  }

  list() {
    return Object.values(this.professors).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 按 id / 邮箱 / 姓名定位，姓名支持包含匹配（模型经常只记得姓或写法有差异）
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
