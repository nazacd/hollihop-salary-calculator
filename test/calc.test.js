import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonth, categoryOf, lessonPay, unitRule } from '../public/calc.js';
import { monthRange } from '../src/month.js';

const settings = (over = {}) => ({
  currency: 'UZS',
  rates: { group: 10_000, individual: 50_000 },
  basis: 'payable',
  individualPattern: '\\bIV\\b|INDIV',
  unitOverrides: {},
  adjustments: {},
  ...over,
});

const st = (clientId, { absent = false, teacherPayable = !absent } = {}) => ({ clientId, absent, teacherPayable, studentPayable: teacherPayable });

const month = {
  year: 2026,
  month: 9,
  from: '2026-09-01',
  to: '2026-09-30',
  units: [
    { id: 1, type: 'Group', name: 'SAT MATH 15:30', learningType: 'GROUP', schedule: [] },
    { id: 2, type: 'Group', name: 'IV PAIR', learningType: 'IV OFFLINE', schedule: [] },
  ],
  students: [
    { clientId: 10, name: 'A', enrollments: [{ unitId: 1 }] },
    { clientId: 11, name: 'B', enrollments: [{ unitId: 1 }] },
    { clientId: 12, name: 'C', enrollments: [{ unitId: 2 }] },
  ],
  lessons: [
    // 2 present + 1 absent-but-payable -> 3 paid
    { unitId: 1, date: '2026-09-01', minutes: 90, status: 'taught', students: [st(10), st(11, { absent: true, teacherPayable: true })] },
    // absent and not payable -> 1 paid
    { unitId: 1, date: '2026-09-03', minutes: 90, status: 'taught', students: [st(10), st(11, { absent: true })] },
    { unitId: 1, date: '2026-09-05', minutes: 90, status: 'cancelled', students: [st(10, { absent: true }), st(11, { absent: true })] },
    { unitId: 2, date: '2026-09-02', minutes: 90, status: 'taught', students: [st(12)] },
    { unitId: 2, date: '2026-09-04', minutes: 90, status: 'covered', coveredBy: 'X', students: [st(12)] },
    { unitId: 2, date: '2026-09-30', minutes: 90, status: 'upcoming', students: [st(12)] },
  ],
};

test('monthRange handles month lengths', () => {
  assert.deepEqual(monthRange(2026, 2), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange(2028, 2), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthRange(2026, 12), { from: '2026-12-01', to: '2026-12-31' });
});

test('categoryOf detects individual units and honours overrides', () => {
  const s = settings();
  assert.equal(categoryOf(month.units[0], s), 'group');
  assert.equal(categoryOf(month.units[1], s), 'individual');
  assert.equal(categoryOf({ id: 3, type: 'Individual', name: 'x' }, s), 'individual');
  assert.equal(categoryOf(month.units[1], settings({ unitOverrides: { 2: { category: 'group' } } })), 'group');
  assert.equal(categoryOf(month.units[1], settings({ individualPattern: '(' })), 'group', 'invalid regex is ignored');
});

test('payable basis pays absent-but-payable students', () => {
  const s = settings();
  const pay = lessonPay(month.lessons[0], unitRule(month.units[0], s), s);
  assert.equal(pay.paid, 2);
  assert.equal(pay.amount, 20_000);
});

test('attended basis only pays present students', () => {
  const s = settings({ basis: 'attended' });
  const pay = lessonPay(month.lessons[0], unitRule(month.units[0], s), s);
  assert.equal(pay.paid, 1);
  assert.equal(pay.amount, 10_000);
});

test('per_lesson and per_hour modes', () => {
  const perLesson = settings({ unitOverrides: { 1: { mode: 'per_lesson', rate: 70_000 } } });
  assert.equal(lessonPay(month.lessons[0], unitRule(month.units[0], perLesson), perLesson).amount, 70_000);
  const perHour = settings({ unitOverrides: { 1: { mode: 'per_hour', rate: 40_000 } } });
  assert.equal(lessonPay(month.lessons[0], unitRule(month.units[0], perHour), perHour).amount, 60_000);
  const none = settings({ unitOverrides: { 1: { mode: 'none' } } });
  assert.equal(lessonPay(month.lessons[0], unitRule(month.units[0], none), none).amount, 0);
});

test('computeMonth totals', () => {
  const s = settings({ adjustments: { '2026-09': [{ id: 'a', label: 'Bonus', amount: 5_000 }] } });
  const r = computeMonth(month, s);
  assert.equal(r.totals.taught, 3);
  assert.equal(r.totals.cancelled, 1);
  assert.equal(r.totals.covered, 1);
  assert.equal(r.totals.upcoming, 1);
  // 20k + 10k (group) + 50k (individual)
  assert.equal(r.totals.earned, 80_000);
  assert.equal(r.totals.adjustments, 5_000);
  assert.equal(r.totals.total, 85_000);
  assert.equal(r.totals.upcomingAmount, 50_000);
  assert.equal(r.totals.projected, 135_000);
  assert.equal(r.totals.missed, 50_000);
  assert.equal(r.totals.minutes, 270);
  assert.equal(r.totals.absentUnpaid, 1);

  const b = r.students.find((x) => x.clientId === 11);
  assert.equal(b.attended, 0);
  assert.equal(b.absentPaid, 1);
  assert.equal(b.absentUnpaid, 1);
  assert.equal(b.earned, 10_000);

  const g = r.units.find((u) => u.id === 1);
  assert.equal(g.earned, 30_000);
  assert.equal(r.daily.get('2026-09-01'), 20_000);
});
