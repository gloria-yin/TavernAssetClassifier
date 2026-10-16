import { eventSource, event_types, getRequestHeaders, getThumbnailUrl, name1, saveSettingsDebounced, selectCharacterById, setUserAvatar, setUserName, unshallowCharacter, user_avatar } from '../../../../script.js';
import { getContext, writeExtensionField } from '../../../../scripts/extensions.js';
import { background_settings, getBackgroundPath } from '../../../../scripts/backgrounds.js';
import { promptManager } from '../../../../scripts/openai.js';
import { getThemeObject, power_user } from '../../../../scripts/power-user.js';
import { charSetAuxWorlds, getWorldInfoSettings, loadWorldInfo, saveWorldInfo, selected_world_info, updateWorldInfoList, updateWorldInfoSettings, world_info } from '../../../../scripts/world-info.js';
import { getCharaFilename } from '../../../../scripts/utils.js';

const EXTENSION_KEY = 'tavernAssetClassifier';
const COLOR_TAGS = [
  { name: '黑', color: '#111111', text: '#ffffff' },
  { name: '白', color: '#f7f7f2', text: '#202020' },
  { name: '红', color: '#ef4444', text: '#ffffff' },
  { name: '橙', color: '#f97316', text: '#ffffff' },
  { name: '黄', color: '#eab308', text: '#202020' },
  { name: '绿', color: '#22c55e', text: '#ffffff' },
  { name: '蓝', color: '#3b82f6', text: '#ffffff' },
  { name: '紫', color: '#8b5cf6', text: '#ffffff' },
  { name: '棕', color: '#8b5a2b', text: '#ffffff' },
  { name: '灰', color: '#737373', text: '#ffffff' },
  { name: '粉', color: '#ec4899', text: '#ffffff' },
];
const AVATAR_TAGS = ['大头像', '小头像', '无头像'];
const CATEGORIES = ['style', 'topic', 'color', 'avatar'];

const CATEGORY_LABELS = {
  style: '风格',
  topic: '主题',
  color: '颜色',
  avatar: '头像',
};

const state = {
  selectedFilters: [],
  themeSearchQuery: '',
  autoMetadataScanStarted: false,
  batchThemeImportActive: false,
  sessionImportedThemeValues: [],
  themePickerCleanup: null,
  observer: null,
  themeObserverReleaseTimer: null,
  refreshTimer: null,
  allThemeOptions: [],
  suppressThemeObserver: false,
  themeBackgroundSyncTimer: null,
  themeBackgroundSyncBound: false,
  lastThemeBackgroundSyncName: '',
  characterBindingTimer: null,
  characterBindingRenderTimer: null,
  characterBindingQuery: '',
  characterRelationDeleteMode: false,
  applyingCharacterBinding: false,
  lastAppliedCharacterBindingKey: '',
};

function notify(type, message) {
  const toastr = window.toastr;
  if (toastr?.[type]) {
    toastr[type](message);
    return;
  }
  console[type === 'error' ? 'error' : 'log'](message);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function trapModalEvents(overlay) {
  const eventNames = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu', 'wheel'];
  eventNames.forEach(eventName => {
    overlay.addEventListener(eventName, event => {
      event.stopPropagation();
      if (event.target === overlay) {
        event.preventDefault();
      }
    });
  });
}

function closeModalOverlay(overlay) {
  overlay.remove();
  if (!document.querySelector('#tac-tag-modal, #tac-rename-modal, #tac-binding-modal')) {
    document.body.classList.remove('tac-modal-open');
    document.documentElement.classList.remove('tac-modal-open');
  }
}

function mountModalOverlay(overlay) {
  document.body.classList.add('tac-modal-open');
  document.documentElement.classList.add('tac-modal-open');
  document.documentElement.append(overlay);
}

function getSettings(create = true) {
  const context = getContext();
  const root = context.extensionSettings ?? context.extension_settings;
  if (!root || typeof root !== 'object') return null;
  if (!root[EXTENSION_KEY] && create) {
    root[EXTENSION_KEY] = { files: {} };
  }
  const settings = root[EXTENSION_KEY];
  if (!settings.files || typeof settings.files !== 'object') settings.files = {};
  return settings;
}

function saveSettings() {
  try {
    saveSettingsDebounced();
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to save settings', error);
  }
}

function normalizeTag(value) {
  return String(value ?? '').trim();
}

function uniqueTags(tags) {
  return [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
}

function normalizeThemeNameKey(value) {
  return normalizeTag(value).toLocaleLowerCase('zh-Hans-CN');
}

function getKnownThemeNameKeys() {
  const settings = getSettings(false);
  const names = new Set(Object.keys(settings?.files ?? {}).map(normalizeThemeNameKey).filter(Boolean));
  state.allThemeOptions.forEach(option => {
    [option.value, option.text].map(normalizeThemeNameKey).filter(Boolean).forEach(name => names.add(name));
  });
  return names;
}

function isThemeNameTag(tag, themeNames = getKnownThemeNameKeys()) {
  return themeNames.has(normalizeThemeNameKey(tag));
}

function sanitizeStoredThemeNameTags() {
  const settings = getSettings(false);
  if (!settings?.files) return false;
  const themeNames = getKnownThemeNameKeys();
  let changed = false;

  Object.values(settings.files).forEach(record => {
    if (!record || typeof record !== 'object') return;
    ['style', 'topic'].forEach(category => {
      const current = uniqueTags(record[category]);
      const filtered = current.filter(tag => !isThemeNameTag(tag, themeNames));
      if (filtered.length !== current.length) changed = true;
      record[category] = filtered;
    });
  });

  if (changed) {
    state.selectedFilters = state.selectedFilters.filter(filter => !isThemeNameTag(filter.tag, themeNames));
    saveSettings();
  }
  return changed;
}

function getThemeSelect() {
  return document.querySelector('#themes');
}

function snapshotThemeOptions() {
  const select = getThemeSelect();
  if (!select) return;

  const merged = new Map(state.allThemeOptions.map(option => [option.value, option]));
  Array.from(select.options).forEach(option => {
    const value = String(option.value || option.textContent || '').trim();
    if (!value) return;
    const existing = merged.get(value);
    merged.set(value, {
      value,
      text: String(option.dataset.tacThemeName || existing?.text || option.textContent || value),
    });
  });
  state.allThemeOptions = Array.from(merged.values());
}

function suppressThemeObserverUntilNextTask() {
  state.suppressThemeObserver = true;
  clearTimeout(state.themeObserverReleaseTimer);
  state.themeObserverReleaseTimer = setTimeout(() => {
    state.themeObserverReleaseTimer = null;
    state.suppressThemeObserver = false;
  }, 0);
}

function getThemeNames() {
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  return getOrderedThemeOptions().map(option => option.value).filter(Boolean);
}

function cloneData(value) {
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function dataMatches(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function stringSetsMatch(left, right) {
  const first = uniqueTags(left).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const second = uniqueTags(right).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function makeBindingId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `tac-binding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getCurrentCharacterContext() {
  const context = getContext();
  const id = context.characterId;
  const character = id !== undefined ? context.characters?.[id] : null;
  return { context, id, character };
}

function getCurrentCharacterKey() {
  const { id, character } = getCurrentCharacterContext();
  return character ? `${id}:${character.avatar || character.name || ''}` : '';
}

function normalizeCharacterBindings(bindings = {}) {
  const root = bindings && typeof bindings === 'object' ? bindings : {};
  const presets = root.presets && typeof root.presets === 'object' ? root.presets : {};
  const users = root.users && typeof root.users === 'object' ? root.users : {};
  const worldBooks = root.worldBooks && typeof root.worldBooks === 'object' ? root.worldBooks : {};
  const beautify = root.beautify && typeof root.beautify === 'object' ? root.beautify : {};
  const legacyThemeName = normalizeTag(beautify.themeName);
  const beautifyItems = (Array.isArray(beautify.items) ? beautify.items : [])
    .filter(Boolean)
    .map(item => ({
      id: String(item.id || makeBindingId()),
      themeName: normalizeTag(item.themeName),
      createdAt: normalizeTag(item.createdAt),
    }))
    .filter(item => item.themeName);
  if (!beautifyItems.length && legacyThemeName) {
    beautifyItems.push({ id: 'legacy-beautify', themeName: legacyThemeName, createdAt: normalizeTag(beautify.updatedAt) });
  }
  const uniqueBeautifyItems = Array.from(new Map(beautifyItems.map(item => [normalizeThemeNameKey(item.themeName), item])).values());
  const requestedBeautifyStar = normalizeTag(beautify.starredId) || (legacyThemeName ? 'legacy-beautify' : '');
  return {
    version: 4,
    presets: {
      starredId: normalizeTag(presets.starredId),
      items: Array.isArray(presets.items) ? presets.items.filter(Boolean).map(item => ({
        id: String(item.id || makeBindingId()),
        name: normalizeTag(item.name) || '未命名预设绑定',
        createdAt: normalizeTag(item.createdAt),
        presetName: normalizeTag(item.presetName),
        presetValue: normalizeTag(item.presetValue),
        promptOrder: Array.isArray(item.promptOrder) ? cloneData(item.promptOrder) : [],
        updatedAt: normalizeTag(item.updatedAt),
      })) : [],
    },
    beautify: {
      starredId: uniqueBeautifyItems.some(item => item.id === requestedBeautifyStar) ? requestedBeautifyStar : '',
      items: uniqueBeautifyItems,
    },
    relatedCharacters: Array.from(new Map((Array.isArray(root.relatedCharacters) ? root.relatedCharacters : [])
      .map(item => typeof item === 'string' ? { avatar: item, name: '' } : item)
      .filter(item => item && normalizeTag(item.avatar))
      .map(item => [normalizeTag(item.avatar), {
        avatar: normalizeTag(item.avatar),
        name: normalizeTag(item.name),
      }])).values()),
    users: {
      starredId: normalizeTag(users.starredId),
      items: Array.isArray(users.items) ? users.items.filter(Boolean).map(item => ({
        id: String(item.id || makeBindingId()),
        name: normalizeTag(item.name) || '未命名 user 绑定',
        createdAt: normalizeTag(item.createdAt),
        avatar: normalizeTag(item.avatar),
        userName: normalizeTag(item.userName),
      })) : [],
    },
    worldBooks: {
      starredId: normalizeTag(worldBooks.starredId),
      items: Array.isArray(worldBooks.items) ? worldBooks.items.filter(Boolean).map(item => {
        const books = Array.isArray(item.books) ? item.books.filter(book => book && normalizeTag(book.name)).map(book => ({
          name: normalizeTag(book.name),
          data: book.data && typeof book.data === 'object' ? cloneData(book.data) : { entries: {} },
        })) : [];
        const hasScopedSelection = Array.isArray(item.globalBooks) || item.characterBooks;
        return {
          id: String(item.id || makeBindingId()),
          name: normalizeTag(item.name) || '未命名世界书绑定',
          createdAt: normalizeTag(item.createdAt),
          updatedAt: normalizeTag(item.updatedAt),
          globalBooks: uniqueTags(hasScopedSelection ? item.globalBooks : books.map(book => book.name)),
          characterBooks: {
            primary: normalizeTag(item.characterBooks?.primary),
            additional: uniqueTags(item.characterBooks?.additional),
          },
          preserveCharacterBooks: Boolean(item.preserveCharacterBooks),
          books,
        };
      }) : [],
    },
  };
}

function getCurrentCharacterBindings() {
  const { character } = getCurrentCharacterContext();
  return normalizeCharacterBindings(character?.data?.extensions?.[EXTENSION_KEY]);
}

async function saveCurrentCharacterBindings(bindings) {
  const { id, character } = getCurrentCharacterContext();
  if (id === undefined || !character) {
    notify('info', '请先打开一张角色卡。');
    return false;
  }
  const normalized = normalizeCharacterBindings(bindings);
  try {
    await writeExtensionField(id, EXTENSION_KEY, normalized);
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to save character bindings', error);
    notify('error', '保存角色绑定失败，请检查控制台。');
    return false;
  }
}

function getCharacterLibrary() {
  const context = getContext();
  return (context.characters ?? []).map((character, id) => ({
    id,
    character,
    avatar: normalizeTag(character?.avatar),
    name: normalizeTag(character?.name) || '未命名角色',
  })).filter(item => item.avatar);
}

function findCharacterByAvatar(avatar) {
  const normalized = normalizeTag(avatar);
  return getCharacterLibrary().find(item => item.avatar === normalized) ?? null;
}

async function loadCharacterByAvatar(avatar) {
  const found = findCharacterByAvatar(avatar);
  if (!found) return null;
  await unshallowCharacter(found.id);
  return findCharacterByAvatar(avatar);
}

async function collectCharacterRelationGroup(seedAvatars) {
  const pending = uniqueTags(seedAvatars);
  const visited = new Set();
  while (pending.length) {
    const avatar = pending.shift();
    if (!avatar || visited.has(avatar)) continue;
    visited.add(avatar);
    const found = await loadCharacterByAvatar(avatar);
    if (!found) continue;
    const bindings = normalizeCharacterBindings(found.character?.data?.extensions?.[EXTENSION_KEY]);
    bindings.relatedCharacters.forEach(item => {
      if (!visited.has(item.avatar)) pending.push(item.avatar);
    });
  }
  return Array.from(visited).map(findCharacterByAvatar).filter(Boolean);
}

async function synchronizeCharacterRelationGroup(members) {
  const uniqueMembers = Array.from(new Map(members.filter(Boolean).map(item => [item.avatar, item])).values());
  const references = uniqueMembers.map(item => ({ avatar: item.avatar, name: item.name }));
  for (const member of uniqueMembers) {
    const loaded = await loadCharacterByAvatar(member.avatar);
    if (!loaded) continue;
    const bindings = normalizeCharacterBindings(loaded.character?.data?.extensions?.[EXTENSION_KEY]);
    bindings.relatedCharacters = references.filter(item => item.avatar !== loaded.avatar);
    await writeExtensionField(loaded.id, EXTENSION_KEY, bindings);
  }
}

async function addCharacterToRelationGroup(targetAvatar) {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  if (!currentAvatar || !targetAvatar || currentAvatar === targetAvatar) return false;
  try {
    const group = await collectCharacterRelationGroup([currentAvatar, targetAvatar]);
    await synchronizeCharacterRelationGroup(group);
    notify('success', `角色卡关联集合已更新，共 ${group.length} 张角色卡。`);
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to add character relation', error);
    notify('error', '添加角色卡关联失败，请检查控制台。');
    return false;
  }
}

async function removeCharacterFromRelationGroup(targetAvatar) {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  if (!currentAvatar || !targetAvatar || currentAvatar === targetAvatar) return false;
  try {
    const group = await collectCharacterRelationGroup([currentAvatar]);
    const removed = group.find(item => item.avatar === targetAvatar) || await loadCharacterByAvatar(targetAvatar);
    const remaining = group.filter(item => item.avatar !== targetAvatar);
    await synchronizeCharacterRelationGroup(remaining);
    if (removed) {
      const bindings = normalizeCharacterBindings(removed.character?.data?.extensions?.[EXTENSION_KEY]);
      bindings.relatedCharacters = [];
      await writeExtensionField(removed.id, EXTENSION_KEY, bindings);
    }
    notify('success', '已从关联集合中移除角色卡。');
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to remove character relation', error);
    notify('error', '删除角色卡关联失败，请检查控制台。');
    return false;
  }
}

function getTransferableWorldBookBinding(item) {
  const characterBookNames = new Set(uniqueTags([
    item?.characterBooks?.primary,
    ...(item?.characterBooks?.additional ?? []),
  ]));
  const globalBookNames = new Set(uniqueTags(item?.globalBooks).filter(name => !characterBookNames.has(name)));
  const books = (Array.isArray(item?.books) ? item.books : [])
    .filter(book => globalBookNames.has(normalizeTag(book?.name)))
    .map(book => ({
      name: normalizeTag(book.name),
      data: { entries: cloneData(book?.data?.entries ?? {}) },
    }))
    .filter(book => Object.keys(book.data.entries).length);
  if (!books.length) return null;
  return {
    ...cloneData(item),
    globalBooks: books.map(book => book.name),
    characterBooks: { primary: '', additional: [] },
    preserveCharacterBooks: true,
    books,
  };
}

function getCharacterTransferCounts(bindings) {
  return {
    beautify: bindings.beautify.items.length,
    presets: bindings.presets.items.length,
    worldBooks: bindings.worldBooks.items.reduce((total, item) => {
      const transferable = getTransferableWorldBookBinding(item);
      return total + (transferable?.books ?? []).reduce(
        (count, book) => count + Object.keys(book.data.entries).length,
        0,
      );
    }, 0),
    users: bindings.users.items.length,
  };
}

function getTransferredBindingSignature(type, item) {
  if (type === 'beautify') return normalizeThemeNameKey(item.themeName);
  if (type === 'presets') return JSON.stringify([item.presetName, item.presetValue, item.promptOrder]);
  if (type === 'users') return JSON.stringify([item.avatar, item.userName]);
  return JSON.stringify([item.globalBooks, item.books]);
}

function mergeTransferredBindingBucket(type, sourceBucket, targetBucket, transform = item => cloneData(item)) {
  const existingBySignature = new Map(targetBucket.items.map(item => [getTransferredBindingSignature(type, item), item]));
  const transferred = [];
  let inheritedStarId = '';
  for (const sourceItem of sourceBucket.items) {
    const item = transform(sourceItem);
    if (!item) continue;
    const signature = getTransferredBindingSignature(type, item);
    const existing = existingBySignature.get(signature);
    if (existing) {
      if (sourceBucket.starredId === sourceItem.id) inheritedStarId = existing.id;
      continue;
    }
    item.id = makeBindingId();
    item.createdAt = new Date().toISOString();
    existingBySignature.set(signature, item);
    transferred.push(item);
    if (sourceBucket.starredId === sourceItem.id) inheritedStarId = item.id;
  }
  targetBucket.items = [...transferred, ...targetBucket.items];
  const hasValidTargetStar = targetBucket.items.some(item => item.id === targetBucket.starredId);
  if (!hasValidTargetStar && inheritedStarId) targetBucket.starredId = inheritedStarId;
  return transferred.length;
}

async function transferCharacterBindingContent(sourceAvatar, targetAvatar, selectedTypes) {
  try {
    const source = await loadCharacterByAvatar(sourceAvatar);
    const target = await loadCharacterByAvatar(targetAvatar);
    if (!source || !target) throw new Error('source or target character is missing');
    const sourceBindings = normalizeCharacterBindings(source.character?.data?.extensions?.[EXTENSION_KEY]);
    const targetBindings = normalizeCharacterBindings(target.character?.data?.extensions?.[EXTENSION_KEY]);
    const transferredCounts = {};

    if (selectedTypes.includes('beautify')) {
      transferredCounts.beautify = mergeTransferredBindingBucket(
        'beautify', sourceBindings.beautify, targetBindings.beautify,
      );
    }
    if (selectedTypes.includes('presets')) {
      transferredCounts.presets = mergeTransferredBindingBucket(
        'presets', sourceBindings.presets, targetBindings.presets,
      );
    }
    if (selectedTypes.includes('worldBooks')) {
      transferredCounts.worldBooks = mergeTransferredBindingBucket(
        'worldBooks', sourceBindings.worldBooks, targetBindings.worldBooks, getTransferableWorldBookBinding,
      );
    }
    if (selectedTypes.includes('users')) {
      transferredCounts.users = mergeTransferredBindingBucket(
        'users', sourceBindings.users, targetBindings.users,
      );
    }

    await writeExtensionField(target.id, EXTENSION_KEY, normalizeCharacterBindings(targetBindings));
    scheduleCharacterBindingRender();
    const total = Object.values(transferredCounts).reduce((sum, count) => sum + count, 0);
    notify('success', total ? `已将所选内容转移到“${target.name}”。` : `“${target.name}”中已有相同内容，无需重复转移。`);
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to transfer character bindings', error);
    notify('error', '转移关联角色卡内容失败，请检查控制台。');
    return false;
  }
}

function getCurrentPromptPresetSelect() {
  const preferredSelectors = [
    '#settings_preset_openai',
    '#settings_preset_textgenerationwebui',
    '#settings_preset_novel',
    'select[id*="preset"][id*="openai"]',
    'select[id*="preset"][id*="completion"]',
  ];
  for (const selector of preferredSelectors) {
    const select = document.querySelector(selector);
    const value = String(select?.value || '').trim();
    if (value) return select;
  }
  return null;
}

function getCurrentThemeName() {
  const select = getThemeSelect();
  if (!select) return String(power_user.theme || '').trim();

  const selectedValue = String(select.value || '').trim();
  if (selectedValue && Array.from(select.options).some(option => option.value === selectedValue)) {
    return selectedValue;
  }

  const selectedOptionValue = String(select.selectedOptions?.[0]?.value || '').trim();
  if (selectedOptionValue) return selectedOptionValue;

  return String(select.options?.[0]?.value || power_user.theme || '').trim();
}

function getThemeRecord(name, create = true) {
  const settings = getSettings(create);
  if (!settings || !name) return null;
  if (!settings.files[name] && create) {
    settings.files[name] = { style: [], topic: [], color: [], avatar: [] };
  }
  const record = settings.files[name];
  if (!record) return null;
  record.style = uniqueTags(record.style);
  record.topic = uniqueTags(record.topic);
  record.color = uniqueTags(record.color).filter(tag => COLOR_TAGS.some(item => item.name === tag));
  record.avatar = uniqueTags(record.avatar).filter(tag => AVATAR_TAGS.includes(tag)).slice(0, 1);
  record.autoColorDisabled = Boolean(record.autoColorDisabled);
  record.autoAvatarDisabled = Boolean(record.autoAvatarDisabled);
  record.background = normalizeTag(record.background);
  record.favorite = Boolean(record.favorite);
  return record;
}

function getOrderedThemeOptions() {
  return state.allThemeOptions
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const firstImportIndex = state.sessionImportedThemeValues.indexOf(a.option.value);
      const secondImportIndex = state.sessionImportedThemeValues.indexOf(b.option.value);
      const firstIsImported = firstImportIndex !== -1;
      const secondIsImported = secondImportIndex !== -1;
      if (firstIsImported !== secondIsImported) return firstIsImported ? 1 : -1;
      if (firstIsImported && secondIsImported) return firstImportIndex - secondImportIndex;
      const favoriteDifference = Number(Boolean(getThemeRecordForTheme(b.option.value)?.favorite))
        - Number(Boolean(getThemeRecordForTheme(a.option.value)?.favorite));
      return favoriteDifference || a.index - b.index;
    })
    .map(entry => entry.option);
}

function makeThemePickerTag(category, tag) {
  const chip = document.createElement('span');
  chip.className = `tac-theme-picker-tag tac-theme-picker-tag-${category}`;
  chip.title = `${CATEGORY_LABELS[category]}：${tag}`;
  if (category === 'color') {
    const color = getColorMeta(tag);
    chip.setAttribute('aria-label', chip.title);
    chip.style.setProperty('--tac-picker-color', color?.color || '#888');
    chip.innerHTML = '<span class="tac-theme-picker-color-dot"></span>';
    return chip;
  }
  if (category === 'avatar') {
    chip.innerHTML = '<i class="fa-solid fa-user"></i><span></span>';
  } else {
    chip.innerHTML = '<span></span>';
  }
  chip.querySelector('span:last-child').textContent = tag;
  return chip;
}

function appendThemePickerContent(container, name, fallback = name) {
  const record = getThemeRecordForTheme(name);
  const title = document.createElement('span');
  title.className = 'tac-theme-picker-entry-name';
  if (record?.favorite) {
    const favorite = document.createElement('i');
    favorite.className = 'fa-solid fa-star tac-theme-picker-favorite';
    favorite.title = '已收藏';
    title.append(favorite);
  }
  const titleText = document.createElement('span');
  titleText.textContent = fallback;
  title.append(titleText);

  const tags = document.createElement('span');
  tags.className = 'tac-theme-picker-entry-tags';
  ['color', 'avatar', 'style', 'topic'].forEach(category => {
    uniqueTags(record?.[category]).forEach(tag => tags.append(makeThemePickerTag(category, tag)));
  });
  container.replaceChildren(title, tags);
}

function positionThemePickerMenu(picker) {
  const trigger = picker?.querySelector('.tac-theme-picker-trigger');
  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!trigger || !menu) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
  menu.style.left = `${Math.max(margin, rect.left)}px`;
  menu.style.width = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
  menu.style.maxHeight = `${Math.max(96, openAbove ? spaceAbove - 4 : spaceBelow - 4)}px`;
  menu.style.top = openAbove ? 'auto' : `${rect.bottom + 4}px`;
  menu.style.bottom = openAbove ? `${window.innerHeight - rect.top + 4}px` : 'auto';
}

function setThemePickerOpen(picker, open) {
  const trigger = picker?.querySelector('.tac-theme-picker-trigger');
  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!trigger || !menu) return;
  picker.classList.toggle('is-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (open) positionThemePickerMenu(picker);
}

function renderThemePicker() {
  const picker = document.querySelector('#tac-theme-picker');
  const select = getThemeSelect();
  if (!picker || !select) return;
  const currentValue = getCurrentThemeName();
  const currentOption = state.allThemeOptions.find(item => item.value === currentValue);
  const selection = picker.querySelector('.tac-theme-picker-selection');
  appendThemePickerContent(selection, currentValue, currentOption?.text || currentValue || '选择美化');

  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const visibleValues = Array.from(select.options).map(option => option.value).filter(Boolean);
  visibleValues.forEach(value => {
    const source = state.allThemeOptions.find(item => item.value === value);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `tac-theme-picker-item${value === currentValue ? ' is-selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(value === currentValue));
    const content = document.createElement('span');
    content.className = 'tac-theme-picker-entry';
    appendThemePickerContent(content, value, source?.text || value);
    const check = document.createElement('i');
    check.className = 'fa-solid fa-check tac-theme-picker-check';
    item.append(content, check);
    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      selectTheme(value, { preserveSettingsDrawer: true });
      setThemePickerOpen(picker, false);
      renderThemePicker();
    });
    menu.append(item);
  });
  if (!visibleValues.length) {
    const empty = document.createElement('div');
    empty.className = 'tac-theme-picker-empty';
    empty.textContent = '没有匹配的美化。';
    menu.append(empty);
  }
}

function mountThemePicker(themeRow) {
  const select = getThemeSelect();
  if (!select || document.querySelector('#tac-theme-picker')) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  sanitizeStoredThemeNameTags();
  const picker = document.createElement('div');
  picker.id = 'tac-theme-picker';
  picker.className = 'tac-theme-picker';
  picker.innerHTML = `
    <button type="button" class="tac-theme-picker-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="tac-theme-picker-selection"></span>
      <i class="fa-solid fa-chevron-down tac-theme-picker-chevron"></i>
    </button>
  `;
  const menu = document.createElement('div');
  menu.id = 'tac-theme-picker-menu';
  menu.className = 'tac-theme-picker-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  select.classList.add('tac-native-theme-select');
  themeRow.classList.add('tac-theme-picker-row');
  select.before(picker);
  document.documentElement.append(menu);

  ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click'].forEach(eventName => {
    menu.addEventListener(eventName, event => event.stopPropagation());
  });

  picker.querySelector('.tac-theme-picker-trigger').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setThemePickerOpen(picker, !picker.classList.contains('is-open'));
  });
  const closeOnOutsidePointer = event => {
    if (!picker.contains(event.target) && !menu.contains(event.target)) setThemePickerOpen(picker, false);
  };
  const closeOnEscape = event => {
    if (event.key === 'Escape') setThemePickerOpen(picker, false);
  };
  const closeOnViewportChange = () => setThemePickerOpen(picker, false);
  document.addEventListener('pointerdown', closeOnOutsidePointer);
  document.addEventListener('keydown', closeOnEscape);
  window.addEventListener('resize', closeOnViewportChange);
  state.themePickerCleanup = () => {
    document.removeEventListener('pointerdown', closeOnOutsidePointer);
    document.removeEventListener('keydown', closeOnEscape);
    window.removeEventListener('resize', closeOnViewportChange);
  };
  renderThemePicker();
}

function pruneMissingThemeRecords() {
  // Keep saved labels even if SillyTavern temporarily rebuilds or filters the
  // native theme dropdown. Rendering only reads records for existing themes, so
  // stale records stay hidden without risking accidental label loss.
}

function getColorMeta(name) {
  return COLOR_TAGS.find(item => item.name === name);
}

function parseCssColor(value) {
  const normalized = normalizeTag(value);
  const rgba = normalized.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgba) {
    return {
      red: Math.min(255, Number(rgba[1])),
      green: Math.min(255, Number(rgba[2])),
      blue: Math.min(255, Number(rgba[3])),
      alpha: rgba[4] === undefined ? 1 : Math.min(1, Number(rgba[4])),
    };
  }
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (!hex) return null;
  const expanded = hex.length === 3 ? hex.split('').map(part => `${part}${part}`).join('') : hex;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function getColorTagFromRgb({ red, green, blue }) {
  const maximum = Math.max(red, green, blue) / 255;
  const minimum = Math.min(red, green, blue) / 255;
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta) {
    if (maximum === red / 255) hue = 60 * (((green - blue) / 255 / delta) % 6);
    else if (maximum === green / 255) hue = 60 * (((blue - red) / 255 / delta) + 2);
    else hue = 60 * (((red - green) / 255 / delta) + 4);
  }
  if (hue < 0) hue += 360;
  if (lightness <= 0.13) return '黑';
  if (lightness >= 0.9 && saturation <= 0.22) return '白';
  if (saturation <= 0.12) return lightness >= 0.78 ? '白' : lightness <= 0.24 ? '黑' : '灰';
  if (hue >= 18 && hue < 52 && lightness < 0.48) return '棕';
  if (hue < 16 || hue >= 345) return '红';
  if (hue < 45) return '橙';
  if (hue < 70) return '黄';
  if (hue < 165) return '绿';
  if (hue < 255) return '蓝';
  if (hue < 300) return '紫';
  return '粉';
}

function inferThemeColorTags(theme) {
  const weightedFields = [
    ['blur_tint_color', 5],
    ['chat_tint_color', 4],
    ['user_mes_blur_tint_color', 3.5],
    ['bot_mes_blur_tint_color', 3.5],
    ['main_text_color', 3],
    ['quote_text_color', 2],
    ['italics_text_color', 1.5],
    ['underline_text_color', 1.5],
    ['border_color', 1],
  ];
  const scores = new Map();
  weightedFields.forEach(([field, weight]) => {
    const color = parseCssColor(theme?.[field]);
    if (!color || color.alpha < 0.15) return;
    const tag = getColorTagFromRgb(color);
    scores.set(tag, (scores.get(tag) || 0) + weight * color.alpha);
  });
  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [];
  const threshold = ranked[0][1] * 0.42;
  return ranked.filter(([, score], index) => index === 0 || score >= threshold).slice(0, 2).map(([tag]) => tag);
}

function resolveCssVariable(value, variables, depth = 0) {
  if (depth > 4) return normalizeTag(value);
  return normalizeTag(value).replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/gi, (_match, name, fallback = '') => {
    const replacement = variables.get(name) || fallback;
    return resolveCssVariable(replacement, variables, depth + 1);
  });
}

function parseCssLength(value, variables) {
  const resolved = resolveCssVariable(value, variables);
  const match = resolved.match(/^(-?\d*\.?\d+)\s*(px|vw|vh|vmin|vmax|cqw|cqh|rem|em|%)(?=\s|$|!)/i);
  if (!match) return null;
  return { value: Math.abs(Number(match[1])), unit: match[2].toLowerCase() };
}

function getThemeAvatarRuleParts(theme) {
  const css = String(theme?.custom_css || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!css) return { rules: [], variables: new Map() };
  const variables = new Map();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    variables.set(match[1], normalizeTag(match[2]));
  }

  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalizeTag(match[1].split(/[\r\n]/).pop());
    if (!selector) continue;
    selector.split(',').map(normalizeTag).filter(Boolean).forEach(part => {
      const lower = part.toLowerCase();
      const positiveSelector = part.replace(/:not\(\s*\[\s*is_user\s*=\s*["']true["']\s*\]\s*\)/gi, '');
      const userOnly = /\[\s*is_user\s*=\s*["']true["']\s*\]/i.test(positiveSelector)
        && !/\[\s*is_user\s*=\s*["']false["']\s*\]/i.test(positiveSelector);
      if (userOnly) return;
      const chatScoped = lower.includes('mesavatarwrapper') || lower.includes('#chat') || /\.mes(?:\b|\[)/i.test(part);
      if (!chatScoped) return;
      const avatarIndex = lower.lastIndexOf('.avatar');
      const targetsAvatar = avatarIndex >= 0;
      const avatarSuffix = targetsAvatar ? lower.slice(avatarIndex + '.avatar'.length) : '';
      const targetsAvatarElement = targetsAvatar && !/^\s+(?:img|picture|source)\b/.test(avatarSuffix) && !/^::?/.test(avatarSuffix);
      const targetsWrapper = lower.includes('mesavatarwrapper') && !targetsAvatar && !/::?/.test(lower.slice(lower.lastIndexOf('mesavatarwrapper') + 'mesavatarwrapper'.length));
      if (!targetsAvatarElement && !targetsWrapper) return;
      rules.push({ selector: lower, body: match[2], targetsAvatarElement, targetsWrapper });
    });
  }
  return { rules, variables };
}

function inferThemeAvatarTag(theme) {
  const { rules, variables } = getThemeAvatarRuleParts(theme);
  if (!rules.length) return '';
  let avatarVisibility = null;
  let wrapperVisibility = null;
  let bigScore = 0;
  let smallScore = 0;

  const updateVisibility = (rule, current) => {
    const display = Array.from(rule.body.matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    const visibility = Array.from(rule.body.matchAll(/(?:^|;)\s*visibility\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    const opacity = Array.from(rule.body.matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    if (display) current = /^\s*none\b/i.test(display) ? false : true;
    if (visibility) current = /^\s*(?:hidden|collapse)\b/i.test(visibility) ? false : true;
    if (opacity && Number.parseFloat(opacity) === 0) current = false;
    return current;
  };

  const scoreLength = (length, nestedInWrapper) => {
    if (!length || !Number.isFinite(length.value) || length.value === 0) return;
    const { value, unit } = length;
    if (unit === 'px') {
      if (value >= 140) bigScore += 3;
      else if (value <= 110) smallScore += 2;
      return;
    }
    if (unit === 'rem' || unit === 'em') {
      if (value >= 9) bigScore += 3;
      else if (value <= 7) smallScore += 2;
      return;
    }
    if (['vw', 'vh', 'vmin', 'vmax', 'cqw', 'cqh'].includes(unit)) {
      if (value >= 25) bigScore += 3;
      else if (value <= 21) smallScore += 2;
      return;
    }
    if (unit === '%' && !nestedInWrapper) {
      if (value >= 45) bigScore += 3;
      else if (value <= 25) smallScore += 1;
    }
  };

  rules.forEach(rule => {
    if (rule.targetsAvatarElement) avatarVisibility = updateVisibility(rule, avatarVisibility);
    if (rule.targetsWrapper) wrapperVisibility = updateVisibility(rule, wrapperVisibility);
    const nestedInWrapper = rule.selector.includes('mesavatarwrapper') && rule.targetsAvatarElement;
    for (const match of rule.body.matchAll(/(?:^|;)\s*(?:width|height)\s*:\s*([^;]+)/gi)) {
      if (rule.targetsAvatarElement) scoreLength(parseCssLength(match[1], variables), nestedInWrapper);
      if (rule.targetsWrapper) {
        const length = parseCssLength(match[1], variables);
        if (length && ((length.unit === '%' && length.value <= 25)
          || (['vw', 'vmin', 'cqw'].includes(length.unit) && length.value <= 22)
          || (length.unit === 'px' && length.value <= 120))) smallScore += 1;
      }
    }
  });

  if (avatarVisibility === false || wrapperVisibility === false) return '无头像';
  if (bigScore > smallScore && bigScore >= 3) return '大头像';
  return '小头像';
}

function applyInferredThemeTags(record, theme) {
  let changed = false;
  if (!record.color.length && !record.autoColorDisabled) {
    const colors = inferThemeColorTags(theme);
    if (colors.length) {
      record.color = colors;
      changed = true;
    }
  }
  if (!record.avatar.length && !record.autoAvatarDisabled) {
    const avatar = inferThemeAvatarTag(theme);
    if (avatar) {
      record.avatar = [avatar];
      changed = true;
    }
  }
  return changed;
}

function autoTagCurrentThemeMetadata() {
  const name = getCurrentThemeName();
  const record = getThemeRecord(name);
  if (!record || !applyInferredThemeTags(record, getThemeObject(name))) return false;
  saveSettings();
  return true;
}

async function autoTagAllThemeMetadata() {
  if (state.autoMetadataScanStarted) return;
  state.autoMetadataScanStarted = true;
  try {
    const response = await fetch('/api/settings/get', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`settings failed: ${response.status}`);
    const data = await response.json();
    let changed = 0;
    (Array.isArray(data.themes) ? data.themes : []).forEach(theme => {
      const themeName = normalizeTag(theme?.name);
      const option = state.allThemeOptions.find(item => item.value === themeName || item.text === themeName);
      const record = getThemeRecord(option?.value || themeName);
      if (record && applyInferredThemeTags(record, theme)) changed += 1;
    });
    if (changed) {
      saveSettings();
      scheduleRefresh();
    }
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to auto-tag theme metadata', error);
  }
}

function getTagPool(category) {
  const tags = new Set();
  getThemeNames().forEach(name => {
    const record = getThemeRecordForTheme(name);
    if (!record) return;
    uniqueTags(record[category]).forEach(tag => tags.add(tag));
  });
  return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function getThemeRecordForTheme(name) {
  const settings = getSettings(false);
  if (!settings?.files || !name) return null;
  const exact = getThemeRecord(name, false);
  if (exact) return exact;

  const option = state.allThemeOptions.find(item => item.value === name || item.text === name);
  if (!option) return null;

  if (option.text && settings.files[option.text]) return getThemeRecord(option.text, false);
  if (option.value && settings.files[option.value]) return getThemeRecord(option.value, false);
  return null;
}

function getBackgroundCssUrl(filename) {
  const normalized = normalizeTag(filename);
  return normalized ? `url("${getBackgroundPath(normalized)}")` : '';
}

function getBackgroundDisplayName(filename) {
  const normalized = normalizeTag(filename);
  return normalized.replace(/\.[^.]+$/, '') || normalized;
}

async function getAvailableBackgrounds() {
  try {
    const response = await fetch('/api/backgrounds/all', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`backgrounds failed: ${response.status}`);
    const data = await response.json();
    return (data.images ?? [])
      .map(item => typeof item === 'string' ? item : item?.filename)
      .map(normalizeTag)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to load backgrounds', error);
    return [];
  }
}

function applyBackgroundFile(filename) {
  const normalized = normalizeTag(filename);
  if (!normalized) return false;
  const url = getBackgroundCssUrl(normalized);
  if (!url) return false;
  document.querySelector('#bg1')?.style.setProperty('background-image', url);
  background_settings.name = normalized;
  background_settings.url = url;
  return true;
}

function applyBoundBackgroundForTheme(themeName = getCurrentThemeName()) {
  const record = getThemeRecordForTheme(themeName);
  const background = normalizeTag(record?.background);
  if (!background) return false;
  state.lastThemeBackgroundSyncName = themeName;
  return applyBackgroundFile(background);
}

function syncBoundBackgroundForCurrentTheme(force = false) {
  const themeName = normalizeTag(power_user.theme) || getCurrentThemeName();
  if (!themeName) return;
  if (!force && state.lastThemeBackgroundSyncName === themeName) return;
  const applied = applyBoundBackgroundForTheme(themeName);
  if (!applied) state.lastThemeBackgroundSyncName = themeName;
}

function startThemeBackgroundSync() {
  if (state.themeBackgroundSyncBound) return;
  state.themeBackgroundSyncBound = true;
  eventSource?.on?.(event_types.SETTINGS_UPDATED, syncBoundBackgroundForCurrentTheme);
  state.themeBackgroundSyncTimer = setInterval(() => syncBoundBackgroundForCurrentTheme(), 3000);
}

function stopThemeBackgroundSync() {
  if (state.themeBackgroundSyncTimer) {
    clearInterval(state.themeBackgroundSyncTimer);
    state.themeBackgroundSyncTimer = null;
  }
  if (state.themeBackgroundSyncBound) {
    eventSource?.removeListener?.(event_types.SETTINGS_UPDATED, syncBoundBackgroundForCurrentTheme);
    state.themeBackgroundSyncBound = false;
  }
  state.lastThemeBackgroundSyncName = '';
}

function makeTag(category, tag, active = false, options = {}) {
  const color = category === 'color' ? getColorMeta(tag) : null;
  const avatar = category === 'avatar';
  const compactColor = color && options.compactColor;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tac-tag tac-tag-${category}${active ? ' is-active' : ''}${compactColor ? ' tac-tag-color-compact' : ''}`;
  button.dataset.category = category;
  button.dataset.tag = tag;
  button.title = `${CATEGORY_LABELS[category]}：${tag}`;
  button.setAttribute('aria-label', `${CATEGORY_LABELS[category]}：${tag}`);
  if (color) {
    button.style.setProperty('--tac-tag-bg', color.color);
    button.style.setProperty('--tac-tag-fg', color.text);
  }
  button.innerHTML = `${color ? '<span class="tac-color-dot"></span>' : ''}${avatar ? '<i class="fa-solid fa-user tac-avatar-icon"></i>' : ''}<span></span>`;
  button.querySelector('span:last-child').textContent = compactColor ? '' : tag;
  return button;
}

function requestDeleteTagConfirmation(category, tag) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">删除标签</div>
            <div class="tac-modal-title">从全部美化中删除</div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button danger_button" data-action="confirm">删除</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-confirm-body').textContent = `确定删除“${CATEGORY_LABELS[category]}：${tag}”吗？全部使用这个标签的美化都会移除该标签。`;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

function setAutomaticTaggingDisabled(record, category, disabled) {
  if (category === 'color') record.autoColorDisabled = Boolean(disabled);
  if (category === 'avatar') record.autoAvatarDisabled = Boolean(disabled);
}

function removeThemeTag(record, category, tag) {
  record[category] = uniqueTags(record[category]).filter(item => item !== tag);
  if ((category === 'color' || category === 'avatar') && !record[category].length) {
    setAutomaticTaggingDisabled(record, category, true);
  }
}

function deleteTagFromAllThemes(category, tag) {
  const settings = getSettings(false);
  let removed = 0;
  Object.values(settings?.files ?? {}).forEach(record => {
    if (!record || typeof record !== 'object') return;
    const previous = uniqueTags(record[category]);
    const next = previous.filter(item => item !== tag);
    removed += previous.length - next.length;
    record[category] = next;
    if (next.length !== previous.length && (category === 'color' || category === 'avatar')) {
      setAutomaticTaggingDisabled(record, category, true);
    }
  });
  state.selectedFilters = state.selectedFilters.filter(filter => (
    filter.category !== category || filter.tag !== tag
  ));
  saveSettings();
  scheduleRefresh();
  return removed;
}

async function confirmDeleteTagFromAllThemes(category, tag) {
  if (!await requestDeleteTagConfirmation(category, tag)) return;
  const removed = deleteTagFromAllThemes(category, tag);
  notify(removed ? 'success' : 'info', removed
    ? `已从 ${removed} 个美化中删除“${tag}”标签。`
    : `没有美化正在使用“${tag}”标签。`);
  if (document.querySelector('#tac-tag-modal')) openTagEditor();
}

function enableGlobalTagLongPress(chip, category, tag) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    chip.classList.remove('is-long-pressing');
  };

  chip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cancel();
    startX = event.clientX;
    startY = event.clientY;
    chip.classList.add('is-long-pressing');
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      chip.classList.remove('is-long-pressing');
      navigator.vibrate?.(20);
      void confirmDeleteTagFromAllThemes(category, tag);
    }, 650);
  });
  chip.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
    chip.addEventListener(eventName, cancel);
  });
  chip.addEventListener('contextmenu', event => event.preventDefault());
  chip.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function makeFilterTag(category, tag, active = false) {
  const chip = makeTag(category, tag, active, { compactColor: category === 'color' });
  chip.title = active
    ? `${CATEGORY_LABELS[category]}：${tag}，点击取消筛选`
    : `${CATEGORY_LABELS[category]}：${tag}，点击筛选`;
  chip.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toggleFilter(category, tag);
  });
  return chip;
}

function scheduleRefresh(delay = 0) {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    renderFilterPanel();
  }, delay);
}

function getFilteredThemeNames() {
  const names = getThemeNames();
  const query = normalizeTag(state.themeSearchQuery).toLocaleLowerCase('zh-Hans-CN');
  if (!state.selectedFilters.length && !query) return names;

  return names.filter(name => {
    const record = getThemeRecordForTheme(name);
    if (state.selectedFilters.length && !record) return false;
    const matchesTags = state.selectedFilters.every(filter => uniqueTags(record?.[filter.category]).includes(filter.tag));
    const searchable = [name, ...CATEGORIES.flatMap(category => uniqueTags(record?.[category]))]
      .join(' ')
      .toLocaleLowerCase('zh-Hans-CN');
    return matchesTags && (!query || searchable.includes(query));
  });
}

function applyThemeFilterToSelect() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  if (!state.allThemeOptions.length) return;

  const previousValue = String(select.value || power_user.theme || '').trim();
  const visibleNames = new Set(getFilteredThemeNames());
  const orderedOptions = getOrderedThemeOptions();
  const hasFilter = state.selectedFilters.length || normalizeTag(state.themeSearchQuery);
  let nextOptions = hasFilter
    ? orderedOptions.filter(option => visibleNames.has(option.value))
    : orderedOptions;
  const currentOption = orderedOptions.find(option => option.value === previousValue);
  if (hasFilter && currentOption && !nextOptions.some(option => option.value === previousValue)) {
    nextOptions = [currentOption, ...nextOptions];
  }
  const currentValues = Array.from(select.options).map(option => option.value);
  const nextValues = nextOptions.map(option => option.value);
  const isAlreadyTargetList = currentValues.length === nextValues.length
    && currentValues.every((value, index) => value === nextValues[index]);

  if (isAlreadyTargetList) {
    const labelUpdates = [];
    Array.from(select.options).forEach(option => {
      const source = orderedOptions.find(item => item.value === option.value);
      if (!source) return;
      const sourceName = source.text || source.value;
      const label = sourceName;
      if (option.dataset.tacThemeName !== sourceName || option.textContent !== label) {
        labelUpdates.push({ option, sourceName, label });
      }
    });
    if (!labelUpdates.length) return;
    suppressThemeObserverUntilNextTask();
    labelUpdates.forEach(({ option, sourceName, label }) => {
      option.dataset.tacThemeName = sourceName;
      option.textContent = label;
    });
    return;
  }

  suppressThemeObserverUntilNextTask();
  select.innerHTML = '';
  nextOptions.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value;
    option.dataset.tacThemeName = item.text || item.value;
    option.textContent = item.text || item.value;
    select.append(option);
  });

  if (nextOptions.some(option => option.value === previousValue)) {
    select.value = previousValue;
  }
  try {
    window.jQuery?.(select).trigger('change.select2');
  } catch {
    // Select2 may not be attached.
  }
}

function restoreThemeSelectOptions() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  state.selectedFilters = [];
  state.themeSearchQuery = '';
  applyThemeFilterToSelect();
}

function renderFilterPanel() {
  sanitizeStoredThemeNameTags();
  pruneMissingThemeRecords();
  const panel = document.querySelector('#tac-filter-body');
  if (!panel) return;

  const names = getThemeNames();
  const pools = Object.fromEntries(CATEGORIES.map(category => [category, new Set()]));

  names.forEach(name => {
    const record = getThemeRecordForTheme(name);
    if (!record) return;
    CATEGORIES.forEach(category => {
      uniqueTags(record[category]).forEach(tag => pools[category].add(tag));
    });
  });

  panel.innerHTML = '';
  const search = document.createElement('div');
  search.className = 'tac-theme-search';
  search.innerHTML = `
    <input type="search" class="text_pole tac-theme-search-input" placeholder="搜索美化名称或标签" autocomplete="off">
    <button type="button" class="menu_button tac-theme-search-submit" title="查询"><i class="fa-solid fa-magnifying-glass"></i><span>查询</span></button>
    <button type="button" class="menu_button tac-theme-search-clear" title="清空搜索"><i class="fa-solid fa-xmark"></i><span>清空</span></button>
  `;
  const searchInput = search.querySelector('.tac-theme-search-input');
  searchInput.value = state.themeSearchQuery;
  const submitSearch = () => {
    state.themeSearchQuery = normalizeTag(searchInput.value);
    renderFilterPanel();
  };
  search.querySelector('.tac-theme-search-submit').addEventListener('click', submitSearch);
  search.querySelector('.tac-theme-search-clear').addEventListener('click', () => {
    state.themeSearchQuery = '';
    renderFilterPanel();
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitSearch();
  });
  panel.append(search);

  const activeWrap = document.createElement('div');
  activeWrap.className = 'tac-active-filters';
  const activeHead = document.createElement('div');
  activeHead.className = 'tac-active-head';
  const activeTags = document.createElement('div');
  activeTags.className = 'tac-active-tags';
  const selectedLabel = document.createElement('span');
  selectedLabel.className = 'tac-selected-label';
  selectedLabel.textContent = '当前已选标签：';
  selectedLabel.title = state.selectedFilters.length
    ? state.selectedFilters.map(filter => `${CATEGORY_LABELS[filter.category]}：${filter.tag}`).join('，')
    : '无';
  activeHead.append(selectedLabel);

  if (state.selectedFilters.length) {
    state.selectedFilters.forEach(filter => {
      const chip = makeFilterTag(filter.category, filter.tag, true);
      if (filter.category !== 'color') {
        const text = chip.querySelector('span:last-child');
        if (text) text.textContent = `${CATEGORY_LABELS[filter.category]}：${filter.tag}`;
      }
      activeTags.append(chip);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tac-clear-filters menu_button';
    clear.textContent = '清空';
    clear.addEventListener('click', () => {
      state.selectedFilters = [];
      renderFilterPanel();
      scheduleRefresh();
    });
    activeHead.append(clear);
  } else {
    const empty = document.createElement('span');
    empty.className = 'tac-empty';
    empty.textContent = '无';
    activeTags.append(empty);
  }
  activeWrap.append(activeHead, activeTags);
  panel.append(activeWrap);

  const filterGrid = document.createElement('div');
  filterGrid.className = 'tac-filter-grid';
  for (const category of CATEGORIES) {
    const selectedInCategory = state.selectedFilters
      .filter(item => item.category === category)
      .map(item => item.tag);
    const fixedValues = category === 'avatar' ? AVATAR_TAGS : [];
    const values = uniqueTags([...fixedValues, ...Array.from(pools[category]), ...selectedInCategory])
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    const group = document.createElement('section');
    group.className = 'tac-filter-group';
    const title = document.createElement('div');
    title.className = 'tac-filter-title';
    title.textContent = CATEGORY_LABELS[category];
    const tags = document.createElement('div');
    tags.className = 'tac-filter-tags';

    if (values.length) {
      values.forEach(tag => {
        const active = state.selectedFilters.some(item => item.category === category && item.tag === tag);
        tags.append(makeFilterTag(category, tag, active));
      });
    } else {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '暂无可选标签';
      tags.append(empty);
    }

    group.append(title, tags);
    filterGrid.append(group);
  }
  panel.append(filterGrid);

  applyThemeFilterToSelect();
  renderThemePicker();
}

function renderFilteredThemeList(panel) {
  const matches = getFilteredThemeNames();
  const list = document.createElement('section');
  list.className = 'tac-results-panel';

  const head = document.createElement('div');
  head.className = 'tac-results-head';
  const title = document.createElement('div');
  title.className = 'tac-results-title';
  title.textContent = '筛选后的美化';
  const count = document.createElement('span');
  count.className = 'tac-results-count';
  count.textContent = `${matches.length} 个`;
  head.append(title, count);
  list.append(head);

  const body = document.createElement('div');
  body.className = 'tac-result-list';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'tac-no-matches';
    empty.textContent = '没有可显示的主题。';
    body.append(empty);
    list.append(body);
    panel.append(list);
    return;
  }

  matches.forEach(name => {
    const record = getThemeRecordForTheme(name) ?? { style: [], topic: [], color: [], avatar: [] };
    const item = document.createElement('div');
    item.role = 'button';
    item.tabIndex = 0;
    item.className = 'tac-result-item';
    item.title = '点击应用这个主题';

    const nameEl = document.createElement('span');
    nameEl.className = 'tac-result-name';
    nameEl.textContent = name;

    const tags = document.createElement('span');
    tags.className = 'tac-result-tags';
    for (const category of CATEGORIES) {
      uniqueTags(record[category]).forEach(tag => {
        const active = state.selectedFilters.some(item => item.category === category && item.tag === tag);
        tags.append(makeFilterTag(category, tag, active));
      });
    }

    item.append(nameEl, tags);
    item.addEventListener('click', () => selectTheme(name));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTheme(name);
      }
    });
    body.append(item);
  });

  list.append(body);
  panel.append(list);
}

function toggleFilter(category, tag) {
  const index = state.selectedFilters.findIndex(item => item.category === category && item.tag === tag);
  if (index >= 0) {
    state.selectedFilters.splice(index, 1);
  } else {
    if (category === 'avatar') {
      state.selectedFilters = state.selectedFilters.filter(item => item.category !== 'avatar');
    }
    state.selectedFilters.push({ category, tag });
    notify('info', `已选择标签：${CATEGORY_LABELS[category]}：${tag}`);
  }
  renderFilterPanel();
}

function isUserSettingsDrawerOpen() {
  return document.querySelector('#user-settings-block')?.classList.contains('openDrawer') ?? false;
}

function restoreUserSettingsDrawer() {
  const drawer = document.querySelector('#user-settings-block');
  if (!drawer) return;
  drawer.classList.remove('closedDrawer');
  drawer.classList.add('openDrawer');
  const icon = drawer.parentElement?.querySelector(':scope > .drawer-toggle .drawer-icon');
  icon?.classList.remove('closedIcon');
  icon?.classList.add('openIcon');
}

function selectTheme(name, { preserveSettingsDrawer = isUserSettingsDrawerOpen() } = {}) {
  const select = getThemeSelect();
  if (!select) return;
  select.value = name;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (preserveSettingsDrawer) {
    setTimeout(restoreUserSettingsDrawer, 0);
    setTimeout(restoreUserSettingsDrawer, 80);
  }
}

function openTagEditor() {
  const name = getCurrentThemeName();
  if (!name) {
    notify('info', '请先选择一个主题。');
    return;
  }

  const existing = document.querySelector('#tac-tag-modal');
  if (existing) closeModalOverlay(existing);

  const record = getThemeRecord(name);
  if (!record) {
    notify('error', '无法读取当前主题标签。');
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'tac-tag-modal';
  document.body.classList.add('tac-modal-open');
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">标签设置</div>
          <div class="tac-modal-title"></div>
        </div>
        <div class="tac-modal-head-actions">
          <button type="button" class="menu_button tac-icon-button tac-favorite-button${record.favorite ? ' is-active' : ''}" data-action="favorite" title="收藏美化" aria-pressed="${record.favorite}">
            <i class="fa-${record.favorite ? 'solid' : 'regular'} fa-star"></i>
          </button>
          <button type="button" class="menu_button tac-icon-button" data-action="close" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div class="tac-modal-selected"></div>
      <div class="tac-editor-groups"></div>
      <div class="tac-modal-actions">
        <button type="button" class="menu_button" data-action="apply">确定</button>
      </div>
    </div>
  `;
  overlay.querySelector('.tac-modal-title').textContent = name;
  overlay.addEventListener('click', event => {
    if (event.target.closest('[data-action="favorite"]')) {
      record.favorite = !record.favorite;
      saveSettings();
      const favoriteButton = overlay.querySelector('.tac-favorite-button');
      favoriteButton.classList.toggle('is-active', record.favorite);
      favoriteButton.setAttribute('aria-pressed', String(record.favorite));
      favoriteButton.querySelector('i').className = `fa-${record.favorite ? 'solid' : 'regular'} fa-star`;
      renderFilterPanel();
      return;
    }
    if (event.target.closest('[data-action="close"]')) {
      closeModalOverlay(overlay);
      return;
    }
    if (event.target.closest('[data-action="apply"]')) {
      saveSettings();
      scheduleRefresh();
      refreshSelected();
      closeModalOverlay(overlay);
    }
  });

  const selected = overlay.querySelector('.tac-modal-selected');
  const refreshSelected = () => {
    selected.innerHTML = '';
    const tags = document.createElement('div');
    tags.className = 'tac-editor-selected-tags';
    for (const category of CATEGORIES) {
      uniqueTags(record[category]).forEach(tag => {
        const chip = makeTag(category, tag);
        chip.title = '点击移除；长按可从全部美化中删除';
        enableGlobalTagLongPress(chip, category, tag);
        chip.addEventListener('click', () => {
          removeThemeTag(record, category, tag);
          saveSettings();
          scheduleRefresh();
          refreshSelected();
        });
        const text = chip.querySelector('span:last-child');
        if (text) text.textContent = `${CATEGORY_LABELS[category]}：${tag}`;
        tags.append(chip);
      });
    }
    if (!tags.children.length) {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '当前主题还没有标签。';
      tags.append(empty);
    }
    selected.append(tags);
  };
  refreshSelected();

  const groups = overlay.querySelector('.tac-editor-groups');
  for (const category of CATEGORIES) {
    groups.append(createEditorGroup(category, record, refreshSelected));
  }
  groups.append(createBackgroundBindingGroup(record));

  mountModalOverlay(overlay);
}

function createEditorGroup(category, record, refreshSelected) {
  const group = document.createElement('section');
  group.className = 'tac-editor-group';
  const title = document.createElement('div');
  title.className = 'tac-editor-title';
  title.textContent = CATEGORY_LABELS[category];
  const chips = document.createElement('div');
  chips.className = 'tac-editor-chips';
  const existingTitle = document.createElement('div');
  existingTitle.className = 'tac-editor-existing-title';
  existingTitle.textContent = '已设置标签';
  const input = category === 'color' || category === 'avatar' ? null : document.createElement('input');
  const inputRow = input ? document.createElement('div') : null;
  const addButton = input ? document.createElement('button') : null;
  if (input) {
    input.className = 'text_pole tac-tag-input';
    input.placeholder = '输入标签，回车添加';
    inputRow.className = 'tac-tag-input-row';
    addButton.type = 'button';
    addButton.className = 'menu_button tac-tag-add-button';
    addButton.title = '添加标签';
    addButton.innerHTML = '<i class="fa-solid fa-plus"></i>';
  }
  const suggestions = document.createElement('div');
  suggestions.className = 'tac-tag-suggestions';
  const suggestionsTitle = document.createElement('div');
  suggestionsTitle.className = 'tac-editor-existing-title';
  suggestionsTitle.textContent = '已输入过的标签';
  const suggestionsTags = document.createElement('div');
  suggestionsTags.className = 'tac-editor-chips';

  const refreshChips = () => {
    chips.innerHTML = '';
    uniqueTags(record[category]).forEach(tag => {
      const chip = makeTag(category, tag);
      chip.title = '点击移除；长按可从全部美化中删除';
      enableGlobalTagLongPress(chip, category, tag);
      chip.addEventListener('click', () => {
        removeThemeTag(record, category, tag);
        saveSettings();
        scheduleRefresh();
        refreshSelected?.();
        refreshChips();
        refreshSuggestions();
      });
      chips.append(chip);
    });
  };

  const addTag = tag => {
    const normalized = normalizeTag(tag);
    if (!normalized) return;
    if ((category === 'style' || category === 'topic') && isThemeNameTag(normalized)) {
      notify('info', '美化名称不能作为标签。');
      return;
    }
    record[category] = uniqueTags([...(record[category] ?? []), normalized]);
    saveSettings();
    scheduleRefresh();
    refreshSelected?.();
    refreshChips();
    refreshSuggestions();
  };

  const refreshSuggestions = () => {
    suggestionsTags.innerHTML = '';
    getTagPool(category)
      .filter(tag => !uniqueTags(record[category]).includes(tag))
      .forEach(tag => {
        const chip = makeTag(category, tag);
        chip.title = '点击添加到当前美化；长按可从全部美化中删除';
        enableGlobalTagLongPress(chip, category, tag);
        chip.addEventListener('click', () => addTag(tag));
        suggestionsTags.append(chip);
      });
    suggestions.hidden = !suggestionsTags.children.length;
  };

  const addInputTag = () => {
    const tag = normalizeTag(input.value);
    if (!tag) return;
    addTag(tag);
    input.value = '';
  };

  if (input) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addInputTag();
    });
    addButton.addEventListener('click', addInputTag);
  }

  group.append(title);
  if (input) {
    inputRow.append(input, addButton);
    group.append(inputRow);
  }

  if (category === 'color') {
    const palette = document.createElement('div');
    palette.className = 'tac-color-palette';
    const refreshPalette = () => {
      palette.innerHTML = '';
      COLOR_TAGS.forEach(item => {
        const button = makeTag('color', item.name, uniqueTags(record.color).includes(item.name));
        button.title = '点击切换；长按可从全部美化中移除这个颜色标签';
        enableGlobalTagLongPress(button, 'color', item.name);
        button.addEventListener('click', () => {
          if (uniqueTags(record.color).includes(item.name)) {
            record.color = uniqueTags(record.color).filter(tag => tag !== item.name);
            setAutomaticTaggingDisabled(record, 'color', !record.color.length);
          } else {
            record.color = uniqueTags([...(record.color ?? []), item.name]);
            setAutomaticTaggingDisabled(record, 'color', false);
          }
          saveSettings();
          scheduleRefresh();
          refreshSelected?.();
          refreshChips();
          refreshPalette();
        });
        palette.append(button);
      });
    };
    refreshPalette();
    group.append(palette);
  } else if (category === 'avatar') {
    const palette = document.createElement('div');
    palette.className = 'tac-avatar-palette';
    const refreshPalette = () => {
      palette.innerHTML = '';
      AVATAR_TAGS.forEach(name => {
        const button = makeTag('avatar', name, uniqueTags(record.avatar).includes(name));
        button.title = '点击切换；长按可从全部美化中移除这个头像标签';
        enableGlobalTagLongPress(button, 'avatar', name);
        button.addEventListener('click', () => {
          const removing = uniqueTags(record.avatar).includes(name);
          record.avatar = removing ? [] : [name];
          setAutomaticTaggingDisabled(record, 'avatar', removing);
          saveSettings();
          scheduleRefresh();
          refreshSelected?.();
          refreshChips();
          refreshPalette();
        });
        palette.append(button);
      });
    };
    refreshPalette();
    group.append(palette);
  } else {
    suggestions.append(suggestionsTitle, suggestionsTags);
    group.append(suggestions);
    refreshSuggestions();
  }

  group.append(existingTitle, chips);
  refreshChips();
  return group;
}

function createBackgroundBindingGroup(record) {
  const details = document.createElement('details');
  details.className = 'tac-editor-group tac-background-binding';

  const summary = document.createElement('summary');
  summary.className = 'tac-background-binding-head';

  const title = document.createElement('div');
  title.className = 'tac-editor-title';
  title.innerHTML = '<i class="fa-solid fa-image"></i> 绑定背景';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'menu_button tac-background-clear';
  clear.textContent = '清除绑定';
  clear.addEventListener('click', () => {
    record.background = '';
    saveSettings();
    renderBackgroundList();
  });

  const chevron = document.createElement('i');
  chevron.className = 'fa-solid fa-chevron-down tac-background-chevron';

  const current = document.createElement('div');
  current.className = 'tac-editor-existing-title tac-background-current';

  const list = document.createElement('div');
  list.className = 'tac-background-grid';
  list.innerHTML = '<span class="tac-empty">正在读取背景...</span>';

  const renderBackgroundList = async () => {
    current.textContent = record.background
      ? `当前绑定：${getBackgroundDisplayName(record.background)}`
      : '当前未绑定背景。';
    const backgrounds = await getAvailableBackgrounds();
    list.innerHTML = '';
    if (!backgrounds.length) {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '没有可绑定的背景。';
      list.append(empty);
      return;
    }
    backgrounds.forEach(filename => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `tac-background-item${record.background === filename ? ' is-selected' : ''}`;
      item.title = filename;
      item.innerHTML = `
        <span class="tac-background-thumb"></span>
        <span class="tac-background-name"></span>
      `;
      item.querySelector('.tac-background-thumb').style.backgroundImage = getBackgroundCssUrl(filename);
      item.querySelector('.tac-background-name').textContent = getBackgroundDisplayName(filename);
      item.addEventListener('click', () => {
        record.background = filename;
        saveSettings();
        renderBackgroundList();
      });
      list.append(item);
    });
  };

  clear.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  summary.append(title, clear, chevron);
  details.append(summary, current, list);
  details.addEventListener('toggle', () => {
    if (details.open && !details.dataset.loaded) {
      details.dataset.loaded = '1';
      renderBackgroundList();
    }
  });
  current.textContent = record.background
    ? `当前绑定：${getBackgroundDisplayName(record.background)}`
    : '当前未绑定背景。';
  return details;
}

function requestThemeName(oldName) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-rename-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-rename-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card tac-binding-form-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">重命名主题</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-rename-body">
          <input class="text_pole tac-rename-input" autocomplete="off">
        </div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">确定</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = oldName;
    const input = overlay.querySelector('.tac-rename-input');
    input.value = oldName;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close('');
      if (event.target.closest('[data-action="confirm"]')) close(input.value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') close(input.value);
      if (event.key === 'Escape') close('');
    });

  mountModalOverlay(overlay);
});
}

async function renameCurrentTheme() {
  const oldName = getCurrentThemeName();
  if (!oldName) {
    notify('info', '请先选择一个主题。');
    return;
  }

  const nextName = normalizeTag(await requestThemeName(oldName));
  if (!nextName || nextName === oldName) return;

  if (getThemeNames().includes(nextName)) {
    notify('error', '这个名称已经存在。');
    return;
  }

  try {
    const theme = getThemeObject(nextName);
    const saveResponse = await fetch('/api/themes/save', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify(theme),
    });
    if (!saveResponse.ok) throw new Error(`save failed: ${saveResponse.status}`);

    let oldDeleted = true;
    const deleteResponse = await fetch('/api/themes/delete', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ name: oldName }),
    });
    if (!deleteResponse.ok) {
      oldDeleted = false;
      console.warn(`TavernAssetClassifier: old theme was not deleted: ${deleteResponse.status}`);
    }

    state.allThemeOptions = state.allThemeOptions.filter(option => option.value !== oldName);
    state.allThemeOptions.push({ value: nextName, text: nextName });

    const settings = getSettings();
    if (settings.files[oldName]) {
      settings.files[nextName] = globalThis.structuredClone
        ? globalThis.structuredClone(settings.files[oldName])
        : JSON.parse(JSON.stringify(settings.files[oldName]));
    }
    sanitizeStoredThemeNameTags();
    power_user.theme = nextName;
    saveSettings();
    applyThemeFilterToSelect();
    const select = getThemeSelect();
    if (select) {
      select.value = nextName;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scheduleRefresh();
    notify(
      oldDeleted ? 'success' : 'warning',
      oldDeleted
        ? '主题已重命名。刷新页面后会同步到酒馆原生主题列表缓存。'
        : '已保存为新名称，但旧主题文件没有删除；如果它是内置主题，这是正常的。',
    );
  } catch (error) {
    console.error('TavernAssetClassifier: rename failed', error);
    notify('error', '重命名失败，请检查控制台。');
  }
}


function getCurrentPromptPresetName() {
  const select = getCurrentPromptPresetSelect();
  const selected = select?.selectedOptions?.[0];
  return normalizeTag(selected?.textContent || select?.value);
}

function getCurrentPromptPresetValue() {
  return normalizeTag(getCurrentPromptPresetSelect()?.value);
}

function getPresetBindingDisplayName(binding) {
  const select = getCurrentPromptPresetSelect();
  if (binding?.presetValue && select) {
    const option = Array.from(select.options).find(item => item.value === binding.presetValue);
    if (option) return normalizeTag(option.textContent || option.value);
  }
  return normalizeTag(binding?.presetName || binding?.presetValue || '未知');
}


function getCurrentPromptOrderSnapshot() {
  const manager = promptManager;
  const character = manager?.activeCharacter;
  if (!manager?.getPromptOrderForCharacter || !character) return [];
  return cloneData(manager.getPromptOrderForCharacter(character));
}

function capturePresetBinding(name) {
  return {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    presetName: getCurrentPromptPresetName(),
    presetValue: getCurrentPromptPresetValue(),
    promptOrder: getCurrentPromptOrderSnapshot(),
  };
}

function captureUserBinding(name) {
  return {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    avatar: normalizeTag(user_avatar),
    userName: normalizeTag(name1),
  };
}

function getCurrentCharacterWorldBookSelection() {
  const { id, character } = getCurrentCharacterContext();
  const fileName = character ? getCharaFilename(id) : '';
  const extra = world_info?.charLore?.find(item => item?.name === fileName);
  return {
    fileName: normalizeTag(fileName),
    primary: normalizeTag(character?.data?.extensions?.world),
    additional: uniqueTags(extra?.extraBooks),
  };
}

function getWorldBookBindingSummary(binding) {
  const books = Array.isArray(binding?.books) ? binding.books : [];
  const entryCount = books.reduce((total, book) => total + Object.keys(book?.data?.entries ?? {}).length, 0);
  const globalCount = uniqueTags(binding?.globalBooks).length;
  const characterCount = uniqueTags([
    binding?.characterBooks?.primary,
    ...(binding?.characterBooks?.additional ?? []),
  ]).length;
  const characterSummary = binding?.preserveCharacterBooks ? '角色 保留' : `角色 ${characterCount} 本`;
  return `全局 ${globalCount} 本 · ${characterSummary} · ${entryCount} 条目`;
}

async function captureWorldBookBinding(name) {
  const globalBooks = uniqueTags(selected_world_info);
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const characterBooks = {
    primary: characterSelection.primary,
    additional: characterSelection.additional,
  };
  const bookNames = uniqueTags([globalBooks, characterBooks.primary, characterBooks.additional].flat());
  const books = [];
  for (const bookName of bookNames) {
    const data = await loadWorldInfo(bookName);
    if (!data) throw new Error(`failed to load world book: ${bookName}`);
    books.push({ name: bookName, data: cloneData(data) });
  }
  return {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    globalBooks,
    characterBooks,
    preserveCharacterBooks: false,
    books,
  };
}

async function requestBindingName(title, defaultValue) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">角色绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-rename-body">
          <input class="text_pole tac-rename-input" autocomplete="off">
        </div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">保存</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    const input = overlay.querySelector('.tac-rename-input');
    input.value = defaultValue || '';

    const close = value => {
      closeModalOverlay(overlay);
      resolve(normalizeTag(value));
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close('');
      if (event.target.closest('[data-action="confirm"]')) close(input.value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') close(input.value);
      if (event.key === 'Escape') close('');
    });

    mountModalOverlay(overlay);
    const isMobileViewport = window.matchMedia?.('(max-width: 700px)')?.matches || navigator.maxTouchPoints > 0;
    if (!isMobileViewport) {
      setTimeout(() => input.focus(), 0);
    }
  });
}

async function savePresetBinding() {
  const presetName = getCurrentPromptPresetName();
  if (!presetName) {
    notify('info', '当前没有可保存的预设。');
    return;
  }
  const name = await requestBindingName('预设绑定名称', presetName);
  if (!name) return;
  const bindings = getCurrentCharacterBindings();
  bindings.presets.items.unshift(capturePresetBinding(name));
  if (await saveCurrentCharacterBindings(bindings)) notify('success', '预设绑定已保存到当前角色卡。');
}

async function saveUserBinding() {
  const name = await requestBindingName('user 绑定名称', normalizeTag(name1) || '当前 user');
  if (!name) return;
  const bindings = getCurrentCharacterBindings();
  bindings.users.items.unshift(captureUserBinding(name));
  if (await saveCurrentCharacterBindings(bindings)) notify('success', 'user 绑定已保存到当前角色卡。');
}

async function saveWorldBookBinding() {
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const currentNames = uniqueTags([
    ...selected_world_info,
    characterSelection.primary,
    ...characterSelection.additional,
  ]);
  const defaultName = currentNames.length ? currentNames.join(' + ') : '无世界书';
  const name = await requestBindingName('世界书绑定名称', defaultName);
  if (!name) return;
  try {
    const snapshot = await captureWorldBookBinding(name);
    const bindings = getCurrentCharacterBindings();
    bindings.worldBooks.items.unshift(snapshot);
    if (await saveCurrentCharacterBindings(bindings)) {
      notify('success', `世界书绑定已保存：${getWorldBookBindingSummary(snapshot)}`);
    }
  } catch (error) {
    console.error('TavernAssetClassifier: failed to capture world books', error);
    notify('error', '读取世界书条目失败，未保存绑定。');
  }
}

async function saveBeautifyBinding(themeName = getCurrentThemeName()) {
  const normalized = normalizeTag(themeName);
  if (!normalized) {
    notify('info', '当前没有可绑定的美化。');
    return false;
  }
  const bindings = getCurrentCharacterBindings();
  const exists = bindings.beautify.items.some(item => normalizeThemeNameKey(item.themeName) === normalizeThemeNameKey(normalized));
  if (exists) {
    notify('info', `美化“${normalized}”已经添加。`);
    return false;
  }
  bindings.beautify.items.unshift({
    id: makeBindingId(),
    themeName: normalized,
    createdAt: new Date().toISOString(),
  });
  const saved = await saveCurrentCharacterBindings(bindings);
  if (saved) notify('success', `已添加美化：${normalized}`);
  return saved;
}

function requestCharacterRelationConfirmation(title, message, confirmLabel) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);
    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">角色卡关联</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm"></button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    overlay.querySelector('.tac-confirm-body').textContent = message;
    overlay.querySelector('[data-action="confirm"]').textContent = confirmLabel;
    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

async function switchToRelatedCharacter(avatar, fallbackName = '') {
  const target = findCharacterByAvatar(avatar);
  if (!target) {
    notify('warning', `找不到角色卡：${fallbackName || avatar}`);
    return;
  }
  const confirmed = await requestCharacterRelationConfirmation(
    '切换角色卡',
    `确定转到“${target.name}”的角色卡界面吗？`,
    '确认前往',
  );
  if (!confirmed) return;
  const latest = findCharacterByAvatar(avatar);
  if (latest) await selectCharacterById(latest.id);
}

async function confirmRemoveRelatedCharacter(avatar, fallbackName = '') {
  const target = findCharacterByAvatar(avatar);
  const name = target?.name || fallbackName || avatar;
  const confirmed = await requestCharacterRelationConfirmation(
    '删除角色卡关联',
    `确定将“${name}”移出当前关联集合吗？剩余角色卡仍会保持互联。`,
    '确认删除',
  );
  if (confirmed) await removeCharacterFromRelationGroup(avatar);
}

function openCharacterTransferModal(sourceAvatar, targetAvatar, fallbackName = '') {
  const source = findCharacterByAvatar(sourceAvatar);
  const target = findCharacterByAvatar(targetAvatar);
  if (!source || !target) {
    notify('warning', `找不到角色卡：${fallbackName || targetAvatar}`);
    return;
  }
  const sourceBindings = normalizeCharacterBindings(source.character?.data?.extensions?.[EXTENSION_KEY]);
  const counts = getCharacterTransferCounts(sourceBindings);
  const options = [
    { type: 'beautify', icon: 'fa-palette', label: '美化', detail: '复制已添加的美化', unit: '项' },
    { type: 'presets', icon: 'fa-sliders', label: '预设', detail: '复制预设与条目顺序', unit: '项' },
    { type: 'worldBooks', icon: 'fa-book-atlas', label: '世界书', detail: '仅复制非角色绑定世界书的条目', unit: '条' },
    { type: 'users', icon: 'fa-user', label: 'user 信息', detail: '复制 user 名称与头像绑定', unit: '项' },
  ];

  const existing = document.querySelector('#tac-binding-modal');
  if (existing) closeModalOverlay(existing);
  const overlay = document.createElement('div');
  overlay.id = 'tac-binding-modal';
  overlay.className = 'tac-character-transfer-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card tac-character-transfer-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">角色卡关联已添加</div>
          <div class="tac-modal-title">转移内容到 <span></span></div>
        </div>
        <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tac-character-transfer-body">
        <p>选择要复制到关联角色卡的内容。目标卡已有内容会保留，相同内容不会重复添加。</p>
        <div class="tac-character-transfer-grid"></div>
      </div>
      <div class="tac-modal-actions">
        <button type="button" class="menu_button" data-action="cancel">暂不转移</button>
        <button type="button" class="menu_button" data-action="confirm" disabled>转移所选</button>
      </div>
    </div>
  `;
  overlay.querySelector('.tac-modal-title span').textContent = target.name;
  const grid = overlay.querySelector('.tac-character-transfer-grid');
  options.forEach(option => {
    const count = counts[option.type];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tac-character-transfer-option';
    button.dataset.transferType = option.type;
    button.disabled = !count;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `
      <span class="tac-character-transfer-icon"><i class="fa-solid ${option.icon}"></i></span>
      <span class="tac-character-transfer-copy">
        <strong></strong>
        <small></small>
      </span>
      <span class="tac-character-transfer-count"></span>
      <i class="fa-solid fa-check tac-character-transfer-check"></i>
    `;
    button.querySelector('strong').textContent = option.label;
    button.querySelector('small').textContent = count ? option.detail : '当前角色卡没有可转移内容';
    button.querySelector('.tac-character-transfer-count').textContent = `${count} ${option.unit}`;
    grid.append(button);
  });

  const selected = new Set();
  const confirm = overlay.querySelector('[data-action="confirm"]');
  grid.addEventListener('click', event => {
    const button = event.target.closest('.tac-character-transfer-option');
    if (!button || button.disabled) return;
    const type = button.dataset.transferType;
    if (selected.has(type)) selected.delete(type);
    else selected.add(type);
    const active = selected.has(type);
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
    confirm.disabled = !selected.size;
  });
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-action="cancel"]')) {
      closeModalOverlay(overlay);
      return;
    }
    if (!event.target.closest('[data-action="confirm"]') || !selected.size) return;
    confirm.disabled = true;
    confirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>转移中</span>';
    const transferred = await transferCharacterBindingContent(sourceAvatar, targetAvatar, Array.from(selected));
    if (transferred) closeModalOverlay(overlay);
    else {
      confirm.disabled = false;
      confirm.textContent = '重试转移';
    }
  });
  mountModalOverlay(overlay);
}

function openCharacterLibraryPicker() {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  const linked = new Set(getCurrentCharacterBindings().relatedCharacters.map(item => item.avatar));
  const candidates = getCharacterLibrary()
    .filter(item => item.avatar !== currentAvatar && !linked.has(item.avatar))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  if (!candidates.length) {
    notify('info', '角色卡库中没有可添加的角色卡。');
    return;
  }

  const existing = document.querySelector('#tac-binding-modal');
  if (existing) closeModalOverlay(existing);
  const overlay = document.createElement('div');
  overlay.id = 'tac-binding-modal';
  overlay.className = 'tac-character-library-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card tac-character-library-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">角色卡关联</div>
          <div class="tac-modal-title">从角色卡库添加</div>
        </div>
        <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tac-character-library-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="search" class="text_pole" placeholder="搜索角色名称" autocomplete="off">
      </div>
      <div class="tac-character-library-grid"></div>
      <div class="tac-character-library-empty" hidden>没有匹配的角色卡。</div>
    </div>
  `;
  const grid = overlay.querySelector('.tac-character-library-grid');
  const empty = overlay.querySelector('.tac-character-library-empty');
  candidates.forEach(candidate => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tac-character-library-item';
    button.dataset.searchText = `${candidate.name} ${candidate.avatar}`.toLocaleLowerCase('zh-Hans-CN');
    button.innerHTML = '<img alt=""><span></span>';
    button.querySelector('img').src = getThumbnailUrl('avatar', candidate.avatar);
    button.querySelector('img').alt = candidate.name;
    button.querySelector('span').textContent = candidate.name;
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (await addCharacterToRelationGroup(candidate.avatar)) {
        closeModalOverlay(overlay);
        openCharacterTransferModal(currentAvatar, candidate.avatar, candidate.name);
      } else button.disabled = false;
    });
    grid.append(button);
  });
  const searchInput = overlay.querySelector('input');
  searchInput.addEventListener('input', () => {
    const query = normalizeTag(searchInput.value).toLocaleLowerCase('zh-Hans-CN');
    const items = Array.from(grid.children);
    items.forEach(item => item.hidden = Boolean(query) && !item.dataset.searchText.includes(query));
    empty.hidden = items.some(item => !item.hidden);
  });
  overlay.addEventListener('click', event => {
    if (event.target.closest('[data-action="cancel"]')) closeModalOverlay(overlay);
  });
  mountModalOverlay(overlay);
}

async function applyPresetBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const select = getCurrentPromptPresetSelect();
  const matchedOption = select ? Array.from(select.options).find(option => (
    (binding.presetValue && option.value === binding.presetValue)
      || (binding.presetName && normalizeTag(option.textContent) === binding.presetName)
      || (binding.presetName && option.value === binding.presetName)
  )) : null;
  const presetNeedsChange = Boolean(matchedOption && select?.value !== matchedOption.value);
  const promptOrderNeedsChange = Boolean(
    Array.isArray(binding.promptOrder)
      && binding.promptOrder.length
      && !dataMatches(getCurrentPromptOrderSnapshot(), binding.promptOrder),
  );
  if (presetNeedsChange) {
    select.value = matchedOption.value;
    const jquery = window.jQuery || window.$;
    if (jquery) {
      jquery(select).trigger('change');
    } else {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  } else if (!matchedOption && (binding.presetName || binding.presetValue) && !automatic) {
    notify('warning', `找不到预设：${getPresetBindingDisplayName(binding)}`);
  }

  const manager = promptManager;
  const character = manager?.activeCharacter;
  if (promptOrderNeedsChange && character && manager?.removePromptOrderForCharacter && manager?.addPromptOrderForCharacter) {
    manager.removePromptOrderForCharacter(character);
    manager.addPromptOrderForCharacter(character, cloneData(binding.promptOrder));
    manager.saveServiceSettings?.();
    manager.render?.(false);
  }

  const changed = presetNeedsChange || promptOrderNeedsChange;
  if (!automatic) notify('success', changed ? `已应用预设绑定：${binding.name}` : '当前预设和条目顺序已经一致。');
  return changed;
}

async function applyUserBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const avatarNeedsChange = Boolean(binding.avatar && binding.avatar !== normalizeTag(user_avatar));
  const nameNeedsChange = Boolean(binding.userName && binding.userName !== normalizeTag(name1));
  if (avatarNeedsChange && power_user.personas?.[binding.avatar]) {
    await setUserAvatar(binding.avatar, { toastPersonaNameChange: !automatic, navigateToCurrent: false });
  } else if (avatarNeedsChange && !automatic) {
    notify('warning', `找不到 user 头像：${binding.avatar}`);
  }
  if (nameNeedsChange) {
    setUserName(binding.userName, { toastPersonaNameChange: !automatic });
  }
  const changed = (avatarNeedsChange && Boolean(power_user.personas?.[binding.avatar])) || nameNeedsChange;
  if (!automatic) notify('success', changed ? `已应用 user 绑定：${binding.name}` : '当前 user 已与绑定一致。');
  return changed;
}

function applyBeautifyBinding(themeName, { automatic = false } = {}) {
  const normalized = normalizeTag(themeName);
  if (!normalized) return false;
  if (!getThemeNames().includes(normalized)) {
    if (!automatic) notify('warning', `找不到美化：${normalized}`);
    return false;
  }
  if (normalizeTag(power_user.theme || getCurrentThemeName()) === normalized) {
    if (!automatic) notify('success', '当前美化已与绑定一致。');
    return false;
  }
  selectTheme(normalized);
  if (!automatic) notify('success', `已应用角色卡美化：${normalized}`);
  return true;
}

async function applyWorldBookBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const books = Array.isArray(binding.books) ? binding.books : [];
  const targetGlobalBooks = uniqueTags(binding.globalBooks ?? books.map(book => book.name));
  let contentChanged = false;

  try {
    for (const book of books) {
      const current = await loadWorldInfo(book.name);
      if (dataMatches(current, book.data)) continue;
      await saveWorldInfo(book.name, cloneData(book.data), true);
      contentChanged = true;
    }

    const globalSelectionChanged = !stringSetsMatch(selected_world_info, targetGlobalBooks);
    if (globalSelectionChanged) {
      updateWorldInfoSettings(cloneData(getWorldInfoSettings()), targetGlobalBooks);
    }
    if (contentChanged || globalSelectionChanged) {
      await updateWorldInfoList();
    }

    const { id, character } = getCurrentCharacterContext();
    const currentCharacterBooks = getCurrentCharacterWorldBookSelection();
    const targetPrimary = binding.preserveCharacterBooks
      ? currentCharacterBooks.primary
      : normalizeTag(binding.characterBooks?.primary);
    const targetAdditional = binding.preserveCharacterBooks
      ? currentCharacterBooks.additional
      : uniqueTags(binding.characterBooks?.additional);
    const primaryChanged = Boolean(character) && currentCharacterBooks.primary !== targetPrimary;
    const additionalChanged = Boolean(character)
      && !stringSetsMatch(currentCharacterBooks.additional, targetAdditional);
    if (primaryChanged) await writeExtensionField(id, 'world', targetPrimary);
    if (additionalChanged) charSetAuxWorlds(currentCharacterBooks.fileName, targetAdditional);

    const changed = contentChanged || globalSelectionChanged || primaryChanged || additionalChanged;
    if (!automatic) notify('success', changed ? `已应用世界书绑定：${binding.name}` : '当前世界书及条目已经一致。');
    return changed;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to apply world books', error);
    if (!automatic) notify('error', '应用世界书绑定失败，请检查控制台。');
    return false;
  }
}

async function deleteCharacterBinding(type, id) {
  const bindings = getCurrentCharacterBindings();
  const bucket = bindings[type];
  if (!bucket?.items) return;
  const item = bucket.items.find(entry => entry.id === id);
  const confirmed = await requestDeleteBindingConfirmation(type, item?.name || item?.themeName || '');
  if (!confirmed) return;
  bucket.items = bucket.items.filter(item => item.id !== id);
  if (bucket.starredId === id) bucket.starredId = '';
  await saveCurrentCharacterBindings(bindings);
}

function requestDeleteBindingConfirmation(type, name) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">删除绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button danger_button" data-action="confirm">删除</button>
        </div>
      </div>
    `;
    const titles = { beautify: '删除美化绑定', presets: '删除预设绑定', users: '删除 user 绑定', worldBooks: '删除世界书绑定' };
    overlay.querySelector('.tac-modal-title').textContent = titles[type] || '删除绑定';
    overlay.querySelector('.tac-confirm-body').textContent = name ? `确定删除“${name}”？` : '确定删除这条绑定？';

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

function requestUpdateBindingConfirmation(title, message) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">更新绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">确认更新</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    overlay.querySelector('.tac-confirm-body').textContent = message;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

async function updatePresetBinding(id) {
  const presetName = getCurrentPromptPresetName();
  if (!presetName) {
    notify('info', '当前没有可用于更新的预设。');
    return;
  }
  const bindings = getCurrentCharacterBindings();
  const item = bindings.presets.items.find(binding => binding.id === id);
  if (!item) return;
  if (!await requestUpdateBindingConfirmation('更新预设绑定', `将“${item.name}”更新为当前预设“${presetName}”，是否继续？`)) return;

  const snapshot = capturePresetBinding(item.name);
  Object.assign(item, snapshot, {
    id: item.id,
    name: item.name,
    createdAt: item.createdAt || snapshot.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (await saveCurrentCharacterBindings(bindings)) {
    notify('success', `已用当前预设更新绑定：${item.name}`);
  }
}

async function updateWorldBookBinding(id) {
  const bindings = getCurrentCharacterBindings();
  const item = bindings.worldBooks.items.find(binding => binding.id === id);
  if (!item) return;
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const currentNames = uniqueTags([
    ...selected_world_info,
    characterSelection.primary,
    ...characterSelection.additional,
  ]);
  const description = currentNames.length ? currentNames.join('、') : '无世界书';
  if (!await requestUpdateBindingConfirmation('更新世界书绑定', `将“${item.name}”更新为当前启用及角色挂载的世界书（${description}）和全部条目，是否继续？`)) return;

  try {
    const snapshot = await captureWorldBookBinding(item.name);
    Object.assign(item, snapshot, {
      id: item.id,
      name: item.name,
      createdAt: item.createdAt || snapshot.createdAt,
      updatedAt: new Date().toISOString(),
    });
    if (await saveCurrentCharacterBindings(bindings)) {
      notify('success', `已更新世界书绑定：${getWorldBookBindingSummary(item)}`);
    }
  } catch (error) {
    console.error('TavernAssetClassifier: failed to update world books', error);
    notify('error', '读取世界书条目失败，未更新绑定。');
  }
}

async function starCharacterBinding(type, id) {
  const bindings = getCurrentCharacterBindings();
  const bucket = bindings[type];
  if (!bucket) return;
  bucket.starredId = bucket.starredId === id ? '' : id;
  await saveCurrentCharacterBindings(bindings);
}

async function applyStarredCharacterBindings() {
  if (state.applyingCharacterBinding) return;
  const key = getCurrentCharacterKey();
  if (!key || state.lastAppliedCharacterBindingKey === key) return;
  state.applyingCharacterBinding = true;
  state.lastAppliedCharacterBindingKey = key;
  try {
    const bindings = getCurrentCharacterBindings();
    const beautify = bindings.beautify.items.find(item => item.id === bindings.beautify.starredId);
    if (beautify) {
      applyBeautifyBinding(beautify.themeName, { automatic: true });
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const preset = bindings.presets.items.find(item => item.id === bindings.presets.starredId);
    if (preset) await applyPresetBinding(preset, { automatic: true });
    const user = bindings.users.items.find(item => item.id === bindings.users.starredId);
    if (user) await applyUserBinding(user, { automatic: true });
    const worldBooks = bindings.worldBooks.items.find(item => item.id === bindings.worldBooks.starredId);
    if (worldBooks) await applyWorldBookBinding(worldBooks, { automatic: true });
  } finally {
    state.applyingCharacterBinding = false;
    scheduleCharacterBindingRender();
  }
}

function scheduleCharacterBindingApply(delay = 500) {
  clearTimeout(state.characterBindingTimer);
  state.characterBindingTimer = setTimeout(() => {
    state.characterBindingTimer = null;
    applyStarredCharacterBindings();
  }, delay);
}

function scheduleCharacterBindingRender(delay = 80) {
  clearTimeout(state.characterBindingRenderTimer);
  state.characterBindingRenderTimer = setTimeout(() => {
    state.characterBindingRenderTimer = null;
    renderCharacterBindingPanel();
  }, delay);
}




function waitForThemeImportInputReset(input, timeout = 300000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!input.files?.length || Date.now() - startedAt >= timeout) {
        clearInterval(timer);
        resolve(!input.files?.length);
      }
    }, 50);
  });
}

async function importThemeFilesSequentially(input, files) {
  if (typeof DataTransfer !== 'function') {
    notify('error', '当前浏览器不支持批量传递文件，请升级浏览器后重试。');
    return;
  }

  let imported = 0;
  let skipped = 0;
  let firstImportedTheme = '';
  let metadataChanged = false;
  state.batchThemeImportActive = true;
  try {
    for (const file of files) {
      let themeName = '';
      let parsedTheme = null;
      try {
        parsedTheme = JSON.parse(await file.text());
        themeName = normalizeTag(parsedTheme?.name);
        if (!themeName) throw new Error('missing theme name');
      } catch (error) {
        console.warn('TavernAssetClassifier: invalid theme file', file.name, error);
        skipped += 1;
        continue;
      }

      if (state.allThemeOptions.some(option => option.value === themeName || option.text === themeName)
        || Array.from(getThemeSelect()?.options ?? []).some(option => option.value === themeName)) {
        skipped += 1;
        continue;
      }

      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        const reset = waitForThemeImportInputReset(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (!await reset) throw new Error('theme import timed out');
        const exists = state.allThemeOptions.some(option => option.value === themeName || option.text === themeName)
          || Array.from(getThemeSelect()?.options ?? []).some(option => option.value === themeName);
        if (exists) {
          imported += 1;
          firstImportedTheme ||= themeName;
          if (!state.sessionImportedThemeValues.includes(themeName)) {
            state.sessionImportedThemeValues.push(themeName);
          }
          const record = getThemeRecord(themeName);
          if (record && applyInferredThemeTags(record, parsedTheme)) metadataChanged = true;
        } else {
          skipped += 1;
        }
      } catch (error) {
        console.warn('TavernAssetClassifier: failed to import theme file', file.name, error);
        skipped += 1;
        input.value = '';
      }
    }
  } finally {
    state.batchThemeImportActive = false;
    input.value = '';
  }

  if (metadataChanged) saveSettings();
  if (firstImportedTheme) {
    selectTheme(firstImportedTheme, { preserveSettingsDrawer: true });
    renderThemePicker();
    scheduleRefresh();
  }
  notify(imported ? 'success' : 'warning', `批量导入完成：成功 ${imported} 个${skipped ? `，跳过 ${skipped} 个` : ''}。`);
}

function enableBatchThemeImport() {
  const input = document.querySelector('#ui_preset_import_file');
  if (!input || input.dataset.tacBatchImport === '1') return;
  input.multiple = true;
  input.dataset.tacBatchImport = '1';
  input.addEventListener('change', event => {
    const files = Array.from(input.files ?? []);
    if (files.length <= 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    void importThemeFilesSequentially(input, files);
  }, true);
}

function mountUi() {
  const themeBlock = document.querySelector('#UI-presets-block');
  const themeRow = document.querySelector('#themes')?.closest('.flex-container');
  if (!themeBlock || !themeRow) return false;
  mountThemePicker(themeRow);
  enableBatchThemeImport();
  if (document.querySelector('#tac-filter-panel')) return true;

  const actions = document.createElement('div');
  actions.id = 'tac-theme-actions';
  actions.addEventListener('click', event => event.stopPropagation());

  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (updateButton) {
    updateButton.title = '覆盖保存当前美化';
    updateButton.setAttribute('aria-label', '覆盖保存当前美化');
    actions.append(updateButton);
  }
  if (saveButton) {
    saveButton.title = '另存为新美化';
    saveButton.setAttribute('aria-label', '另存为新美化');
    actions.append(saveButton);
  }

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.id = 'tac-theme-rename-button';
  rename.className = 'menu_button margin0';
  rename.title = '重命名当前主题';
  rename.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
  rename.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void renameCurrentTheme();
  });
  actions.append(rename);

  const setButton = document.createElement('button');
  setButton.type = 'button';
  setButton.id = 'tac-open-tag-editor';
  setButton.className = 'menu_button';
  setButton.title = '设定标签';
  setButton.innerHTML = '<i class="fa-solid fa-tags"></i>';
  setButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openTagEditor();
  });
  actions.append(setButton);

  themeBlock.append(actions);

  const details = document.createElement('details');
  details.id = 'tac-filter-panel';
  details.open = true;
  details.innerHTML = `
    <summary>
      <span><i class="fa-solid fa-layer-group"></i> 分类筛选</span>
      <i class="fa-solid fa-chevron-down tac-chevron"></i>
    </summary>
    <div id="tac-filter-body"></div>
  `;
  themeBlock.append(details);

  getThemeSelect()?.addEventListener('change', () => {
    setTimeout(() => {
      autoTagCurrentThemeMetadata();
      renderThemePicker();
      scheduleRefresh();
      syncBoundBackgroundForCurrentTheme(true);
    }, 0);
  });

  document.querySelector('#ui-preset-delete-button')?.addEventListener('click', () => {
    const deletedName = getCurrentThemeName();
    scheduleRefresh(300);
    setTimeout(() => {
      const select = getThemeSelect();
      const stillVisible = Array.from(select?.options ?? []).some(option => option.value === deletedName);
      if (deletedName && !stillVisible) {
        state.allThemeOptions = state.allThemeOptions.filter(option => option.value !== deletedName);
        state.sessionImportedThemeValues = state.sessionImportedThemeValues.filter(value => value !== deletedName);
      }
      scheduleRefresh();
    }, 900);
  });

  document.querySelector('#ui-preset-update-button')?.addEventListener('click', () => {
    scheduleRefresh(300);
  });

  document.querySelector('#ui-preset-save-button')?.addEventListener('click', () => {
    scheduleRefresh(300);
  });

  scheduleRefresh();
  void autoTagAllThemeMetadata();
  setTimeout(() => {
    if (autoTagCurrentThemeMetadata()) scheduleRefresh();
  }, 250);
  startThemeBackgroundSync();
  syncBoundBackgroundForCurrentTheme(true);
  return true;
}

function destroyBeautifyFeature() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  state.observer?.disconnect();
  state.observer = null;
  state.themePickerCleanup?.();
  state.themePickerCleanup = null;
  stopThemeBackgroundSync();
  restoreThemeSelectOptions();
  const themeBlock = document.querySelector('#UI-presets-block');
  const actions = document.querySelector('#tac-theme-actions');
  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (themeBlock && actions) {
    if (updateButton) themeBlock.insertBefore(updateButton, actions);
    if (saveButton) themeBlock.insertBefore(saveButton, actions);
  }
  actions?.remove();
  document.querySelector('#tac-theme-picker')?.remove();
  document.querySelector('#tac-theme-picker-menu')?.remove();
  getThemeSelect()?.classList.remove('tac-native-theme-select');
  getThemeSelect()?.closest('.tac-theme-picker-row')?.classList.remove('tac-theme-picker-row');
  document.querySelector('#tac-filter-panel')?.remove();
}

function startBeautifyFeature() {
  const tryMount = () => {
    if (mountUi()) {
      observeThemeOptions();
      return;
    }
    setTimeout(tryMount, 500);
  };
  tryMount();
}

function observeThemeOptions() {
  const select = getThemeSelect();
  if (!select || state.observer) return;
  snapshotThemeOptions();
  state.observer = new MutationObserver(mutations => {
    if (state.suppressThemeObserver) return;
    const knownValues = new Set(state.allThemeOptions.map(option => option.value));
    const addedValues = [];
    const removedValues = [];
    const collectValues = (nodes, target) => nodes.forEach(node => {
      if (!(node instanceof Element)) return;
      if (node.matches('option')) target.push(normalizeTag(node.value));
      node.querySelectorAll?.('option').forEach(option => target.push(normalizeTag(option.value)));
    });
    mutations.forEach(mutation => {
      collectValues(Array.from(mutation.addedNodes), addedValues);
      collectValues(Array.from(mutation.removedNodes), removedValues);
    });
    const currentValues = new Set(Array.from(select.options).map(option => normalizeTag(option.value)).filter(Boolean));
    const trulyRemoved = new Set(removedValues.filter(value => value && !currentValues.has(value)));
    if (trulyRemoved.size) {
      state.allThemeOptions = state.allThemeOptions.filter(option => !trulyRemoved.has(option.value));
      state.sessionImportedThemeValues = state.sessionImportedThemeValues.filter(value => !trulyRemoved.has(value));
    }
    snapshotThemeOptions();
    const importedValue = addedValues.find(value => value && !knownValues.has(value));
    if (importedValue && currentValues.has(importedValue) && !state.batchThemeImportActive) {
      select.value = importedValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderThemePicker();
    scheduleRefresh();
  });
  state.observer.observe(select, { childList: true, subtree: true, attributes: true });
}

function getExtensionSettingsHost() {
  return document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
}

function makeBindingButton(icon, title, onClick, extraClass = '', label = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `menu_button tac-binding-icon ${extraClass}`.trim();
  button.title = title;
  button.innerHTML = `<i class="${icon.includes(' ') ? icon : `fa-solid ${icon}`}"></i>${label ? '<span></span>' : ''}`;
  if (label) button.querySelector('span').textContent = label;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.();
  });
  return button;
}

function makeBindingListItem(type, item, starredId) {
  const row = document.createElement('div');
  const isStarred = starredId === item.id;
  const isStacked = type === 'presets' || type === 'worldBooks';
  row.className = `tac-binding-item${type === 'users' ? ' tac-binding-user-item' : ''}${isStacked ? ' tac-binding-stacked-item' : ''}${isStarred ? ' is-starred' : ''}`;
  const worldBookNames = Array.isArray(item.books) ? item.books.map(book => book.name) : [];
  const typeLabel = type === 'presets' ? '预设' : type === 'worldBooks' ? '世界书' : 'user';
  row.dataset.searchText = [item.name, item.presetName, item.presetValue, item.userName, ...worldBookNames, typeLabel]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('zh-Hans-CN');

  if (type === 'users') {
    const avatar = document.createElement('div');
    avatar.className = 'tac-binding-user-avatar';
    if (item.avatar) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = getThumbnailUrl('persona', item.avatar);
      avatar.append(image);
    } else {
      avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    }
    row.append(avatar);
  }

  const main = document.createElement('div');
  main.className = 'tac-binding-item-main';
  const title = document.createElement('div');
  title.className = 'tac-binding-item-title';
  title.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'tac-binding-item-meta';
  if (type === 'presets') {
    meta.textContent = getPresetBindingDisplayName(item);
  } else if (type === 'worldBooks') {
    meta.textContent = `${getWorldBookBindingSummary(item)}${worldBookNames.length ? ` · ${worldBookNames.join('、')}` : ''}`;
  } else {
    meta.textContent = item.userName || '未记录角色名';
  }
  main.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'tac-binding-item-actions';
  const star = makeBindingButton(
    isStarred ? 'fa-star' : 'fa-regular fa-star',
    isStarred ? '取消自动加载' : '标为自动加载',
    () => starCharacterBinding(type, item.id),
    `tac-binding-star${isStarred ? ' is-active' : ''}`,
  );
  star.setAttribute('aria-pressed', String(isStarred));
  actions.append(star);
  if (type === 'presets') {
    actions.append(makeBindingButton('fa-rotate', '用当前预设更新绑定', () => updatePresetBinding(item.id), 'tac-binding-update'));
  } else if (type === 'worldBooks') {
    actions.append(makeBindingButton('fa-rotate', '用当前世界书及条目更新绑定', () => updateWorldBookBinding(item.id), 'tac-binding-update'));
  }
  const applyBinding = () => {
    if (type === 'presets') return applyPresetBinding(item);
    if (type === 'worldBooks') return applyWorldBookBinding(item);
    return applyUserBinding(item);
  };
  actions.append(
    makeBindingButton('fa-right-to-bracket', '应用绑定', applyBinding),
    makeBindingButton('fa-trash', '删除绑定', () => deleteCharacterBinding(type, item.id)),
  );
  row.append(main, actions);
  return row;
}

function makeBeautifyBindingListItem(item, starredId) {
  const row = document.createElement('div');
  const isStarred = starredId === item.id;
  row.className = `tac-binding-item tac-beautify-binding-item${isStarred ? ' is-starred' : ''}`;
  row.dataset.searchText = `${item.themeName} 美化`.toLocaleLowerCase('zh-Hans-CN');

  const main = document.createElement('div');
  main.className = 'tac-binding-item-main';
  const title = document.createElement('div');
  title.className = 'tac-binding-item-title';
  title.textContent = item.themeName;
  main.append(title);
  if (normalizeThemeNameKey(item.themeName) === normalizeThemeNameKey(getCurrentThemeName())) {
    const meta = document.createElement('div');
    meta.className = 'tac-binding-item-meta';
    meta.textContent = '当前正在使用';
    main.append(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'tac-binding-item-actions';
  const star = makeBindingButton(
    isStarred ? 'fa-star' : 'fa-regular fa-star',
    isStarred ? '取消自动加载' : '标为自动加载',
    () => starCharacterBinding('beautify', item.id),
    `tac-binding-star${isStarred ? ' is-active' : ''}`,
  );
  star.setAttribute('aria-pressed', String(isStarred));
  actions.append(
    star,
    makeBindingButton('fa-right-to-bracket', '应用美化', () => applyBeautifyBinding(item.themeName)),
    makeBindingButton('fa-trash', '删除美化绑定', () => deleteCharacterBinding('beautify', item.id)),
  );
  row.append(main, actions);
  return row;
}

function applyCharacterBindingSearch(root, query) {
  const normalized = normalizeTag(query).toLocaleLowerCase('zh-Hans-CN');
  root.querySelectorAll('.tac-binding-list').forEach(list => {
    const items = Array.from(list.querySelectorAll(':scope > .tac-binding-item'));
    items.forEach(item => {
      item.hidden = Boolean(normalized) && !item.dataset.searchText.includes(normalized);
    });
    const empty = list.querySelector(':scope > .tac-binding-search-empty');
    if (empty) empty.hidden = !normalized || items.some(item => !item.hidden);
  });
}

function renderPresetBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-sliders"></i> 预设绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存预设绑定"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', savePresetBinding);
  const list = section.querySelector('.tac-binding-list');
  if (bindings.presets.items.length) {
    bindings.presets.items.forEach(item => list.append(makeBindingListItem('presets', item, bindings.presets.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的预设绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存预设绑定。</div>';
  }
  return section;
}

function renderBeautifyBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module tac-beautify-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-palette"></i> 美化绑定</div>
      <button type="button" class="menu_button tac-binding-save" data-action="add" title="添加当前美化"><i class="fa-solid fa-plus"></i><span>添加</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('[data-action="add"]')?.addEventListener('click', () => saveBeautifyBinding(getCurrentThemeName()));
  const list = section.querySelector('.tac-binding-list');
  if (bindings.beautify.items.length) {
    bindings.beautify.items.forEach(item => list.append(makeBeautifyBindingListItem(item, bindings.beautify.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的美化绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有添加美化绑定。</div>';
  }
  return section;
}

function renderCharacterRelationModule(bindings) {
  const section = document.createElement('section');
  section.className = `tac-binding-module tac-character-relation-module${state.characterRelationDeleteMode ? ' is-delete-mode' : ''}`;
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-link"></i> 角色卡关联</div>
      <div class="tac-character-relation-actions">
        <button type="button" class="menu_button tac-binding-icon" data-action="add" title="从角色卡库添加"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="menu_button tac-binding-icon${state.characterRelationDeleteMode ? ' is-active' : ''}" data-action="delete-mode" title="显示或隐藏删除按钮"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
    <div class="tac-character-relation-grid"></div>
  `;
  section.querySelector('[data-action="add"]').addEventListener('click', openCharacterLibraryPicker);
  const deleteMode = section.querySelector('[data-action="delete-mode"]');
  deleteMode.disabled = !bindings.relatedCharacters.length;
  deleteMode.addEventListener('click', () => {
    state.characterRelationDeleteMode = !state.characterRelationDeleteMode;
    renderCharacterBindingPanel();
  });

  const grid = section.querySelector('.tac-character-relation-grid');
  if (!bindings.relatedCharacters.length) {
    grid.innerHTML = '<div class="tac-binding-empty">还没有关联角色卡，点击“＋”从角色卡库添加。</div>';
    return section;
  }
  bindings.relatedCharacters.forEach(reference => {
    const target = findCharacterByAvatar(reference.avatar);
    const name = target?.name || reference.name || reference.avatar;
    const card = document.createElement('div');
    card.className = `tac-character-relation-card${target ? '' : ' is-missing'}`;
    card.role = 'button';
    card.tabIndex = target ? 0 : -1;
    card.title = target ? `前往角色卡：${name}` : `角色卡已不在角色库：${name}`;
    card.innerHTML = `
      <span class="tac-character-relation-avatar"><img alt=""></span>
      <span class="tac-character-relation-name"></span>
      <button type="button" class="tac-character-relation-remove" title="删除关联" aria-label="删除关联"><i class="fa-solid fa-xmark"></i></button>
    `;
    const image = card.querySelector('img');
    image.src = target ? getThumbnailUrl('avatar', target.avatar) : '';
    image.alt = name;
    card.querySelector('.tac-character-relation-name').textContent = name;
    card.querySelector('.tac-character-relation-remove').addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void confirmRemoveRelatedCharacter(reference.avatar, name);
    });
    card.addEventListener('click', event => {
      if (!target || event.target.closest('.tac-character-relation-remove')) return;
      void switchToRelatedCharacter(reference.avatar, name);
    });
    card.addEventListener('keydown', event => {
      if (!target || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      void switchToRelatedCharacter(reference.avatar, name);
    });
    grid.append(card);
  });
  return section;
}

function renderUserBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-user"></i> user 绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存 user 绑定"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', saveUserBinding);
  const list = section.querySelector('.tac-binding-list');
  if (bindings.users.items.length) {
    bindings.users.items.forEach(item => list.append(makeBindingListItem('users', item, bindings.users.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的 user 绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存 user 绑定。</div>';
  }
  return section;
}

function renderWorldBookBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-book-atlas"></i> 世界书绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存当前启用及角色挂载的全部世界书和条目"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', saveWorldBookBinding);
  const list = section.querySelector('.tac-binding-list');
  if (bindings.worldBooks.items.length) {
    bindings.worldBooks.items.forEach(item => list.append(makeBindingListItem('worldBooks', item, bindings.worldBooks.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的世界书绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存世界书绑定。</div>';
  }
  return section;
}

function renderCharacterBindingPanel() {
  const body = document.querySelector('#tac-character-binding-body');
  if (!body) return;
  const { character } = getCurrentCharacterContext();
  body.innerHTML = '';
  if (!character) {
    body.innerHTML = '<div class="tac-binding-empty">打开角色卡后可以保存和加载绑定。</div>';
    return;
  }
  const bindings = getCurrentCharacterBindings();
  const status = document.createElement('div');
  status.className = 'tac-binding-character-status';
  status.innerHTML = `<i class="fa-solid fa-id-card"></i><span></span>`;
  status.querySelector('span').textContent = `当前角色：${character.name || character.avatar || '未命名角色'}`;
  const search = document.createElement('div');
  search.className = 'tac-binding-search';
  search.innerHTML = `
    <i class="fa-solid fa-magnifying-glass"></i>
    <input type="search" class="text_pole tac-binding-search-input" placeholder="搜索角色绑定" autocomplete="off">
    <button type="button" class="menu_button tac-binding-search-clear" title="清空搜索"><i class="fa-solid fa-xmark"></i></button>
  `;
  const searchInput = search.querySelector('.tac-binding-search-input');
  searchInput.value = state.characterBindingQuery;
  const grid = document.createElement('div');
  grid.className = 'tac-binding-grid';
  grid.append(
    renderBeautifyBindingModule(bindings),
    renderPresetBindingModule(bindings),
    renderUserBindingModule(bindings),
    renderWorldBookBindingModule(bindings),
    renderCharacterRelationModule(bindings),
  );
  searchInput.addEventListener('input', () => {
    state.characterBindingQuery = searchInput.value;
    applyCharacterBindingSearch(body, state.characterBindingQuery);
  });
  search.querySelector('.tac-binding-search-clear').addEventListener('click', () => {
    state.characterBindingQuery = '';
    searchInput.value = '';
    applyCharacterBindingSearch(body, '');
    searchInput.focus();
  });
  body.append(status, search, grid);
  applyCharacterBindingSearch(body, state.characterBindingQuery);
}

function renderFeatureSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'tac-extension-settings';
  panel.className = 'extension_container';
  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>美化与角色绑定</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div id="tac-character-binding-panel" class="tac-settings-card tac-character-binding-panel">
          <div id="tac-character-binding-body"></div>
        </div>
      </div>
    </div>
  `;
  setTimeout(renderCharacterBindingPanel, 0);
  return panel;
}

function mountFeatureSettingsPanel() {
  const existing = document.querySelector('#tac-extension-settings');
  if (existing) {
    renderCharacterBindingPanel();
    return true;
  }
  const host = getExtensionSettingsHost();
  if (!host) return false;
  host.append(renderFeatureSettingsPanel());
  renderCharacterBindingPanel();
  return true;
}

function startFeatureSettingsPanel() {
  const tryMount = () => {
    if (mountFeatureSettingsPanel()) return;
    setTimeout(tryMount, 500);
  };
  tryMount();
}

function handleCharacterBindingContextChanged() {
  state.lastAppliedCharacterBindingKey = '';
  state.characterRelationDeleteMode = false;
  scheduleCharacterBindingRender();
  scheduleCharacterBindingApply();
}

function start() {
  startFeatureSettingsPanel();
  startBeautifyFeature();
  eventSource?.on?.(event_types.APP_READY, handleCharacterBindingContextChanged);
  eventSource?.on?.(event_types.CHAT_CHANGED, handleCharacterBindingContextChanged);
  eventSource?.on?.(event_types.CHARACTER_EDITED, scheduleCharacterBindingRender);
  scheduleCharacterBindingApply(900);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
