// Persists user settings (rates, per-unit overrides, monthly adjustments) as a JSON file.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  teacherId: null,
  currency: 'UZS',
  // Default pay per paid student per lesson, by unit category.
  rates: { group: 0, individual: 0 },
  // Which student-days earn money:
  //  'payable'  – whatever HolliHop marks as payable to the teacher (default)
  //  'attended' – only students who actually attended
  basis: 'payable',
  // Learning types / names matching this regex are treated as individual lessons.
  individualPattern: '\\bIV\\b|INDIV',
  // { [unitId]: { category?: 'group'|'individual', mode?: 'per_student'|'per_lesson'|'per_hour'|'none', rate?: number } }
  unitOverrides: {},
  // { 'YYYY-MM': [{ id, label, amount }] } – bonuses (+) and deductions (-)
  adjustments: {},
  // Optional monthly salary goal used for the progress bar.
  monthlyGoal: 0,
};

export class SettingsStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(defaults).filter(([, v]) => v != null)) };
    this.cache = null;
    this.writing = Promise.resolve();
  }

  async get() {
    if (!this.cache) {
      let stored = {};
      try {
        stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`Could not read ${this.file}: ${err.message}`);
      }
      this.cache = sanitize({ ...this.defaults, ...stored });
    }
    return structuredClone(this.cache);
  }

  async replace(next) {
    this.cache = sanitize({ ...this.defaults, ...next });
    const data = JSON.stringify(this.cache, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, this.file);
    });
    await this.writing;
    return structuredClone(this.cache);
  }
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const MODES = new Set(['per_student', 'per_lesson', 'per_hour', 'none']);
const CATEGORIES = new Set(['group', 'individual']);

function sanitize(s) {
  const out = {
    teacherId: s.teacherId ? num(s.teacherId, null) : null,
    currency: String(s.currency || 'UZS').slice(0, 12),
    rates: { group: num(s.rates?.group), individual: num(s.rates?.individual) },
    basis: s.basis === 'attended' ? 'attended' : 'payable',
    individualPattern: typeof s.individualPattern === 'string' ? s.individualPattern.slice(0, 200) : DEFAULT_SETTINGS.individualPattern,
    unitOverrides: {},
    adjustments: {},
    monthlyGoal: num(s.monthlyGoal),
  };
  for (const [id, o] of Object.entries(s.unitOverrides || {})) {
    const clean = {};
    if (CATEGORIES.has(o?.category)) clean.category = o.category;
    if (MODES.has(o?.mode)) clean.mode = o.mode;
    if (o?.rate !== undefined && o?.rate !== null && o?.rate !== '') clean.rate = num(o.rate);
    if (Object.keys(clean).length) out.unitOverrides[id] = clean;
  }
  for (const [ym, list] of Object.entries(s.adjustments || {})) {
    if (!/^\d{4}-\d{2}$/.test(ym) || !Array.isArray(list)) continue;
    const items = list
      .slice(0, 100)
      .map((a) => ({ id: String(a.id || Math.random().toString(36).slice(2)), label: String(a.label || '').slice(0, 200), amount: num(a.amount) }));
    if (items.length) out.adjustments[ym] = items;
  }
  return out;
}
