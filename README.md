# HolliHop salary calculator

A small personal website that calculates a teacher's salary from [HolliHop](https://hollihop.ru) CRM data.

It pulls your groups, lesson days and per-student attendance from the HolliHop API, applies your pay rates and shows:

- **Salary for the month**: earned so far, projected total (including scheduled lessons), bonuses and deductions, and progress towards a monthly goal.
- **Calendar**: every lesson of the month, colour-coded as *taught*, *upcoming*, *cancelled* or *covered by a colleague*. Click a day to see who attended and what each lesson paid.
- **Lessons**: a filterable list with present/paid counts, amount and HolliHop notes, plus CSV export.
- **Students**: attendance, paid and unpaid absences, how much you earned from each student, and their phone numbers.
- **Groups & rates**: per-group overrides for type (group / individual), pay mode (per student, per lesson, per hour, not paid) and rate.
- **Trends**: salary, hours, attendance and cancellations over the last 3, 6 or 12 months.
- **Attention** panel: unpaid absences, lessons that earned nothing, lessons colleagues covered for you, groups you substituted in, students who left, and groups with no rate set.

Switch months with the arrows, or with the ← / → keys.

## How pay is calculated

Defaults (all editable in **Settings**):

- **Group lessons**: 15,000 UZS per paid student per lesson, plus **500 UZS every 6 months** from the date you became a group teacher. That date is suggested from HolliHop: it's the first regular (not one-day substitution) schedule of yours in a group. The raise is applied per lesson date, so lessons from the raise day onwards use the new rate.
- **Individual lessons**: 1,250,000 UZS per student per month, split across the month's lessons. In a pair, each student pays this. The default divisor is the number of lessons the group's weekly schedule gives that month (e.g. Tue/Thu/Sat in September 2026 = 13), or the actual number of lessons if there were more. You can set a fixed number instead (e.g. 12). If you teach every lesson and the student is paid for all of them, you get exactly 1,250,000. Lessons a colleague covered, and months where the student joined or left part-way, pay proportionally less.

Any group can be overridden with its own type, pay mode and rate:

| Pay mode | Amount per lesson |
| --- | --- |
| Student × lesson | `rate (+ raise) × paid students` |
| Monthly / student | `rate ÷ lessons in month × paid students` |
| Per lesson | `rate` (if at least one student is paid) |
| Per hour | `rate × lesson minutes / 60` |
| Not paid | `0` |

A custom per-group rate is used as-is, without the seniority raise.

A student counts as **paid** either:
- *As HolliHop marks it* (default): HolliHop's "payable to teacher" flag on the attendance record, so an absence without a valid reason is paid and an excused one isn't; or
- *Only students who attended*.

A group is treated as individual when its learning type or name matches a regex (default `\bIV\b|INDIV`, so `IV OFFLINE` groups are individual).

Only lessons you actually taught count. HolliHop's per-teacher days are used, so lessons a colleague covered for you are excluded (and shown as "missed"). Lessons where you substituted in someone else's group are included.

## Setup

Requires Node.js 20.12+ (no npm dependencies).

```bash
cp .env.example .env    # then fill in BASE_URL and AUTHKEY
npm start               # http://localhost:3000
```

| Variable | Description |
| --- | --- |
| `BASE_URL` | HolliHop API base, e.g. `https://yourschool.t8s.ru/Api/V2` |
| `AUTHKEY` | HolliHop API key |
| `TEACHER_ID` | Optional. Your teacher id. If it's not set, pick yourself in the UI. |
| `APP_PASSWORD` | Optional. Protects the site with HTTP basic auth (any username). **Recommended if the site is reachable from the internet**, because it shows students' phone numbers. |
| `PORT` | Optional, default `3000` |

The API key never leaves the server. Settings (rates, overrides, bonuses) are stored in `data/settings.json`; use *Settings → Export* to back them up.

### Docker

```bash
docker build -t salary .
docker run -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data salary
```

## Development

```bash
npm run dev   # restarts on file changes
npm test      # salary calculation tests
```

- `server.js`: HTTP server, JSON API and static files
- `src/hollihop.js`: HolliHop API client with a 5-minute cache (use the ⟳ button to bypass it)
- `src/month.js`: turns HolliHop units, days and attendance into a month snapshot
- `src/settings.js`: settings persistence
- `public/calc.js`: salary calculation (shared by the UI and the tests)
- `public/app.js`: the single-page UI
