// Builds a normalized month snapshot for one teacher out of raw HolliHop data.
// Salary is computed on the client (public/calc.js) so rate changes are instant.

const pad = (n) => String(n).padStart(2, '0');

export function monthRange(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(last)}`,
  };
}

function teacherIdsOf(item) {
  if (Array.isArray(item.TeacherIds) && item.TeacherIds.length) return item.TeacherIds;
  return item.TeacherId != null ? [item.TeacherId] : [];
}

function teacherNamesOf(item) {
  if (Array.isArray(item.Teachers) && item.Teachers.length) return item.Teachers;
  return item.Teacher ? [item.Teacher] : [];
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildMonth(api, { teacherId, year, month, fresh = false }) {
  const { from, to } = monthRange(year, month);
  const opts = { fresh };
  const tid = Number(teacherId);

  // Units the teacher taught in this month; Days here are only the teacher's own days.
  const { units: myUnits, now } = await api.edUnits({ teacherId: tid, dateFrom: from, dateTo: to }, opts);

  const perUnit = await mapLimit(myUnits, 4, async (u) => {
    const [full, students] = await Promise.all([
      api.edUnits({ id: u.Id, dateFrom: from, dateTo: to }, opts).then((r) => r.units[0]),
      api.edUnitStudents({ edUnitId: u.Id, dateFrom: from, dateTo: to }, opts),
    ]);
    return { mine: u, full: full ?? u, students };
  });

  const nowStr = (now || new Date().toISOString()).slice(0, 16); // YYYY-MM-DDTHH:MM
  const units = [];
  const lessons = [];
  const studentMap = new Map();

  for (const { mine, full, students } of perUnit) {
    const scheduleById = new Map();
    for (const s of full.ScheduleItems ?? []) scheduleById.set(s.Id, s);
    for (const s of mine.ScheduleItems ?? []) if (!scheduleById.has(s.Id)) scheduleById.set(s.Id, s);

    const myDays = new Map((mine.Days ?? []).map((d) => [d.Date, d]));
    // A unit where most lessons belong to someone else means you were only substituting.
    const othersDays = (full.Days ?? []).filter((d) => !myDays.has(d.Date) && !d.Pass).length;
    const isCover = myDays.size < othersDays;

    units.push({
      id: mine.Id,
      type: mine.Type,
      name: (mine.Name || '').replace(/\s+/g, ' ').trim(),
      discipline: mine.Discipline,
      level: mine.Level,
      learningType: mine.LearningType,
      office: mine.OfficeOrCompanyName,
      studentsCount: mine.StudentsCount,
      assignee: mine.Assignee?.FullName,
      isCover,
      schedule: (mine.ScheduleItems ?? []).map((s) => ({
        beginDate: s.BeginDate,
        endDate: s.EndDate,
        weekdays: s.Weekdays,
        beginTime: s.BeginTime,
        endTime: s.EndTime,
        room: s.ClassroomName,
      })),
    });

    // Per-student day info keyed by date.
    const studentDays = new Map(); // date -> [{...}]
    for (const st of students) {
      const id = st.StudentClientId;
      if (!studentMap.has(id)) {
        studentMap.set(id, {
          clientId: id,
          name: (st.StudentName || '').replace(/\s+/g, ' ').trim(),
          mobile: st.StudentMobile && st.StudentMobile !== '-' ? st.StudentMobile : st.StudentAgents?.find((a) => a.Mobile)?.Mobile,
          enrollments: [],
        });
      }
      studentMap.get(id).enrollments.push({
        unitId: mine.Id,
        beginDate: st.BeginDate,
        endDate: st.EndDate,
        status: st.Status,
        leaveReason: st.StudentExtraFields?.find((f) => /SABAB|REASON/i.test(f.Name))?.Value,
      });
      for (const d of st.Days ?? []) {
        if (!studentDays.has(d.Date)) studentDays.set(d.Date, []);
        studentDays.get(d.Date).push({
          clientId: id,
          absent: !!d.Pass,
          teacherPayable: (d.TeacherPayableMinutes ?? 0) > 0,
          studentPayable: (d.StudentPayableMinutes ?? 0) > 0,
          description: d.Description || undefined,
        });
      }
    }

    for (const d of full.Days ?? []) {
      const mineDay = myDays.get(d.Date);
      const sched = (d.ScheduleItemIds ?? []).map((sid) => scheduleById.get(sid)).find(Boolean);
      const beginTime = sched?.BeginTime;
      const endTime = sched?.EndTime;
      let status;
      let coveredBy;
      if (mineDay) {
        if (mineDay.Pass) status = 'cancelled';
        else if (`${d.Date}T${endTime || '23:59'}` > nowStr) status = 'upcoming';
        else status = 'taught';
      } else {
        // Someone else taught this lesson in your unit (a substitute covered you).
        if (d.Pass || isCover) continue;
        if (sched && teacherIdsOf(sched).includes(tid)) continue;
        status = 'covered';
        coveredBy = sched ? teacherNamesOf(sched).join(', ') : undefined;
      }
      const day = mineDay ?? d;
      lessons.push({
        unitId: mine.Id,
        date: d.Date,
        beginTime,
        endTime,
        minutes: day.Minutes ?? 0,
        status,
        coveredBy,
        room: sched?.ClassroomName,
        description: day.Description || undefined,
        students: studentDays.get(d.Date) ?? [],
      });
    }
  }

  lessons.sort((a, b) => (a.date + (a.beginTime || '')).localeCompare(b.date + (b.beginTime || '')));
  units.sort((a, b) => a.name.localeCompare(b.name));
  const studentsOut = [...studentMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { teacherId: tid, year, month, from, to, now: nowStr, units, lessons, students: studentsOut };
}

// Every unit the teacher ever had a schedule in, with the first date they taught it.
// Used to suggest when the teacher started leading their own groups.
export async function teacherHistory(api, { teacherId, fresh = false }) {
  const tid = Number(teacherId);
  const today = new Date().toISOString().slice(0, 10);
  const { units } = await api.edUnits({ teacherId: tid, dateFrom: '2000-01-01', dateTo: today, queryDays: false }, { fresh });
  return units
    .map((u) => {
      const items = [...(u.ScheduleItems ?? [])].sort((a, b) => (a.BeginDate || '').localeCompare(b.BeginDate || ''));
      const mine = items.filter((s) => teacherIdsOf(s).includes(tid));
      if (!mine.length) return null;
      return {
        id: u.Id,
        type: u.Type,
        name: (u.Name || '').replace(/\s+/g, ' ').trim(),
        learningType: u.LearningType,
        firstDate: mine[0].BeginDate,
        // First regular schedule (a week or longer / open-ended) – one-day entries are substitutions.
        regularSince: mine.find((s) => !s.EndDate || daysBetween(s.BeginDate, s.EndDate) >= 7)?.BeginDate ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.regularSince ?? a.firstDate).localeCompare(b.regularSince ?? b.firstDate));
}
