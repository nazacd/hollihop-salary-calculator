import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonth, categoryOf, lessonPay, unitRule, groupRaise, monthsBetween, isPaidStudent } from '../public/calc.js';
import { monthRange, findDemo } from '../src/month.js';

const settings = (over = {}) => ({
  currency: 'UZS',
  rates: { group: 10_000, individual: 50_000 },
  modes: { group: 'per_student', individual: 'per_student' },
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

test('monthsBetween counts whole months', () => {
  assert.equal(monthsBetween('2026-04-22', '2026-10-21'), 5);
  assert.equal(monthsBetween('2026-04-22', '2026-10-22'), 6);
  assert.equal(monthsBetween('2026-04-22', '2027-01-01'), 8);
});

test('group rate rises by 500 every 6 months from the start date', () => {
  const s = settings({ rates: { group: 15_000, individual: 0 }, groupRaise: { amount: 500, everyMonths: 6, since: '2026-04-22' } });
  assert.equal(groupRaise('2026-04-01', s), 0, 'no raise before start');
  assert.equal(groupRaise('2026-10-21', s), 0);
  assert.equal(groupRaise('2026-10-22', s), 500);
  assert.equal(groupRaise('2027-10-22', s), 1_500);

  const rule = unitRule(month.units[0], s);
  const lesson = (date) => ({ ...month.lessons[0], date }); // 2 paid students
  assert.equal(lessonPay(lesson('2026-10-21'), rule, s).amount, 30_000);
  assert.equal(lessonPay(lesson('2026-10-22'), rule, s).amount, 31_000);

  // A custom per-group rate is used as-is, without the raise.
  const custom = settings({ ...s, unitOverrides: { 1: { rate: 20_000 } } });
  assert.equal(lessonPay(lesson('2027-10-22'), unitRule(month.units[0], custom), custom).amount, 40_000);
});

test('individual pay: 1,250,000 per student for a package of 12 lessons', () => {
  const s = settings({ rates: { group: 15_000, individual: 1_250_000 }, modes: { group: 'per_student', individual: 'package' }, packageLessons: 12 });
  const rule = unitRule(month.units[1], s);
  assert.equal(rule.mode, 'package');
  const perLesson = Math.round((1_250_000 * 100) / 12) / 100;
  assert.equal(lessonPay(month.lessons[3], rule, s).amount, perLesson);

  // Pairs: each paid student counts; an excused absence doesn't.
  const pair = { ...month.lessons[3], students: [st(12), st(13), st(14, { absent: true })] };
  assert.equal(lessonPay(pair, rule, s).amount, Math.round((2 * 1_250_000 * 100) / 12) / 100);

  // 12 paid lessons in a month → exactly one package, regardless of month length.
  const m = {
    ...month,
    units: [month.units[1]],
    students: [month.students[2]],
    lessons: Array.from({ length: 12 }, (_, i) => ({ unitId: 2, date: `2026-09-${String(i + 1).padStart(2, '0')}`, minutes: 90, status: 'taught', students: [st(12)] })),
  };
  assert.ok(Math.abs(computeMonth(m, s).totals.earned - 1_250_000) < 1);

  // Package size is configurable.
  const eight = settings({ ...s, packageLessons: 8 });
  assert.equal(lessonPay(month.lessons[3], unitRule(month.units[1], eight), eight).amount, 156_250);
});

const hd = (Date, Pass, Description) => ({ Date, Pass, Description });

test('findDemo: the demo is the last DEMO note up to the first visit, else the first visit', () => {
  // XAYDAROVA IRODA: planned demo on 18 Sep she skipped, real demo on 5 Oct, first marked present 7 Oct
  const iroda = [hd('2026-09-18', true, 'DEMO'), hd('2026-09-21', true), hd('2026-10-02', true), hd('2026-10-05', true, 'DEMO'), hd('2026-10-07', false)];
  assert.equal(findDemo(iroda), '2026-10-05');
  // JURAYEVA SHAHLO: "DEMO KELDILAR" marked absent, then present the next lesson
  assert.equal(findDemo([hd('2026-08-13', false), hd('2026-08-12', true, 'DEMO KELDILAR')]), '2026-08-12');
  // No note: the first visit is the demo
  assert.equal(findDemo([hd('2026-09-21', false), hd('2026-09-23', false)]), '2026-09-21');
  // Later DEMO-like notes after the first visit don't matter
  assert.equal(findDemo([hd('2026-09-21', false), hd('2026-09-23', true, 'demo')]), '2026-09-21');
  // Never came
  assert.equal(findDemo([hd('2026-09-21', true), hd('2026-09-23', true)]), null);
});

test('demo and not-started days are unpaid; "charged" basis skips excused absences', () => {
  const s = settings({ basis: 'charged' });
  const present = { absent: false, studentPayable: true, teacherPayable: true };
  const unexcused = { absent: true, studentPayable: true, teacherPayable: true };
  const excused = { absent: true, studentPayable: false, teacherPayable: true }; // e.g. "KASAL BOGAN"
  assert.equal(isPaidStudent(present, s), true);
  assert.equal(isPaidStudent(unexcused, s), true);
  assert.equal(isPaidStudent(excused, s), false);
  assert.equal(isPaidStudent(excused, settings({ basis: 'payable' })), true);
  assert.equal(isPaidStudent({ ...present, demo: true }, s), false);
  assert.equal(isPaidStudent({ ...unexcused, beforeStart: true }, s), false);
  assert.equal(isPaidStudent({ ...present, demo: true }, settings({ basis: 'charged', demoUnpaid: false })), true);

  const lesson = {
    unitId: 1,
    date: '2026-09-21',
    minutes: 90,
    status: 'taught',
    students: [
      { clientId: 10, ...present },
      { clientId: 11, ...present, demo: true },
      { clientId: 12, ...unexcused, beforeStart: true },
    ],
  };
  const pay = lessonPay(lesson, unitRule(month.units[0], s), s);
  assert.deepEqual({ paid: pay.paid, demo: pay.demo, total: pay.total, absentPaid: pay.absentPaid }, { paid: 1, demo: 1, total: 1, absentPaid: 0 });
  assert.equal(pay.amount, 10_000);

  const r = computeMonth({ ...month, lessons: [lesson] }, s);
  assert.equal(r.totals.demo, 1);
  assert.equal(r.students.find((x) => x.clientId === 11).demo, 1);
  assert.equal(r.students.find((x) => x.clientId === 12).absentPaid, 0);
});
