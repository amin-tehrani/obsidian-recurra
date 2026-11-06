const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlugin } = require('./helpers');

const P = loadPlugin();
const L = P._lib;
const S = { defaultDuration: 30, defaultReminder: 'at start' };
const mk = (fm, path = 'Tasks/Morning run.md') => L.readTask({ path, basename: path.split('/').pop().replace('.md', '') }, fm, S);
const BASE = 'https://example.github.io/recurra/open/';
const ctx = { tz: 'Europe/Rome', today: '2026-11-06', vault: '', linkStyle: 'web', linkBase: BASE };

test('obsidian:// link: task path and optional date, vault only when asked', () => {
  assert.equal(L.obsidianUri(ctx, 'Tasks/Morning run.md', '2026-11-06'), 'obsidian://recurra?task=Tasks%2FMorning%20run.md&date=2026-11-06');
  assert.equal(L.obsidianUri({ vault: 'My Vault' }, 'T.md'), 'obsidian://recurra?vault=My%20Vault&task=T.md');
});

test('web link wraps the obsidian link after # (never sent to the server)', () => {
  const url = L.openLink(ctx, 'Tasks/Morning run.md', '2026-11-06');
  assert.ok(url.startsWith(BASE + '#'));
  assert.equal(decodeURIComponent(url.split('#')[1]), 'obsidian://recurra?task=Tasks%2FMorning%20run.md&date=2026-11-06');
  assert.equal(L.openLink({ ...ctx, linkStyle: 'obsidian' }, 'T.md'), 'obsidian://recurra?task=T.md');
  assert.equal(L.openLink({ ...ctx, linkStyle: 'none' }, 'T.md'), null);
});

test('descriptions: series links the note, moved/instance days link their page, HTML is escaped', () => {
  const t = mk({ time: '2026-11-02T07:00', recurring: 'every day', goal: '[[A <b> & C]]', moved: ['2026-11-09 -> 2026-11-10T20:00'] });
  const series = L.gSeriesBody(t, ctx).description;
  assert.match(series, /Goal: A &lt;b&gt; &amp; C/);
  assert.match(series, /<a href="https:\/\/example\.github\.io\/recurra\/open\/#obsidian%3A%2F%2Frecurra%3Ftask%3DTasks%252FMorning%2520run\.md">📝 Open in Obsidian<\/a>/);
  const moved = L.gMovedBodies(t, ctx)['2026-11-09'].description;
  assert.match(moved, /^Moved from Mon, Nov 9<br>/);
  assert.match(moved, /date%3D2026-11-09/);
  assert.match(L.gDescription(t, ctx, '2026-11-07'), /📝 Open Sat, Nov 7 in Obsidian/);
  // To Do: plain text, link to the next pending occurrence
  const td = L.todoBody(t, ctx).body.content;
  assert.match(td, /Open Fri, Nov 6 in Obsidian: https:\/\/example\.github\.io\/recurra\/open\/#obsidian%3A%2F%2Frecurra%3Ftask%3DTasks%252FMorning%2520run\.md%26date%3D2026-11-06$/);
});

function fakeGoogle() {
  const calls = [];
  let n = 0;
  const events = {}; // id -> body
  const p = Object.create(P.prototype);
  p.api = async (svc, method, url, body) => {
    calls.push(`${method} ${url.replace(/\?.*/, '')}`);
    const id = decodeURIComponent((url.split('/events/')[1] || '').split('/')[0].split('?')[0]);
    if (method === 'POST') { const nid = `ev${++n}`; events[nid] = body; return { status: 200, json: { id: nid } }; }
    if (method === 'GET' && url.includes('/instances')) {
      const series = events[id];
      const items = [];
      const start = series.start.dateTime.slice(0, 10);
      for (let i = 0; i < 40; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i);
        const ds = d.toISOString().slice(0, 10);
        items.push({ id: `${id}_${ds.replace(/-/g, '')}T060000Z`, originalStartTime: { dateTime: `${ds}T07:00:00+01:00` } });
      }
      return { status: 200, json: { items } };
    }
    if (method === 'GET') return { status: 200, json: { id } };
    if (method === 'DELETE') { delete events[id]; return { status: 204, json: null }; }
    return { status: 200, json: { id } };
  };
  p.apiOk = async (...a) => (await p.api(...a)).json;
  p.save = async () => {};
  p.settings = { googleCalendarName: 'Obsidian Tasks' };
  p.data = { state: { map: {}, gCalId: 'cal' } };
  p.gCalChecked = true;
  return { p, calls, events };
}

test('Google: each day around today gets its own link, only once', async () => {
  const { p, calls } = fakeGoogle();
  const t = mk({ time: '2026-11-02T07:00', recurring: 'every day', skipped_dates: ['2026-11-08'] });
  const errors = [];
  await p.syncGoogle([t], ctx, errors);
  assert.deepEqual(errors, []);
  const patches = calls.filter((c) => c.startsWith('PATCH'));
  // window: Nov 3 .. Nov 20 = 18 days, minus the skipped Nov 8
  assert.equal(patches.length, 17);
  assert.ok(patches[0].endsWith('ev1_20261103T060000Z'));
  const m = p.data.state.map[t.path];
  assert.equal(Object.keys(m.gi.d).length, 17);

  calls.length = 0;
  await p.syncGoogle([t], ctx, errors); // nothing changed → no requests besides none
  assert.deepEqual(calls, []);

  calls.length = 0;
  await p.syncGoogle([t], { ...ctx, today: '2026-11-07' }, errors); // a day later: one new day
  assert.deepEqual(calls.filter((c) => c.startsWith('PATCH')).length, 1);
});

test('Google: changing the series recreates it (no stale per-day copies) and relinks', async () => {
  const { p, calls, events } = fakeGoogle();
  let t = mk({ time: '2026-11-02T07:00', recurring: 'every day' });
  await p.syncGoogle([t], ctx, []);
  calls.length = 0;
  t = mk({ time: '2026-11-02T08:00', recurring: 'every day' }); // new time
  await p.syncGoogle([t], ctx, []);
  assert.equal(calls[0], 'DELETE https://www.googleapis.com/calendar/v3/calendars/cal/events/ev1');
  assert.equal(calls[1], 'POST https://www.googleapis.com/calendar/v3/calendars/cal/events');
  assert.equal(Object.keys(events).join(), 'ev2');
  assert.equal(p.data.state.map[t.path].gi.id, 'ev2');
  assert.equal(calls.filter((c) => c.startsWith('PATCH')).length, 18);
});

test('Google: "No links" setting leaves the days alone', async () => {
  const { p, calls } = fakeGoogle();
  await p.syncGoogle([mk({ time: '2026-11-02T07:00', recurring: 'every day' })], { ...ctx, linkStyle: 'none' }, []);
  assert.equal(calls.filter((c) => c.startsWith('PATCH') || c.includes('instances')).length, 0);
});

test('opening a link: task + date opens that day\'s page, missing task → notice', async () => {
  const opened = [];
  const p = Object.create(P.prototype);
  const t = mk({ time: '2026-11-02T07:00', recurring: 'every day' });
  p.app = { metadataCache: { resolved: true } };
  p.getTasks = () => [t];
  p.openOccurrencePage = async (task, date) => opened.push(`page ${task.name} ${date}`);
  p.openNote = (path) => opened.push(`note ${path}`);
  await p.openFromLink({ task: 'Tasks/Morning run.md', date: '2026-11-06' });
  await p.openFromLink({ task: 'Tasks/Morning run.md' });
  await p.openFromLink({ task: 'Somewhere/else/Morning run.md', date: '2026-11-07' }); // moved note: found by name
  await p.openFromLink({ task: 'Tasks/Nope.md' });
  assert.deepEqual(opened, ['page Morning run 2026-11-06', 'note Tasks/Morning run.md', 'page Morning run 2026-11-07']);
});
