const MODULE_PATHS = {
  script: '/script.js',
  extensions: '/scripts/extensions.js',
  backgrounds: '/scripts/backgrounds.js',
  openai: '/scripts/openai.js',
  power: '/scripts/power-user.js',
  world: '/scripts/world-info.js',
  utils: '/scripts/utils.js',
  personas: '/scripts/personas.js',
};

const FUNCTION_MODULES = {
  getRequestHeaders: 'script', getThumbnailUrl: 'script', saveSettingsDebounced: 'script',
  selectCharacterById: 'script', setUserName: 'script', unshallowCharacter: 'script',
  writeExtensionField: 'extensions', getBackgroundPath: 'backgrounds', getThemeObject: 'power',
  charSetAuxWorlds: 'world', getWorldInfoSettings: 'world', loadWorldInfo: 'world',
  saveWorldInfo: 'world', updateWorldInfoList: 'world', updateWorldInfoSettings: 'world',
  getCharaFilename: 'utils', setUserAvatar: 'personas',
};

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createHostAdapter({ getGlobal = () => globalThis, importModule = path => import(path) } = {}) {
  const modules = {};
  const failures = new Map();
  let loading = null;

  function optionalContext() {
    const global = getGlobal();
    const providers = [global.SillyTavern, modules.extensions, modules.script];
    for (const provider of providers) {
      if (typeof provider?.getContext !== 'function') continue;
      try {
        const context = provider.getContext();
        if (context && typeof context === 'object') return context;
      } catch { /* Another host entry may already be usable during startup. */ }
    }
    return null;
  }

  function missing(name) {
    return new Error(`酒馆接口尚未就绪或不可用：${name}。请检查酒馆版本或重试。`);
  }

  function resolveFunction(name) {
    const context = optionalContext();
    if (typeof context?.[name] === 'function') return [context[name], context];
    const module = modules[FUNCTION_MODULES[name]];
    if (typeof module?.[name] === 'function') return [module[name], module];
    if (name === 'setUserAvatar' && typeof modules.script?.setUserAvatar === 'function') {
      return [modules.script.setUserAvatar, modules.script];
    }
    if (name === 'getCharaFilename' && context) {
      return [(id = context.characterId) => context.characters?.[id]?.avatar?.replace(/\.[^/.]+$/, '') ?? null, null];
    }
    return null;
  }

  const adapter = {
    async load() {
      if (loading) return loading;
      loading = Promise.all(Object.entries(MODULE_PATHS).map(async ([key, path]) => {
        if (modules[key]) return;
        try {
          modules[key] = await withTimeout(Promise.resolve().then(() => importModule(path)), 15000, `加载酒馆模块超时：${path}`);
          failures.delete(path);
        } catch (error) {
          failures.set(path, error);
        }
      })).finally(() => { loading = null; });
      return loading;
    },
    getContext() {
      const context = optionalContext();
      if (!context) throw missing('SillyTavern.getContext');
      return context;
    },
    require(names) {
      for (const name of names) if (!resolveFunction(name)) throw missing(name);
    },
    get moduleErrors() {
      return Array.from(failures, ([path, error]) => ({ path, message: String(error?.message || error) }));
    },
    async ready(timeout = 30000) {
      const global = getGlobal();
      const tauriReady = global.__TAURITAVERN__?.ready ?? global.__TAURITAVERN_MAIN_READY__;
      if (tauriReady) await withTimeout(tauriReady, timeout, 'TT 宿主初始化超时，请重试。');
      const context = adapter.getContext();
      if (!(context.extensionSettings ?? context.extension_settings)) throw missing('extensionSettings');
      if (modules.script?.settingsReady === true) return;
      const source = adapter.eventSource, type = adapter.event_types.APP_READY;
      if (!source?.on || !type) {
        if (modules.script?.settingsReady === false) throw missing('APP_READY');
        return;
      }
      await new Promise((resolve, reject) => {
        let timer;
        const done = () => {
          clearTimeout(timer);
          source.removeListener?.(type, done);
          resolve();
        };
        timer = setTimeout(() => {
          source.removeListener?.(type, done);
          reject(new Error('等待酒馆就绪超时，请保持酒馆在前台后重试。'));
        }, timeout);
        source.on(type, done);
      });
    },
    get eventSource() { return optionalContext()?.eventSource ?? modules.script?.eventSource; },
    get event_types() {
      const context = optionalContext();
      return context?.eventTypes ?? context?.event_types ?? modules.script?.event_types ?? {};
    },
    // Keep module namespaces, not snapshots of mutable host exports.
    get main_api() { return optionalContext()?.mainApi ?? modules.script?.main_api ?? 'openai'; },
    get name1() {
      const name = optionalContext()?.name1 ?? modules.script?.name1;
      if (name === undefined) throw missing('name1');
      return name;
    },
    get user_avatar() {
      const context = optionalContext();
      const avatar = modules.personas?.user_avatar ?? modules.script?.user_avatar ?? context?.userAvatar ?? context?.user_avatar;
      if (avatar === undefined) throw missing('user_avatar');
      return avatar;
    },
    get power_user() {
      const power = optionalContext()?.powerUserSettings ?? modules.power?.power_user;
      if (!power) throw missing('power_user');
      return power;
    },
    get background_settings() {
      if (!modules.backgrounds?.background_settings) throw missing('background_settings');
      return modules.backgrounds.background_settings;
    },
    get promptManager() { return modules.openai?.promptManager ?? null; },
    get world_info() {
      const world = modules.world?.world_info ?? modules.world?.getWorldInfoSettings?.().world_info;
      if (!world) throw missing('world_info');
      return world;
    },
    get selected_world_info() {
      const names = modules.world?.selected_world_info ?? modules.world?.getWorldInfoSettings?.().world_info?.globalSelect;
      if (!Array.isArray(names)) throw missing('selected_world_info');
      return names;
    },
  };
  for (const name of Object.keys(FUNCTION_MODULES)) {
    adapter[name] = (...args) => {
      const target = resolveFunction(name);
      if (!target) throw missing(name);
      return Reflect.apply(target[0], target[1], args);
    };
  }
  return adapter;
}

export const host = createHostAdapter();
export const getContext = (...args) => host.getContext(...args);
export const getRequestHeaders = (...args) => host.getRequestHeaders(...args);
export const getThumbnailUrl = (...args) => host.getThumbnailUrl(...args);
export const saveSettingsDebounced = (...args) => host.saveSettingsDebounced(...args);
export const selectCharacterById = (...args) => host.selectCharacterById(...args);
export const setUserAvatar = (...args) => host.setUserAvatar(...args);
export const setUserName = (...args) => host.setUserName(...args);
export const unshallowCharacter = (...args) => host.unshallowCharacter(...args);
export const writeExtensionField = (...args) => host.writeExtensionField(...args);
export const getBackgroundPath = (...args) => host.getBackgroundPath(...args);
export const getThemeObject = (...args) => host.getThemeObject(...args);
export const charSetAuxWorlds = (...args) => host.charSetAuxWorlds(...args);
export const getWorldInfoSettings = (...args) => host.getWorldInfoSettings(...args);
export const loadWorldInfo = (...args) => host.loadWorldInfo(...args);
export const saveWorldInfo = (...args) => host.saveWorldInfo(...args);
export const updateWorldInfoList = (...args) => host.updateWorldInfoList(...args);
export const updateWorldInfoSettings = (...args) => host.updateWorldInfoSettings(...args);
export const getCharaFilename = (...args) => host.getCharaFilename(...args);
