import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const functions = ['getCurrentPromptPresetSelect', 'getCurrentPromptPresetName', 'getCurrentPromptPresetValue',
  'cloneData', 'capturePresetBinding', 'savePresetBinding', 'updatePresetBinding', 'applyPresetBinding'];
const code = functions.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\r?\\n\\}`))[0]).join('\n');

function fixture() {
  const options = [{ value: '0', textContent: 'Preset A' }, { value: '1', textContent: 'Preset B' }];
  const select = { value: '0', options, get selectedOptions() { return options.filter(option => option.value === this.value); } };
  const f = {
    characterKey: 'first',
    order: [{ identifier: 'main', enabled: true }, { identifier: 'extra', enabled: false }],
    bindings: { presets: { starredId: 'existing', items: [{ id: 'existing', name: 'My binding', createdAt: 'original', presetName: 'Old' }] } },
    writes: [], select,
  };
  const host = { main_api: 'openai', promptManager: { activeCharacter: {}, getPromptOrderForCharacter: () => f.order } };
  const sandbox = vm.createContext({
    host, structuredClone, Date,
    document: { querySelector: selector => selector === '#settings_preset_openai' ? select : null },
    normalizeTag: value => String(value ?? '').trim(),
    makeBindingId: () => 'new-binding',
    getCurrentCharacterKey: () => f.characterKey,
    assertCharacterContext: key => { if (key !== f.characterKey) throw new Error('character changed'); },
    getCurrentCharacterBindings: () => structuredClone(f.bindings),
    saveCurrentCharacterBindings: async bindings => { f.bindings = structuredClone(bindings); f.writes.push(f.characterKey); return true; },
    getCurrentPromptOrderSnapshot: () => structuredClone(f.order),
    requestBindingName: (_title, value) => { f.defaultName = value; return new Promise(resolve => { f.confirm = resolve; }); },
    requestUpdateBindingConfirmation: (_title, message) => { f.confirmation = message; return new Promise(resolve => { f.confirm = resolve; }); },
    notify: () => {},
    state: { promptOrderSavePending: false },
    getPresetBindingDisplayName: binding => binding.presetName,
    changePromptPreset: async (_select, option) => { select.value = option.value; },
  });
  vm.runInContext(code, sandbox);
  return { f, host, sandbox };
}

test('save keeps the preset and prompt order captured before the naming dialog', async () => {
  const { f, sandbox } = fixture();
  const originalOrder = structuredClone(f.order);
  const saving = sandbox.savePresetBinding();
  assert.equal(f.defaultName, 'Preset A');
  f.select.value = '1';
  f.order.reverse();
  f.order[0].enabled = true;
  f.confirm('Saved A');
  await saving;
  const saved = f.bindings.presets.items[0];
  assert.equal(saved.name, 'Saved A');
  assert.equal(saved.presetName, 'Preset A');
  assert.equal(saved.presetValue, '0');
  assert.deepEqual(saved.promptOrder, originalOrder);
});

test('update keeps the preset shown in the confirmation and the binding identity', async () => {
  const { f, sandbox } = fixture();
  const originalOrder = structuredClone(f.order);
  const updating = sandbox.updatePresetBinding('existing');
  assert.ok(f.confirmation.includes('Preset A'));
  f.select.value = '1';
  f.order[0].enabled = false;
  f.confirm(true);
  await updating;
  const saved = f.bindings.presets.items[0];
  assert.equal(saved.presetName, 'Preset A');
  assert.equal(saved.presetValue, '0');
  assert.deepEqual(saved.promptOrder, originalOrder);
  assert.equal(saved.id, 'existing');
  assert.equal(saved.name, 'My binding');
  assert.equal(saved.createdAt, 'original');
  assert.ok(saved.updatedAt);
  assert.equal(f.bindings.presets.starredId, 'existing');
});

for (const action of ['save', 'update']) {
  test(`${action} stops if the character changes while the dialog is open`, async () => {
    const { f, sandbox } = fixture();
    const pending = action === 'save' ? sandbox.savePresetBinding() : sandbox.updatePresetBinding('existing');
    f.characterKey = 'second';
    f.confirm(action === 'save' ? 'Saved A' : true);
    await assert.rejects(pending, /character changed/);
    assert.deepEqual(f.writes, []);
  });

  test(`cancelled ${action} does not write bindings`, async () => {
    const { f, sandbox } = fixture();
    const pending = action === 'save' ? sandbox.savePresetBinding() : sandbox.updatePresetBinding('existing');
    f.confirm(action === 'save' ? '' : false);
    await pending;
    assert.deepEqual(f.writes, []);
  });
}

test('update preserves binding changes made while confirmation is open', async () => {
  const { f, sandbox } = fixture();
  const updating = sandbox.updatePresetBinding('existing');
  f.bindings.presets.starredId = '';
  f.bindings.presets.items.push({ id: 'another', name: 'Another binding' });
  f.confirm(true);
  await updating;
  assert.equal(f.bindings.presets.starredId, '');
  assert.equal(f.bindings.presets.items[1].id, 'another');
});

test('update does not recreate a binding deleted while confirmation is open', async () => {
  const { f, sandbox } = fixture();
  const updating = sandbox.updatePresetBinding('existing');
  f.bindings.presets.items = [];
  f.confirm(true);
  await updating;
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.bindings.presets.items, []);
});

test('an unavailable active API does not capture a different API preset', () => {
  const { host, sandbox } = fixture();
  host.main_api = 'textgenerationwebui';
  assert.equal(sandbox.getCurrentPromptPresetSelect(), null);
  assert.equal(sandbox.getCurrentPromptPresetName(), '');
});

test('a numeric preset name is matched by its label rather than another preset index', async () => {
  const { f, sandbox } = fixture();
  f.select.options[1].textContent = '0';
  await sandbox.applyPresetBinding({ presetName: '0', presetValue: '1', promptOrder: [] });
  assert.equal(f.select.value, '1');
});

test('a missing numeric preset name does not select the preset with that index', async () => {
  const { sandbox } = fixture();
  await assert.rejects(sandbox.applyPresetBinding({ presetName: '0', presetValue: '1', promptOrder: [] }), /0/);
});
