const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlugin } = require('./helpers');

const L = loadPlugin()._lib;
const S = { defaultDuration: 30, defaultReminder: 'at start' };
const mk = (fm) => L.readTask({ path: 'Tasks/Run.md', basename: 'Run' }, fm, S);

test('series dates: range, open-ended with limit, until', () => {
  const t = mk({ time: '2026-11-02T07:00', recurring: 'every Mon, Wed, Fri', until: '2026-11-20' });
  assert.deepEqual(L.seriesDates(t, '2026-11-01', '2026-11-08'), ['2026-11-02', '2026-11-04', '2026-11-06']);
  assert.deepEqual(L.seriesDates(t, '2026-11-07', null, 2), ['2026-11-09', '2026-11-11']);
  assert.deepEqual(L.seriesDates(t, '2026-11-19', null, 5), ['2026-11-20']); // stops at until
});

test('occurrenceOn: status, skip, move, and invalid dates', () => {
  const t = mk({ time: '2026-11-02T07:00', recurring: 'every Mon, Wed, Fri',
    done_dates: ['2026-11-02'], skipped_dates: ['2026-11-04'], moved: ['2026-11-06 -> 2026-11-07T09:30'] });
  assert.equal(L.occurrenceOn(t, '2026-11-02').status, 'Done');
  assert.equal(L.occurrenceOn(t, '2026-11-04').skipped, true);
  const m = L.occurrenceOn(t, '2026-11-06');
  assert.equal(m.moved, true);
  assert.equal(m.date, '2026-11-07');
  assert.equal(m.time, '09:30');
  assert.equal(m.original, '2026-11-06');
  assert.equal(L.occurrenceOn(t, '2026-11-03'), null); // Tuesday is not in the rule
  assert.equal(L.occurrenceOn(t, '2026-10-30'), null); // before the start
});

test('occurrence pages are never treated as tasks', () => {
  const { P } = { P: loadPlugin() };
  const p = Object.create(P.prototype);
  p.settings = { tasksFolder: 'Tasks', defaultDuration: 30 };
  const files = [
    { path: 'Tasks/Run.md', basename: 'Run', fm: { time: '2026-11-02T07:00', recurring: 'every day' } },
    { path: 'Tasks/Run/Run 2026-11-02.md', basename: 'Run 2026-11-02', fm: { type: 'occurrence', series: '[[Run]]', date: '2026-11-02' } },
    { path: 'Tasks/Run/Run 2026-11-03.md', basename: 'Run 2026-11-03', fm: { series: '[[Run]]', date: '2026-11-03' } }, // type removed by hand
  ];
  p.app = {
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }), getFirstLinkpathDest: (l) => files.find((f) => f.basename === l) },
  };
  assert.deepEqual(p.getTasks().map((t) => t.path), ['Tasks/Run.md']);
  const pages = p.occurrencePages().get('Tasks/Run.md');
  assert.deepEqual([...pages.keys()], ['2026-11-02']);
});

test('clicking an occurrence creates Tasks/<Task>/<Task> <date>.md once, then reopens it', async () => {
  const P = loadPlugin();
  const p = Object.create(P.prototype);
  p.settings = { tasksFolder: 'Tasks', defaultDuration: 30 };
  const series = { path: 'Tasks/Run.md', basename: 'Run', parent: { path: 'Tasks' }, fm: { time: '2026-11-02T07:00', recurring: 'every day' } };
  const files = [series];
  const folders = new Set(['Tasks']);
  const opened = [];
  const fmOf = (content) => {
    const fm = {};
    for (const line of content.split('\n---')[0].split('\n').slice(1)) { const [k, ...v] = line.split(': '); fm[k] = v.join(': ').replace(/^"|"$/g, ''); }
    return fm;
  };
  p.app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (x) => (folders.has(x) ? { children: [] } : files.find((f) => f.path === x) || null),
      createFolder: async (x) => { folders.add(x); },
      create: async (path, content) => { const f = { path, basename: path.split('/').pop().replace(/\.md$/, ''), content, fm: fmOf(content) }; files.push(f); return f; },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }), getFirstLinkpathDest: (l) => files.find((f) => f.basename === l) },
    workspace: { getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }) },
  };
  const t = p.getTasks()[0];
  await p.openOccurrencePage(t, '2026-11-06');
  assert.ok(folders.has('Tasks/Run'));
  const page = files.find((f) => f.path === 'Tasks/Run/Run 2026-11-06.md');
  assert.ok(page);
  assert.match(page.content, /type: occurrence\nseries: "\[\[Run\]\]"\ndate: 2026-11-06/);
  assert.match(page.content, /```task-occurrence\n```/);
  p._pages = null;
  await p.openOccurrencePage(t, '2026-11-06'); // existing page: just opens it
  assert.equal(files.length, 2);
  assert.deepEqual(opened, ['Tasks/Run/Run 2026-11-06.md', 'Tasks/Run/Run 2026-11-06.md']);
  assert.deepEqual(p.getTasks().map((x) => x.path), ['Tasks/Run.md']);
});
