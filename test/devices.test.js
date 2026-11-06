// The vault (and data.json) may be shared between devices; only one desktop may sync.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlugin } = require('./helpers');

function harness(platform, localId) {
  const store = { 'taskline-device-id': localId };
  global.window = {
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    setTimeout, setInterval: () => 0,
  };
  const calls = [];
  const disk = { data: null };
  class Plugin {
    constructor() {
      this.app = { workspace: { onLayoutReady: () => {} }, vault: { on: () => {}, getName: () => 'V' }, metadataCache: { on: () => {} } };
    }
    async loadData() { return JSON.parse(JSON.stringify(disk.data)); }
    async saveData(d) { disk.data = JSON.parse(JSON.stringify(d)); }
    addCommand(c) { calls.push('cmd:' + c.id); }
    addRibbonIcon() { calls.push('ribbon'); }
    addSettingTab() {}
    addStatusBarItem() { calls.push('status'); return { addClass() {}, setText() {}, setAttr() {} }; }
    registerMarkdownCodeBlockProcessor(n) { calls.push('block:' + n); }
    registerEvent() {}
    registerInterval() {}
    registerObsidianProtocolHandler(a) { calls.push("uri:" + a); }
  }
  const P = loadPlugin({ Plugin, Notice: class {}, Platform: platform });
  return { P, calls, disk };
}

const base = () => ({ settings: { googleClientId: 'G', syncDevice: 'mac' }, tokens: { google: { refresh: 'R' } }, state: { map: { a: 1 } } });

test('mobile: views + new task only, never writes tokens or sync state', async () => {
  const { P, calls, disk } = harness({ isDesktopApp: false, isMobile: true }, 'phone');
  disk.data = base();
  const p = new P(); await p.onload();
  assert.ok(calls.includes('cmd:new-task') && calls.includes('ribbon') && calls.includes('block:task-today') && calls.includes('uri:taskline'));
  assert.ok(!calls.includes('cmd:sync-now') && !calls.includes('status'));
  disk.data.state.map.b = 2; // the sync device wrote newer state meanwhile
  p.settings.defaultReminder = '10m'; p.settings.googleClientId = 'STALE';
  await p.save();
  assert.deepEqual(disk.data.state.map, { a: 1, b: 2 });
  assert.equal(disk.data.settings.googleClientId, 'G');
  assert.equal(disk.data.settings.defaultReminder, '10m');
  await p.sync(true); // no-op, no network
});

test('second desktop does not sync until it takes over', async () => {
  const { P, disk } = harness({ isDesktopApp: true, isMobile: false }, 'laptop2');
  disk.data = base();
  const p = new P(); await p.onload();
  assert.equal(p.isSyncDevice(), false);
  disk.data.state.map.b = 2;
  p.settings.statusDone = 'finito';
  await p.save();
  assert.deepEqual(disk.data.state.map, { a: 1, b: 2 });
  await p.sync(true); // no-op
  await p.takeOverSync();
  assert.equal(p.isSyncDevice(), true);
  assert.equal(disk.data.settings.syncDevice, 'laptop2');
  assert.deepEqual(disk.data.state.map, { a: 1, b: 2 });
  assert.equal(disk.data.settings.statusDone, 'finito');
});

test('first desktop with no sync device recorded is allowed to sync', async () => {
  const { P, disk } = harness({ isDesktopApp: true, isMobile: false }, 'mac');
  disk.data = base(); disk.data.settings.syncDevice = '';
  const p = new P(); await p.onload();
  assert.equal(p.isSyncDevice(), true);
});

test('device id moves from window.localStorage into the vault-specific store', async () => {
  const { P, disk } = harness({ isDesktopApp: true, isMobile: false }, 'mac');
  disk.data = base();
  const store = {};
  const p = new P();
  p.app.loadLocalStorage = (k) => store[k] || null;
  p.app.saveLocalStorage = (k, v) => { store[k] = v; };
  await p.onload();
  assert.equal(p.isSyncDevice(), true); // legacy id "mac" was carried over
  assert.equal(store['taskline-device-id'], 'mac');
});
