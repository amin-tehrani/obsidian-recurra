const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlugin } = require('./helpers');

const L = loadPlugin()._lib;
const S = { defaultDuration: 30, defaultReminder: 'at start', statusTodo: 'Not started', statusDoing: 'In progress', statusDone: 'Done' };
const mk = (fm, settings) => L.readTask({ path: 'Tasks/T.md', basename: 'T' }, fm, settings || S);
const ctx = { tz: 'Europe/Rome', today: '2026-11-06', vault: 'Vault' };
const days = (t, a, b) => L.occurrencesBetween(t, a, b)
  .map((o) => o.date + (o.moved ? '*' : '') + (o.skipped ? 's' : '') + (o.status === 'Done' ? 'd' : '')).sort();

test('repeat rules parse and describe', () => {
  for (const r of ['every day', 'daily', 'every weekday', 'every 2 days', 'every week on Mon, Thu', 'every 2 weeks on tuesday and friday',
    'every month on the 15th', 'every month on the last Fri', 'monthly on the 2nd tue', 'every year', 'every other week', 'every weekend', 'weekly']) {
    assert.ok(L.describeRule(L.parseRule(r)), r);
  }
  for (const r of ['every blue moon', 'every month on xyz', 'every 0 days']) assert.throws(() => L.parseRule(r), r);
});

test('daily series with done / skipped / moved occurrences', () => {
  const t = mk({ time: '2026-11-06T12:00', recurring: 'every day', duration: '1h',
    done_dates: ['2026-11-06'], skipped_dates: ['2026-11-08'], moved: ['2026-11-09 -> 2026-11-10T20:00'] });
  assert.deepEqual(days(t, '2026-11-05', '2026-11-11'), ['2026-11-06d', '2026-11-07', '2026-11-08s', '2026-11-10', '2026-11-10*', '2026-11-11']);
  assert.equal(L.nextPending(t, '2026-11-08').date, '2026-11-10');

  const g = L.gSeriesBody(t, ctx);
  assert.deepEqual(g.recurrence, ['RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Rome:20261108T120000,20261109T120000']);
  assert.equal(g.start.dateTime, '2026-11-06T12:00:00');
  assert.equal(g.end.dateTime, '2026-11-06T13:00:00');
  const moved = L.gMovedBodies(t, ctx)['2026-11-09'];
  assert.equal(moved.start.dateTime, '2026-11-10T20:00:00');

  const td = L.todoBody(t, ctx);
  assert.equal(td.dueDateTime.dateTime, '2026-11-07T00:00:00');
  assert.deepEqual(td.recurrence.pattern, { type: 'daily', interval: 1 });
});

test('every 2 weeks on Mon, Thu matches Google expansion', () => {
  const t = mk({ time: '2026-11-04T09:00', recurring: 'every 2 weeks on Mon, Thu', until: '2026-12-31' });
  assert.deepEqual(days(t, '2026-11-01', '2026-12-01'), ['2026-11-05', '2026-11-16', '2026-11-19', '2026-11-30']);
  const g = L.gSeriesBody(t, ctx);
  assert.equal(g.start.dateTime, '2026-11-05T09:00:00'); // DTSTART = first real occurrence
  assert.deepEqual(g.recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=MO;UNTIL=20261231T225959Z']);
});

test('monthly on the last Friday (all-day)', () => {
  const t = mk({ time: '2026-11-01', recurring: 'every month on the last Fri' });
  assert.deepEqual(days(t, '2026-11-01', '2027-03-31'), ['2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26', '2027-03-26']);
  assert.deepEqual(L.gSeriesBody(t, ctx).recurrence, ['RRULE:FREQ=MONTHLY;BYDAY=-1FR']);
  assert.deepEqual(L.todoBody(t, ctx).recurrence.pattern, { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' });
});

test('monthly on the 31st skips short months (like Google)', () => {
  const t = mk({ time: '2026-01-31T08:00', recurring: 'monthly' });
  assert.deepEqual(days(t, '2026-01-01', '2026-06-30'), ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('one-off task marked done', () => {
  const t = mk({ time: '2026-11-07T18:30', status: 'Done', reminder: '10m' });
  assert.equal(L.gSeriesBody(t, ctx).summary, '✓ T');
  assert.deepEqual(L.gSeriesBody(t, ctx).reminders.overrides, []);
  const td = L.todoBody(t, ctx);
  assert.equal(td.status, 'completed');
  assert.equal(td.isReminderOn, false);
});

test('invalid rule is reported, not synced as recurring', () => {
  const t = mk({ time: '2026-11-07', recurring: 'every blah' });
  assert.ok(t.ruleError);
  assert.equal(t.recurring, false);
});

test('durations', () => {
  assert.equal(L.parseDuration('1h30m', 30), 90);
  assert.equal(L.parseDuration('45', 30), 45);
  assert.equal(L.parseDuration(90, 30), 90);
  assert.equal(L.parseDuration('2h', 30), 120);
  assert.equal(L.parseDuration('', 30), 30);
});

test('reminder parsing', () => {
  const P = (v) => L.parseReminder(v).mins;
  assert.deepEqual(P('10m'), [10]);
  assert.deepEqual(P('1h, 10m'), [60, 10]);
  assert.deepEqual(P(['1d', '1h 30m']), [1440, 90]);
  assert.deepEqual(P(0), [0]);
  assert.deepEqual(P('at start'), [0]);
  assert.deepEqual(P('2 hours before'), [120]);
  assert.deepEqual(P('none'), []);
  assert.ok(L.parseReminder('soonish').error);
  assert.ok(L.parseReminder('5w').error);
});

test('reminders sync to Google (all) and To Do (first)', () => {
  let t = mk({ time: '2026-11-07T18:30' }); // default: at start
  assert.deepEqual(L.gSeriesBody(t, ctx).reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] });
  assert.equal(L.todoBody(t, ctx).reminderDateTime.dateTime, '2026-11-07T18:30:00');

  t = mk({ time: '2026-11-07T18:30', reminder: ['1d', '10m'] });
  assert.deepEqual(L.gSeriesBody(t, ctx).reminders.overrides.map((o) => o.minutes), [1440, 10]);
  assert.equal(L.todoBody(t, ctx).reminderDateTime.dateTime, '2026-11-06T18:30:00');

  t = mk({ time: '2026-11-07' }); // all-day: no default reminder
  assert.equal(L.todoBody(t, ctx).isReminderOn, false);
  t = mk({ time: '2026-11-07', reminder: '3h' }); // all-day: counted from 00:00
  assert.equal(L.todoBody(t, ctx).reminderDateTime.dateTime, '2026-11-06T21:00:00');

  t = mk({ time: '2026-11-06T12:00', recurring: 'every day', done_dates: ['2026-11-06'], moved: ['2026-11-07 -> 2026-11-07T20:00'], reminder: '15m' });
  assert.deepEqual(L.gMovedBodies(t, ctx)['2026-11-07'].reminders.overrides, [{ method: 'popup', minutes: 15 }]);
  assert.equal(L.todoBody(t, ctx).reminderDateTime.dateTime, '2026-11-07T19:45:00');
});

test('custom status labels', () => {
  const custom = Object.assign({}, S, { statusTodo: 'todo', statusDoing: 'doing', statusDone: 'finito' });
  assert.equal(mk({ status: 'finito' }, custom).status, 'Done');
  assert.equal(mk({ status: 'Doing' }, custom).status, 'In progress');
  assert.equal(mk({ status: 'completed' }, custom).status, 'Done');
  assert.equal(mk({ status: true }, custom).status, 'Done');
  assert.equal(mk({}, custom).status, 'Not started');
  assert.equal(L.statusLabel('Done', custom), 'finito');
});
