import { computeMonth, unitRule, categoryOf, groupRaise, studentRate, isPaidStudent, demoUnpaid, MODES, BASES } from './calc.js';

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS_LABEL = { taught: 'Taught', upcoming: 'Upcoming', cancelled: 'Cancelled', covered: 'Covered by other' };
const pad = (n) => String(n).padStart(2, '0');
const ym = (y, m) => `${y}-${pad(m)}`;
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (v) => `${nf.format(Math.round(v || 0))} ${esc(state.settings?.currency ?? '')}`.trim();
const moneyShort = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const hours = (min) => {
  const h = min / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
};
const fmtDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', opts);
const statusBadge = (s) => `<span class="badge b-${s}">${STATUS_LABEL[s]}</span>`;
const categoryBadge = (c) => (c === 'individual' ? '<span class="badge b-accent">Individual</span>' : '<span class="badge b-neutral">Group</span>');

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- state
const today = new Date();
const state = {
  settings: null,
  teachers: null,
  year: today.getFullYear(),
  month: today.getMonth() + 1,
  tab: 'overview',
  months: new Map(), // 'YYYY-MM' -> raw month data
  loading: false,
  error: null,
  calc: null,
  lessonFilter: { status: 'all', unit: 'all', q: '' },
  studentSort: { key: 'earned', dir: -1 },
  studentQ: '',
  trendCount: 6,
  history: null, // units the teacher ever taught, for the raise start date
};

const raw = () => state.months.get(ym(state.year, state.month));
const teacherName = () => state.teachers?.find((t) => t.id === state.settings?.teacherId)?.name;

// Hash routing: #2026-09/lessons
function readHash() {
  const m = /^#(\d{4})-(\d{2})(?:\/(\w+))?/.exec(location.hash);
  if (m) {
    state.year = Number(m[1]);
    state.month = Number(m[2]);
    if (m[3]) state.tab = m[3];
  }
}
function writeHash() {
  history.replaceState(null, '', `#${ym(state.year, state.month)}/${state.tab}`);
}

// ---------------------------------------------------------------- settings
let saveTimer;
function saveSettings({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const run = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(state.settings) });
    } catch (e) {
      toast(`Could not save settings: ${e.message}`);
    }
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 500);
}

function updateSettings(mutator, opts = {}) {
  mutator(state.settings);
  recompute();
  if (opts.keepView) {
    // Don't rebuild the form the user is typing in; just refresh the totals.
    renderHero();
    renderKpis();
  } else renderAll();
  saveSettings(opts);
}

// ---------------------------------------------------------------- data loading
async function loadMonth(year, month, { fresh = false } = {}) {
  const key = ym(year, month);
  if (!fresh && state.months.has(key)) return state.months.get(key);
  const qs = new URLSearchParams({ year, month, teacherId: state.settings.teacherId });
  if (fresh) qs.set('fresh', '1');
  const data = await api(`/api/month?${qs}`);
  state.months.set(key, data);
  return data;
}

async function load({ fresh = false } = {}) {
  if (!state.settings.teacherId) {
    renderAll();
    openTeacherPicker();
    return;
  }
  state.loading = true;
  state.error = null;
  $('#refreshBtn').classList.add('spin');
  renderAll();
  const key = ym(state.year, state.month);
  try {
    await loadMonth(state.year, state.month, { fresh });
    if (key !== ym(state.year, state.month)) return; // user switched month meanwhile
    if (fresh) {
      // Drop other cached months so Trends refetches too.
      for (const k of [...state.months.keys()]) if (k !== key) state.months.delete(k);
    }
  } catch (e) {
    state.error = e.message;
  } finally {
    if (key === ym(state.year, state.month)) {
      state.loading = false;
      $('#refreshBtn').classList.remove('spin');
      recompute();
      renderAll();
    }
  }
}

function recompute() {
  const r = raw();
  state.calc = r ? computeMonth(r, state.settings) : null;
}

function goMonth(delta) {
  let m = state.month + delta;
  let y = state.year;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  state.year = y;
  state.month = m;
  writeHash();
  recompute();
  load();
}

// ---------------------------------------------------------------- render: frame
function renderAll() {
  $('#monthLabel').textContent = `${MONTHS[state.month - 1]} ${state.year}`;
  $('#teacherBtn').textContent = teacherName() ? `👤 ${teacherName()}` : state.settings?.teacherId ? `👤 #${state.settings.teacherId}` : '👤 Choose teacher';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  renderHero();
  renderKpis();
  renderView();
}

function renderHero() {
  const el = $('#hero');
  const c = state.calc;
  if (!c) {
    el.innerHTML = state.loading
      ? `<div class="card hero-main"><div class="skeleton" style="height:110px;opacity:.4"></div></div><div class="card"><div class="skeleton" style="height:110px"></div></div>`
      : '';
    return;
  }
  const t = c.totals;
  const goal = state.settings.monthlyGoal;
  const progress = goal
    ? `<div class="progress" title="Goal ${money(goal)}">
         <span class="proj" style="width:${Math.min(100, (t.projected / goal) * 100)}%"></span>
         <span style="width:${Math.min(100, (t.total / goal) * 100)}%"></span>
       </div>
       <div class="sub small" style="margin-top:6px">${pct(t.total / goal)} of ${money(goal)} goal${t.upcoming ? ` · ${pct(t.projected / goal)} projected` : ''}</div>`
    : '';
  const noRates = !state.settings.rates.group && !state.settings.rates.individual && !Object.keys(state.settings.unitOverrides).length;
  el.innerHTML = `
    <div class="card hero-main">
      <div class="label">${t.upcoming ? 'Earned so far' : 'Salary'} · ${MONTHS[state.month - 1]}</div>
      <div class="big">${money(t.total)}</div>
      <div class="sub">
        ${t.upcoming ? `<span>Projected: <b>${money(t.projected)}</b></span><span>${t.upcoming} lessons ahead</span>` : `<span>${t.taught} lessons taught</span>`}
        ${t.adjustments ? `<span>incl. adjustments <b>${t.adjustments > 0 ? '+' : ''}${money(t.adjustments)}</b></span>` : ''}
      </div>
      ${progress}
      ${noRates ? `<div class="sub small" style="margin-top:10px">⚠️ Rates are not set yet — <a href="#" data-goto="settings" style="color:#fff">set your rates</a> to see real numbers.</div>` : ''}
    </div>
    <div class="card hero-side">
      <div class="split-row"><span>From lessons</span><span class="num">${money(t.earned)}</span></div>
      <div class="split-row"><span>Bonuses &amp; deductions</span><span class="num">${t.adjustments ? `${t.adjustments > 0 ? '+' : ''}${money(t.adjustments)}` : '—'}</span></div>
      <div class="split-row"><span>Still to earn (scheduled)</span><span class="num" style="color:var(--upcoming)">${t.upcomingAmount ? money(t.upcomingAmount) : '—'}</span></div>
      <div class="split-row" title="What you would have earned for lessons your colleagues covered"><span>Missed (covered by others)</span><span class="num" style="color:var(--covered)">${t.missed ? money(t.missed) : '—'}</span></div>
    </div>`;
}

function renderKpis() {
  const el = $('#kpis');
  const c = state.calc;
  if (!c) {
    el.innerHTML = state.loading ? Array.from({ length: 6 }, () => '<div class="card kpi"><div class="skeleton" style="height:44px"></div></div>').join('') : '';
    return;
  }
  const t = c.totals;
  const items = [
    [t.taught, 'Lessons taught'],
    [hours(t.minutes), 'Hours taught'],
    [t.paidVisits, 'Paid student-visits'],
    [pct(t.attendanceRate), 'Attendance'],
    [t.cancelled, 'Cancelled lessons'],
    [t.covered, 'Covered by others'],
  ];
  el.innerHTML = items.map(([v, l]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
}

function renderView() {
  const el = $('#view');
  if (!state.settings) return;
  if (state.tab === 'settings') return renderSettings(el);
  if (!state.settings.teacherId) {
    el.innerHTML = `<div class="card empty-state"><div class="big-emoji">👋</div><p>First, tell me who you are in HolliHop.</p><button class="btn primary" data-action="pick-teacher">Choose teacher</button></div>`;
    return;
  }
  if (state.error) {
    el.innerHTML = `<div class="banner error"><span>⚠️ Could not load data from HolliHop: ${esc(state.error)}</span><button class="btn sm" data-action="reload">Try again</button></div>`;
    return;
  }
  if (!state.calc) {
    el.innerHTML = `<div class="card"><div class="skeleton" style="height:260px"></div></div>`;
    return;
  }
  if (state.tab === 'trends') return renderTrends(el);
  if (!state.calc.lessons.length && state.tab !== 'groups') {
    el.innerHTML = `<div class="card empty-state"><div class="big-emoji">🏖️</div><p>No lessons found for ${MONTHS[state.month - 1]} ${state.year}.</p></div>`;
    return;
  }
  ({ overview: renderOverview, calendar: renderCalendar, lessons: renderLessons, students: renderStudents, groups: renderGroups }[state.tab] ?? renderOverview)(el);
}

// ---------------------------------------------------------------- overview
function dailyChart(c) {
  const days = new Date(state.year, state.month, 0).getDate();
  const W = 680, H = 220, L = 44, B = 24, T = 10;
  const vals = [];
  const upcoming = new Map();
  for (const l of c.lessons) if (l.status === 'upcoming') upcoming.set(l.date, (upcoming.get(l.date) ?? 0) + l.pay.amount);
  for (let d = 1; d <= days; d++) {
    const iso = `${ym(state.year, state.month)}-${pad(d)}`;
    vals.push({ d, iso, v: c.daily.get(iso) ?? 0, u: upcoming.get(iso) ?? 0 });
  }
  const max = Math.max(1, ...vals.map((x) => x.v + x.u));
  const cumMax = Math.max(1, c.totals.earned + c.totals.upcomingAmount);
  const bw = (W - L) / days;
  const y = (v) => T + (H - B - T) * (1 - v / max);
  let cum = 0;
  const pts = [];
  const nowDate = raw().now.slice(0, 10);
  const bars = vals
    .map((x, i) => {
      const xPos = L + i * bw + 2;
      cum += x.v;
      if (x.iso <= nowDate) pts.push(`${(L + i * bw + bw / 2).toFixed(1)},${(T + (H - B - T) * (1 - cum / cumMax)).toFixed(1)}`);
      const title = `${fmtDate(x.iso)}: ${money(x.v)}${x.u ? ` (+${money(x.u)} scheduled)` : ''}`;
      return `<g><title>${title}</title>
        ${x.v ? `<rect class="bar" x="${xPos}" y="${y(x.v)}" width="${bw - 4}" height="${H - B - y(x.v)}" rx="3"/>` : ''}
        ${x.u ? `<rect class="bar dim" x="${xPos}" y="${y(x.u)}" width="${bw - 4}" height="${H - B - y(x.u)}" rx="3"/>` : ''}
        ${x.d === 1 || x.d % 5 === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${x.d}</text>` : ''}</g>`;
    })
    .join('');
  const ticks = [0, 0.5, 1].map((f) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${L - 6}" y="${y(max * f) + 4}" text-anchor="end">${moneyShort(max * f)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily earnings">${ticks}${bars}
    ${pts.length > 1 ? `<polyline class="line" points="${pts.join(' ')}"><title>Cumulative earnings</title></polyline>` : ''}</svg>`;
}

function renderOverview(el) {
  const c = state.calc;
  const t = c.totals;
  const byCat = { group: { n: 0, v: 0 }, individual: { n: 0, v: 0 } };
  for (const u of c.units) {
    byCat[u.rule.category].n += u.taught;
    byCat[u.rule.category].v += u.earned;
  }
  const adj = c.adjustments;
  el.innerHTML = `
  <div class="stack">
    <div class="card">
      <div class="card-head"><h2>Daily earnings</h2>
        <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Earned</span>
        <span><i class="dot" style="background:color-mix(in srgb,var(--accent) 35%,transparent)"></i>Scheduled</span>
        <span><i class="dot" style="background:var(--taught)"></i>Cumulative</span></div>
      </div>
      ${dailyChart(c)}
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>By group</h2><a href="#" class="small" data-goto="groups">Edit rates →</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Group</th><th class="num">Lessons</th><th class="num">Paid visits</th><th class="num">Earned</th></tr></thead>
          <tbody>${c.units
            .filter((u) => u.taught || u.upcoming || u.cancelled || u.covered)
            .map(
              (u) => `<tr class="clickable" data-unit="${u.id}">
              <td>${esc(u.name)}<div class="small muted">${categoryBadge(u.rule.category)} ${u.isCover ? '<span class="badge b-covered">You substituted</span>' : ''}</div></td>
              <td class="num">${u.taught}${u.upcoming ? `<span class="muted"> +${u.upcoming}</span>` : ''}</td>
              <td class="num">${u.paidVisits}</td>
              <td class="num"><b>${money(u.earned)}</b>${u.projected > u.earned ? `<div class="small muted">→ ${money(u.projected)}</div>` : ''}</td></tr>`,
            )
            .join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${t.taught}</td><td class="num">${t.paidVisits}</td><td class="num">${money(t.earned)}</td></tr></tfoot>
        </table></div>
        <div class="legend" style="margin-top:12px">
          <span>Group lessons: <b>${byCat.group.n}</b> · ${money(byCat.group.v)}</span>
          <span>Individual: <b>${byCat.individual.n}</b> · ${money(byCat.individual.v)}</span>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Bonuses &amp; deductions</h2><button class="btn sm" data-action="add-adj">+ Add</button></div>
          ${adj.length ? '' : '<p class="muted small" style="margin:0">Add a bonus (positive) or a deduction / advance (negative) for this month.</p>'}
          ${adj
            .map(
              (a) => `<div class="adj-row" data-adj="${esc(a.id)}">
                <input class="input" data-adj-field="label" placeholder="e.g. Bonus, advance, fine" value="${esc(a.label)}">
                <input class="input rate" data-adj-field="amount" type="number" step="any" value="${a.amount}">
                <button class="icon-btn" data-action="del-adj" title="Remove" aria-label="Remove">✕</button></div>`,
            )
            .join('')}
        </div>
        <div class="card">
          <h2>Attention</h2>
          ${attentionList(c)}
        </div>
      </div>
    </div>
  </div>`;
}

function attentionList(c) {
  const items = [];
  const unpaid = c.lessons.filter((l) => l.status === 'taught' && l.pay.absentUnpaid > 0);
  if (unpaid.length) items.push(`<b>${c.totals.absentUnpaid}</b> absences you were <b>not paid</b> for, across ${unpaid.length} lessons.`);
  if (c.totals.demo) {
    const names = new Map(raw().students.map((s) => [s.clientId, s.name]));
    const demos = c.lessons.filter((l) => l.status === 'taught').flatMap((l) => l.students.filter((s) => s.demo).map((s) => names.get(s.clientId)));
    items.push(`<b>${c.totals.demo}</b> demo lesson${c.totals.demo > 1 ? 's' : ''} (not paid): ${demos.slice(0, 6).map(esc).join(', ')}${demos.length > 6 ? '…' : ''}.`);
  }
  const ghosts = c.students.filter((s) => s.attended === 0 && s.absentPaid > 0);
  if (ghosts.length)
    items.push(`<b>${ghosts.length}</b> student${ghosts.length > 1 ? 's' : ''} never attended this month but ${ghosts.length > 1 ? 'were' : 'was'} paid for absences: ${ghosts.slice(0, 5).map((s) => esc(s.name)).join(', ')}${ghosts.length > 5 ? '…' : ''}. Check they're still in the group.`);
  const empty = c.lessons.filter((l) => l.status === 'taught' && l.pay.total > 0 && l.pay.paid === 0);
  if (empty.length) items.push(`<b>${empty.length}</b> taught lessons earned nothing (everyone absent / unpaid).`);
  const cancelled = c.lessons.filter((l) => l.status === 'cancelled');
  if (cancelled.length) items.push(`<b>${cancelled.length}</b> lessons cancelled${cancelled.some((l) => l.description) ? ` (${[...new Set(cancelled.map((l) => l.description).filter(Boolean))].slice(0, 3).map(esc).join('; ')})` : ''}.`);
  const covered = c.lessons.filter((l) => l.status === 'covered');
  if (covered.length) items.push(`<b>${covered.length}</b> of your lessons were taught by ${esc([...new Set(covered.map((l) => l.coveredBy).filter(Boolean))].join(', ') || 'colleagues')}.`);
  const subs = c.units.filter((u) => u.isCover && u.taught);
  if (subs.length) items.push(`You substituted in <b>${subs.length}</b> group${subs.length > 1 ? 's' : ''}: ${subs.map((u) => esc(u.name)).join(', ')}.`);
  const left = c.students.filter((s) => s.enrollments.some((e) => e.endDate && e.endDate >= raw().from && e.endDate <= raw().to) && !c.units.find((u) => u.isCover && s.enrollments.every((e) => e.unitId === u.id)));
  if (left.length) items.push(`<b>${left.length}</b> student${left.length > 1 ? 's' : ''} left a group this month: ${left.slice(0, 5).map((s) => esc(s.name)).join(', ')}${left.length > 5 ? '…' : ''}.`);
  const noRate = c.units.filter((u) => u.taught && !u.rule.rate && u.rule.mode !== 'none');
  if (noRate.length) items.push(`<span style="color:var(--danger)"><b>${noRate.length}</b> group${noRate.length > 1 ? 's have' : ' has'} no rate set.</span> <a href="#" data-goto="groups">Fix →</a>`);
  if (!items.length) return '<p class="muted small" style="margin:0">All good — nothing unusual this month. ✨</p>';
  return `<ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- calendar
function renderCalendar(el) {
  const c = state.calc;
  const first = new Date(state.year, state.month - 1, 1);
  const days = new Date(state.year, state.month, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const byDate = new Map();
  for (const l of c.lessons) {
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="day empty"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${ym(state.year, state.month)}-${pad(d)}`;
    const ls = byDate.get(iso) ?? [];
    const sum = ls.reduce((a, l) => a + (l.status === 'taught' ? l.pay.amount : 0), 0);
    cells.push(`<div class="day${iso === todayIso ? ' today' : ''}" data-date="${iso}" tabindex="0">
      <div class="day-head"><b>${d}</b>${sum ? `<span class="day-sum">${moneyShort(sum)}</span>` : ''}</div>
      ${ls.map((l) => `<div class="pill s-${l.status}" title="${esc(`${l.beginTime ?? ''} ${l.unit.name} — ${STATUS_LABEL[l.status]}`)}">${esc(l.beginTime ?? '')} ${esc(shortName(l.unit))}</div>`).join('')}
    </div>`);
  }
  el.innerHTML = `<div class="card">
    <div class="card-head"><h2>${MONTHS[state.month - 1]} ${state.year}</h2>
      <div class="legend">${Object.entries(STATUS_LABEL).map(([k, v]) => `<span><i class="dot" style="background:var(--${k})"></i>${v}</span>`).join('')}</div></div>
    <div class="cal">${DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
  </div>`;
}

function shortName(unit) {
  // "MR NAZARBEK M/W/F 14:00 PRE SAT MATH" -> "PRE SAT MATH"
  if (!unit) return '';
  const name = unit.name ?? '';
  const short = name
    .replace(/^(MR|MS|MRS)\s+\S+(\s*&\s*\S+)?\s*/i, '')
    .replace(/\b(M\/W\/F|T\/T\/S)\b/gi, '')
    .replace(/\d{1,2}:\d{2}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return short || unit.discipline || name;
}

function openDay(iso) {
  const ls = state.calc.lessons.filter((l) => l.date === iso);
  const sum = ls.reduce((a, l) => a + l.pay.amount, 0);
  openModal(`<h2>${fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2>
    <p class="muted" style="margin:0">${ls.length ? `${ls.length} lesson${ls.length > 1 ? 's' : ''} · ${money(sum)}` : 'No lessons on this day.'}</p>
    ${ls.map(lessonBlock).join('')}`);
}

// Attendance + pay badges for one student on one lesson.
function studentDayBadges(s, lessonStatus) {
  const rule = demoUnpaid(state.settings);
  if (rule && s.beforeStart) return '<span class="badge b-neutral" title="Enrolled, but hasn\'t come to the group yet">not started</span>';
  const att = s.absent ? '<span class="badge b-danger">Absent</span>' : '<span class="badge b-taught">Present</span>';
  if (rule && s.demo) return `${s.absent ? '' : att} <span class="badge b-covered" title="First appearance in the group — not paid">demo</span>`;
  if (lessonStatus === 'cancelled') return att;
  return `${att} ${isPaidStudent(s, state.settings) ? '<span class="badge b-accent">paid</span>' : '<span class="badge b-neutral">not paid</span>'}`;
}

function lessonBlock(l) {
  const studentsById = new Map(raw().students.map((s) => [s.clientId, s]));
  const rows = l.students
    .map((s) => {
      const st = studentsById.get(s.clientId);
      return `<div class="student-row"${demoUnpaid(state.settings) && s.beforeStart ? ' style="opacity:.55"' : ''}><span>${esc(st?.name ?? s.clientId)}${s.description ? ` <span class="small muted">— ${esc(s.description)}</span>` : ''}</span><span>${studentDayBadges(s, l.status)}</span></div>`;
    })
    .join('');
  return `<div class="lesson-block">
    <div class="head"><div><b>${esc(l.unit.name)}</b><div class="small muted">${esc(l.beginTime ?? '')}${l.endTime ? `–${esc(l.endTime)}` : ''} · ${l.minutes} min${l.room ? ` · ${esc(l.room)}` : ''} · ${esc(l.unit.office ?? '')}</div></div>
      <div style="text-align:right">${statusBadge(l.status)}<div class="num" style="font-weight:700;margin-top:4px">${l.pay.amount ? money(l.pay.amount) : l.status === 'covered' && l.pay.worth ? `<span class="small muted">missed ${money(l.pay.worth)}</span>` : '—'}</div></div></div>
    ${l.coveredBy ? `<p class="small" style="margin:8px 0 0">Taught by <b>${esc(l.coveredBy)}</b></p>` : ''}
    ${l.description ? `<p class="small" style="margin:8px 0 0">📝 ${esc(l.description)}</p>` : ''}
    ${l.status !== 'covered' && l.students.length ? `<div style="margin-top:10px">${rows}</div>
      <p class="small muted" style="margin:8px 0 0">${l.pay.present}/${l.pay.total} present · ${l.pay.paid} paid${l.pay.demo ? ` · ${l.pay.demo} demo` : ''} · ${ruleText(l.rule, l.date)}</p>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- lessons
function renderLessons(el) {
  const c = state.calc;
  const f = state.lessonFilter;
  const q = f.q.trim().toLowerCase();
  const list = c.lessons.filter(
    (l) =>
      (f.status === 'all' || l.status === f.status) &&
      (f.unit === 'all' || String(l.unitId) === f.unit) &&
      (!q || l.unit.name.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q)),
  );
  const counts = { all: c.lessons.length };
  for (const l of c.lessons) counts[l.status] = (counts[l.status] ?? 0) + 1;
  const total = list.reduce((a, l) => a + l.pay.amount, 0);
  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div class="seg" role="group">${['all', 'taught', 'upcoming', 'cancelled', 'covered']
        .map((s) => `<button data-lfilter="${s}" class="${f.status === s ? 'on' : ''}">${s === 'all' ? 'All' : STATUS_LABEL[s]} ${counts[s] ?? 0}</button>`)
        .join('')}</div>
      <div class="toolbar">
        <select class="input" id="lessonUnit"><option value="all">All groups</option>${c.units.map((u) => `<option value="${u.id}" ${f.unit === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <input class="input" id="lessonQ" placeholder="Search…" value="${esc(f.q)}">
        <button class="btn sm" data-action="csv">⬇ CSV</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Time</th><th>Group</th><th>Status</th><th class="num">Present</th><th class="num">Paid</th><th class="num">Amount</th><th>Note</th></tr></thead>
      <tbody>${list
        .map(
          (l) => `<tr class="clickable" data-lesson="${l.unitId}|${l.date}">
          <td style="white-space:nowrap">${fmtDate(l.date)}</td>
          <td class="muted" style="white-space:nowrap">${esc(l.beginTime ?? '')}</td>
          <td>${esc(l.unit.name)}</td>
          <td>${statusBadge(l.status)}</td>
          <td class="num">${l.status === 'covered' ? '—' : `${l.pay.present}/${l.pay.total}`}</td>
          <td class="num">${l.status === 'covered' || l.status === 'cancelled' ? '—' : l.pay.paid}</td>
          <td class="num"><b>${l.pay.amount ? money(l.pay.amount) : '—'}</b></td>
          <td class="small muted">${esc(l.coveredBy ? `by ${l.coveredBy}` : '')}${l.coveredBy && l.description ? ' · ' : ''}${esc(l.description ?? '')}</td></tr>`,
        )
        .join('')}</tbody>
      <tfoot><tr><td colspan="6">${list.length} lessons</td><td class="num">${money(total)}</td><td></td></tr></tfoot>
    </table></div>
  </div>`;
}

function exportCsv() {
  const c = state.calc;
  const studentsById = new Map(raw().students.map((s) => [s.clientId, s.name]));
  const rows = [['Date', 'Start', 'End', 'Minutes', 'Group', 'Category', 'Status', 'Present', 'Students', 'Paid students', 'Amount', 'Covered by', 'Note', 'Absent students']];
  for (const l of c.lessons) {
    rows.push([
      l.date, l.beginTime ?? '', l.endTime ?? '', l.minutes, l.unit.name, l.rule.category, l.status, l.pay.present, l.pay.total, l.pay.paid,
      l.pay.amount, l.coveredBy ?? '', l.description ?? '', l.students.filter((s) => s.absent).map((s) => studentsById.get(s.clientId)).join('; '),
    ]);
  }
  for (const a of c.adjustments) rows.push(['', '', '', '', `Adjustment: ${a.label}`, '', '', '', '', '', a.amount, '', '', '']);
  rows.push(['', '', '', '', 'TOTAL', '', '', '', '', '', c.totals.total, '', '', '']);
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `salary-${ym(state.year, state.month)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- students
function renderStudents(el) {
  const c = state.calc;
  const unitsById = new Map(c.units.map((u) => [u.id, u]));
  const q = state.studentQ.trim().toLowerCase();
  const { key, dir } = state.studentSort;
  const list = c.students
    .filter((s) => s.attended + s.absentPaid + s.absentUnpaid + s.demo + s.upcoming > 0)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.enrollments.some((e) => unitsById.get(e.unitId)?.name.toLowerCase().includes(q)))
    .map((s) => ({ ...s, rate: s.attended + s.absentPaid + s.absentUnpaid ? s.attended / (s.attended + s.absentPaid + s.absentUnpaid) : null }))
    .sort((a, b) => {
      const av = a[key] ?? -1, bv = b[key] ?? -1;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dir;
    });
  const th = (k, label, cls = '') => `<th class="sortable ${cls}" data-sort="${k}">${label}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  el.innerHTML = `<div class="card">
    <div class="card-head"><h2>${list.length} students</h2><input class="input" id="studentQ" placeholder="Search student or group…" value="${esc(state.studentQ)}"></div>
    <div class="table-wrap"><table>
      <thead><tr>${th('name', 'Student')}<th>Group</th>${th('attended', 'Attended', 'num')}${th('absentPaid', 'Absent · paid', 'num')}${th('absentUnpaid', 'Absent · unpaid', 'num')}${th('demo', 'Demo', 'num')}${th('rate', 'Attendance', 'num')}${th('earned', 'You earned', 'num')}<th>Phone</th></tr></thead>
      <tbody>${list
        .map(
          (s) => `<tr class="clickable" data-student="${s.clientId}">
          <td><b>${esc(s.name)}</b>${s.enrollments.some((e) => e.endDate && e.endDate <= raw().to) ? ' <span class="badge b-neutral" title="Left the group">left</span>' : ''}</td>
          <td class="small">${[...new Set(s.enrollments.map((e) => e.unitId))].map((id) => esc(shortName(unitsById.get(id)))).join('<br>')}</td>
          <td class="num">${s.attended}</td>
          <td class="num">${s.absentPaid || '—'}</td>
          <td class="num" ${s.absentUnpaid ? 'style="color:var(--danger)"' : ''}>${s.absentUnpaid || '—'}</td>
          <td class="num">${s.demo || '—'}</td>
          <td class="num">${pct(s.rate)}</td>
          <td class="num"><b>${money(s.earned)}</b>${s.upcoming ? `<div class="small muted">+${money(s.upcoming)}</div>` : ''}</td>
          <td class="small">${s.mobile ? `<a href="tel:${esc(s.mobile.replace(/\s/g, ''))}" onclick="event.stopPropagation()">${esc(s.mobile)}</a>` : '—'}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div></div>`;
}

function openStudent(id) {
  const s = state.calc.students.find((x) => x.clientId === id);
  const unitsById = new Map(state.calc.units.map((u) => [u.id, u]));
  const ls = state.calc.lessons.filter((l) => l.status !== 'covered' && l.students.some((x) => x.clientId === id));
  const rows = ls
    .map((l) => {
      const d = l.students.find((x) => x.clientId === id);
      const share = l.pay.paid && isPaidStudent(d, state.settings) ? l.pay.amount / l.pay.paid : 0;
      return `<tr><td>${fmtDate(l.date)}</td><td class="small">${esc(shortName(l.unit))}</td><td>${l.status === 'taught' ? studentDayBadges(d, l.status) : statusBadge(l.status)}</td>
        <td class="num">${share ? money(share) : '—'}</td><td class="small muted">${esc(d.description ?? '')}</td></tr>`;
    })
    .join('');
  openModal(`<h2>${esc(s.name)}</h2>
    <p class="muted" style="margin:0 0 4px">${s.mobile ? `📞 <a href="tel:${esc(s.mobile.replace(/\s/g, ''))}">${esc(s.mobile)}</a> · ` : ''}${s.attended} attended · ${s.absentPaid + s.absentUnpaid} absent${s.demo ? ' · demo lesson' : ''} · earned ${money(s.earned)}</p>
    ${s.enrollments.map((e) => `<div class="small muted">${esc(unitsById.get(e.unitId)?.name ?? '')}: since ${esc(e.beginDate ?? '?')}${e.endDate ? ` until ${esc(e.endDate)}` : ''}${e.leaveReason ? ` — ${esc(e.leaveReason)}` : ''}</div>`).join('')}
    <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Date</th><th>Group</th><th>Status</th><th class="num">Earned</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

// ---------------------------------------------------------------- groups & rates
function renderGroups(el) {
  const c = state.calc;
  const s = state.settings;
  el.innerHTML = `
    <div class="banner" style="background:var(--accent-soft);border-color:transparent">
      <span>Group lessons: <b>${ruleText(defaultRule('group'), raw().to)}</b>. Individual: <b>${ruleText(defaultRule('individual'), raw().to)}</b>. You can override any group below.</span>
      <button class="btn sm" data-goto="settings">Change defaults</button>
    </div>
    ${c.units.length ? '' : '<div class="card empty-state">No groups this month.</div>'}
    <div class="groups">${c.units
      .map((u) => {
        const o = s.unitOverrides[u.id] ?? {};
        const def = s.rates[u.rule.category];
        const sched = [...new Map(u.schedule.filter((x) => !x.endDate || x.endDate >= raw().from).map((x) => [`${x.weekdays}|${x.beginTime}`, x])).values()];
        return `<div class="card group-card" data-unit-card="${u.id}">
        <div>
          <div class="title">${esc(u.name)}</div>
          <div class="meta small" style="margin-top:6px">${categoryBadge(u.rule.category)}${u.isCover ? '<span class="badge b-covered">You substituted</span>' : ''}
            <span class="badge b-neutral">${esc(u.discipline ?? '')}</span><span class="badge b-neutral">${esc(u.office ?? '')}</span>
            <span class="badge b-neutral">${u.studentsCount ?? 0} students</span></div>
          <div class="small muted" style="margin-top:6px">${sched.map((x) => `${weekdaysText(x.weekdays)} ${esc(x.beginTime)}–${esc(x.endTime)}`).join(' · ')}</div>
        </div>
        <div class="rule">
          <div class="field"><label>Type</label>
            <select class="input" data-ov="category"><option value="">Auto (${categoryOfAuto(u)})</option><option value="group" ${o.category === 'group' ? 'selected' : ''}>Group</option><option value="individual" ${o.category === 'individual' ? 'selected' : ''}>Individual</option></select></div>
          <div class="field"><label>Pay mode</label>
            <select class="input" data-ov="mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${u.rule.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field" style="grid-column:span 2"><label>${RATE_LABEL[u.rule.mode] ?? 'Rate'} ${o.rate === undefined ? '<span class="muted">(default)</span>' : ''}</label>
            <div class="toolbar"><input class="input rate" style="flex:1" data-ov="rate" type="number" min="0" step="any" placeholder="${def}" value="${o.rate ?? ''}">
            ${o.rate !== undefined || o.mode || o.category ? '<button class="btn sm" data-action="reset-unit">Reset</button>' : ''}</div>
            <span class="hint">${ruleText(u.rule, raw().to)}</span></div>
        </div>
        <div class="stats">
          <div><b>${u.taught}</b><span>taught</span></div>
          <div><b>${u.upcoming}</b><span>upcoming</span></div>
          <div><b>${u.cancelled + u.covered}</b><span>missed</span></div>
          <div><b>${u.paidVisits}</b><span>paid visits</span></div>
        </div>
        <div class="earned"><span class="muted">Earned</span><span><b>${money(u.earned)}</b>${u.projected > u.earned ? ` <span class="small muted">→ ${money(u.projected)}</span>` : ''}</span></div>
      </div>`;
      })
      .join('')}</div>`;
}

function categoryOfAuto(u) {
  const { category } = unitRule(u, { ...state.settings, unitOverrides: {} });
  return category === 'individual' ? 'individual' : 'group';
}

function weekdaysText(mask) {
  // HolliHop weekday bitmask: Mon=1, Tue=2, Wed=4 … Sun=64
  const out = DOW.filter((_, i) => mask & (1 << i));
  return out.length ? out.join('/') : '';
}

const RATE_LABEL = {
  per_student: 'Per paid student, per lesson',
  package: `Per student, per ${state.settings?.packageLessons ?? 12} lessons`,
  per_lesson: 'Per lesson',
  per_hour: 'Per hour',
};

const unitOf = (id) => state.calc?.units.find((u) => String(u.id) === String(id)) ?? { id };

function defaultRule(category) {
  return unitRule({ id: '__default__', type: category === 'individual' ? 'Individual' : 'Group' }, {
    ...state.settings,
    individualPattern: '',
  });
}

// Human-readable description of how a rule pays on a given date.
function ruleText(rule, date) {
  switch (rule.mode) {
    case 'per_student': {
      const raise = rule.raise ? groupRaise(date, state.settings) : 0;
      return `${money(rule.rate + raise)} per paid student / lesson${raise ? ` (${money(rule.rate)} + ${money(raise)} raise)` : ''}`;
    }
    case 'package':
      return `${money(rule.rate)} per ${rule.packageLessons} lessons = ${money(studentRate(rule, date, state.settings))} per paid student / lesson`;
    case 'per_lesson':
      return `${money(rule.rate)} per lesson`;
    case 'per_hour':
      return `${money(rule.rate)} per hour`;
    default:
      return 'Not paid';
  }
}

function isoToday() {
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The next date the group raise goes up, or null.
function nextRaiseDate() {
  const r = state.settings.groupRaise;
  if (!r?.since || !r.amount) return null;
  const start = isoToday() < r.since ? r.since : isoToday();
  const now = groupRaise(start, state.settings);
  for (let i = 1; i <= 31 * (r.everyMonths + 1); i++) {
    const d = addDays(start, i);
    if (groupRaise(d, state.settings) > now) return d;
  }
  return null;
}

// Suggest the "group teacher since" date: first lesson in a group that became your own.
function suggestedRaiseStart() {
  const own = (state.history ?? []).filter((u) => u.regularSince && categoryOf({ ...u, id: `h${u.id}` }, state.settings) === 'group');
  return own[0] ? { ...own[0], firstDate: own[0].regularSince } : null;
}

async function loadHistory() {
  if (state.history || !state.settings.teacherId) return;
  try {
    state.history = await api(`/api/history?teacherId=${state.settings.teacherId}`);
  } catch {
    state.history = [];
  }
}

// ---------------------------------------------------------------- trends
async function renderTrends(el) {
  const n = state.trendCount;
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(state.year, state.month - 1 - i, 1);
    keys.push([d.getFullYear(), d.getMonth() + 1]);
  }
  const missing = keys.filter(([y, m]) => !state.months.has(ym(y, m)));
  if (missing.length) {
    el.innerHTML = `<div class="card"><p class="muted">Loading ${missing.length} month${missing.length > 1 ? 's' : ''} from HolliHop…</p><div class="skeleton" style="height:220px"></div></div>`;
    const tab = state.tab;
    try {
      for (const [y, m] of missing) await loadMonth(y, m);
    } catch (e) {
      el.innerHTML = `<div class="banner error">⚠️ ${esc(e.message)}</div>`;
      return;
    }
    if (state.tab === tab) renderView();
    return;
  }
  const rows = keys.map(([y, m]) => {
    const r = computeMonth(state.months.get(ym(y, m)), state.settings);
    return { y, m, t: r.totals };
  });
  const W = 680, H = 240, L = 50, B = 28, T = 16;
  const max = Math.max(1, ...rows.map((r) => r.t.projected));
  const bw = (W - L) / rows.length;
  const yv = (v) => T + (H - B - T) * (1 - v / max);
  const bars = rows
    .map((r, i) => {
      const x = L + i * bw + bw * 0.18;
      const w = bw * 0.64;
      return `<g><title>${MONTHS[r.m - 1]} ${r.y}: ${money(r.t.total)}${r.t.upcomingAmount ? ` (projected ${money(r.t.projected)})` : ''}</title>
        ${r.t.upcomingAmount ? `<rect class="bar dim" x="${x}" y="${yv(r.t.projected)}" width="${w}" height="${H - B - yv(r.t.projected)}" rx="4"/>` : ''}
        <rect class="bar" x="${x}" y="${yv(Math.max(0, r.t.total))}" width="${w}" height="${H - B - yv(Math.max(0, r.t.total))}" rx="4"/>
        <text x="${x + w / 2}" y="${yv(r.t.projected) - 4}" text-anchor="middle">${moneyShort(r.t.total)}</text>
        <text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${MONTHS[r.m - 1].slice(0, 3)}</text></g>`;
    })
    .join('');
  const ticks = [0, 0.5, 1].map((f) => `<line class="grid" x1="${L}" x2="${W}" y1="${yv(max * f)}" y2="${yv(max * f)}"/><text x="${L - 6}" y="${yv(max * f) + 4}" text-anchor="end">${moneyShort(max * f)}</text>`).join('');
  const avg = rows.filter((r) => r.t.taught).reduce((a, r, _, arr) => a + r.t.total / arr.length, 0);
  el.innerHTML = `<div class="stack"><div class="card">
      <div class="card-head"><h2>Salary by month</h2>
        <div class="toolbar"><span class="muted small">Average: <b>${money(avg)}</b></span>
        <div class="seg">${[3, 6, 12].map((k) => `<button data-trend="${k}" class="${n === k ? 'on' : ''}">${k} mo</button>`).join('')}</div></div></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Salary by month">${ticks}${bars}</svg>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Month</th><th class="num">Lessons</th><th class="num">Hours</th><th class="num">Paid visits</th><th class="num">Attendance</th><th class="num">Cancelled</th><th class="num">Covered</th><th class="num">Salary</th></tr></thead>
      <tbody>${rows
        .slice()
        .reverse()
        .map(
          (r) => `<tr class="clickable" data-month="${ym(r.y, r.m)}"><td>${MONTHS[r.m - 1]} ${r.y}</td><td class="num">${r.t.taught}</td><td class="num">${hours(r.t.minutes)}</td><td class="num">${r.t.paidVisits}</td>
          <td class="num">${pct(r.t.attendanceRate)}</td><td class="num">${r.t.cancelled}</td><td class="num">${r.t.covered}</td><td class="num"><b>${money(r.t.total)}</b></td></tr>`,
        )
        .join('')}</tbody>
    </table></div></div></div>`;
}

// ---------------------------------------------------------------- settings
function renderSettings(el) {
  const s = state.settings;
  el.innerHTML = `<div class="stack">
    <div class="card">
      <h2>Group lessons</h2>
      <div class="form-grid">
        <div class="field"><label for="rateGroup">Starting rate, per paid student per lesson</label>
          <input class="input" id="rateGroup" data-setting="rates.group" type="number" min="0" step="any" value="${s.rates.group}"></div>
        <div class="field"><label for="raiseAmount">Raise</label>
          <div class="toolbar"><span>+</span><input class="input rate" id="raiseAmount" data-setting="groupRaise.amount" type="number" min="0" step="any" value="${s.groupRaise.amount}">
          <span>every</span><input class="input" style="width:70px" id="raiseEvery" data-setting="groupRaise.everyMonths" type="number" min="1" step="1" value="${s.groupRaise.everyMonths}"><span>months</span></div></div>
        <div class="field"><label for="raiseSince">Group teacher since</label>
          <input class="input" id="raiseSince" data-setting="groupRaise.since" type="date" value="${esc(s.groupRaise.since)}">
          ${raiseSuggestionHtml()}</div>
      </div>
      <p class="small" style="margin:14px 0 0">${raiseSummaryHtml()}</p>
    </div>
    <div class="card">
      <h2>Individual lessons</h2>
      <div class="form-grid">
        <div class="field"><label for="rateInd">Pay per student, per package</label>
          <input class="input" id="rateInd" data-setting="rates.individual" type="number" min="0" step="any" value="${s.rates.individual}">
          <span class="hint">In pairs, each student counts separately.</span></div>
        <div class="field"><label for="packageLessons">Lessons in a package</label>
          <input class="input" id="packageLessons" data-setting="packageLessons" type="number" min="1" step="1" value="${s.packageLessons}">
          <span class="hint">Every paid lesson earns ${money(s.rates.individual / (s.packageLessons || 12))} per student.</span></div>
      </div>
    </div>
    <div class="card">
      <h2>General</h2>
      <div class="form-grid">
        <div class="field"><label for="currency">Currency</label>
          <input class="input" id="currency" data-setting="currency" value="${esc(s.currency)}"></div>
        <div class="field"><label for="goal">Monthly goal (optional)</label>
          <input class="input" id="goal" data-setting="monthlyGoal" type="number" min="0" step="any" value="${s.monthlyGoal || ''}"></div>
      </div>
    </div>
    <div class="card">
      <h2>Which students earn money?</h2>
      <div class="seg" style="margin-bottom:8px">${Object.entries(BASES)
        .map(([k, v]) => `<button data-basis="${k}" class="${s.basis === k ? 'on' : ''}">${v}</button>`)
        .join('')}</div>
      <p class="muted small" style="margin:0 0 12px">“Students charged” pays for students who were present or absent <b>without</b> a valid reason — the ones the student pays for.
        HolliHop's own “payable to teacher” flag also pays excused absences (sick, abroad…) and demo lessons.</p>
      <label class="toolbar small"><input type="checkbox" id="demoUnpaid" ${s.demoUnpaid ? 'checked' : ''}>
        A student's first appearance in a group is a free <b>demo</b> (not paid); lessons before it don't count.</label>
    </div>
    <div class="card">
      <h2>Individual lesson detection</h2>
      <div class="field"><label for="indPattern">Learning type or group name matches (regex, case-insensitive)</label>
        <input class="input" id="indPattern" data-setting="individualPattern" value="${esc(s.individualPattern)}">
        <span class="hint">Default <code>\\bIV\\b|INDIV</code> treats “IV OFFLINE” groups as individual. You can override any group in “Groups &amp; rates”.</span></div>
    </div>
    <div class="card">
      <h2>Teacher</h2>
      <p style="margin:0 0 10px">${teacherName() ? esc(teacherName()) : s.teacherId ? `#${s.teacherId}` : 'Not selected'} <span class="muted small">${s.teacherId ? `(id ${s.teacherId})` : ''}</span></p>
      <button class="btn" data-action="pick-teacher">Change teacher</button>
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p class="muted small" style="margin-top:0">Settings are stored on the server in <code>data/settings.json</code>.</p>
      <div class="toolbar">
        <button class="btn" data-action="export-settings">⬇ Export settings</button>
        <label class="btn">⬆ Import settings<input type="file" accept="application/json" id="importSettings" hidden></label>
        <button class="btn danger" data-action="clear-overrides">Reset all group overrides</button>
      </div>
    </div>
  </div>`;
}

function raiseSuggestionHtml() {
  const sug = suggestedRaiseStart();
  if (!state.history) return '<span class="hint">Looking up your groups in HolliHop…</span>';
  if (!sug) return '<span class="hint">Couldn\'t find your first group in HolliHop. Set the date manually.</span>';
  const same = sug.firstDate === state.settings.groupRaise.since;
  return `<span class="hint">HolliHop: your first regular group <b>${esc(sug.name)}</b> started on <b>${esc(sug.firstDate)}</b>.
    ${same ? '✓' : `<button class="btn sm" data-action="use-raise-start" data-date="${esc(sug.firstDate)}">Use this date</button>`}</span>`;
}

function raiseSummaryHtml() {
  const s = state.settings;
  if (!s.groupRaise.since) return '<span style="color:var(--danger)">Set the “group teacher since” date to apply the raise.</span>';
  const now = s.rates.group + groupRaise(isoToday(), s);
  const next = nextRaiseDate();
  return `Your group rate today: <b>${money(now)}</b> per paid student / lesson.${
    next ? ` Next raise on <b>${fmtDate(next, { day: 'numeric', month: 'long', year: 'numeric' })}</b> → ${money(s.rates.group + groupRaise(next, s))}.` : ''
  }`;
}


// ---------------------------------------------------------------- modal & teacher picker
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#overlay').hidden = false;
  $('#modalClose').focus();
}
function closeModal() {
  $('#overlay').hidden = true;
}

async function openTeacherPicker() {
  openModal(`<h2>Who are you?</h2><p class="muted" style="margin:0">Pick yourself from the HolliHop teacher list.</p>
    <input class="input" id="teacherQ" placeholder="Search by name…" style="width:100%;margin-top:12px">
    <div class="teacher-list" id="teacherList"><div class="skeleton" style="height:200px"></div></div>`);
  try {
    if (!state.teachers) state.teachers = await api('/api/teachers');
  } catch (e) {
    $('#teacherList').innerHTML = `<div class="banner error" style="margin:8px">${esc(e.message)}</div>`;
    return;
  }
  const draw = () => {
    const q = ($('#teacherQ')?.value ?? '').trim().toLowerCase();
    const list = state.teachers.filter((t) => !q || t.name.toLowerCase().includes(q) || String(t.id) === q).sort((a, b) => a.fired - b.fired || a.name.localeCompare(b.name));
    $('#teacherList').innerHTML = list
      .map((t) => `<button data-teacher="${t.id}"><b>${esc(t.name)}</b> ${t.fired ? '<span class="badge b-neutral">fired</span>' : ''} ${t.id === state.settings.teacherId ? '<span class="badge b-accent">current</span>' : ''}<div class="small muted">${esc(t.disciplines.slice(0, 4).join(', '))}${t.offices.length ? ` · ${esc(t.offices.join(', '))}` : ''}</div></button>`)
      .join('') || '<p class="muted" style="padding:12px">No teachers found.</p>';
  };
  draw();
  $('#teacherQ').addEventListener('input', draw);
  $('#teacherQ').focus();
  renderAll();
}

// ---------------------------------------------------------------- events
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
}

function bindEvents() {
  $('#prevMonth').addEventListener('click', () => goMonth(-1));
  $('#nextMonth').addEventListener('click', () => goMonth(1));
  $('#monthLabel').addEventListener('click', () => {
    state.year = today.getFullYear();
    state.month = today.getMonth() + 1;
    writeHash();
    recompute();
    load();
  });
  $('#refreshBtn').addEventListener('click', () => load({ fresh: true }).then(() => !state.error && toast('Data refreshed from HolliHop')));
  $('#teacherBtn').addEventListener('click', openTeacherPicker);
  $('#modalClose').addEventListener('click', closeModal);
  $('#overlay').addEventListener('click', (e) => e.target.id === 'overlay' && closeModal());
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    writeHash();
    renderAll();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.target.matches('input, select, textarea') || !$('#overlay').hidden) return;
    if (e.key === 'ArrowLeft') goMonth(-1);
    if (e.key === 'ArrowRight') goMonth(1);
  });
  window.addEventListener('hashchange', () => {
    const before = ym(state.year, state.month);
    readHash();
    if (before !== ym(state.year, state.month)) {
      recompute();
      load();
    } else renderAll();
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const go = t.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      closeModal();
      state.tab = go.dataset.goto;
      writeHash();
      renderAll();
      return;
    }
    const teacher = t.closest('[data-teacher]');
    if (teacher) {
      const id = Number(teacher.dataset.teacher);
      closeModal();
      if (id !== state.settings.teacherId) {
        state.months.clear();
        state.calc = null;
        state.history = null;
        updateSettings((s) => {
          s.teacherId = id;
          s.groupRaise.since = '';
        }, { immediate: true });
        load();
        initHistory();
      }
      return;
    }
    const action = t.closest('[data-action]')?.dataset.action;
    if (action) return handleAction(action, t);
    const day = t.closest('[data-date]');
    if (day) return openDay(day.dataset.date);
    const lesson = t.closest('[data-lesson]');
    if (lesson) {
      const [uid, date] = lesson.dataset.lesson.split('|');
      const l = state.calc.lessons.find((x) => String(x.unitId) === uid && x.date === date);
      return openModal(`<h2>${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>${lessonBlock(l)}`);
    }
    const student = t.closest('[data-student]');
    if (student) return openStudent(Number(student.dataset.student));
    const unit = t.closest('[data-unit]');
    if (unit) {
      state.lessonFilter = { status: 'all', unit: unit.dataset.unit, q: '' };
      state.tab = 'lessons';
      writeHash();
      return renderAll();
    }
    const lf = t.closest('[data-lfilter]');
    if (lf) {
      state.lessonFilter.status = lf.dataset.lfilter;
      return renderView();
    }
    const sort = t.closest('[data-sort]');
    if (sort) {
      const k = sort.dataset.sort;
      state.studentSort = { key: k, dir: state.studentSort.key === k ? -state.studentSort.dir : k === 'name' ? 1 : -1 };
      return renderView();
    }
    const basis = t.closest('[data-basis]');
    if (basis) return updateSettings((s) => (s.basis = basis.dataset.basis));
    const trend = t.closest('[data-trend]');
    if (trend) {
      state.trendCount = Number(trend.dataset.trend);
      return renderView();
    }
    const month = t.closest('[data-month]');
    if (month) {
      const [y, m] = month.dataset.month.split('-').map(Number);
      state.year = y;
      state.month = m;
      state.tab = 'overview';
      writeHash();
      recompute();
      return load();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'lessonQ') {
      state.lessonFilter.q = t.value;
      return rerenderKeepingFocus();
    }
    if (t.id === 'studentQ') {
      state.studentQ = t.value;
      return rerenderKeepingFocus();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'lessonUnit') {
      state.lessonFilter.unit = t.value;
      return renderView();
    }
    if (t.id === 'demoUnpaid') {
      updateSettings((s) => (s.demoUnpaid = t.checked));
      return toast('Saved');
    }
    if (t.dataset.setting) {
      const path = t.dataset.setting;
      const value = t.type === 'number' ? Number(t.value) || 0 : t.value;
      if (path === 'individualPattern') {
        try {
          new RegExp(value);
        } catch {
          return toast('That is not a valid regular expression');
        }
      }
      updateSettings((s) => setPath(s, path, value));
      return toast('Saved');
    }
    if (t.dataset.ov) {
      const id = t.closest('[data-unit-card]').dataset.unitCard;
      updateSettings((s) => {
        const o = { ...(s.unitOverrides[id] ?? {}) };
        const field = t.dataset.ov;
        if (t.value === '') delete o[field];
        else o[field] = field === 'rate' ? Number(t.value) : t.value;
        if (field === 'mode' && t.value === (s.modes?.[categoryOf({ ...unitOf(id) }, s)] ?? 'per_student')) delete o.mode;
        s.unitOverrides[id] = o;
      });
      return toast('Saved');
    }
    if (t.dataset.adjField) {
      const id = t.closest('[data-adj]').dataset.adj;
      const key = ym(state.year, state.month);
      updateSettings((s) => {
        const a = s.adjustments[key]?.find((x) => x.id === id);
        if (a) a[t.dataset.adjField] = t.dataset.adjField === 'amount' ? Number(t.value) || 0 : t.value;
      }, { keepView: true });
      return;
    }
    if (t.id === 'importSettings' && t.files[0]) {
      t.files[0].text().then((txt) => {
        try {
          const next = JSON.parse(txt);
          state.settings = { ...state.settings, ...next };
          state.months.clear();
          saveSettings({ immediate: true }).then(() => load());
          toast('Settings imported');
        } catch {
          toast('Invalid settings file');
        }
      });
    }
  });
}

function rerenderKeepingFocus() {
  const id = document.activeElement?.id;
  const pos = document.activeElement?.selectionStart;
  renderView();
  if (id) {
    const el = document.getElementById(id);
    el?.focus();
    if (pos != null) el?.setSelectionRange(pos, pos);
  }
}

function handleAction(action, t) {
  const key = ym(state.year, state.month);
  switch (action) {
    case 'reload':
      return load({ fresh: true });
    case 'use-raise-start':
      updateSettings((s) => (s.groupRaise.since = t.closest('[data-action]').dataset.date));
      return toast('Saved');
    case 'pick-teacher':
      return openTeacherPicker();
    case 'csv':
      return exportCsv();
    case 'add-adj':
      updateSettings((s) => {
        s.adjustments[key] = [...(s.adjustments[key] ?? []), { id: Math.random().toString(36).slice(2), label: '', amount: 0 }];
      });
      return setTimeout(() => document.querySelector('[data-adj]:last-of-type input')?.focus(), 0);
    case 'del-adj': {
      const id = t.closest('[data-adj]').dataset.adj;
      return updateSettings((s) => {
        s.adjustments[key] = (s.adjustments[key] ?? []).filter((a) => a.id !== id);
      });
    }
    case 'reset-unit': {
      const id = t.closest('[data-unit-card]').dataset.unitCard;
      return updateSettings((s) => delete s.unitOverrides[id]);
    }
    case 'clear-overrides':
      if (confirm('Reset rate overrides for all groups?')) updateSettings((s) => (s.unitOverrides = {}));
      return;
    case 'export-settings': {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(state.settings, null, 2)], { type: 'application/json' }));
      a.download = 'salary-settings.json';
      a.click();
      return URL.revokeObjectURL(a.href);
    }
  }
}

// ---------------------------------------------------------------- boot
// Loads the teacher's group history; fills in the raise start date the first time.
async function initHistory() {
  await loadHistory();
  const sug = suggestedRaiseStart();
  if (sug && !state.settings.groupRaise.since) {
    updateSettings((s) => (s.groupRaise.since = sug.firstDate), { immediate: true });
    toast(`Group raise counted from ${sug.firstDate}, your first group in HolliHop. You can change it in Settings.`, 6000);
  } else renderAll();
}

async function boot() {
  readHash();
  bindEvents();
  try {
    state.settings = await api('/api/settings');
  } catch (e) {
    $('#view').innerHTML = `<div class="banner error">⚠️ ${esc(e.message)}</div>`;
    return;
  }
  writeHash();
  initHistory();
  api('/api/teachers')
    .then((t) => {
      state.teachers = t;
      renderAll();
    })
    .catch(() => {});
  load();
}

boot();
