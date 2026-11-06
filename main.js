'use strict';
/*
 * Taskline — goals timeline, task views with Google-Calendar-style recurrence,
 * and one-way sync (Obsidian → Google Calendar, Obsidian → Microsoft To Do).
 * https://github.com/amin-tehrani/obsidian-taskline  ·  MIT License
 *
 * Task note frontmatter (files in the tasks folder):
 *   type: task
 *   goal: "[[Get fit]]"
 *   time: 2026-11-06T12:00        # or just 2026-11-06 for all-day
 *   duration: 60                  # minutes, or "1h30m"
 *   status: Not started           # one-off tasks: Not started | In progress | Done
 *   recurring: every weekday      # optional; makes the note a series
 *   until: 2026-12-31             # optional end of series
 *   reminder: [1d, 10m]           # optional: before start; "none" = no reminder; empty = default
 *   done_dates: [2026-11-06]      # per-occurrence completion (recurring)
 *   skipped_dates: [2026-11-10]   # per-occurrence skip (recurring)
 *   moved: ["2026-11-12 -> 2026-11-12T20:00"]  # per-occurrence reschedule (recurring)
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, MarkdownRenderChild } = obsidian;
// Syncing needs a desktop (OAuth loopback + Node). Vaults are often shared between devices
// (Obsidian Sync, iCloud, Syncthing, git), including this plugin's data.json, so exactly one
// desktop — the "sync device" — talks to Google/Microsoft; every other device only shows and edits tasks.
const IS_MOBILE = !!(obsidian.Platform && !obsidian.Platform.isDesktopApp);
const LOCAL_SETTING_KEYS = ['tasksFolder', 'goalsFolder', 'defaultDuration', 'defaultReminder',
  'statusTodo', 'statusDoing', 'statusDone', 'goalStartProp', 'goalEndProp', 'goalParentProp'];
const DEVICE_KEY = 'taskline-device-id';
function deviceId() {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); window.localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch (e) { return 'unknown'; }
}

const DEFAULT_SETTINGS = {
  tasksFolder: 'Tasks',
  goalsFolder: 'Goals',
  statusTodo: 'Not started',
  statusDoing: 'In progress',
  statusDone: 'Done',
  goalStartProp: 'target_start',
  goalEndProp: 'target_end',
  goalParentProp: 'parent_goal',
  defaultDuration: 30,
  defaultReminder: 'at start',
  autoSync: true,
  syncIntervalMin: 10,
  googleEnabled: true,
  googleClientId: '',
  googleClientSecret: '',
  googleCalendarName: 'Obsidian Tasks',
  msEnabled: true,
  msClientId: '',
  msTenant: 'common',
  msListName: 'Obsidian',
  syncDevice: '', // id of the one desktop that syncs (set on first sync / connect)
};

/** Map a status value to 'Not started' | 'In progress' | 'Done' (canonical, used internally). */
function normStatus(v, s) {
  const x = toStr(v).trim().toLowerCase();
  if (!x) return 'Not started';
  const eq = (label) => !!label && toStr(label).trim().toLowerCase() === x;
  if (eq(s.statusDone) || ['done', 'completed', 'complete', 'finished', 'x', 'true'].includes(x)) return 'Done';
  if (eq(s.statusDoing) || ['in progress', 'in-progress', 'doing', 'started', 'active'].includes(x)) return 'In progress';
  return 'Not started';
}
/** The label written to notes for a canonical status. */
function statusLabel(canonical, s) {
  return (canonical === 'Done' ? s.statusDone : canonical === 'In progress' ? s.statusDoing : s.statusTodo) || canonical;
}

/* ------------------------------------------------------------------ */
/* Date helpers (all local time, dates as 'YYYY-MM-DD' strings)        */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}
const weekday = (d) => (d.getDay() + 6) % 7; // 0 = Monday
const mondayOf = (d) => addDays(d, -weekday(d));
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const todayYmd = () => ymd(new Date());

function addMinutesLocal(date, time, mins) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const e = new Date(y, m - 1, d, hh, mm + mins);
  return { date: ymd(e), time: `${pad(e.getHours())}:${pad(e.getMinutes())}` };
}

function toStr(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length ? toStr(v[0]) : '';
  return String(v).trim();
}
function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => (x instanceof Date ? normDate(x) : toStr(x))).filter(Boolean);
  return toStr(v).split(',').map((s) => s.trim()).filter(Boolean);
}
function normDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  const m = toStr(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : null;
}
/** "2026-11-06T12:00" | "2026-11-06 12:00" | "2026-11-06" → {date, time|null} */
function parseWhen(v) {
  if (v instanceof Date && !isNaN(v)) {
    const t = v.getUTCHours() || v.getUTCMinutes() ? `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : null;
    return { date: normDate(v), time: t };
  }
  const m = toStr(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { date: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, time: m[4] != null ? `${pad(+m[4])}:${m[5]}` : null };
}
function parseDuration(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'number') return v > 0 ? Math.round(v) : dflt;
  const s = toStr(v).toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return +s || dflt;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h(?:ours?|rs?)?)?(?:(\d+)m(?:in(?:utes?|s)?)?)?$/);
  if (m && (m[1] || m[2])) return Math.round(parseFloat(m[1] || 0) * 60 + +(m[2] || 0)) || dflt;
  return dflt;
}
const REM_UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, w: 10080, week: 10080, weeks: 10080 };
const REM_MAX = 40320; // Google's limit: 4 weeks
/** Reminder offsets in minutes before start (unique, earliest first in the order written). */
function parseReminder(v) {
  if (v === false) return { mins: [] };
  const items = Array.isArray(v) ? v : toStr(v).split(/[,;]/);
  const mins = [];
  const bad = [];
  for (const raw of items) {
    if (raw == null || raw === '') continue;
    if (typeof raw === 'number') { mins.push(Math.round(raw)); continue; }
    const s = String(raw).toLowerCase().trim().replace(/\s*before( start)?$/, '').trim();
    if (!s) continue;
    if (/^(none|off|no|false)$/.test(s)) return { mins: [] };
    if (/^(at start|on time|at time|start|now|0)$/.test(s)) { mins.push(0); continue; }
    if (/^\d+$/.test(s)) { mins.push(+s); continue; }
    const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)];
    const ok = parts.length && parts.map((x) => x[0]).join('').replace(/\s+/g, '') === s.replace(/\s+/g, '') && parts.every((x) => REM_UNITS[x[2]]);
    if (!ok) { bad.push(String(raw)); continue; }
    mins.push(Math.round(parts.reduce((a, x) => a + parseFloat(x[1]) * REM_UNITS[x[2]], 0)));
  }
  const out = [...new Set(mins)];
  const tooBig = out.filter((m) => m < 0 || m > REM_MAX);
  let error = null;
  if (bad.length) error = `reminder "${bad.join(', ')}" not understood (use e.g. 10m, 1h, 1d, at start, none)`;
  else if (tooBig.length) error = 'reminders can be at most 4 weeks before';
  else if (out.length > 5) error = 'at most 5 reminders (Google Calendar limit)';
  return { mins: out.filter((m) => m >= 0 && m <= REM_MAX).slice(0, 5), error };
}
function describeReminder(mins) {
  if (!mins.length) return 'no reminder';
  return mins.map((m) => {
    if (m === 0) return 'at start';
    for (const [u, n] of [['week', 10080], ['day', 1440], ['hour', 60]]) if (m % n === 0) return `${m / n} ${u}${m / n > 1 ? 's' : ''} before`;
    return `${m} min before`;
  }).join(', ');
}

function parseMoved(v) {
  const out = {};
  for (const item of toList(v)) {
    const m = item.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*(?:->|→|=>)\s*(.+)$/);
    if (!m) continue;
    const orig = normDate(m[1]);
    const w = parseWhen(m[2].trim());
    if (orig && w) out[orig] = w;
  }
  return out;
}
const whenStr = (w) => (w.time ? `${w.date}T${w.time}` : w.date);
function linkText(v) {
  const s = toStr(v);
  const m = s.match(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/);
  return m ? m[1].trim() : s;
}

/* ------------------------------------------------------------------ */
/* Recurrence rules                                                    */
/* ------------------------------------------------------------------ */

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_FULL = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_NAMES = {
  mo: 0, mon: 0, monday: 0, tu: 1, tue: 1, tues: 1, tuesday: 1, we: 2, wed: 2, wednesday: 2,
  th: 3, thu: 3, thur: 3, thurs: 3, thursday: 3, fr: 4, fri: 4, friday: 4,
  sa: 5, sat: 5, saturday: 5, su: 6, sun: 6, sunday: 6,
};
const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 };
const ORD_LABEL = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

function parseDayList(str) {
  const parts = str.replace(/^on\s+/, '').split(/\s*(?:,|\band\b|&|\/)\s*/).filter(Boolean);
  if (!parts.length) throw new Error('no days given');
  const days = parts.map((p) => {
    const k = p.trim().replace(/\.$/, '').replace(/s$/, (x) => (p.trim().length > 4 ? '' : x)); // "mondays" → "monday"
    if (!(k in DAY_NAMES)) throw new Error(`unknown day "${p.trim()}"`);
    return DAY_NAMES[k];
  });
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Parses a human repeat rule. Only accepts rules that both Google Calendar and
 * Microsoft To Do can represent natively, so sync is always exact.
 * Returns {freq: daily|weekly|monthly|yearly, interval, byDay?, byMonthDay?, setPos?}
 */
function parseRule(text) {
  let s = toStr(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/^repeats?\s+/, '');
  s = s.replace(/^(daily|weekly|monthly|yearly|annually)\b/, (m) => ({
    daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year', annually: 'every year',
  })[m]);
  if (/^(every )?weekdays?$/.test(s)) return { freq: 'weekly', interval: 1, byDay: [0, 1, 2, 3, 4] };
  if (/^(every )?weekends?$/.test(s)) return { freq: 'weekly', interval: 1, byDay: [5, 6] };

  let m = s.match(/^every (?:(\d+|other) )?(day|week|month|year)s?(?: (.+))?$/);
  if (m) {
    const interval = m[1] === 'other' ? 2 : m[1] ? parseInt(m[1], 10) : 1;
    if (!(interval >= 1)) throw new Error('interval must be at least 1');
    const unit = m[2];
    const rest = m[3] ? m[3].replace(/^on\s+/, '').replace(/^the\s+/, '').trim() : '';
    if (unit === 'day') { if (rest) throw new Error(`unexpected "${m[3]}"`); return { freq: 'daily', interval }; }
    if (unit === 'year') { if (rest) throw new Error(`unexpected "${m[3]}" (yearly repeats on the start date)`); return { freq: 'yearly', interval }; }
    if (unit === 'week') {
      const r = { freq: 'weekly', interval };
      if (rest) r.byDay = parseDayList(rest);
      return r;
    }
    // month
    const r = { freq: 'monthly', interval };
    if (rest) {
      let mm = rest.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (mm) {
        const d = +mm[1];
        if (d < 1 || d > 31) throw new Error('day of month must be 1–31');
        r.byMonthDay = d;
        return r;
      }
      mm = rest.match(/^(first|second|third|fourth|last|1st|2nd|3rd|4th) (\w+)$/);
      if (mm) {
        const k = mm[2].replace(/\.$/, '');
        if (!(k in DAY_NAMES)) throw new Error(`unknown day "${mm[2]}"`);
        r.setPos = ORDINALS[mm[1]];
        r.byDay = [DAY_NAMES[k]];
        return r;
      }
      throw new Error(`can't read "${m[3]}" — try "on the 15th" or "on the last Fri"`);
    }
    return r;
  }
  m = s.match(/^every (.+)$/);
  if (m) return { freq: 'weekly', interval: 1, byDay: parseDayList(m[1]) };
  throw new Error(`can't understand "${text}"`);
}

function describeRule(r) {
  const every = (n, unit) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  switch (r.freq) {
    case 'daily': return every(r.interval, 'day');
    case 'weekly': {
      if (r.byDay && r.interval === 1 && r.byDay.join() === '0,1,2,3,4') return 'Every weekday';
      let s = every(r.interval, 'week');
      if (r.byDay) s += ' on ' + r.byDay.map((i) => DAY_LABEL[i]).join(', ');
      return s;
    }
    case 'monthly': {
      let s = every(r.interval, 'month');
      if (r.setPos) s += ` on the ${ORD_LABEL[r.setPos]} ${DAY_LABEL[r.byDay[0]]}`;
      else if (r.byMonthDay) s += ` on day ${r.byMonthDay}`;
      return s;
    }
    case 'yearly': return every(r.interval, 'year');
  }
  return '';
}

/** Does date `d` match `rule` for a series starting on `start`? */
function matches(rule, start, d) {
  if (daysBetween(start, d) < 0) return false;
  switch (rule.freq) {
    case 'daily': return daysBetween(start, d) % rule.interval === 0;
    case 'weekly': {
      const byDay = rule.byDay || [weekday(start)];
      if (!byDay.includes(weekday(d))) return false;
      return (daysBetween(mondayOf(start), mondayOf(d)) / 7) % rule.interval === 0;
    }
    case 'monthly': {
      const months = (d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth();
      if (months % rule.interval) return false;
      if (rule.setPos) {
        if (weekday(d) !== rule.byDay[0]) return false;
        if (rule.setPos === -1) return d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
        return Math.ceil(d.getDate() / 7) === rule.setPos;
      }
      return d.getDate() === (rule.byMonthDay || start.getDate());
    }
    case 'yearly': {
      if ((d.getFullYear() - start.getFullYear()) % rule.interval) return false;
      return d.getMonth() === start.getMonth() && d.getDate() === start.getDate();
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Task model                                                          */
/* ------------------------------------------------------------------ */

function readTask(file, fm, settings) {
  fm = fm || {};
  const t = {
    file,
    path: file.path,
    name: file.basename,
    goal: linkText(fm.goal),
    when: parseWhen(fm.time),
    duration: parseDuration(fm.duration, settings.defaultDuration),
    status: normStatus(fm.status, settings),
    ruleText: toStr(fm.recurring != null && fm.recurring !== '' ? fm.recurring : fm.repeat),
    rule: null,
    ruleError: null,
    until: normDate(fm.until),
    done: new Set(toList(fm.done_dates).map(normDate).filter(Boolean)),
    skipped: new Set(toList(fm.skipped_dates).map(normDate).filter(Boolean)),
    moved: parseMoved(fm.moved),
    reminders: [],
    reminderError: null,
  };
  {
    const raw = fm.reminder != null ? fm.reminder : fm.reminders;
    const explicit = raw != null && raw !== '' && !(Array.isArray(raw) && !raw.length);
    // default reminder applies to timed tasks only (an all-day task would ring at midnight)
    const r = explicit ? parseReminder(raw) : (t.when && t.when.time ? parseReminder(settings.defaultReminder || '') : { mins: [] });
    t.reminders = r.mins;
    if (r.error && explicit) t.reminderError = r.error;
  }
  if (t.ruleText) {
    try { t.rule = parseRule(t.ruleText); } catch (e) { t.ruleError = e.message; }
    if (t.rule && !t.when) t.ruleError = 'a repeating task needs a "time" to start from';
  }
  t.recurring = !!(t.rule && t.when);
  return t;
}

function firstOccurrence(t) {
  const start = parseYmd(t.when.date);
  const end = t.until ? parseYmd(t.until) : null;
  let d = start;
  for (let i = 0; i < 1500; i++, d = addDays(d, 1)) {
    if (end && d > end) return null;
    if (matches(t.rule, start, d)) return ymd(d);
  }
  return null;
}

function makeOcc(t, original, date, time, extra) {
  return Object.assign({
    task: t, original, date, time, recurring: t.recurring,
    status: t.recurring ? (t.done.has(original) ? 'Done' : 'Not started') : t.status,
    skipped: t.recurring && t.skipped.has(original),
    moved: false,
  }, extra || {});
}

/** All occurrences whose (possibly moved) date is within [from, to] (inclusive, 'YYYY-MM-DD'). */
function occurrencesBetween(t, from, to) {
  const out = [];
  if (!t.when) return out;
  if (!t.recurring) {
    if (t.when.date >= from && t.when.date <= to) out.push(makeOcc(t, t.when.date, t.when.date, t.when.time));
    return out;
  }
  const start = parseYmd(t.when.date);
  const last = t.until && t.until < to ? t.until : to;
  for (let d = parseYmd(from > t.when.date ? from : t.when.date); ymd(d) <= last; d = addDays(d, 1)) {
    const o = ymd(d);
    if (!matches(t.rule, start, d) || t.moved[o]) continue;
    out.push(makeOcc(t, o, o, t.when.time));
  }
  for (const [o, w] of Object.entries(t.moved)) {
    if (w.date >= from && w.date <= to) out.push(makeOcc(t, o, w.date, w.time || t.when.time, { moved: true }));
  }
  return out;
}

/** Next occurrence on/after `today` that is not done or skipped. */
function nextPending(t, today) {
  if (!t.recurring) return null;
  const cands = [];
  const start = parseYmd(t.when.date);
  const end = t.until ? parseYmd(t.until) : null;
  let d = parseYmd(today > t.when.date ? today : t.when.date);
  for (let i = 0; i < 1500; i++, d = addDays(d, 1)) {
    if (end && d > end) break;
    if (!matches(t.rule, start, d)) continue;
    const o = ymd(d);
    if (t.done.has(o) || t.skipped.has(o) || t.moved[o]) continue;
    cands.push({ date: o, time: t.when.time, original: o });
    break;
  }
  for (const [o, w] of Object.entries(t.moved)) {
    if (w.date >= today && !t.done.has(o) && !t.skipped.has(o)) cands.push({ date: w.date, time: w.time || t.when.time, original: o });
  }
  cands.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  return cands[0] || null;
}

const sortOccs = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')) || a.task.name.localeCompare(b.task.name);

/* ------------------------------------------------------------------ */
/* Sync payload builders                                               */
/* ------------------------------------------------------------------ */

function toRRule(rule, seriesStart, allDay, until) {
  const sd = parseYmd(seriesStart);
  const p = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) p.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'weekly') {
    p.push(`BYDAY=${(rule.byDay || [weekday(sd)]).map((i) => RRULE_DAYS[i]).join(',')}`);
    p.push('WKST=MO');
  }
  if (rule.freq === 'monthly') {
    if (rule.setPos) p.push(`BYDAY=${rule.setPos}${RRULE_DAYS[rule.byDay[0]]}`);
    else p.push(`BYMONTHDAY=${rule.byMonthDay || sd.getDate()}`);
  }
  if (until) {
    if (allDay) p.push(`UNTIL=${until.replace(/-/g, '')}`);
    else {
      const u = parseYmd(until);
      const e = new Date(u.getFullYear(), u.getMonth(), u.getDate(), 23, 59, 59);
      p.push(`UNTIL=${e.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    }
  }
  return 'RRULE:' + p.join(';');
}

function toGraphPattern(rule, seriesStart) {
  const sd = parseYmd(seriesStart);
  switch (rule.freq) {
    case 'daily': return { type: 'daily', interval: rule.interval };
    case 'weekly': return {
      type: 'weekly', interval: rule.interval, firstDayOfWeek: 'monday',
      daysOfWeek: (rule.byDay || [weekday(sd)]).map((i) => DAY_FULL[i]),
    };
    case 'monthly': return rule.setPos
      ? { type: 'relativeMonthly', interval: rule.interval, daysOfWeek: [DAY_FULL[rule.byDay[0]]], index: ORD_LABEL[rule.setPos] }
      : { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth: rule.byMonthDay || sd.getDate() };
    case 'yearly': return { type: 'absoluteYearly', interval: rule.interval, dayOfMonth: sd.getDate(), month: sd.getMonth() + 1 };
  }
  return null;
}

function syncDescription(t, ctx) {
  const lines = [];
  if (t.goal) lines.push(`Goal: ${t.goal}`);
  if (t.recurring) lines.push(`Repeats: ${describeRule(t.rule)}`);
  lines.push(`Open in Obsidian: obsidian://open?vault=${encodeURIComponent(ctx.vault)}&file=${encodeURIComponent(t.path)}`);
  return lines.join('\n');
}

function gReminders(t, off) {
  return { useDefault: false, overrides: off ? [] : t.reminders.map((minutes) => ({ method: 'popup', minutes })) };
}

function gTimes(date, time, duration, tz) {
  if (!time) return { start: { date }, end: { date: ymd(addDays(parseYmd(date), 1)) } };
  const e = addMinutesLocal(date, time, duration);
  return {
    start: { dateTime: `${date}T${time}:00`, timeZone: tz },
    end: { dateTime: `${e.date}T${e.time}:00`, timeZone: tz },
  };
}

/** Google event for the task (single event, or the recurring series). null = no event. */
function gSeriesBody(t, ctx) {
  if (!t.when) return null;
  const description = syncDescription(t, ctx);
  if (!t.recurring) {
    return Object.assign({ summary: (t.status === 'Done' ? '✓ ' : '') + t.name, description, status: 'confirmed', reminders: gReminders(t, t.status === 'Done') },
      gTimes(t.when.date, t.when.time, t.duration, ctx.tz));
  }
  const first = firstOccurrence(t);
  if (!first) return null;
  const allDay = !t.when.time;
  const start = parseYmd(t.when.date);
  const recurrence = [toRRule(t.rule, t.when.date, allDay, t.until)];
  const ex = [...new Set([...t.skipped, ...Object.keys(t.moved)])]
    .filter((o) => o >= first && matches(t.rule, start, parseYmd(o)))
    .sort();
  if (ex.length) {
    recurrence.push(allDay
      ? `EXDATE;VALUE=DATE:${ex.map((o) => o.replace(/-/g, '')).join(',')}`
      : `EXDATE;TZID=${ctx.tz}:${ex.map((o) => `${o.replace(/-/g, '')}T${t.when.time.replace(':', '')}00`).join(',')}`);
  }
  return Object.assign({ summary: t.name, description, status: 'confirmed', recurrence, reminders: gReminders(t) },
    gTimes(first, t.when.time, t.duration, ctx.tz));
}

/** Stand-alone Google events for moved occurrences, keyed by original date. */
function gMovedBodies(t, ctx) {
  const out = {};
  if (!t.recurring) return out;
  for (const [o, w] of Object.entries(t.moved)) {
    if (t.skipped.has(o)) continue;
    out[o] = Object.assign({
      summary: t.name,
      description: `Moved from ${o}\n${syncDescription(t, ctx)}`,
      status: 'confirmed',
      reminders: gReminders(t, t.done.has(o)),
    }, gTimes(w.date, w.time || t.when.time, t.duration, ctx.tz));
  }
  return out;
}

/** To Do holds one reminder: the first one listed, counted back from the start (all-day: from 00:00). */
function todoReminder(t, date, time, tz) {
  if (!t.reminders.length) return { isReminderOn: false };
  const r = addMinutesLocal(date, time || '00:00', -t.reminders[0]);
  return { isReminderOn: true, reminderDateTime: { dateTime: `${r.date}T${r.time}:00`, timeZone: tz } };
}

/** Microsoft To Do task body. */
function todoBody(t, ctx) {
  const base = { title: t.name, body: { content: syncDescription(t, ctx), contentType: 'text' } };
  if (!t.recurring) {
    const b = Object.assign(base, {
      status: t.status === 'Done' ? 'completed' : t.status === 'In progress' ? 'inProgress' : 'notStarted',
      recurrence: null,
      isReminderOn: false,
      dueDateTime: null,
    });
    if (t.when) {
      b.dueDateTime = { dateTime: `${t.when.date}T00:00:00`, timeZone: ctx.tz };
      if (t.status !== 'Done') Object.assign(b, todoReminder(t, t.when.date, t.when.time, ctx.tz));
    }
    return b;
  }
  const next = nextPending(t, ctx.today);
  if (!next) return Object.assign(base, { status: 'completed', recurrence: null, isReminderOn: false });
  const b = Object.assign(base, {
    status: 'notStarted',
    dueDateTime: { dateTime: `${next.date}T00:00:00`, timeZone: ctx.tz },
    recurrence: {
      pattern: toGraphPattern(t.rule, t.when.date),
      range: t.until
        ? { type: 'endDate', startDate: next.date, endDate: t.until }
        : { type: 'noEnd', startDate: next.date },
    },
    isReminderOn: false,
  });
  return Object.assign(b, todoReminder(t, next.date, next.time, ctx.tz));
}

function hashOf(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const stripNulls = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));

/* ------------------------------------------------------------------ */
/* OAuth (loopback + PKCE) and HTTP                                    */
/* ------------------------------------------------------------------ */

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const MS_SCOPE = 'offline_access Tasks.ReadWrite';
const GCAL = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function openExternal(url) {
  try { require('electron').shell.openExternal(url); } catch (e) { window.open(url); }
}

/** Runs a loopback OAuth authorization-code flow and returns the code + redirect URI used. */
function loopbackAuthorize(buildUrl, hostForRedirect) {
  const http = require('http');
  const crypto = require('crypto');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    const servers = [];
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      servers.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } });
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for sign-in (5 min).')), 5 * 60 * 1000);
    let redirectUri;
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404); res.end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:system-ui;padding:3em"><h2>${ok ? '✅ Connected — you can close this tab and go back to Obsidian.' : '❌ Sign-in failed: ' + (u.searchParams.get('error_description') || u.searchParams.get('error') || 'state mismatch')}</h2></body></html>`);
      if (ok) finish(null, { code: u.searchParams.get('code'), verifier, redirectUri });
      else finish(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'state mismatch'));
    };
    const s4 = http.createServer(handler);
    servers.push(s4);
    s4.on('error', (e) => finish(e));
    s4.listen(0, '127.0.0.1', () => {
      const port = s4.address().port;
      // also listen on IPv6 loopback in case the browser resolves "localhost" to ::1
      const s6 = http.createServer(handler);
      s6.on('error', () => { /* no IPv6 — fine */ });
      try { s6.listen(port, '::1'); servers.push(s6); } catch (e) { /* ignore */ }
      redirectUri = `http://${hostForRedirect}:${port}`;
      openExternal(buildUrl({ redirectUri, challenge, state }));
    });
  });
}

async function postForm(url, params) {
  const res = await requestUrl({
    url, method: 'POST', throw: false,
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams(params).toString(),
  });
  let json = {};
  try { json = JSON.parse(res.text || '{}'); } catch (e) { /* ignore */ }
  if (res.status >= 400) throw new Error(json.error_description || json.error || `HTTP ${res.status}`);
  return json;
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class TasklinePlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.data = {
      settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
      tokens: data.tokens || {},
      state: Object.assign({ map: {} }, data.state || {}),
    };
    this.settings = this.data.settings;
    this.syncing = false;
    this.views = new Set();
    this.lastSync = null;
    this.lastErrors = [];

    this.registerMarkdownCodeBlockProcessor('task-today', (src, el, ctx) => ctx.addChild(new TMView(el, this, renderToday)));
    this.registerMarkdownCodeBlockProcessor('task-week', (src, el, ctx) => ctx.addChild(new TMView(el, this, renderWeek)));
    this.registerMarkdownCodeBlockProcessor('task-upcoming', (src, el, ctx) => ctx.addChild(new TMView(el, this, renderUpcoming)));
    this.registerMarkdownCodeBlockProcessor('goal-timeline', (src, el, ctx) => ctx.addChild(new TMView(el, this, renderTimeline)));

    this.addCommand({ id: 'new-task', name: 'New task', callback: () => new NewTaskModal(this).open() });
    this.addRibbonIcon('list-plus', 'New task', () => new NewTaskModal(this).open());
    this.addSettingTab(new TMSettingTab(this.app, this));
    if (IS_MOBILE) return;

    this.addCommand({ id: 'sync-now', name: 'Sync now (Google Calendar + Microsoft To Do)', callback: () => this.sync(true) });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('tm-status');
    this.statusEl.onclick = () => this.sync(true);
    this.updateStatus();

    // keep sync mappings stable when notes are renamed
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const map = this.data.state.map;
      if (map[oldPath]) { map[file.path] = map[oldPath]; delete map[oldPath]; this.save(); }
      if (this.isTaskPath(file.path) || this.isTaskPath(oldPath)) this.scheduleSync();
    }));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => { if (this.isTaskPath(file.path)) this.scheduleSync(); }));
    this.registerEvent(this.app.vault.on('delete', (file) => { if (this.isTaskPath(file.path)) this.scheduleSync(); }));

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.sync(false), 5000);
      this.registerInterval(window.setInterval(() => this.sync(false), Math.max(1, this.settings.syncIntervalMin) * 60 * 1000));
    });
  }

  onunload() { clearTimeout(this.syncTimer); }

  refreshViews() { for (const v of this.views) v.queue(); }

  /** True if this device is (or may become) the one that syncs. */
  isSyncDevice() { return !IS_MOBILE && (!this.settings.syncDevice || this.settings.syncDevice === deviceId()); }

  /** Make this desktop the sync device, starting from what is on disk (another device may have newer state). */
  async takeOverSync() {
    const data = (await this.loadData()) || {};
    const local = {};
    for (const k of LOCAL_SETTING_KEYS) local[k] = this.settings[k];
    this.data = {
      settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}, local, { syncDevice: deviceId() }),
      tokens: data.tokens || {},
      state: Object.assign({ map: {} }, data.state || {}),
    };
    this.settings = this.data.settings;
    this.gCalChecked = false; this.tListChecked = false;
    await this.saveData(this.data);
  }

  async save() {
    if (this.isSyncDevice()) { await this.saveData(this.data); return; }
    // not the sync device: write back only the general settings, never tokens/sync state
    const fresh = (await this.loadData()) || {};
    fresh.settings = Object.assign({}, fresh.settings || {});
    for (const k of LOCAL_SETTING_KEYS) fresh.settings[k] = this.settings[k];
    await this.saveData(fresh);
  }

  isTaskPath(p) { return p.startsWith(this.settings.tasksFolder.replace(/\/$/, '') + '/') && p.endsWith('.md'); }
  isGoalPath(p) { return p.startsWith(this.settings.goalsFolder.replace(/\/$/, '') + '/') && p.endsWith('.md'); }

  getTasks() {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => this.isTaskPath(f.path))
      .map((f) => ({ f, fm: (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {} }))
      .filter(({ fm }) => !fm.type || toStr(fm.type).toLowerCase() === 'task')
      .map(({ f, fm }) => readTask(f, fm, this.settings));
  }

  getGoals() {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => this.isGoalPath(f.path))
      .map((f) => ({ file: f, fm: (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {} }))
      .filter(({ fm }) => !fm.type || toStr(fm.type).toLowerCase() === 'goal');
  }

  openNote(path, newLeaf) { this.app.workspace.openLinkText(path, '', !!newLeaf); }

  /* ---------- task actions ---------- */

  async editFm(task, fn) { await this.app.fileManager.processFrontMatter(task.file, fn); }

  async toggleDone(o) {
    if (o.recurring) return this.setOccurrenceFlag(o.task, o.original, 'done_dates', o.status !== 'Done');
    return this.editFm(o.task, (fm) => { fm.status = statusLabel(o.status === 'Done' ? 'Not started' : 'Done', this.settings); });
  }

  async toggleSkip(o) { return this.setOccurrenceFlag(o.task, o.original, 'skipped_dates', !o.skipped); }

  async setStatus(task, status) { return this.editFm(task, (fm) => { fm.status = statusLabel(status, this.settings); }); }

  async setOccurrenceFlag(task, original, key, on) {
    return this.editFm(task, (fm) => {
      const set = new Set(toList(fm[key]).map(normDate).filter(Boolean));
      on ? set.add(original) : set.delete(original);
      fm[key] = [...set].sort();
    });
  }

  /** newWhen = {date, time|null}; null = reset a moved recurring occurrence */
  async moveOccurrence(o, newWhen) {
    const t = o.task;
    if (!o.recurring) return this.editFm(t, (fm) => { fm.time = whenStr(newWhen); });
    return this.editFm(t, (fm) => {
      const kept = toList(fm.moved).filter((item) => normDate(item.split(/->|→|=>/)[0]) !== o.original);
      const same = newWhen && newWhen.date === o.original && (newWhen.time || null) === (t.when.time || null);
      if (newWhen && !same) kept.push(`${o.original} -> ${whenStr(newWhen)}`);
      fm.moved = kept.sort();
    });
  }

  /* ---------- sync ---------- */

  scheduleSync() {
    if (!this.settings.autoSync) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(false), 10000);
  }

  googleReady() { return this.settings.googleEnabled && this.data.tokens.google && this.data.tokens.google.refresh; }
  msReady() { return this.settings.msEnabled && this.data.tokens.ms && this.data.tokens.ms.refresh; }

  updateStatus(text) {
    if (!this.statusEl) return;
    if (!this.isSyncDevice() || (!this.googleReady() && !this.msReady())) { this.statusEl.setText(''); return; }
    if (text) { this.statusEl.setText(text); return; }
    const t = this.lastSync ? `${pad(this.lastSync.getHours())}:${pad(this.lastSync.getMinutes())}` : '—';
    this.statusEl.setText(this.lastErrors.length ? `⚠ Task sync: ${this.lastErrors.length} error(s)` : `⟳ Tasks synced ${t}`);
    this.statusEl.setAttr('title', this.lastErrors.length ? this.lastErrors.join('\n') : 'Click to sync now');
  }

  async sync(manual) {
    if (IS_MOBILE) return;
    if (!this.isSyncDevice()) {
      if (manual) new Notice('Taskline: another device syncs this vault. To sync from here, use Settings → Taskline → "Sync from this device".');
      return;
    }
    if (!manual && !this.settings.autoSync) return;
    if (!this.googleReady() && !this.msReady()) {
      if (manual) new Notice('Taskline: connect Google Calendar or Microsoft To Do in the plugin settings first.');
      return;
    }
    if (!this.settings.syncDevice) this.settings.syncDevice = deviceId();
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    this.updateStatus('⟳ Syncing tasks…');
    const errors = [];
    try {
      const tasks = this.getTasks();
      const ctx = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, today: todayYmd(), vault: this.app.vault.getName() };
      if (this.googleReady()) await this.syncGoogle(tasks, ctx, errors).catch((e) => errors.push(`Google: ${e.message}`));
      if (this.msReady()) await this.syncTodo(tasks, ctx, errors).catch((e) => errors.push(`To Do: ${e.message}`));
      // drop mappings for deleted tasks once nothing remains on either side
      const live = new Set(tasks.map((t) => t.path));
      for (const [p, m] of Object.entries(this.data.state.map)) {
        if (!live.has(p) && !m.g && !m.t && !(m.gm && Object.keys(m.gm).length)) delete this.data.state.map[p];
      }
      this.lastSync = new Date();
    } catch (e) {
      errors.push(e.message);
    } finally {
      this.lastErrors = errors;
      await this.save();
      this.syncing = false;
      this.updateStatus();
      if (manual) new Notice(errors.length ? `Task sync finished with ${errors.length} error(s):\n${errors.slice(0, 5).join('\n')}` : 'Tasks synced ✓');
      if (errors.length) console.warn('[taskline] sync errors', errors);
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); }
    }
  }

  async accessToken(svc) {
    const t = this.data.tokens[svc];
    if (!t || !t.refresh) throw new Error('not connected');
    if (t.access && t.expiry > Date.now() + 60000) return t.access;
    const s = this.settings;
    const json = await (svc === 'google'
      ? postForm('https://oauth2.googleapis.com/token', {
        client_id: s.googleClientId, client_secret: s.googleClientSecret, refresh_token: t.refresh, grant_type: 'refresh_token',
      })
      : postForm(`https://login.microsoftonline.com/${s.msTenant || 'common'}/oauth2/v2.0/token`, {
        client_id: s.msClientId, refresh_token: t.refresh, grant_type: 'refresh_token', scope: MS_SCOPE,
      })).catch((e) => {
      const name = svc === 'google' ? 'Google Calendar' : 'Microsoft To Do';
      if (/invalid_grant|expired|revoked/i.test(e.message)) {
        if (!this.reconnectNoticeShown) new Notice(`${name} sign-in expired. Open Settings → Taskline and click Reconnect.`, 15000);
        this.reconnectNoticeShown = true;
        throw new Error('sign-in expired — reconnect in settings');
      }
      throw e;
    });
    this.reconnectNoticeShown = false;
    t.access = json.access_token;
    t.expiry = Date.now() + (json.expires_in || 3600) * 1000;
    if (json.refresh_token) t.refresh = json.refresh_token;
    await this.save();
    return t.access;
  }

  /** JSON API call with token refresh + one retry on 401/429/5xx. Returns {status, json}. */
  async api(svc, method, url, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(svc);
      const res = await requestUrl({
        url, method, throw: false,
        headers: { Authorization: `Bearer ${token}` },
        contentType: 'application/json',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { /* ignore */ }
      if (attempt === 0 && res.status === 401) { this.data.tokens[svc].access = null; continue; }
      if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      return { status: res.status, json };
    }
  }

  async apiOk(svc, method, url, body) {
    const r = await this.api(svc, method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url.replace(/^https:\/\/[^/]+/, '')} → ${r.status} ${(r.json && r.json.error && (r.json.error.message || r.json.error)) || ''}`);
    return r.json;
  }

  /** create/update/delete one remote object so it matches `body`. slotHolder[key] = {id, h} */
  async reconcile(holder, key, body, ops) {
    const cur = holder[key];
    if (!body) {
      if (cur) { await ops.remove(cur.id); delete holder[key]; }
      return;
    }
    const h = hashOf(body);
    if (cur && cur.h === h) return;
    if (cur) {
      const ok = await ops.update(cur.id, body);
      if (ok) { cur.h = h; return; }
    }
    const id = await ops.create(body);
    holder[key] = { id, h };
  }

  async syncGoogle(tasks, ctx, errors) {
    const st = this.data.state;
    const map = st.map;
    // ensure the dedicated calendar exists
    if (st.gCalId && !this.gCalChecked) {
      const r = await this.api('google', 'GET', `${GCAL}/calendars/${encodeURIComponent(st.gCalId)}`);
      if (r.status === 404 || r.status === 403) {
        st.gCalId = null;
        for (const m of Object.values(map)) { delete m.g; delete m.gm; }
      } else if (r.status >= 400) throw new Error(`calendar check failed (${r.status})`);
    }
    if (!st.gCalId) {
      const cal = await this.apiOk('google', 'POST', `${GCAL}/calendars`, { summary: this.settings.googleCalendarName || 'Obsidian Tasks', timeZone: ctx.tz });
      st.gCalId = cal.id;
      await this.save();
    }
    this.gCalChecked = true;
    const base = `${GCAL}/calendars/${encodeURIComponent(st.gCalId)}/events`;
    const ops = {
      create: async (b) => (await this.apiOk('google', 'POST', base, b)).id,
      update: async (id, b) => {
        const r = await this.api('google', 'PUT', `${base}/${encodeURIComponent(id)}`, b);
        if (r.status === 404 || r.status === 410) return false;
        if (r.status >= 400) throw new Error(`update event → ${r.status} ${(r.json && r.json.error && r.json.error.message) || ''}`);
        return true;
      },
      remove: async (id) => {
        const r = await this.api('google', 'DELETE', `${base}/${encodeURIComponent(id)}`);
        if (r.status >= 400 && r.status !== 404 && r.status !== 410) throw new Error(`delete event → ${r.status}`);
      },
    };
    const live = new Set();
    for (const t of tasks) {
      live.add(t.path);
      if (t.ruleError) { errors.push(`${t.name}: ${t.ruleError}`); continue; }
      const m = map[t.path] || (map[t.path] = {});
      try {
        await this.reconcile(m, 'g', gSeriesBody(t, ctx), ops);
        m.gm = m.gm || {};
        const want = gMovedBodies(t, ctx);
        for (const [o, b] of Object.entries(want)) await this.reconcile(m.gm, o, b, ops);
        for (const o of Object.keys(m.gm)) if (!want[o]) await this.reconcile(m.gm, o, null, ops);
      } catch (e) { errors.push(`Google · ${t.name}: ${e.message}`); }
    }
    for (const [p, m] of Object.entries(map)) {
      if (live.has(p)) continue;
      try {
        await this.reconcile(m, 'g', null, ops);
        for (const o of Object.keys(m.gm || {})) await this.reconcile(m.gm, o, null, ops);
      } catch (e) { errors.push(`Google · ${p}: ${e.message}`); }
    }
  }

  async syncTodo(tasks, ctx, errors) {
    const st = this.data.state;
    const map = st.map;
    if (st.tListId && !this.tListChecked) {
      const r = await this.api('ms', 'GET', `${GRAPH}/me/todo/lists/${encodeURIComponent(st.tListId)}`);
      if (r.status === 404) { st.tListId = null; for (const m of Object.values(map)) delete m.t; } else if (r.status >= 400) throw new Error(`list check failed (${r.status})`);
    }
    if (!st.tListId) {
      const list = await this.apiOk('ms', 'POST', `${GRAPH}/me/todo/lists`, { displayName: this.settings.msListName || 'Obsidian' });
      st.tListId = list.id;
      await this.save();
    }
    this.tListChecked = true;
    const base = `${GRAPH}/me/todo/lists/${encodeURIComponent(st.tListId)}/tasks`;
    const ops = {
      create: async (b) => (await this.apiOk('ms', 'POST', base, stripNulls(b))).id,
      update: async (id, b) => {
        const r = await this.api('ms', 'PATCH', `${base}/${encodeURIComponent(id)}`, b);
        if (r.status === 404) return false;
        if (r.status >= 400) throw new Error(`update task → ${r.status} ${(r.json && r.json.error && r.json.error.message) || ''}`);
        return true;
      },
      remove: async (id) => {
        const r = await this.api('ms', 'DELETE', `${base}/${encodeURIComponent(id)}`);
        if (r.status >= 400 && r.status !== 404) throw new Error(`delete task → ${r.status}`);
      },
    };
    const live = new Set();
    for (const t of tasks) {
      live.add(t.path);
      if (t.ruleError) continue; // reported by Google pass or views
      const m = map[t.path] || (map[t.path] = {});
      try { await this.reconcile(m, 't', todoBody(t, ctx), ops); } catch (e) { errors.push(`To Do · ${t.name}: ${e.message}`); }
    }
    for (const [p, m] of Object.entries(map)) {
      if (live.has(p)) continue;
      try { await this.reconcile(m, 't', null, ops); } catch (e) { errors.push(`To Do · ${p}: ${e.message}`); }
    }
  }

  async connectGoogle() {
    await this.takeOverSync();
    const s = this.settings;
    if (!s.googleClientId || !s.googleClientSecret) throw new Error('Enter the Google client ID and secret first.');
    const { code, verifier, redirectUri } = await loopbackAuthorize(({ redirectUri, challenge, state }) =>
      'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: s.googleClientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPE,
        access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
      }).toString(), '127.0.0.1');
    const json = await postForm('https://oauth2.googleapis.com/token', {
      client_id: s.googleClientId, client_secret: s.googleClientSecret, code, code_verifier: verifier,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    });
    if (!json.refresh_token) throw new Error('Google did not return a refresh token — remove the app at myaccount.google.com/permissions and try again.');
    this.data.tokens.google = { access: json.access_token, refresh: json.refresh_token, expiry: Date.now() + (json.expires_in || 3600) * 1000 };
    this.gCalChecked = false;
    await this.save();
  }

  async connectMicrosoft() {
    await this.takeOverSync();
    const s = this.settings;
    if (!s.msClientId) throw new Error('Enter the Microsoft application (client) ID first.');
    const tenant = s.msTenant || 'common';
    const { code, verifier, redirectUri } = await loopbackAuthorize(({ redirectUri, challenge, state }) =>
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
        client_id: s.msClientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
        scope: MS_SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
      }).toString(), 'localhost');
    const json = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      client_id: s.msClientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      code_verifier: verifier, scope: MS_SCOPE,
    });
    if (!json.refresh_token) throw new Error('Microsoft did not return a refresh token (is offline_access allowed?).');
    this.data.tokens.ms = { access: json.access_token, refresh: json.refresh_token, expiry: Date.now() + (json.expires_in || 3600) * 1000 };
    this.tListChecked = false;
    await this.save();
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

class TMView extends MarkdownRenderChild {
  constructor(el, plugin, renderFn) {
    super(el);
    this.plugin = plugin;
    this.renderFn = renderFn;
    this.state = { offset: 0 };
  }
  onload() {
    // keep clicks inside the view from putting Live Preview into edit mode
    ['mousedown', 'click'].forEach((ev) => this.containerEl.addEventListener(ev, (e) => {
      if (e.target.closest('a, button, input, .tm-clickable')) e.stopPropagation();
    }));
    this.render();
    const p = this.plugin;
    p.views.add(this);
    const relevant = (path) => p.isTaskPath(path) || p.isGoalPath(path);
    this.registerEvent(p.app.metadataCache.on('changed', (f) => { if (relevant(f.path)) this.queue(); }));
    this.registerEvent(p.app.vault.on('delete', (f) => { if (relevant(f.path)) this.queue(); }));
    this.registerEvent(p.app.vault.on('rename', (f, old) => { if (relevant(f.path) || relevant(old)) this.queue(); }));
    let day = todayYmd();
    this.registerInterval(window.setInterval(() => { if (todayYmd() !== day) { day = todayYmd(); this.render(); } }, 60000));
  }
  queue() { clearTimeout(this.t); this.t = setTimeout(() => this.render(), 250); }
  onunload() { clearTimeout(this.t); this.plugin.views.delete(this); }
  render() {
    this.containerEl.empty();
    try { this.renderFn(this.containerEl, this.plugin, this.state, () => this.render()); } catch (e) {
      this.containerEl.createDiv({ cls: 'tm-warn', text: `Taskline view error: ${e.message}` });
      console.error(e);
    }
  }
}

function fmtDay(dStr, opts) {
  return parseYmd(dStr).toLocaleDateString(undefined, opts || { weekday: 'long', month: 'short', day: 'numeric' });
}

function header(root, title, { onPrev, onToday, onNext, plugin, todayLabel }) {
  const h = root.createDiv({ cls: 'tm-header' });
  h.createDiv({ cls: 'tm-title', text: title });
  if (onPrev) {
    const nav = h.createDiv({ cls: 'tm-nav' });
    nav.createEl('button', { cls: 'tm-btn', text: '‹', attr: { 'aria-label': 'Previous' } }).onclick = onPrev;
    nav.createEl('button', { cls: 'tm-btn', text: todayLabel || 'Today' }).onclick = onToday;
    nav.createEl('button', { cls: 'tm-btn', text: '›', attr: { 'aria-label': 'Next' } }).onclick = onNext;
  }
  if (plugin) h.createEl('button', { cls: 'tm-btn mod-cta', text: '+ New task' }).onclick = () => new NewTaskModal(plugin).open();
  return h;
}

function warnings(root, tasks, plugin) {
  for (const t of tasks.filter((x) => x.ruleError || x.reminderError)) {
    const w = root.createDiv({ cls: 'tm-warn tm-clickable', text: `⚠ ${t.name}: ${t.ruleError || t.reminderError}` });
    w.onclick = () => plugin.openNote(t.path);
  }
}

function renderRow(container, o, plugin, opts) {
  opts = opts || {};
  const t = o.task;
  const row = container.createDiv({ cls: 'tm-row' + (o.status === 'Done' ? ' is-done' : '') + (o.skipped ? ' is-skipped' : '') + (opts.overdue ? ' is-overdue' : '') });
  const cb = row.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox tm-check' });
  cb.checked = o.status === 'Done';
  cb.disabled = !!o.skipped;
  cb.onclick = (e) => { e.preventDefault(); plugin.toggleDone(o); };
  if (!opts.compact || o.time) {
    let label = o.time || (opts.compact ? '' : 'All day');
    if (opts.showDate) label = `${fmtDay(o.date, { weekday: 'short', month: 'short', day: 'numeric' })}${o.time ? ' · ' + o.time : ''}`;
    if (label) row.createSpan({ cls: 'tm-time', text: label });
  }
  const main = row.createDiv({ cls: 'tm-main' });
  const name = main.createEl('a', { cls: 'tm-name', text: t.name, href: '#' });
  name.onclick = (e) => { e.preventDefault(); plugin.openNote(t.path, e.metaKey || e.ctrlKey); };
  if (!opts.compact) {
    if (t.goal) main.createSpan({ cls: 'tm-goal', text: t.goal });
    if (o.status === 'In progress') main.createSpan({ cls: 'tm-pill tm-inprogress', text: statusLabel('In progress', plugin.settings) });
  }
  if (o.recurring) main.createSpan({ cls: 'tm-icon', text: '🔁', attr: { title: describeRule(t.rule) + (t.until ? ` until ${t.until}` : '') } });
  if (o.moved) main.createSpan({ cls: 'tm-icon', text: '↪', attr: { title: `Moved from ${o.original}` } });

  const actions = row.createDiv({ cls: 'tm-actions' });
  const btn = (text, title, fn) => { const b = actions.createEl('button', { cls: 'tm-btn tm-small', text, attr: { title } }); b.onclick = fn; };
  if (!o.recurring && o.status === 'Not started') btn('▶', `Start (${statusLabel('In progress', plugin.settings)})`, () => plugin.setStatus(t, 'In progress'));
  if (o.recurring) btn(o.skipped ? '↺' : '⤼', o.skipped ? 'Un-skip this day' : 'Skip this day', () => plugin.toggleSkip(o));
  if (!o.skipped) btn('🕑', o.recurring ? 'Move this occurrence' : 'Reschedule', () => new MoveModal(plugin, o).open());
  return row;
}

function renderToday(el, plugin, state, rerender) {
  const today = todayYmd();
  const day = ymd(addDays(parseYmd(today), state.offset));
  const root = el.createDiv({ cls: 'tm tm-today' });
  const rel = state.offset === 0 ? 'Today' : state.offset === 1 ? 'Tomorrow' : state.offset === -1 ? 'Yesterday' : '';
  header(root, `${rel ? rel + ' · ' : ''}${fmtDay(day)}`, {
    plugin,
    onPrev: () => { state.offset--; rerender(); },
    onToday: () => { state.offset = 0; rerender(); },
    onNext: () => { state.offset++; rerender(); },
  });
  const tasks = plugin.getTasks();
  warnings(root, tasks, plugin);
  const occs = tasks.flatMap((t) => occurrencesBetween(t, day, day)).sort(sortOccs);
  const overdue = day === today
    ? tasks.filter((t) => !t.recurring && t.when && t.when.date < today && t.status !== 'Done')
      .map((t) => makeOcc(t, t.when.date, t.when.date, t.when.time)).sort(sortOccs)
    : [];
  const groups = [
    ['Overdue', overdue, { overdue: true, showDate: true }],
    ['To do', occs.filter((o) => !o.skipped && o.status === 'Not started')],
    ['In progress', occs.filter((o) => !o.skipped && o.status === 'In progress')],
    ['Done', occs.filter((o) => !o.skipped && o.status === 'Done')],
    ['Skipped', occs.filter((o) => o.skipped)],
  ];
  let any = false;
  for (const [title, list, opts] of groups) {
    if (!list.length) continue;
    any = true;
    const g = root.createDiv({ cls: 'tm-group' });
    const gt = g.createDiv({ cls: 'tm-group-title' });
    gt.createSpan({ text: title });
    gt.createSpan({ cls: 'tm-count', text: String(list.length) });
    list.forEach((o) => renderRow(g, o, plugin, opts));
  }
  if (!any) root.createDiv({ cls: 'tm-empty', text: 'Nothing scheduled for this day.' });
  const total = occs.filter((o) => !o.skipped).length;
  if (total) {
    const done = occs.filter((o) => !o.skipped && o.status === 'Done').length;
    const bar = root.createDiv({ cls: 'tm-progress', attr: { title: `${done}/${total} done` } });
    bar.createDiv({ cls: 'tm-progress-fill', attr: { style: `width:${Math.round((done / total) * 100)}%` } });
  }
}

function renderWeek(el, plugin, state, rerender) {
  const today = todayYmd();
  const mon = addDays(mondayOf(parseYmd(today)), state.offset * 7);
  const sun = addDays(mon, 6);
  const root = el.createDiv({ cls: 'tm tm-weekview' });
  header(root, `${mon.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${sun.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`, {
    plugin, todayLabel: 'This week',
    onPrev: () => { state.offset--; rerender(); },
    onToday: () => { state.offset = 0; rerender(); },
    onNext: () => { state.offset++; rerender(); },
  });
  const tasks = plugin.getTasks();
  warnings(root, tasks, plugin);
  const occs = tasks.flatMap((t) => occurrencesBetween(t, ymd(mon), ymd(sun))).filter((o) => !o.skipped);
  const grid = root.createDiv({ cls: 'tm-week-grid' });
  for (let i = 0; i < 7; i++) {
    const d = ymd(addDays(mon, i));
    const col = grid.createDiv({ cls: 'tm-day' + (d === today ? ' is-today' : '') + (d < today ? ' is-past' : '') });
    col.createDiv({ cls: 'tm-day-head', text: fmtDay(d, { weekday: 'short', day: 'numeric' }) });
    const list = occs.filter((o) => o.date === d).sort(sortOccs);
    if (!list.length) col.createDiv({ cls: 'tm-empty', text: '—' });
    list.forEach((o) => renderRow(col, o, plugin, { compact: true }));
  }
}

function renderUpcoming(el, plugin) {
  const today = todayYmd();
  const tdy = parseYmd(today);
  const tomorrow = ymd(addDays(tdy, 1));
  const endWeek = ymd(addDays(mondayOf(tdy), 6));
  const endNext = ymd(addDays(mondayOf(tdy), 13));
  const root = el.createDiv({ cls: 'tm tm-upcoming' });
  header(root, 'Upcoming', { plugin });
  const tasks = plugin.getTasks();
  const items = [];
  const undated = [];
  for (const t of tasks) {
    if (t.recurring) {
      const n = nextPending(t, today);
      if (n) items.push(makeOcc(t, n.original, n.date, n.time, { moved: !!t.moved[n.original] }));
    } else if (t.status !== 'Done') {
      if (t.when) items.push(makeOcc(t, t.when.date, t.when.date, t.when.time));
      else undated.push(makeOcc(t, null, null, null));
    }
  }
  items.sort(sortOccs);
  const groups = [
    ['Overdue', (o) => o.date < today, { overdue: true }],
    ['Today', (o) => o.date === today],
    ['Tomorrow', (o) => o.date === tomorrow],
    ['Later this week', (o) => o.date > tomorrow && o.date <= endWeek],
    ['Next week', (o) => o.date > endWeek && o.date <= endNext],
    ['Later', (o) => o.date > endNext],
  ];
  for (const [title, pred, opts] of groups) {
    const list = items.filter(pred);
    if (!list.length) continue;
    const g = root.createDiv({ cls: 'tm-group' });
    const gt = g.createDiv({ cls: 'tm-group-title' });
    gt.createSpan({ text: title });
    gt.createSpan({ cls: 'tm-count', text: String(list.length) });
    list.forEach((o) => renderRow(g, o, plugin, Object.assign({ showDate: true }, opts || {})));
  }
  if (undated.length) {
    const g = root.createDiv({ cls: 'tm-group' });
    g.createDiv({ cls: 'tm-group-title', text: 'No date' });
    undated.forEach((o) => renderRow(g, o, plugin, { compact: false }));
  }
  if (!items.length && !undated.length) root.createDiv({ cls: 'tm-empty', text: 'All clear.' });
}

function renderTimeline(el, plugin) {
  const root = el.createDiv({ cls: 'tm tm-timeline' });
  header(root, 'Goals timeline', {});
  const st = plugin.settings;
  const goals = plugin.getGoals().map(({ file, fm }) => {
    let s = normDate(fm[st.goalStartProp]);
    let e = normDate(fm[st.goalEndProp]);
    let warn = '';
    if (!s && e) s = e;
    if (s && !e) e = s;
    if (s && e && e < s) { warn = `${st.goalEndProp} is before ${st.goalStartProp}`; [s, e] = [e, s]; }
    const parentName = linkText(fm[st.goalParentProp]);
    let parent = null;
    if (parentName) {
      const pf = plugin.app.metadataCache.getFirstLinkpathDest(parentName, file.path);
      parent = pf ? pf.path : null;
    }
    return { file, path: file.path, name: file.basename, start: s, end: e, desc: toStr(fm.description), parent, warn };
  });
  if (!goals.length) { root.createDiv({ cls: 'tm-empty', text: `No goals in ${plugin.settings.goalsFolder}.` }); return; }

  // order: roots by start date, each followed by its children (any depth)
  const byStart = (a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.name.localeCompare(b.name);
  const paths = new Set(goals.map((g) => g.path));
  const roots = goals.filter((g) => !g.parent || !paths.has(g.parent)).sort(byStart);
  const ordered = [];
  const visit = (g, depth, hue) => {
    ordered.push(Object.assign(g, { depth, hue }));
    goals.filter((c) => c.parent === g.path && c !== g).sort(byStart).forEach((c) => visit(c, depth + 1, hue));
  };
  roots.forEach((g, i) => visit(g, 0, Math.round((i * 137.508 + 210) % 360)));

  const dated = ordered.filter((g) => g.start);
  const today = todayYmd();
  let min = dated.length ? dated.map((g) => g.start).sort()[0] : today;
  let max = dated.length ? dated.map((g) => g.end).sort().slice(-1)[0] : today;
  if (today < min && daysBetween(parseYmd(today), parseYmd(min)) < 60) min = today;
  if (today > max && daysBetween(parseYmd(max), parseYmd(today)) < 60) max = today;
  const rs = parseYmd(min); const re = parseYmd(max);
  const rangeStart = new Date(rs.getFullYear(), rs.getMonth(), 1);
  const rangeEnd = new Date(re.getFullYear(), re.getMonth() + 1, 1); // exclusive
  const total = daysBetween(rangeStart, rangeEnd);
  const pct = (d) => (daysBetween(rangeStart, typeof d === 'string' ? parseYmd(d) : d) / total) * 100;

  const months = [];
  for (let d = new Date(rangeStart); d < rangeEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(new Date(d));
  const showYear = rangeStart.getFullYear() !== addDays(rangeEnd, -1).getFullYear();

  const grid = root.createDiv({ cls: 'tm-tl' });
  const headRow = grid.createDiv({ cls: 'tm-tl-row tm-tl-head' });
  headRow.createDiv({ cls: 'tm-tl-label', text: 'Goal' });
  const headTrack = headRow.createDiv({ cls: 'tm-tl-track' });
  for (const m of months) {
    const left = pct(m);
    const right = pct(new Date(m.getFullYear(), m.getMonth() + 1, 1));
    headTrack.createDiv({
      cls: 'tm-tl-month',
      text: m.toLocaleDateString(undefined, showYear || months.length < 8 ? { month: 'short', year: '2-digit' } : { month: 'short' }),
      attr: { style: `left:${left}%;width:${right - left}%` },
    });
  }
  const todayPct = today >= ymd(rangeStart) && today < ymd(rangeEnd) ? pct(today) : null;

  for (const g of ordered) {
    const row = grid.createDiv({ cls: 'tm-tl-row' });
    const label = row.createDiv({ cls: 'tm-tl-label tm-clickable' + (g.depth ? ' is-child' : ''), attr: { style: `padding-left:${8 + g.depth * 16}px`, title: g.desc || g.name } });
    label.setText((g.depth ? '↳ ' : '') + g.name + (g.warn ? ' ⚠' : ''));
    label.onclick = (e) => plugin.openNote(g.path, e.metaKey || e.ctrlKey);
    const track = row.createDiv({ cls: 'tm-tl-track' });
    for (const m of months) track.createDiv({ cls: 'tm-tl-gridline', attr: { style: `left:${pct(m)}%` } });
    if (todayPct != null) track.createDiv({ cls: 'tm-tl-today', attr: { style: `left:${todayPct}%`, title: `Today ${today}` } });
    if (!g.start) { track.createDiv({ cls: 'tm-tl-nodate', text: 'no dates set' }); continue; }
    const left = pct(g.start);
    const width = Math.max(pct(ymd(addDays(parseYmd(g.end), 1))) - left, 0.8);
    const light = g.depth ? 62 : 48;
    const bar = track.createDiv({
      cls: 'tm-tl-bar tm-clickable' + (g.end < today ? ' is-past' : ''),
      attr: {
        style: `left:${left}%;width:${width}%;background:hsl(${g.hue} 60% ${light}%)`,
        title: `${g.name}\n${g.start} → ${g.end}${g.desc ? '\n' + g.desc : ''}${g.warn ? '\n⚠ ' + g.warn : ''}`,
      },
    });
    bar.createSpan({ text: g.name });
    bar.onclick = (e) => plugin.openNote(g.path, e.metaKey || e.ctrlKey);
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function nextHalfHour() {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return { date: ymd(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

class NewTaskModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tm-modal');
    contentEl.createEl('h3', { text: 'New task' });
    const nh = nextHalfHour();
    const v = { name: '', goal: '', date: nh.date, time: nh.time, allDay: false, duration: String(this.plugin.settings.defaultDuration), recurring: '', until: '', reminder: '' };
    this.v = v;
    new Setting(contentEl).setName('Name').addText((t) => { t.onChange((x) => { v.name = x; }); setTimeout(() => t.inputEl.focus(), 0); });
    new Setting(contentEl).setName('Goal').addDropdown((d) => {
      d.addOption('', '—');
      this.plugin.getGoals().map((g) => g.file.basename).sort().forEach((n) => d.addOption(n, n));
      d.onChange((x) => { v.goal = x; });
    });
    new Setting(contentEl).setName('Date').addText((t) => { t.inputEl.type = 'date'; t.setValue(v.date); t.onChange((x) => { v.date = x; }); });
    const timeSetting = new Setting(contentEl).setName('Time').addText((t) => { t.inputEl.type = 'time'; t.setValue(v.time); t.onChange((x) => { v.time = x; }); });
    new Setting(contentEl).setName('All day').addToggle((t) => t.onChange((x) => { v.allDay = x; timeSetting.settingEl.toggle(!x); }));
    new Setting(contentEl).setName('Duration (minutes)').addText((t) => { t.inputEl.type = 'number'; t.setValue(v.duration); t.onChange((x) => { v.duration = x; }); });
    const rep = new Setting(contentEl).setName('Repeat')
      .setDesc('every day · every weekday · every 2 days · every week on Mon, Thu · every 2 weeks · every month on the 15th · every month on the last Fri · every year');
    const preview = contentEl.createDiv({ cls: 'tm-rule-preview' });
    rep.addText((t) => {
      t.setPlaceholder('does not repeat');
      t.onChange((x) => {
        v.recurring = x.trim();
        if (!v.recurring) { preview.setText(''); preview.removeClass('tm-warn'); return; }
        try { preview.setText('→ ' + describeRule(parseRule(v.recurring))); preview.removeClass('tm-warn'); } catch (e) { preview.setText('⚠ ' + e.message); preview.addClass('tm-warn'); }
      });
    });
    new Setting(contentEl).setName('Repeat until (optional)').addText((t) => { t.inputEl.type = 'date'; t.onChange((x) => { v.until = x; }); });
    const remSetting = new Setting(contentEl).setName('Reminder')
      .setDesc(`Before start, comma-separated: 10m, 1h, 1d, at start, none. Empty = default (${this.plugin.settings.defaultReminder || 'none'}; all-day tasks: none).`);
    const remPreview = contentEl.createDiv({ cls: 'tm-rule-preview' });
    remSetting.addText((t) => {
      t.setPlaceholder('default');
      t.onChange((x) => {
        v.reminder = x.trim();
        if (!v.reminder) { remPreview.setText(''); remPreview.removeClass('tm-warn'); return; }
        const r = parseReminder(v.reminder);
        if (r.error) { remPreview.setText('⚠ ' + r.error); remPreview.addClass('tm-warn'); } else { remPreview.setText('→ ' + describeReminder(r.mins)); remPreview.removeClass('tm-warn'); }
      });
    });
    new Setting(contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(() => this.submit()));
    contentEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT') { e.preventDefault(); this.submit(); } });
  }
  async submit() {
    const v = this.v;
    const name = v.name.trim().replace(/[\\/:*?"<>|#^[\]]/g, '-');
    if (!name) { new Notice('Give the task a name.'); return; }
    if (v.recurring) { try { parseRule(v.recurring); } catch (e) { new Notice(`Repeat: ${e.message}`); return; } }
    if (v.reminder && parseReminder(v.reminder).error) { new Notice(`Reminder: ${parseReminder(v.reminder).error}`); return; }
    const when = v.allDay || !v.time ? v.date : `${v.date}T${v.time}`;
    const lines = ['---', 'type: task', `goal: ${v.goal ? JSON.stringify(`[[${v.goal}]]`) : ''}`, `time: ${when || ''}`, `duration: ${parseDuration(v.duration, this.plugin.settings.defaultDuration)}`];
    if (v.recurring) {
      lines.push(`recurring: ${JSON.stringify(v.recurring)}`);
      if (v.until) lines.push(`until: ${v.until}`);
      lines.push('done_dates: []', 'skipped_dates: []', 'moved: []');
    } else {
      lines.push(`status: ${JSON.stringify(statusLabel('Not started', this.plugin.settings))}`);
    }
    const rem = v.reminder ? v.reminder.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
    lines.push(`reminder: ${rem.length > 1 ? `[${rem.join(', ')}]` : (rem[0] || '')}`);
    lines.push('---', '', '');
    const folder = this.plugin.settings.tasksFolder.replace(/\/$/, '');
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    let path = `${folder}/${name}.md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${folder}/${name} ${i}.md`;
    const file = await this.app.vault.create(path, lines.join('\n'));
    this.close();
    await this.app.workspace.getLeaf(false).openFile(file);
  }
  onClose() { this.contentEl.empty(); }
}

class MoveModal extends Modal {
  constructor(plugin, occ) { super(plugin.app); this.plugin = plugin; this.o = occ; }
  onOpen() {
    const { contentEl } = this;
    const o = this.o;
    contentEl.addClass('tm-modal');
    contentEl.createEl('h3', { text: o.recurring ? `Move “${o.task.name}” on ${fmtDay(o.original)}` : `Reschedule “${o.task.name}”` });
    if (o.recurring) contentEl.createEl('p', { cls: 'tm-muted', text: 'Only this occurrence moves. To change every occurrence, edit "time" or "recurring" in the note.' });
    const v = { date: o.date || todayYmd(), time: o.time || '' };
    new Setting(contentEl).setName('Date').addText((t) => { t.inputEl.type = 'date'; t.setValue(v.date); t.onChange((x) => { v.date = x; }); });
    new Setting(contentEl).setName('Time').setDesc('Leave empty for all day').addText((t) => { t.inputEl.type = 'time'; t.setValue(v.time); t.onChange((x) => { v.time = x; }); });
    const s = new Setting(contentEl);
    if (o.recurring && o.moved) s.addButton((b) => b.setButtonText('Back to original time').onClick(async () => { await this.plugin.moveOccurrence(o, null); this.close(); }));
    s.addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) { new Notice('Pick a date.'); return; }
      await this.plugin.moveOccurrence(o, { date: v.date, time: v.time || null });
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class TMSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    const save = async () => { await p.save(); };
    containerEl.empty();
    const intro = containerEl.createEl('p', { cls: 'setting-item-description' });
    intro.appendText('Setup guide for Google Calendar and Microsoft To Do: ');
    intro.createEl('a', { text: 'README', href: 'https://github.com/amin-tehrani/obsidian-taskline#setting-up-sync' });

    new Setting(containerEl).setName('Tasks folder').addText((t) => t.setValue(s.tasksFolder).onChange(async (x) => { s.tasksFolder = x.trim(); await save(); }));
    new Setting(containerEl).setName('Goals folder').addText((t) => t.setValue(s.goalsFolder).onChange(async (x) => { s.goalsFolder = x.trim(); await save(); }));
    new Setting(containerEl).setName('Default duration (minutes)').addText((t) => t.setValue(String(s.defaultDuration)).onChange(async (x) => { s.defaultDuration = parseInt(x, 10) || 30; await save(); }));
    new Setting(containerEl).setName('Default reminder').setDesc('Used when a timed task has an empty "reminder" field. E.g. "at start", "10m", "1h, 10m", or "none".').addText((t) => t.setValue(s.defaultReminder).onChange(async (x) => { s.defaultReminder = x.trim(); await save(); }));

    new Setting(containerEl).setName('Status values').setHeading()
      .setDesc('What one-off tasks write to their "status" property. Common words (todo, doing, done, completed…) are always understood when reading.');
    const text = (name, key, dflt) => new Setting(containerEl).setName(name).addText((t) => t.setPlaceholder(dflt).setValue(s[key]).onChange(async (x) => { s[key] = x.trim() || dflt; await save(); p.refreshViews(); }));
    text('Not started', 'statusTodo', 'Not started');
    text('In progress', 'statusDoing', 'In progress');
    text('Done', 'statusDone', 'Done');

    new Setting(containerEl).setName('Goal properties').setHeading().setDesc('Frontmatter properties the goal timeline reads from notes in the goals folder.');
    text('Start date', 'goalStartProp', 'target_start');
    text('End date', 'goalEndProp', 'target_end');
    text('Parent goal (link)', 'goalParentProp', 'parent_goal');

    new Setting(containerEl).setName('Sync').setHeading();
    if (IS_MOBILE) {
      containerEl.createEl('p', { cls: 'setting-item-description', text: 'Sync to Google Calendar / Microsoft To Do runs on a desktop. Tasks you add or change here are synced once your vault reaches that computer and Obsidian is open there.' });
      return;
    }
    if (!p.isSyncDevice()) {
      new Setting(containerEl).setName('Another device syncs this vault')
        .setDesc('Only one computer talks to Google/Microsoft, so events are never duplicated. Your edits here are synced by that device.')
        .addButton((b) => b.setButtonText('Sync from this device').onClick(async () => { await p.takeOverSync(); this.display(); p.updateStatus(); p.sync(true); }));
      return;
    }
    new Setting(containerEl).setName('Sync automatically').setDesc('After you edit a task (10 s delay) and every N minutes.').addToggle((t) => t.setValue(s.autoSync).onChange(async (x) => { s.autoSync = x; await save(); }));
    new Setting(containerEl).setName('Sync interval (minutes)').setDesc('Takes effect after reloading Obsidian.').addText((t) => t.setValue(String(s.syncIntervalMin)).onChange(async (x) => { s.syncIntervalMin = parseInt(x, 10) || 10; await save(); }));

    const connectRow = (name, connected, connectFn, disconnectFn) => new Setting(containerEl)
      .setName(connected ? `✅ ${name} connected` : `${name} not connected`)
      .addButton((b) => b.setButtonText(connected ? 'Reconnect' : 'Connect').setCta().onClick(async () => {
        new Notice(`Opening ${name} sign-in in your browser…`);
        try { await connectFn(); new Notice(`${name} connected ✓`); this.display(); p.updateStatus(); p.sync(true); } catch (e) { new Notice(`${name}: ${e.message}`, 10000); }
      }))
      .addButton((b) => b.setButtonText('Disconnect').setDisabled(!connected).onClick(async () => { await disconnectFn(); this.display(); p.updateStatus(); }));

    new Setting(containerEl).setName('Google Calendar').setHeading();
    new Setting(containerEl).setName('Enabled').addToggle((t) => t.setValue(s.googleEnabled).onChange(async (x) => { s.googleEnabled = x; await save(); p.updateStatus(); }));
    new Setting(containerEl).setName('OAuth client ID').addText((t) => t.setValue(s.googleClientId).onChange(async (x) => { s.googleClientId = x.trim(); await save(); }));
    new Setting(containerEl).setName('OAuth client secret').addText((t) => { t.inputEl.type = 'password'; t.setValue(s.googleClientSecret).onChange(async (x) => { s.googleClientSecret = x.trim(); await save(); }); });
    new Setting(containerEl).setName('Calendar name').setDesc('A separate calendar is created for your tasks; your other calendars are never touched.').addText((t) => t.setValue(s.googleCalendarName).onChange(async (x) => { s.googleCalendarName = x; await save(); }));
    connectRow('Google Calendar', !!(p.data.tokens.google && p.data.tokens.google.refresh), () => p.connectGoogle(), async () => { delete p.data.tokens.google; await save(); });

    new Setting(containerEl).setName('Microsoft To Do').setHeading();
    new Setting(containerEl).setName('Enabled').addToggle((t) => t.setValue(s.msEnabled).onChange(async (x) => { s.msEnabled = x; await save(); p.updateStatus(); }));
    new Setting(containerEl).setName('Application (client) ID').addText((t) => t.setValue(s.msClientId).onChange(async (x) => { s.msClientId = x.trim(); await save(); }));
    new Setting(containerEl).setName('Tenant').setDesc('"common" (default), or "consumers" if your app registration allows personal accounts only.').addText((t) => t.setValue(s.msTenant).onChange(async (x) => { s.msTenant = x.trim() || 'common'; await save(); }));
    new Setting(containerEl).setName('List name').addText((t) => t.setValue(s.msListName).onChange(async (x) => { s.msListName = x; await save(); }));
    connectRow('Microsoft To Do', !!(p.data.tokens.ms && p.data.tokens.ms.refresh), () => p.connectMicrosoft(), async () => { delete p.data.tokens.ms; await save(); });

    new Setting(containerEl).setName('Sync now').addButton((b) => b.setButtonText('Sync now').onClick(() => p.sync(true)));
  }
}

module.exports = TasklinePlugin;
module.exports.default = TasklinePlugin;
module.exports._lib = {
  parseRule, describeRule, matches, readTask, occurrencesBetween, nextPending, firstOccurrence,
  toRRule, toGraphPattern, gSeriesBody, gMovedBodies, todoBody, parseWhen, parseDuration, parseMoved, parseReminder, describeReminder, normStatus, statusLabel,
};
