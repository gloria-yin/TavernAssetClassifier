import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.TAC_TEST_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!chrome) throw new Error('Set TAC_TEST_CHROME to a Chromium executable.');

const root = new URL('../', import.meta.url);
const indexSource = await readFile(new URL('index.js', root), 'utf8');
const hostSource = await readFile(new URL('host.js', root), 'utf8');
const styles = await readFile(new URL('style.css', root), 'utf8');
const exportsForTest = ['host', 'state', 'start', 'getSettings', 'getThemeRecord', 'getFilteredThemeNames', 'toggleFilter',
  'capturePresetBinding', 'captureUserBinding', 'captureWorldBookBinding', 'applyPresetBinding', 'applyUserBinding',
  'applyWorldBookBinding', 'applyStarredCharacterBindings', 'transferCharacterBindingContent', 'saveSettings',
  'importThemeFilesSequentially', 'renameCurrentTheme', 'refreshFeatureMounts', 'saveCurrentCharacterBindings', 'savePromptOrderSettings'];
const themeMarkup = `<div id="UI-presets-block"><div class="flex-container"><select id="themes"><option>Alpha</option><option>Beta</option></select></div>
<button id="ui-preset-update-button">Save</button><button id="ui-preset-save-button">Save As</button><button id="ui-preset-delete-button">Delete</button>
<input id="ui_preset_import_file" type="file"></div>`;

function installFixture(mode) {
  const copy = value => structuredClone(value);
  const events = new Map();
  const types = { APP_READY: 'app_ready', CHAT_CHANGED: 'chat_changed', CHARACTER_EDITED: 'character_edited', SETTINGS_UPDATED: 'settings_updated', OAI_PRESET_CHANGED_AFTER: 'preset_after', CHAT_COMPLETION_SETTINGS_READY: 'completion_ready', PRESET_CHANGED: 'preset_changed' };
  const eventSource = {
    on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    removeListener(name, callback) { events.get(name)?.delete(callback); },
    async emit(name, ...args) { for (const callback of [...(events.get(name) || [])]) await callback(...args); },
  };
  const f = window.__fixture = {
    events, types, eventSource, calls: [], messages: [], errors: [], characterId: 0, userName: 'Owner', avatar: 'a.png', saves: 0, mainApi: 'openai',
    extensionSettings: mode === 'existing' ? { tavernAssetClassifier: { files: { Alpha: { style: ['kept'], favorite: true, background: 'garden.jpg' } }, futureField: 'keep' }, anotherExtension: { keep: true } } : {},
    power: { theme: 'Alpha', personas: { 'a.png': 'Owner', 'b.png': 'Reader' }, avatar_style: 0 },
    background: { name: '', url: '' },
    themes: { Alpha: { name: 'Alpha', main_text_color: '#ffffff' }, Beta: { name: 'Beta', main_text_color: '#000000' } },
    characters: [
      { name: 'Alice', avatar: 'alpha.png', data: { extensions: { world: 'PrimaryA' } } },
      { name: 'Bob', avatar: 'beta.png', data: { extensions: { world: 'PrimaryB', unrelated: 'keep' } } },
    ],
    globalBooks: ['Global'],
    worldInfo: { globalSelect: ['Global'], charLore: [{ name: 'alpha', extraBooks: ['AuxA'] }, { name: 'beta', extraBooks: ['AuxB'] }] },
    books: Object.fromEntries(['Global', 'Other', 'PrimaryA', 'PrimaryB', 'AuxA', 'AuxB'].map(name => [name, { metadata: { keep: name }, entries: { 0: { uid: 0, content: name + ' text', disable: false, key: [name] } } }])),
    orders: { 0: [{ identifier: 'main', enabled: true }, { identifier: 'extra', enabled: false }], 1: [{ identifier: 'main', enabled: true }] },
    presetName: 'Preset One',
  };
  f.diskBooks = copy(f.books);
  f.diskCharacters = Object.fromEntries(f.characters.map(character => [character.avatar, copy(character)]));
  if (mode === 'malformed') f.extensionSettings.tavernAssetClassifier = { files: ['do not overwrite'] };
  f.manager = {
    activeCharacter: { id: 0 },
    getPromptOrderForCharacter(character) { return f.orders[character.id]; },
    removePromptOrderForCharacter(character) { delete f.orders[character.id]; },
    addPromptOrderForCharacter(character, order) { f.orders[character.id] = copy(order); },
    async saveServiceSettings() { f.calls.push('save-prompt-order'); },
    async render() { f.calls.push('render-prompts'); },
  };
  f.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-Fixture': 'true' });
  f.getThumbnailUrl = (type, file) => '/thumbnail?type=' + type + '&file=' + encodeURIComponent(file);
  f.saveSettingsDebounced = () => { f.saves++; f.savedSettings = copy(f.extensionSettings); };
  f.writeExtensionField = async (id, key, value) => {
    f.characters[id].data.extensions[key] = copy(value);
    f.calls.push(['write-character', id, key]);
    if (!f.failCharacterWrites) f.diskCharacters[f.characters[id].avatar].data.extensions[key] = copy(value);
  };
  f.unshallowCharacter = async id => { f.calls.push(['load-character', id]); };
  f.selectCharacterById = async id => { f.characterId = id; f.manager.activeCharacter = { id }; await eventSource.emit(types.CHAT_CHANGED); };
  f.loadWorldInfo = async name => f.books[name] ? copy(f.books[name]) : null;
  f.saveWorldInfo = async (name, data) => {
    f.books[name] = copy(data);
    if (!f.failWorldWrites) f.diskBooks[name] = copy(data);
    f.calls.push(['save-world', name]);
    if (f.pauseWorldSave) { f.pauseWorldSave = false; await new Promise(resolve => { f.resumeWorldSave = resolve; }); }
  };
  f.updateWorldInfoList = async () => { f.calls.push('refresh-worlds'); };
  f.getContext = () => ({
    characterId: f.characterId, characters: f.characters, name1: f.userName, extensionSettings: f.extensionSettings, mainApi: f.mainApi,
    powerUserSettings: f.power, eventSource, eventTypes: types, chatCompletionSettings: { preset_settings_openai: f.presetName },
    getRequestHeaders: f.getRequestHeaders, getThumbnailUrl: f.getThumbnailUrl, saveSettingsDebounced: f.saveSettingsDebounced,
    writeExtensionField: f.writeExtensionField, unshallowCharacter: f.unshallowCharacter, selectCharacterById: f.selectCharacterById,
    loadWorldInfo: f.loadWorldInfo, saveWorldInfo: f.saveWorldInfo, updateWorldInfoList: f.updateWorldInfoList,
  });
  window.SillyTavern = { getContext: f.getContext };
  if (mode.startsWith('tt')) window.__TAURITAVERN__ = { ready: Promise.resolve(), api: {} };
  window.toastr = Object.fromEntries(['error', 'warning', 'info', 'success'].map(type => [type, message => f.messages.push({ type, message })]));
  window.$ = window.jQuery = element => ({ trigger(name) { if (name === 'change') element.dispatchEvent(new Event('change', { bubbles: true })); } });
  addEventListener('error', event => f.errors.push(event.message));
  addEventListener('unhandledrejection', event => f.errors.push(String(event.reason)));
  f.bindThemeControls = () => {
    document.querySelector('#themes').addEventListener('change', event => { f.power.theme = event.target.value; void eventSource.emit(types.SETTINGS_UPDATED); });
    document.querySelector('#ui_preset_import_file').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      const theme = JSON.parse(await file.text());
      f.themes[theme.name] = theme;
      document.querySelector('#themes').add(new Option(theme.name, theme.name));
      event.target.value = '';
    });
  };
  f.bindThemeControls();
  document.querySelector('#settings_preset_openai').addEventListener('change', event => {
    const name = event.target.selectedOptions[0].textContent;
    setTimeout(async () => {
      f.presetName = name;
      f.orders[f.characterId] = [{ identifier: 'main', enabled: true }];
      await eventSource.emit(types.OAI_PRESET_CHANGED_AFTER);
      await eventSource.emit(types.PRESET_CHANGED, { apiId: f.mainApi, name });
    }, 50);
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const body = JSON.parse(options.body || '{}');
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/settings/get') return json({ themes: Object.values(f.themes) });
    if (path === '/api/backgrounds/all') return json({ images: ['garden.jpg'] });
    if (path === '/api/worldinfo/get') return f.diskBooks[body.name] ? json(f.diskBooks[body.name]) : new Response('', { status: 404 });
    if (path === '/api/characters/get') return json(f.diskCharacters[body.avatar_url]);
    if (path === '/api/themes/save') { f.themes[body.name] = body; return json({}); }
    if (path === '/api/themes/delete') { delete f.themes[body.name]; return json({}); }
    return nativeFetch(input, options);
  };
}

let activeMode = 'fresh';
let failStyle = false;
const modules = {
  '/script.js': `const f=window.__fixture;export let settingsReady=${'READY'};export const getContext=f.getContext,getRequestHeaders=f.getRequestHeaders,getThumbnailUrl=f.getThumbnailUrl,saveSettingsDebounced=f.saveSettingsDebounced,writeExtensionField=f.writeExtensionField,unshallowCharacter=f.unshallowCharacter,selectCharacterById=f.selectCharacterById,eventSource=f.eventSource,event_types=f.types;export function setUserName(name){f.userName=name;}export {user_avatar,setUserAvatar} from '/scripts/personas.js';f.completeReady=()=>{settingsReady=true;return f.eventSource.emit(f.types.APP_READY);};`,
  '/scripts/extensions.js': `const f=window.__fixture;export const getContext=f.getContext,writeExtensionField=f.writeExtensionField,extension_settings=f.extensionSettings;`,
  '/scripts/personas.js': `const f=window.__fixture;export let user_avatar=f.avatar;export async function setUserAvatar(value){user_avatar=value;f.avatar=value;f.userName='Persona Name';}`,
  '/scripts/power-user.js': `const f=window.__fixture;export const power_user=f.power;export function getThemeObject(name){return {...f.themes[f.power.theme],name};}`,
  '/scripts/backgrounds.js': `const f=window.__fixture;export const background_settings=f.background;export const getBackgroundPath=file=>'/backgrounds/'+encodeURIComponent(file);`,
  '/scripts/openai.js': `const f=window.__fixture;export let promptManager=f.manager;f.setManager=value=>{promptManager=value;};`,
  '/scripts/utils.js': `export const getCharaFilename=id=>window.__fixture.characters[id]?.avatar.replace(/\.[^/.]+$/,'');`,
  '/scripts/world-info.js': `const f=window.__fixture;export const world_info=f.worldInfo,loadWorldInfo=f.loadWorldInfo,saveWorldInfo=f.saveWorldInfo,updateWorldInfoList=f.updateWorldInfoList;export let selected_world_info=f.globalBooks;export const getWorldInfoSettings=()=>({world_info});export function updateWorldInfoSettings(_,names){selected_world_info=[...names];f.globalBooks=selected_world_info;world_info.globalSelect=selected_world_info;}export function charSetAuxWorlds(name,books){const old=world_info.charLore.find(item=>item.name===name);if(old)old.extraBooks=[...books];else world_info.charLore.push({name,extraBooks:[...books]});}`,
};
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html;charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <div id="extensions_settings"></div><div id="user-settings-block">${themeMarkup}</div><div id="bg1"></div>
      <select id="settings_preset_openai"><option value="0">Preset One</option><option value="1">Preset Two</option></select>
      <script>(${installFixture.toString()})(${JSON.stringify(activeMode)});import('/plugin/index.js');</script></body></html>`);
  } else if (path === '/plugin/index.js') {
    response.setHeader('Content-Type', 'text/javascript;charset=utf-8');
    response.end(indexSource + '\nglobalThis.__tac={' + exportsForTest.join(',') + '};');
  } else if (path === '/plugin/host.js') {
    response.setHeader('Content-Type', 'text/javascript;charset=utf-8');
    response.end(hostSource);
  } else if (path === '/plugin/style.css') {
    response.writeHead(failStyle ? 404 : 200, { 'Content-Type': 'text/css' });
    response.end(failStyle ? '' : styles);
  } else if (modules[path]) {
    response.setHeader('Content-Type', 'text/javascript;charset=utf-8');
    if (activeMode === 'tt-context' && path === '/script.js') response.end('export const settingsReady=true;');
    else response.end(modules[path].replace('READY', activeMode === 'delayed' ? 'false' : 'true'));
  } else if (path === '/thumbnail') {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="gray"/></svg>');
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tac-compatibility-'));
let browser, client;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.next = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.next;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

async function evaluate(expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 12000 });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error('Timed out: ' + expression + ' ' + JSON.stringify(await evaluate('({errors:window.__fixture?.errors,status:document.querySelector("#tac-startup-status")?.innerText})')));
}

async function navigate(mode, width = 1200) {
  activeMode = mode;
  failStyle = mode === 'style-failure';
  await client.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
  await client.call('Page.navigate', { url: baseUrl + '/?mode=' + mode + '&nonce=' + Date.now() });
  await waitFor('!!window.__tac && !!window.__fixture');
}

async function ready() {
  await waitFor('__tac.state.started && !!document.querySelector("#tac-filter-panel") && !!document.querySelector("#tac-character-binding-body .tac-binding-grid")');
}

try {
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--remote-debugging-port=0', '--user-data-dir=' + temporaryRoot, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let port;
  for (let index = 0; index < 150; index++) {
    try { port = Number((await readFile(join(temporaryRoot, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await sleep(50); }
  }
  assert.ok(port, 'Chromium did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  client = new CDP(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await client.call('Page.enable');

  await navigate('fresh');
  await ready();
  assert.equal(await evaluate('!!__tac.getSettings(false).files'), true);
  assert.equal(await evaluate('document.querySelectorAll("#tac-classifier-style").length'), 1);
  await evaluate('__tac.getThemeRecord("Alpha").style=["soft"];__tac.toggleFilter("style","soft");');
  assert.deepEqual(await evaluate('__tac.getFilteredThemeNames()'), ['Alpha']);
  await evaluate('__tac.toggleFilter("style","soft");');

  const preset = await evaluate('__tac.capturePresetBinding("preset")');
  const user = await evaluate('__tac.captureUserBinding("user")');
  const worlds = await evaluate('__tac.captureWorldBookBinding("worlds")');
  assert.equal(preset.presetName, 'Preset One');
  assert.equal(user.avatar, 'a.png');
  assert.deepEqual(worlds.books.map(book => book.name).sort(), ['AuxA', 'Global', 'PrimaryA']);
  assert.deepEqual(worlds.books[0].data.metadata, { keep: 'Global' });
  const desiredOrder = [{ identifier: 'extra', enabled: true }, { identifier: 'main', enabled: false }];
  await evaluate(`__tac.applyPresetBinding(${JSON.stringify({ ...preset, presetValue: '1', presetName: 'Preset Two', promptOrder: desiredOrder })})`);
  assert.deepEqual(await evaluate('__fixture.orders[0]'), desiredOrder);
  assert.equal(await evaluate('__fixture.presetName'), 'Preset Two');
  await evaluate('document.querySelector("#settings_preset_openai").innerHTML=\'<option value="0">Preset Two</option><option value="1" selected>Preset One</option>\';');
  await evaluate(`__tac.applyPresetBinding(${JSON.stringify({ ...preset, presetValue: '1', presetName: 'Preset Two', promptOrder: desiredOrder })})`);
  assert.equal(await evaluate('document.querySelector("#settings_preset_openai").value'), '0', 'preset name must win over an outdated numeric option value');
  assert.equal(await evaluate('__fixture.presetName'), 'Preset Two');
  assert.match(await evaluate(`(async()=>{try{await __tac.applyPresetBinding({presetName:'Deleted Preset',presetValue:'0'});return '';}catch(error){return error.message;}})()`), /找不到预设：Deleted Preset/);
  assert.match(await evaluate(`(async()=>{try{await __tac.savePromptOrderSettings({saveServiceSettings:()=>new Promise(()=>{})},25);return '';}catch(error){return error.message;}})()`), /尚未确认保存/);
  const savesBeforeRetry = await evaluate('__fixture.calls.filter(call=>call==="save-prompt-order").length');
  await evaluate(`__tac.applyPresetBinding(${JSON.stringify({ ...preset, presetName: 'Preset Two', promptOrder: desiredOrder })})`);
  assert.equal(await evaluate('__fixture.calls.filter(call=>call==="save-prompt-order").length'), savesBeforeRetry + 1, 'unchanged in-memory order must still retry an unconfirmed save');
  assert.equal(await evaluate('__tac.state.promptOrderSavePending'), false);
  await evaluate(`__tac.applyUserBinding(${JSON.stringify({ ...user, avatar: 'b.png', userName: 'Owner' })})`);
  assert.equal(await evaluate('__fixture.avatar'), 'b.png');
  assert.equal(await evaluate('__fixture.userName'), 'Owner', 'persona name changes must not override the bound name');
  await evaluate('__tac.host.updateWorldInfoSettings({},["Other"]);__fixture.characters[0].data.extensions.world="PrimaryB";__tac.host.charSetAuxWorlds("alpha",["AuxB"]);__fixture.books.Global.entries[0].content="changed";');
  await evaluate(`__tac.applyWorldBookBinding(${JSON.stringify(worlds)})`);
  assert.deepEqual(await evaluate('__fixture.globalBooks'), ['Global']);
  assert.equal(await evaluate('__fixture.characters[0].data.extensions.world'), 'PrimaryA');
  assert.deepEqual(await evaluate('__fixture.worldInfo.charLore.find(item=>item.name==="alpha").extraBooks'), ['AuxA']);
  assert.deepEqual(await evaluate('__fixture.books.Global'), worlds.books[0].data);
  await evaluate('__fixture.books.Global.entries[0].content="changed again";__fixture.diskBooks.Global.entries[0].content="disk still old";__fixture.failWorldWrites=true;');
  assert.match(await evaluate(`(async()=>{try{await __tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true});return '';}catch(error){return error.message;}})()`), /未确认世界书已完整保存/);
  const failedWrites = await evaluate('__fixture.calls.filter(call=>call[0]==="save-world").length');
  assert.match(await evaluate(`(async()=>{try{await __tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true});return '';}catch(error){return error.message;}})()`), /未确认世界书已完整保存/);
  assert.equal(await evaluate('__fixture.calls.filter(call=>call[0]==="save-world").length'), failedWrites + 1, 'a failed native world save must retry even if its memory cache matches');
  await evaluate('__fixture.failWorldWrites=false;');
  await evaluate(`__tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true})`);
  assert.deepEqual(await evaluate('__fixture.diskBooks.Global'), worlds.books[0].data);
  await evaluate('__fixture.characters[0].data.extensions.world="PrimaryB";__fixture.diskCharacters["alpha.png"].data.extensions.world="PrimaryB";__fixture.failCharacterWrites=true;');
  assert.match(await evaluate(`(async()=>{try{await __tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true});return '';}catch(error){return error.message;}})()`), /未确认角色卡字段已完整保存/);
  await evaluate('__fixture.failCharacterWrites=false;');
  await evaluate(`__tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true})`);
  assert.equal(await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.world'), 'PrimaryA', 'retry must repair an unpersisted primary world even when the UI already shows the target');
  await evaluate('__fixture.failCharacterWrites=true;');
  assert.equal(await evaluate('__tac.saveCurrentCharacterBindings({users:{items:[{id:"failed-save",userName:"Unsaved"}]}})'), false);
  assert.equal(await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier'), undefined);
  assert.match(await evaluate('__fixture.messages.at(-1).message'), /未确认保存/);
  await evaluate('__fixture.failCharacterWrites=false;');
  assert.equal(await evaluate('__tac.saveCurrentCharacterBindings({users:{items:[{id:"retry-save",userName:"Saved"}]}})'), true);
  assert.equal(await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier.users.items[0].userName'), 'Saved');

  await evaluate(`(()=>{const data=__fixture.characters[0].data.extensions;data.tavernAssetClassifier={beautify:{items:[{id:'beauty',themeName:'Alpha'}]},presets:{items:[${JSON.stringify(preset)}]},users:{items:[${JSON.stringify(user)}]},worldBooks:{items:[${JSON.stringify(worlds)}]}};})()`);
  await evaluate('__tac.transferCharacterBindingContent("alpha.png","beta.png",["beautify","presets","users","worldBooks"])');
  const transferred = await evaluate('__fixture.characters[1].data.extensions.tavernAssetClassifier');
  assert.equal(transferred.worldBooks.items[0].preserveCharacterBooks, true);
  assert.deepEqual(transferred.worldBooks.items[0].books.map(book => book.name), ['Global']);
  await evaluate('__tac.transferCharacterBindingContent("alpha.png","beta.png",["beautify","presets","users","worldBooks"])');
  assert.equal(await evaluate('__fixture.characters[1].data.extensions.tavernAssetClassifier.users.items.length'), 1);
  assert.equal(await evaluate('__fixture.characters[1].data.extensions.unrelated'), 'keep');
  await evaluate('__fixture.characterId=1;__fixture.manager.activeCharacter={id:1};');
  await evaluate(`__tac.applyWorldBookBinding(${JSON.stringify(transferred.worldBooks.items[0])})`);
  assert.equal(await evaluate('__fixture.characters[1].data.extensions.world'), 'PrimaryB');
  assert.deepEqual(await evaluate('__fixture.worldInfo.charLore.find(item=>item.name==="beta").extraBooks'), ['AuxB']);

  await evaluate('__fixture.characterId=0;__fixture.manager.activeCharacter={id:0};__tac.refreshFeatureMounts();');
  await evaluate(`(()=>{const b=__fixture.characters[0].data.extensions.tavernAssetClassifier;for(const type of ['beautify','presets','users','worldBooks'])b[type].starredId=b[type].items[0].id;__tac.state.lastAppliedCharacterBindingKey='';})()`);
  await evaluate('__tac.applyStarredCharacterBindings()');
  assert.equal(await evaluate('__tac.state.lastAppliedCharacterBindingKey'), '0:alpha.png');
  assert.equal(await evaluate('__fixture.avatar'), user.avatar);
  assert.equal(await evaluate('__fixture.presetName'), preset.presetName);
  assert.deepEqual(await evaluate('__fixture.orders[0]'), preset.promptOrder);
  await evaluate('__fixture.setManager(null);__tac.state.lastAppliedCharacterBindingKey="";');
  assert.equal(await evaluate('(async()=>{try{await __tac.applyStarredCharacterBindings();return false;}catch{return true;}})()'), true);
  assert.equal(await evaluate('__tac.state.lastAppliedCharacterBindingKey'), '', 'failed automatic binding must remain retryable');
  await evaluate('__fixture.setManager(__fixture.manager);');
  await evaluate('__tac.applyStarredCharacterBindings()');
  assert.equal(await evaluate('__tac.state.lastAppliedCharacterBindingKey'), '0:alpha.png');
  await evaluate('document.querySelector("#settings_preset_openai").value="0";document.querySelector("#settings_preset_openai").dispatchEvent(new Event("change",{bubbles:true}));');
  await waitFor('__fixture.presetName==="Preset Two"');
  await evaluate('new Promise(resolve=>setTimeout(resolve,750))');
  assert.equal(await evaluate('__fixture.presetName'), 'Preset Two', 'completed automatic bindings must not override later manual preset choices');
  await evaluate(`__fixture.books.Global.entries[0].content='different';__fixture.pauseWorldSave=true;void(window.__raceResult=__tac.applyWorldBookBinding(${JSON.stringify(worlds)},{automatic:true}).then(()=>'',error=>error.message));`);
  await waitFor('typeof __fixture.resumeWorldSave==="function"');
  await evaluate('__fixture.selectCharacterById(1);__fixture.resumeWorldSave();');
  assert.match(await evaluate('__raceResult'), /角色已切换/);
  assert.equal(await evaluate('__fixture.characters[1].data.extensions.world'), 'PrimaryB');
  await evaluate('__fixture.selectCharacterById(0)');
  await evaluate('document.querySelector("#tac-character-binding-body .tac-binding-module:nth-child(2) .tac-binding-save").click()');
  await waitFor('!!document.querySelector("#tac-binding-modal input")');
  await evaluate('document.querySelector("#tac-binding-modal input").value="Saved through UI";document.querySelector("#tac-binding-modal [data-action=confirm]").click()');
  await waitFor('__fixture.characters[0].data.extensions.tavernAssetClassifier.presets.items.some(item=>item.name==="Saved through UI")');
  await evaluate('__fixture.setManager(null);');
  assert.equal(await evaluate('(()=>{try{__tac.capturePresetBinding("must fail");return false;}catch{return true;}})()'), true);
  await evaluate('__fixture.setManager(__fixture.manager);');

  await evaluate(`(()=>{const input=document.querySelector('#ui_preset_import_file');return __tac.importThemeFilesSequentially(input,[new File([JSON.stringify({name:'Imported',main_text_color:'#123456'})],'theme.json',{type:'application/json'})]);})()`);
  assert.equal(await evaluate('__fixture.power.theme'), 'Imported');
  assert.equal(await evaluate('!!__fixture.themes.Imported'), true);
  await evaluate('void __tac.renameCurrentTheme();');
  await waitFor('!!document.querySelector("#tac-rename-modal input")');
  await evaluate('document.querySelector("#tac-rename-modal input").value="Renamed";document.querySelector("#tac-rename-modal [data-action=confirm]").click()');
  await waitFor('__fixture.power.theme==="Renamed"');
  assert.equal(await evaluate('!!__fixture.themes.Renamed && !__fixture.themes.Imported'), true);

  await evaluate(`document.querySelector('#user-settings-block').innerHTML=${JSON.stringify(themeMarkup)};__fixture.bindThemeControls();document.querySelector('#extensions_settings').replaceWith(Object.assign(document.createElement('div'),{id:'extensions_settings'}));`);
  await ready();
  assert.equal(await evaluate('document.querySelectorAll("#tac-filter-panel").length'), 1);
  assert.equal(await evaluate('__fixture.events.get("chat_changed").size'), 1);
  assert.equal(await evaluate('__fixture.events.get("settings_updated").size'), 1);
  await evaluate('__fixture.mainApi="textgenerationwebui";document.querySelector("#settings_preset_openai").id="settings_preset_textgenerationwebui";__fixture.setManager(null);');
  assert.deepEqual(await evaluate('__tac.capturePresetBinding("Text preset").promptOrder'), []);
  await evaluate(`__tac.applyPresetBinding({name:'Text preset',presetName:'Preset Two',presetValue:'1',promptOrder:[]})`);
  assert.equal(await evaluate('__fixture.presetName'), 'Preset Two');
  assert.deepEqual(await evaluate('__fixture.errors'), []);
  console.log('PASS desktop: fresh install, labels/filter, chat/text presets, user, complete worldbooks, transfer, auto-apply/retry, character-switch guard, UI save, import/rename, panel remount');

  await navigate('preset-dialogs');
  await ready();
  await waitFor('__tac.state.lastAppliedCharacterBindingKey==="0:alpha.png"');
  await evaluate(`__fixture.orders[0]=[{identifier:'extra',enabled:true},{identifier:'main',enabled:false}];window.__expectedPreset=__tac.capturePresetBinding('Dialog snapshot');document.querySelector('#tac-character-binding-body .tac-binding-module:nth-child(2) .tac-binding-save').click();`);
  await waitFor('!!document.querySelector("#tac-binding-modal input")');
  await evaluate(`__tac.applyPresetBinding({presetName:'Preset Two',promptOrder:[{identifier:'main',enabled:true}]})`);
  await evaluate('document.querySelector("#tac-binding-modal input").value="Dialog snapshot";document.querySelector("#tac-binding-modal [data-action=confirm]").click()');
  await waitFor('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier?.presets.items.length===1');
  const dialogSaved = await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier.presets.items[0]');
  assert.equal(dialogSaved.presetName, 'Preset One', 'save must use the preset selected before the naming dialog');
  assert.deepEqual(dialogSaved.promptOrder, await evaluate('__expectedPreset.promptOrder'));
  await evaluate(`__tac.applyPresetBinding(${JSON.stringify(dialogSaved)})`);
  assert.equal(await evaluate('__fixture.presetName'), 'Preset One');
  assert.deepEqual(await evaluate('__fixture.orders[0]'), dialogSaved.promptOrder);

  await waitFor('!!document.querySelector(".tac-binding-update")');
  await evaluate(`__fixture.orders[0][0].enabled=false;window.__expectedPreset=__tac.capturePresetBinding('Dialog snapshot');document.querySelector('.tac-binding-update').click();`);
  await waitFor('!!document.querySelector("#tac-binding-modal .tac-confirm-body")');
  await evaluate(`__tac.applyPresetBinding({presetName:'Preset Two',promptOrder:[{identifier:'main',enabled:true}]})`);
  await evaluate('document.querySelector("#tac-binding-modal [data-action=confirm]").click()');
  await waitFor('!!__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier.presets.items[0].updatedAt');
  const dialogUpdated = await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier.presets.items[0]');
  assert.equal(dialogUpdated.presetName, 'Preset One', 'update must use the preset named in the confirmation');
  assert.deepEqual(dialogUpdated.promptOrder, await evaluate('__expectedPreset.promptOrder'));
  assert.equal(dialogUpdated.id, dialogSaved.id);
  await evaluate(`__tac.applyPresetBinding(${JSON.stringify(dialogUpdated)})`);
  assert.deepEqual(await evaluate('__fixture.orders[0]'), dialogUpdated.promptOrder);

  await evaluate('document.querySelector(".tac-binding-update").click()');
  await waitFor('!!document.querySelector("#tac-binding-modal .tac-confirm-body")');
  await evaluate('__fixture.characterId=1;__fixture.manager.activeCharacter={id:1};document.querySelector("#tac-binding-modal [data-action=confirm]").click()');
  await waitFor('__fixture.messages.some(item=>item.type==="error" && item.message.includes("角色已切换"))');
  assert.equal(await evaluate('__fixture.diskCharacters["beta.png"].data.extensions.tavernAssetClassifier'), undefined);
  assert.deepEqual(await evaluate('__fixture.diskCharacters["alpha.png"].data.extensions.tavernAssetClassifier.presets.items[0]'), dialogUpdated);
  assert.deepEqual(await evaluate('__fixture.errors'), []);
  console.log('PASS preset dialogs: save/update snapshots survive preset changes, reload restores the captured order, character switches stop updates');

  await navigate('existing', 390);
  await ready();
  assert.equal(await evaluate('__tac.getSettings().futureField'), 'keep');
  assert.equal(await evaluate('__tac.getThemeRecord("Alpha").favorite'), true);
  assert.deepEqual(await evaluate('__tac.getThemeRecord("Alpha").style'), ['kept']);
  assert.equal(await evaluate('__fixture.background.name'), 'garden.jpg');
  assert.deepEqual(await evaluate('__fixture.extensionSettings.anotherExtension'), { keep: true });
  assert.deepEqual(await evaluate('__fixture.errors'), []);
  console.log('PASS mobile viewport: existing settings, favorites, background bindings, unrelated data');

  await navigate('tt-context', 390);
  await ready();
  assert.equal(await evaluate('__tac.host.getRequestHeaders()["X-Fixture"]'), 'true');
  assert.deepEqual(await evaluate('__fixture.errors'), []);
  console.log('PASS TT-like host: context-only common functions and event aliases');

  await navigate('delayed');
  await waitFor('typeof __fixture.completeReady==="function"');
  assert.equal(await evaluate('__tac.state.started'), false);
  assert.equal(await evaluate('Object.hasOwn(__fixture.extensionSettings,"tavernAssetClassifier")'), false);
  await evaluate('__fixture.completeReady()');
  await ready();
  console.log('PASS delayed initialization: no config writes or auto-apply before host readiness');

  await navigate('malformed');
  await waitFor('document.querySelector("#tac-startup-status")?.textContent.includes("配置格式异常")');
  assert.deepEqual(await evaluate('__fixture.extensionSettings.tavernAssetClassifier'), { files: ['do not overwrite'] });
  assert.equal(await evaluate('__tac.state.started'), false);
  console.log('PASS malformed configuration: visible error, original data preserved');

  await navigate('style-failure');
  await waitFor('document.querySelector("#tac-startup-status")?.textContent.includes("style.css")');
  assert.equal(await evaluate('__tac.state.started'), false);
  failStyle = false;
  await evaluate('document.querySelector("#tac-startup-status button").click()');
  await ready();
  assert.equal(await evaluate('document.querySelectorAll("#tac-classifier-style").length'), 1);
  assert.deepEqual(await evaluate('__fixture.errors'), []);
  console.log('PASS style failure: visible diagnostics, retry restores the complete UI');
} finally {
  if (client) { try { await client.call('Browser.close'); } catch {} client.ws.close(); }
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once('exit', resolve); setTimeout(() => { browser.kill(); resolve(); }, 3000).unref(); });
  await new Promise(resolve => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
