import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHostAdapter } from '../host.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const settingsFunction = source.match(/function getSettings\(create = true\) \{[\s\S]*?\r?\n\}/)[0];

function settingsReader(root) {
  const sandbox = vm.createContext({ getContext: () => ({ extensionSettings: root }), EXTENSION_KEY: 'tavernAssetClassifier' });
  vm.runInContext(settingsFunction, sandbox);
  return create => vm.runInContext(`getSettings(${create})`, sandbox);
}

test('fresh installation: reading absent settings does not throw or create data', () => {
  const root = {};
  assert.equal(settingsReader(root)(false), null);
  assert.deepEqual(root, {});
  assert.deepEqual(JSON.parse(JSON.stringify(settingsReader(root)(true))), { files: {} });
});

test('existing settings, unknown fields, and saved tags keep their identity', () => {
  const saved = { files: { Theme: { favorite: true, style: ['tag'] } }, futureField: { keep: true } };
  const root = { tavernAssetClassifier: saved };
  assert.equal(settingsReader(root)(true), saved);
  assert.deepEqual(saved.files.Theme.style, ['tag']);
  assert.deepEqual(saved.futureField, { keep: true });
});

test('malformed settings are reported without overwriting the original data', () => {
  for (const saved of ['bad-data', false, 0, { files: ['legacy'] }]) {
    const root = { tavernAssetClassifier: saved };
    assert.throws(() => settingsReader(root)(true), /配置格式异常/);
    assert.equal(root.tavernAssetClassifier, saved);
  }
});

test('context functions remain usable when internal module imports fail', async () => {
  const context = { extensionSettings: {}, getRequestHeaders() { return { token: 'fixture' }; }, writeExtensionField(...args) { return args; } };
  const adapter = createHostAdapter({ getGlobal: () => ({ SillyTavern: { getContext: () => context } }), importModule: async () => { throw new Error('module unavailable'); } });
  await adapter.load();
  await adapter.ready();
  assert.deepEqual(adapter.getRequestHeaders(), { token: 'fixture' });
  assert.deepEqual(adapter.writeExtensionField(0, 'key', 1), [0, 'key', 1]);
  assert.equal(adapter.moduleErrors.length, 8);
  assert.throws(() => adapter.require(['saveWorldInfo']), /saveWorldInfo/);
});

test('mutable module exports and replaced context values are read live', async () => {
  const script = { settingsReady: true };
  const personas = { user_avatar: 'first.png' };
  const world = { selected_world_info: ['first'], world_info: { charLore: [] } };
  const openai = { promptManager: null };
  let context = { extensionSettings: {}, name1: 'First', powerUserSettings: { theme: 'First' } };
  const adapter = createHostAdapter({
    getGlobal: () => ({ SillyTavern: { getContext: () => context } }),
    importModule: async path => ({ '/script.js': script, '/scripts/personas.js': personas, '/scripts/world-info.js': world, '/scripts/openai.js': openai })[path] || {},
  });
  await adapter.load();
  assert.equal(adapter.user_avatar, 'first.png');
  assert.equal(adapter.promptManager, null);
  personas.user_avatar = 'second.png';
  world.selected_world_info = ['second'];
  openai.promptManager = { activeCharacter: { id: 1 } };
  context = { ...context, name1: 'Second', powerUserSettings: { theme: 'Second' } };
  assert.equal(adapter.user_avatar, 'second.png');
  assert.equal(adapter.name1, 'Second');
  assert.equal(adapter.power_user.theme, 'Second');
  assert.deepEqual(adapter.selected_world_info, ['second']);
  assert.equal(adapter.promptManager, openai.promptManager);
});

test('context event aliases and native world selection fallback are supported', async () => {
  const eventTypes = { APP_READY: 'ready' };
  const adapter = createHostAdapter({
    getGlobal: () => ({ SillyTavern: { getContext: () => ({ extensionSettings: {}, eventTypes }) } }),
    importModule: async path => path.endsWith('world-info.js') ? { getWorldInfoSettings: () => ({ world_info: { globalSelect: ['Book'] } }) } : {},
  });
  await adapter.load();
  assert.equal(adapter.event_types, eventTypes);
  assert.deepEqual(adapter.selected_world_info, ['Book']);
});

test('initialization waits for APP_READY and removes its temporary listener', async () => {
  const listeners = new Set();
  const eventSource = { on: (_, callback) => listeners.add(callback), removeListener: (_, callback) => listeners.delete(callback) };
  const context = { extensionSettings: {}, eventSource, eventTypes: { APP_READY: 'ready' } };
  const adapter = createHostAdapter({ getGlobal: () => ({ SillyTavern: { getContext: () => context } }), importModule: async () => ({ settingsReady: false }) });
  await adapter.load();
  let ready = false;
  const waiting = adapter.ready(1000).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener();
  await waiting;
  assert.equal(ready, true);
  assert.equal(listeners.size, 0);
});

test('failed module imports can be retried without reloading successful modules', async () => {
  let available = false;
  const counts = new Map();
  const adapter = createHostAdapter({
    getGlobal: () => ({}),
    importModule: async path => {
      counts.set(path, (counts.get(path) || 0) + 1);
      if (path.endsWith('personas.js') && !available) throw new Error('temporary failure');
      return { setUserAvatar: () => true };
    },
  });
  await Promise.all([adapter.load(), adapter.load()]);
  assert.equal(adapter.moduleErrors.length, 1);
  available = true;
  await adapter.load();
  assert.equal(adapter.moduleErrors.length, 0);
  assert.equal(counts.get('/script.js'), 1);
  assert.equal(counts.get('/scripts/personas.js'), 2);
  assert.equal(adapter.setUserAvatar('new.png'), true);
});
