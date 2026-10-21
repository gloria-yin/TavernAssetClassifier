import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = resolve(process.env.TAC_TEST_ST_ROOT || fileURLToPath(new URL('../../../../../', import.meta.url)));
const chrome = process.env.TAC_TEST_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!chrome || !existsSync(join(sourceRoot, 'server.js'))) throw new Error('Set TAC_TEST_ST_ROOT and TAC_TEST_CHROME to a SillyTavern source tree and Chromium executable.');

const temporaryRoot = await mkdtemp(join(tmpdir(), 'tac-native-smoke-'));
const nativeRoot = join(temporaryRoot, 'SillyTavern');
let server, browser, client, serverLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + expression + ' ' + JSON.stringify(await evaluate('({status:document.querySelector("#tac-startup-status")?.innerText,errors:window.__nativeErrors})')));
}

try {
  await mkdir(nativeRoot);
  // Copy only application code/default assets. Never copy the installed user's data or config.
  for (const name of ['src', 'public', 'default', 'server.js', 'package.json', 'webpack.config.js']) {
    const excluded = join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party');
    await cp(join(sourceRoot, name), join(nativeRoot, name), { recursive: true, filter: path => path !== excluded });
  }
  await symlink(join(sourceRoot, 'node_modules'), join(nativeRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const userRoot = join(nativeRoot, 'data', 'default-user');
  const extensionRoot = join(userRoot, 'extensions', 'glo_folder');
  await mkdir(extensionRoot, { recursive: true });
  for (const name of ['host.js', 'style.css', 'manifest.json']) await cp(join(pluginRoot, name), join(extensionRoot, name));
  await writeFile(join(extensionRoot, 'index.js'), await readFile(join(pluginRoot, 'index.js'), 'utf8')
    + '\nglobalThis.__tacNative={host,state,getSettings,saveSettings,getThemeRecord,capturePresetBinding,applyPresetBinding,captureUserBinding,applyUserBinding,captureWorldBookBinding,applyWorldBookBinding,saveCurrentCharacterBindings,readSavedWorldBook};\n');
  const settings = JSON.parse(await readFile(join(nativeRoot, 'default', 'content', 'settings.json'), 'utf8'));
  settings.firstRun = false;
  settings.main_api = 'openai';
  await writeFile(join(userRoot, 'settings.json'), JSON.stringify(settings));
  await mkdir(join(userRoot, 'OpenAI Settings'), { recursive: true });
  await cp(join(nativeRoot, 'default', 'content', 'presets', 'openai', 'Default.json'), join(userRoot, 'OpenAI Settings', 'Native smoke second.json'));
  await cp(join(nativeRoot, 'default', 'config.yaml'), join(nativeRoot, 'config.yaml'));

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, ['--preserve-symlinks', 'server.js', '--dataRoot', join(nativeRoot, 'data'), '--port', String(port), '--browserLaunchEnabled', 'false', '--listen', 'false'], { cwd: nativeRoot, windowsHide: true });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  let listening = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Isolated server stopped: ' + serverLog);
    try { if ((await fetch(baseUrl + '/csrf-token')).ok) { listening = true; break; } } catch {}
    await pause(200);
  }
  assert.ok(listening, 'Isolated server did not start: ' + serverLog);
  console.log('PASS native server: isolated application copy and temporary user data');

  const profile = join(temporaryRoot, 'browser');
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let debugPort;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await pause(50); }
  }
  assert.ok(debugPort, 'Chromium did not start');
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  client = new CDP(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await client.call('Page.enable');
  await client.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__nativeErrors=[];addEventListener("error",e=>__nativeErrors.push(e.message));addEventListener("unhandledrejection",e=>__nativeErrors.push(String(e.reason)));' });
  await client.call('Page.navigate', { url: baseUrl });
  await waitFor('window.__tacNative?.state.started && !!document.querySelector("#tac-filter-panel") && !!document.querySelector("#tac-extension-settings")');
  assert.deepEqual(await evaluate('__tacNative.host.moduleErrors'), []);
  assert.equal(await evaluate('document.querySelectorAll("#tac-classifier-style").length'), 1);
  assert.equal(await evaluate('typeof __tacNative.getSettings().files'), 'object');
  console.log('PASS native startup: fresh installation, real modules, styles, classifier controls');

  await evaluate('__tacNative.getThemeRecord(document.querySelector("#themes").value).style=["native-smoke"];__tacNative.saveSettings();');
  await waitFor('(async()=>{const r=await fetch("/api/settings/get",{method:"POST",headers:__tacNative.host.getRequestHeaders(),body:"{}"});const s=JSON.parse((await r.json()).settings);return Object.values(s.extension_settings.tavernAssetClassifier?.files||{}).some(v=>v.style?.includes("native-smoke"));})()');
  await waitFor('__tacNative.host.getContext().characters.length>0');
  await evaluate('__tacNative.host.selectCharacterById(0)');
  await waitFor('__tacNative.host.getContext().characterId!==undefined && !!__tacNative.host.promptManager?.activeCharacter');
  assert.equal(await evaluate('__tacNative.saveCurrentCharacterBindings({users:{items:[__tacNative.captureUserBinding("Native user")]}})'), true);
  const avatar = await evaluate('__tacNative.host.getContext().characters[__tacNative.host.getContext().characterId].avatar');
  assert.equal(JSON.parse(await readFile(join(userRoot, 'settings.json'), 'utf8')).extension_settings.tavernAssetClassifier.files !== undefined, true);
  assert.ok(existsSync(join(userRoot, 'characters', avatar)));
  console.log('PASS native persistence: tags/settings and character-card binding verified through real endpoints');

  await evaluate('window.__nativePreset=__tacNative.capturePresetBinding("Native preset");__nativePreset.promptOrder.reverse();');
  await evaluate(`(async()=>{const select=document.querySelector('#settings_preset_openai');const option=[...select.options].find(o=>o.value!==select.value);if(!option)throw new Error('Two native presets required');await __tacNative.applyPresetBinding({presetName:option.textContent,presetValue:option.value,promptOrder:[]});await __tacNative.applyPresetBinding(__nativePreset);})()`);
  assert.equal(await evaluate('document.querySelector("#settings_preset_openai").selectedOptions[0].textContent.trim()'), await evaluate('__nativePreset.presetName'));
  const savedSettings = JSON.parse(await readFile(join(userRoot, 'settings.json'), 'utf8'));
  const desiredNativeOrder = await evaluate('__nativePreset.promptOrder');
  assert.ok(savedSettings.oai_settings.prompt_order.some(item => JSON.stringify(item.order) === JSON.stringify(desiredNativeOrder)), 'Native prompt order must reach the settings file');
  await evaluate('__tacNative.applyUserBinding(__tacNative.captureUserBinding("Native user"))');
  console.log('PASS native preset/user: real preset completion events, prompt order save and user interfaces');

  const book = { entries: { 0: { uid: 0, content: 'Native world entry', key: ['native'], disable: false } }, metadata: { preserved: true } };
  await evaluate(`(async()=>{await __tacNative.host.saveWorldInfo('TAC native smoke',${JSON.stringify(book)},true);__tacNative.host.updateWorldInfoSettings(structuredClone(__tacNative.host.getWorldInfoSettings()),['TAC native smoke']);await __tacNative.host.updateWorldInfoList();window.__nativeWorld=await __tacNative.captureWorldBookBinding('Native world');await __tacNative.host.saveWorldInfo('TAC native smoke',{entries:{}},true);await __tacNative.applyWorldBookBinding(__nativeWorld,{automatic:true});})()`);
  assert.deepEqual(await evaluate('__tacNative.readSavedWorldBook("TAC native smoke")'), book);
  assert.deepEqual(await evaluate('__nativeErrors'), []);
  console.log('PASS native worldbook: complete JSON restored and verified after a real disk write');
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  if (client) { try { await client.call('Browser.close'); } catch {} client.ws.close(); }
  for (const child of [browser, server]) {
    if (!child || child.exitCode !== null) continue;
    await new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000).unref();
    });
  }
  const relativeTemporary = relative(tmpdir(), temporaryRoot);
  if (!isAbsolute(relativeTemporary) && !relativeTemporary.startsWith('..') && basename(temporaryRoot).startsWith('tac-native-smoke-')) {
    await unlink(join(nativeRoot, 'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else throw new Error('Refusing to clean an unexpected temporary path: ' + temporaryRoot);
}
