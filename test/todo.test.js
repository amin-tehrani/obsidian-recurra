const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlugin } = require('./helpers');

const P = loadPlugin();
const L = P._lib;
const S = { defaultDuration: 30, defaultReminder: 'at start' };
const mk = (fm) => L.readTask({ path: 'Tasks/test task.md', basename: 'test task' }, fm, S);
const ctx = { tz: 'Europe/Rome', today: '2026-11-06', vault: '', linkStyle: 'none' };

function fakeTodo(initial) {
  const tasks = new Map(Object.entries(initial || {}));
  const calls = [];
  let n = 0;
  const p = Object.create(P.prototype);
  p.api = async (svc, method, url, body, headers) => {
    calls.push(method);
    const id = decodeURIComponent((url.split('/tasks/')[1] || '').split('?')[0]);
    if (method === 'GET' && url.includes('/tasks?')) {
      return { status: 200, json: { value: [...tasks.entries()].map(([k, v]) => ({ id: k, ...v })) } };
    }
    if (method === 'GET') return { status: 200, json: {} };
    if (method === 'POST') { const nid = `new${++n}`; tasks.set(nid, { title: body.title, status: body.status, dueDateTime: body.dueDateTime }); return { status: 201, json: { id: nid } }; }
    if (method === 'DELETE') { tasks.delete(id); return { status: 204, json: null }; }
    if (method === 'PATCH') throw new Error('To Do tasks must never be patched');
    return { status: 200, json: {} };
  };
  p.apiOk = async (...a) => (await p.api(...a)).json;
  p.save = async () => {};
  p.settings = { msListName: 'Obsidian' };
  p.data = { state: { map: {}, tListId: 'list' } };
  p.tListChecked = true;
  return { p, tasks, calls };
}

test('To Do: the copy To Do spawned is removed and the shifted task is rebuilt for the right day', async () => {
  const t = mk({ time: '2026-11-06T15:30', recurring: 'every day', until: '2026-11-19' });
  const body = L.todoBody(t, ctx);
  // the state found on 2026-11-06: ours pushed to Nov 8, plus a spawned copy
  const { p, tasks } = fakeTodo({
    ours: { title: 'test task', status: 'notStarted', dueDateTime: { dateTime: '2026-11-07T23:00:00.0000000', timeZone: 'UTC' } },
    spawned: { title: 'test task', status: 'notStarted', dueDateTime: { dateTime: '2026-11-05T23:00:00.0000000', timeZone: 'UTC' } },
    unrelated: { title: 'Buy milk', status: 'notStarted' },
  });
  p.data.state.map['Tasks/test task.md'] = { t: { id: 'ours', h: 'whatever-matches' } };
  const errors = [];
  await p.syncTodo([t], ctx, errors);
  assert.deepEqual(errors, []);
  const left = [...tasks.entries()];
  assert.equal(left.filter(([, v]) => v.title === 'test task').length, 1);
  const [id, v] = left.find(([, x]) => x.title === 'test task');
  assert.deepEqual(v.dueDateTime, { dateTime: '2026-11-06T00:00:00', timeZone: 'UTC' }); // back on Nov 6, as a UTC date
  assert.deepEqual(body.dueDateTime, v.dueDateTime);
  assert.equal(p.data.state.map['Tasks/test task.md'].t.id, id);
  assert.ok(tasks.has('unrelated')); // tasks with other titles are left alone
});

test('To Do: an unchanged, matching task is left alone (one GET, nothing else)', async () => {
  const t = mk({ time: '2026-11-06T15:30', recurring: 'every day' });
  const { p, calls } = fakeTodo();
  await p.syncTodo([t], ctx, []);
  calls.length = 0;
  await p.syncTodo([t], ctx, []);
  assert.deepEqual(calls, ['GET']);
});

test('To Do: a change replaces the task instead of editing it', async () => {
  let t = mk({ time: '2026-11-06T15:30', recurring: 'every day' });
  const { p, tasks, calls } = fakeTodo();
  await p.syncTodo([t], ctx, []);
  calls.length = 0;
  t = mk({ time: '2026-11-06T15:30', recurring: 'every day', done_dates: ['2026-11-06'] }); // ticked today
  await p.syncTodo([t], ctx, []);
  assert.deepEqual(calls, ['GET', 'DELETE', 'POST']);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].dueDateTime.dateTime, '2026-11-07T00:00:00');
});

test('To Do: completed in To Do but not in Obsidian → recreated as pending (Obsidian is the source of truth)', async () => {
  const t = mk({ time: '2026-11-06T15:30' });
  const { p, tasks } = fakeTodo();
  await p.syncTodo([t], ctx, []);
  const [id] = tasks.keys();
  tasks.get(id).status = 'completed';
  await p.syncTodo([t], ctx, []);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].status, 'notStarted');
});

test('To Do: due dates are sent as UTC calendar dates (local midnight made To Do skip a day)', () => {
  const t = mk({ time: '2026-11-06T15:30', recurring: 'every day' });
  const b = L.todoBody(t, ctx);
  assert.deepEqual(b.dueDateTime, { dateTime: '2026-11-06T00:00:00', timeZone: 'UTC' });
  assert.equal(b.recurrence.range.startDate, '2026-11-06');
  assert.deepEqual(b.reminderDateTime, { dateTime: '2026-11-06T15:30:00', timeZone: 'Europe/Rome' }); // reminders stay local
  const one = L.todoBody(mk({ time: '2026-11-09' }), ctx);
  assert.deepEqual(one.dueDateTime, { dateTime: '2026-11-09T00:00:00', timeZone: 'UTC' });
});
