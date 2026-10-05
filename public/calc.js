// Salary calculation. Pure functions, shared by the browser UI and the tests.

export const MODES = {
  per_student: 'Per student',
  per_lesson: 'Per lesson',
  per_hour: 'Per hour',
  none: 'Not paid',
};

export function categoryOf(unit, settings) {
  const override = settings.unitOverrides?.[unit.id]?.category;
  if (override) return override;
  if (unit.type === 'Individual') return 'individual';
  try {
    const re = new RegExp(settings.individualPattern || '$^', 'i');
    if (re.test(unit.learningType || '') || re.test(unit.name || '')) return 'individual';
  } catch {
    // invalid user regex – fall through
  }
  return 'group';
}

export function unitRule(unit, settings) {
  const o = settings.unitOverrides?.[unit.id] ?? {};
  const category = categoryOf(unit, settings);
  return {
    category,
    mode: o.mode ?? 'per_student',
    rate: o.rate ?? settings.rates?.[category] ?? 0,
    custom: o.mode !== undefined || o.rate !== undefined,
  };
}

export function isPaidStudent(s, settings) {
  return settings.basis === 'attended' ? !s.absent : s.teacherPayable;
}

export function lessonPay(lesson, rule, settings) {
  const students = lesson.students ?? [];
  const present = students.filter((s) => !s.absent).length;
  const paid = students.filter((s) => isPaidStudent(s, settings)).length;
  const absentPaid = students.filter((s) => s.absent && isPaidStudent(s, settings)).length;
  const absentUnpaid = students.filter((s) => s.absent && !isPaidStudent(s, settings)).length;

  // What this lesson is worth; only taught/upcoming lessons actually earn it.
  let worth = 0;
  if (rule.mode === 'per_student') worth = rule.rate * paid;
  else if (rule.mode === 'per_lesson') worth = paid > 0 || students.length === 0 ? rule.rate : 0;
  else if (rule.mode === 'per_hour') worth = paid > 0 || students.length === 0 ? (rule.rate * (lesson.minutes || 0)) / 60 : 0;
  worth = Math.round(worth * 100) / 100;
  const earning = lesson.status === 'taught' || lesson.status === 'upcoming';
  return { present, paid, absentPaid, absentUnpaid, total: students.length, amount: earning ? worth : 0, worth };
}

const ymOf = (m) => `${m.year}-${String(m.month).padStart(2, '0')}`;

export function computeMonth(month, settings) {
  const unitsById = new Map(month.units.map((u) => [u.id, u]));
  const rules = new Map(month.units.map((u) => [u.id, unitRule(u, settings)]));

  const unitStats = new Map(
    month.units.map((u) => [
      u.id,
      { ...u, rule: rules.get(u.id), taught: 0, upcoming: 0, cancelled: 0, covered: 0, minutes: 0, paidVisits: 0, earned: 0, projected: 0 },
    ]),
  );
  const studentStats = new Map(
    month.students.map((s) => [s.clientId, { ...s, attended: 0, absentPaid: 0, absentUnpaid: 0, earned: 0, upcoming: 0 }]),
  );

  const totals = {
    earned: 0,
    upcomingAmount: 0,
    taught: 0,
    upcoming: 0,
    cancelled: 0,
    covered: 0,
    minutes: 0,
    paidVisits: 0,
    presentVisits: 0,
    visits: 0,
    absentUnpaid: 0,
    absentPaid: 0,
    missed: 0,
  };
  const daily = new Map();

  const lessons = month.lessons.map((l) => {
    const unit = unitsById.get(l.unitId);
    const rule = rules.get(l.unitId);
    const pay = lessonPay(l, rule, settings);
    const u = unitStats.get(l.unitId);
    u[l.status] += 1;

    if (l.status === 'taught') {
      totals.taught += 1;
      totals.minutes += l.minutes || 0;
      totals.earned += pay.amount;
      totals.paidVisits += pay.paid;
      totals.presentVisits += pay.present;
      totals.visits += pay.total;
      totals.absentPaid += pay.absentPaid;
      totals.absentUnpaid += pay.absentUnpaid;
      u.minutes += l.minutes || 0;
      u.paidVisits += pay.paid;
      u.earned += pay.amount;
      daily.set(l.date, (daily.get(l.date) ?? 0) + pay.amount);
    } else if (l.status === 'upcoming') {
      totals.upcoming += 1;
      totals.upcomingAmount += pay.amount;
      u.projected += pay.amount;
    } else {
      totals[l.status] += 1;
      if (l.status === 'covered') totals.missed += pay.worth;
    }

    // Attribute money to students: per-student mode pays per student, other modes are split evenly.
    if (l.status === 'taught' || l.status === 'upcoming') {
      const paidStudents = l.students.filter((s) => isPaidStudent(s, settings));
      const share = paidStudents.length ? pay.amount / paidStudents.length : 0;
      for (const s of l.students) {
        const st = studentStats.get(s.clientId);
        if (!st) continue;
        const paid = isPaidStudent(s, settings);
        if (l.status === 'upcoming') {
          if (paid) st.upcoming += share;
          continue;
        }
        if (!s.absent) st.attended += 1;
        else if (paid) st.absentPaid += 1;
        else st.absentUnpaid += 1;
        if (paid) st.earned += share;
      }
    }

    return { ...l, unit, rule, pay };
  });

  for (const u of unitStats.values()) u.projected += u.earned;

  const adjustments = settings.adjustments?.[ymOf(month)] ?? [];
  const adjustmentsTotal = adjustments.reduce((a, b) => a + (Number(b.amount) || 0), 0);
  totals.adjustments = adjustmentsTotal;
  totals.total = totals.earned + adjustmentsTotal;
  totals.projected = totals.total + totals.upcomingAmount;
  totals.attendanceRate = totals.visits ? totals.presentVisits / totals.visits : null;

  return {
    lessons,
    units: [...unitStats.values()].sort((a, b) => b.projected - a.projected || a.name.localeCompare(b.name)),
    students: [...studentStats.values()],
    totals,
    adjustments,
    daily,
  };
}
